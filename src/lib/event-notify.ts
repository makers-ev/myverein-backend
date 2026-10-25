import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import type { AnnouncementAudience } from "../db/schema/communication.js";
import { wardEventResponses } from "../db/schema/absences.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import type { Promoted } from "./event-seats.js";
import type { EventRow } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { meetingInvitees, type MeetingInviteeRow, type MeetingRow } from "../db/schema/meetings.js";
import { AudienceLimitError } from "./audience.js";
import { clubMailLanguage, loadClubSettings } from "./club-settings.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notify, notifySafely } from "./notify/dispatcher.js";
import { tr, type MailLanguage } from "./notify/i18n.js";
import { writeAudit } from "./audit.js";

/**
 * Notifications about changed or cancelled events and meetings (Wave 9 B10). The route detects an essential change
 * (start, end, location, cancellation), composes the message (old and new time) and the audience from the data as it was
 * BEFORE the change (a deleted event takes its RSVPs with it) and schedules the job `notify_event_changed`; the job calls
 * the dispatcher (class `optional`, category `events`: members may switch it off). Nothing here ever fails the HTTP request.
 */

export const EVENT_CHANGED_JOB_TYPE = "notify_event_changed";

export interface EventChangedPayload extends Record<string, unknown> {
  clubId: string;
  kind: "event" | "meeting";
  refId: string;
  /** Distinguishes several changes of the same object (the `updatedAt` millisecond). */
  version: number;
  cancelled: boolean;
  title: string;
  body: string;
  audience: AnnouncementAudience;
  /** Dispatcher event key; default `<kind>.cancelled` / `<kind>.changed`. */
  eventKey?: string;
  /** Replaces `version` in the job key and the delivery `ref_id` (e.g. the invitee row id of a meeting invitation). */
  discriminator?: string;
}

const DEFAULT_TIMEZONE = "Europe/Berlin";

export async function clubTimezone(clubId: string): Promise<string> {
  const [row] = await db.select({ timezone: clubSettings.timezone }).from(clubSettings).where(eq(clubSettings.clubId, clubId));
  return row?.timezone || DEFAULT_TIMEZONE;
}

/** "Mo., 12.10.2026, 18:00 Uhr" (de) / "Mon, 12/10/2026, 18:00" (en) in the club's time zone; "noch ohne Termin" / "no date yet" for none. */
export function formatWhen(date: Date | null | undefined, timezone: string, endsAt?: Date | null, lang: MailLanguage = "de"): string {
  if (!date) return tr(lang, "noch ohne Termin", "no date yet");
  const locale = tr(lang, "de-DE", "en-GB");
  const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: timezone, ...options });
  const dayOptions: Intl.DateTimeFormatOptions = { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" };
  const time = fmt({ hour: "2-digit", minute: "2-digit" });
  const suffix = tr(lang, " Uhr", "");
  const to = tr(lang, "bis", "to");
  const start = `${fmt(dayOptions).format(date)}, ${time.format(date)}${suffix}`;
  if (!endsAt) return start;
  const sameDay = fmt({ dateStyle: "short" }).format(date) === fmt({ dateStyle: "short" }).format(endsAt);
  return sameDay ? `${start} ${to} ${time.format(endsAt)}${suffix}` : `${start} ${to} ${fmt(dayOptions).format(endsAt)}, ${time.format(endsAt)}${suffix}`;
}

export async function locationName(clubId: string, locationId: string | null | undefined): Promise<string | null> {
  if (!locationId) return null;
  const [row] = await db.select({ name: locations.name }).from(locations).where(and(eq(locations.id, locationId), eq(locations.clubId, clubId)));
  return row?.name ?? null;
}

const sameInstant = (a: Date | null | undefined, b: Date | null | undefined): boolean => (a?.getTime() ?? null) === (b?.getTime() ?? null);

export interface TimePlace {
  startsAt: Date | null;
  endsAt: Date | null;
  locationId: string | null;
}

/** Which of start / end / location differ between the stored and the new state. */
export function essentialDiff(before: TimePlace, after: TimePlace): { time: boolean; place: boolean } {
  return { time: !sameInstant(before.startsAt, after.startsAt) || !sameInstant(before.endsAt, after.endsAt), place: before.locationId !== after.locationId };
}

/** Maps the account memberships (`member.id`) to the club members (`club_members.id`) who can be addressed. */
export async function clubMemberIdsOf(clubId: string, accountMemberIds: string[]): Promise<string[]> {
  if (accountMemberIds.length === 0) return [];
  const rows = await db.select({ id: clubMembers.id }).from(clubMembers).where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.memberId, accountMemberIds)));
  return rows.map((r) => r.id);
}

/**
 * Audience of an event change: everyone who answered with yes or sits on the waitlist, plus their guardians (any change);
 * on a cancellation additionally the members of the calendar's department and their guardians.
 */
export async function eventAudience(clubId: string, eventId: string, departmentId: string | null, cancelled: boolean): Promise<AnnouncementAudience | null> {
  const rows = await db
    .select({ memberId: eventAttendees.memberId, clubMemberId: eventAttendees.clubMemberId })
    .from(eventAttendees)
    .where(and(eq(eventAttendees.eventId, eventId), inArray(eventAttendees.status, ["angemeldet", "warteliste"])));
  // Account RSVPs resolve to their club member; registrations of members without account already carry the club member id.
  const memberIds = [...new Set([...(await clubMemberIdsOf(clubId, rows.flatMap((r) => (r.memberId ? [r.memberId] : [])))), ...rows.flatMap((r) => (r.clubMemberId ? [r.clubMemberId] : []))])];
  const departmentIds = cancelled && departmentId ? [departmentId] : [];
  if (memberIds.length === 0 && departmentIds.length === 0) return null;
  // Guardians are told about every change: the child's attendance is also the parent's schedule.
  return { ...(departmentIds.length ? { departmentIds } : {}), ...(memberIds.length ? { memberIds } : {}), includeGuardians: true };
}

export async function meetingAudience(clubId: string, meetingId: string): Promise<AnnouncementAudience | null> {
  const rows = await db
    .select({ id: meetingInvitees.clubMemberId })
    .from(meetingInvitees)
    .innerJoin(clubMembers, eq(clubMembers.id, meetingInvitees.clubMemberId))
    .where(and(eq(meetingInvitees.meetingId, meetingId), eq(clubMembers.clubId, clubId)));
  const memberIds = rows.map((r) => r.id);
  return memberIds.length === 0 ? null : { memberIds, includeGuardians: false };
}

export interface EventMessageInput {
  noun: "Termin" | "Treffen";
  title: string;
  timezone: string;
  before: { startsAt: Date | null; endsAt: Date | null; place: string | null };
  after: { startsAt: Date | null; endsAt: Date | null; place: string | null };
  cancelled: boolean;
  reason?: string | null;
  /** Language of the system text (club `mail_language`); the title of the event stays as written. */
  lang?: MailLanguage;
}

/** Plain-text title and body; the old and the new time are always spelled out. */
export function composeEventMessage(input: EventMessageInput): { title: string; body: string } {
  const { noun, timezone } = input;
  const lang = input.lang ?? "de";
  const old = formatWhen(input.before.startsAt, timezone, input.before.endsAt, lang);
  const place = (value: string | null) => (value ? `\n${tr(lang, "Ort", "Location")}: ${value}` : "");
  const subject = tr(lang, noun === "Termin" ? "Der Termin" : "Das Treffen", noun === "Termin" ? "The event" : "The meeting");
  if (input.cancelled) {
    const reason = input.reason?.trim() ? `\n${tr(lang, "Grund", "Reason")}: ${input.reason.trim()}` : "";
    // A meeting still in Terminfindung never had a date: there is nothing to say about "planned for".
    const planned = input.before.startsAt ? `\n${tr(lang, "Geplant war", "It was scheduled for")}: ${old}${place(input.before.place)}` : `\n${tr(lang, "Die Terminfindung ist damit beendet.", "The scheduling poll has ended.")}`;
    return { title: `${tr(lang, "Abgesagt", "Cancelled")}: ${input.title}`, body: `${subject} ${tr(lang, `„${input.title}“ wurde abgesagt.`, `“${input.title}” has been cancelled.`)}${planned}${reason}` };
  }
  const lines = [`${subject} ${tr(lang, `„${input.title}“ wurde geändert.`, `“${input.title}” has been changed.`)}`];
  const timeChanged = !sameInstant(input.before.startsAt, input.after.startsAt) || !sameInstant(input.before.endsAt, input.after.endsAt);
  if (timeChanged) {
    lines.push(`${tr(lang, "Bisher", "Previously")}: ${old}`, `${tr(lang, "Neu", "New")}: ${formatWhen(input.after.startsAt, timezone, input.after.endsAt, lang)}`);
  } else {
    lines.push(`${tr(lang, "Zeit", "Time")}: ${formatWhen(input.after.startsAt, timezone, input.after.endsAt, lang)}`);
  }
  const unspecified = tr(lang, "nicht angegeben", "not specified");
  if (input.before.place !== input.after.place) lines.push(`${tr(lang, "Ort bisher", "Previous location")}: ${input.before.place ?? unspecified}`, `${tr(lang, "Ort neu", "New location")}: ${input.after.place ?? unspecified}`);
  else if (input.after.place) lines.push(`${tr(lang, "Ort", "Location")}: ${input.after.place}`);
  const heading = noun === "Termin" ? tr(lang, "Terminänderung", "Event changed") : tr(lang, "Treffen verschoben", "Meeting rescheduled");
  return { title: `${heading}: ${input.title}`, body: lines.join("\n") };
}

/**
 * Schedules the notification job. Best effort: a failing enqueue is logged and never surfaces to the caller. With
 * `suppressed` nothing is sent, but the decision is audited (who silenced which change).
 */
export async function scheduleEventChanged(
  payload: EventChangedPayload,
  options: { suppressed: boolean; actor: string | null },
): Promise<"queued" | "suppressed" | "no_audience" | "failed"> {
  try {
    if (options.suppressed) {
      await writeAudit(db, {
        eventType: `${payload.kind}.notify_suppressed`,
        subjectId: payload.refId,
        payload: { clubId: payload.clubId, cancelled: payload.cancelled, actor: options.actor },
      });
      return "suppressed";
    }
    await enqueue({ type: EVENT_CHANGED_JOB_TYPE, payload, dedupeKey: `${EVENT_CHANGED_JOB_TYPE}:${payload.kind}:${payload.refId}:${payload.discriminator ?? payload.version}` });
    return "queued";
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ kind: payload.kind, refId: payload.refId, errName: e?.name, errCode: e?.code }, "[event-notify] could not schedule notification");
    return "failed";
  }
}

/**
 * A waitlisted person moved up to a confirmed seat (event key `event.promoted`, optional, category events, in-app + mail;
 * the audit entry `event_attendee.promote` stays). Called after the RSVP transaction committed; never throws. Nothing is
 * sent for a cancelled or already started event. The delivery `ref_id` carries the `respondedAt` of the waitlist row, so a
 * person who leaves and joins the waitlist again can be told again, while a repeated call is the same delivery.
 * Guardians of a child are told too.
 */
export async function notifyWaitlistPromoted(args: { clubId: string; event: Pick<EventRow, "id" | "title" | "startsAt" | "endsAt" | "locationId" | "cancelledAt">; accountMemberId: string; respondedAt: Date }): Promise<void> {
  try {
    const { clubId, event } = args;
    if (event.cancelledAt !== null || event.startsAt.getTime() <= Date.now()) return;
    const [clubMemberId] = await clubMemberIdsOf(clubId, [args.accountMemberId]);
    if (!clubMemberId) return;
    const timezone = await clubTimezone(clubId);
    const lang = await clubMailLanguage(db, clubId);
    const place = await locationName(clubId, event.locationId);
    await notifySafely({
      clubId,
      class: "optional",
      eventKey: "event.promoted",
      refId: `${event.id}#${args.respondedAt.getTime()}`,
      audience: { memberIds: [clubMemberId], includeGuardians: true },
      content: {
        title: `${tr(lang, "Du bist nachgerückt", "You moved up")}: ${event.title}`,
        body: tr(
          lang,
          `Für „${event.title}“ ist ein Platz frei geworden. Du stehst jetzt nicht mehr auf der Warteliste, sondern bist angemeldet.\nWann: ${formatWhen(event.startsAt, timezone, event.endsAt)}${place ? `\nOrt: ${place}` : ""}\nWenn du nicht kommen kannst, sag bitte ab, damit der Platz weitergegeben wird.`,
          `A spot opened up for “${event.title}”. You are no longer on the waitlist, you are registered.\nWhen: ${formatWhen(event.startsAt, timezone, event.endsAt, lang)}${place ? `\nLocation: ${place}` : ""}\nIf you cannot come, please cancel so the spot can be passed on.`,
        ),
        category: "events",
        template: "announcement",
      },
      channels: ["in_app", "email", "push"],
    });
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ eventId: args.event.id, errName: e?.name, errCode: e?.code }, "[event-notify] could not announce waitlist promotion");
  }
}

/**
 * Tells everybody who moved up from the waitlist (`promote*` of `lib/event-seats.ts`), whatever their identity: an account, a
 * member without account (the guardians are told as well) or a guest without any membership (mail only, no member data kept).
 * Called after the transaction committed; never throws. Nothing is sent for a cancelled or already started event.
 */
export async function notifyPromoted(args: { clubId: string; event: Pick<EventRow, "id" | "title" | "startsAt" | "endsAt" | "locationId" | "cancelledAt">; promoted: Promoted[] }): Promise<void> {
  try {
    const { clubId, event, promoted } = args;
    if (promoted.length === 0 || event.cancelledAt !== null || event.startsAt.getTime() <= Date.now()) return;
    const timezone = await clubTimezone(clubId);
    const lang = await clubMailLanguage(db, clubId);
    const place = await locationName(clubId, event.locationId);
    const when = formatWhen(event.startsAt, timezone, event.endsAt, lang);
    const content = {
      title: `${tr(lang, "Du bist nachgerückt", "You moved up")}: ${event.title}`,
      body: tr(
        lang,
        `Für „${event.title}“ ist ein Platz frei geworden. Du stehst jetzt nicht mehr auf der Warteliste, sondern bist angemeldet.\nWann: ${when}${place ? `\nOrt: ${place}` : ""}\nWenn du nicht kommen kannst, sag bitte ab, damit der Platz weitergegeben wird.`,
        `A spot opened up for “${event.title}”. You are no longer on the waitlist, you are registered.\nWhen: ${when}${place ? `\nLocation: ${place}` : ""}\nIf you cannot come, please cancel so the spot can be passed on.`,
      ),
      category: "events" as const,
    };
    const attendeeIds = promoted.filter((p) => p.kind === "attendee").map((p) => p.id);
    const wardIds = promoted.filter((p) => p.kind === "ward").map((p) => p.id);
    const rows = attendeeIds.length ? await db.select().from(eventAttendees).where(inArray(eventAttendees.id, attendeeIds)) : [];
    const wards = wardIds.length ? await db.select({ id: wardEventResponses.id, wardClubMemberId: wardEventResponses.wardClubMemberId }).from(wardEventResponses).where(inArray(wardEventResponses.id, wardIds)) : [];
    for (const p of promoted) {
      const stamp = `${event.id}#${p.respondedAt.getTime()}`;
      if (p.kind === "ward") {
        const ward = wards.find((w) => w.id === p.id);
        if (ward) await notifySafely({ clubId, class: "optional", eventKey: "event.promoted", refId: stamp, audience: { memberIds: [ward.wardClubMemberId], includeGuardians: true }, content: { ...content, template: "announcement" }, channels: ["in_app", "email", "push"] });
        continue;
      }
      const row = rows.find((r) => r.id === p.id);
      if (!row) continue;
      if (row.guestEmail) {
        // A guest without account: mail only, the delivery address is wiped by the retention job.
        await notifySafely({ clubId, class: "mandatory", eventKey: "event.promoted", refId: `${stamp}:${p.id}`, recipients: [{ email: row.guestEmail, name: row.guestName }], content: { ...content, template: "notice", lang }, channels: ["email"] });
        continue;
      }
      const [accountClubMemberId] = row.memberId ? await clubMemberIdsOf(clubId, [row.memberId]) : [];
      const target = row.clubMemberId ?? accountClubMemberId;
      if (!target) continue;
      await notifySafely({ clubId, class: "optional", eventKey: "event.promoted", refId: stamp, audience: { memberIds: [target], includeGuardians: true }, content: { ...content, template: "announcement" }, channels: ["in_app", "email", "push"] });
    }
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ eventId: args.event.id, errName: e?.name, errCode: e?.code }, "[event-notify] could not announce waitlist promotion");
  }
}

/** Statuses of a meeting that people can still react to (Terminfindung or planned); everything else is history. */
const OPEN_MEETING_STATUSES = ["terminfindung", "geplant"];

/** Whether announcing something about this meeting still makes sense (open status and not in the past). */
export function isOpenMeeting(meeting: Pick<MeetingRow, "status" | "scheduledAt">, now: Date = new Date()): boolean {
  return OPEN_MEETING_STATUSES.includes(meeting.status) && (meeting.scheduledAt === null || meeting.scheduledAt.getTime() > now.getTime());
}

/**
 * Tells one newly invited member about the meeting (event key `meeting.invited`, optional, category events). Covers the
 * start of a Terminfindung too: that is the moment the first invitees are added. Skipped for meetings that are over or
 * cancelled, and when the club switched `notify_meeting_invites` off; `suppress`
 * (body `notify:false`) skips it and audits that. Job key per invitee row, so a repeated request never sends twice
 * while removing and re-adding the person is a new invitation. Never throws.
 */
export async function announceMeetingInvitation(args: { clubId: string; actor: string; meeting: MeetingRow; invitee: MeetingInviteeRow; suppress: boolean }): Promise<"queued" | "suppressed" | "skipped" | "failed"> {
  try {
    const { clubId, meeting, invitee } = args;
    if (!isOpenMeeting(meeting) || !(await loadClubSettings(db, clubId)).notifyMeetingInvites) return "skipped";
    const clubMemberId = invitee.clubMemberId;
    const timezone = await clubTimezone(clubId);
    const lang = await clubMailLanguage(db, clubId);
    const place = await locationName(clubId, meeting.locationId);
    const lines = meeting.scheduledAt
      ? [
          tr(lang, `Du bist zu „${meeting.title}“ eingeladen.`, `You are invited to “${meeting.title}”.`),
          `${tr(lang, "Wann", "When")}: ${formatWhen(meeting.scheduledAt, timezone, null, lang)}`,
          ...(place ? [`${tr(lang, "Ort", "Location")}: ${place}`] : []),
          tr(lang, "Bitte sag zu oder ab.", "Please accept or decline."),
        ]
      : [
          tr(lang, `Du bist zur Terminfindung für „${meeting.title}“ eingeladen.`, `You are invited to the scheduling poll for “${meeting.title}”.`),
          tr(lang, "Der Termin steht noch nicht fest. Bitte trage deine Verfügbarkeit ein und sag zu oder ab.", "The date is not set yet. Please enter your availability and accept or decline."),
        ];
    const payload: EventChangedPayload = {
      clubId,
      kind: "meeting",
      refId: meeting.id,
      version: 0,
      discriminator: invitee.id,
      cancelled: false,
      eventKey: "meeting.invited",
      title: meeting.scheduledAt ? `${tr(lang, "Einladung", "Invitation")}: ${meeting.title}` : `${tr(lang, "Terminfindung", "Scheduling poll")}: ${meeting.title}`,
      body: lines.join("\n"),
      audience: { memberIds: [clubMemberId], includeGuardians: false },
    };
    const scheduled = await scheduleEventChanged(payload, { suppressed: args.suppress, actor: args.actor });
    return scheduled === "queued" || scheduled === "suppressed" ? scheduled : "failed";
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ meetingId: args.meeting.id, errName: e?.name, errCode: e?.code }, "[event-notify] could not announce meeting invitation");
    return "failed";
  }
}

/**
 * Composes and schedules the notification for an essential change or cancellation (B10). Audience and texts come from
 * the state BEFORE the change; `notify: false` suppresses it (audited). Never throws.
 */
export async function announceEventChange(args: {
  clubId: string;
  actor: string | null;
  before: EventRow;
  after: EventRow;
  departmentId: string | null;
  cancelled: boolean;
  reason?: string | null;
  suppress: boolean;
  /** Audience captured earlier (a deleted event no longer has its RSVPs). */
  audience?: Awaited<ReturnType<typeof eventAudience>>;
}): Promise<void> {
  try {
    const { clubId, before, after } = args;
    const audience = args.audience !== undefined ? args.audience : await eventAudience(clubId, before.id, args.departmentId, args.cancelled);
    const timezone = await clubTimezone(clubId);
    const [placeBefore, placeAfter] = await Promise.all([locationName(clubId, before.locationId), locationName(clubId, after.locationId)]);
    const message = composeEventMessage({
      lang: await clubMailLanguage(db, clubId),
      noun: "Termin",
      title: after.title,
      timezone,
      before: { startsAt: before.startsAt, endsAt: before.endsAt, place: placeBefore },
      after: { startsAt: after.startsAt, endsAt: after.endsAt, place: placeAfter },
      cancelled: args.cancelled,
      reason: args.reason ?? null,
    });
    const payload = { clubId, kind: "event" as const, refId: before.id, version: after.updatedAt.getTime(), cancelled: args.cancelled, ...message, audience: audience ?? { memberIds: [], includeGuardians: false } };
    if (!args.suppress && audience === null) return;
    await scheduleEventChanged(payload, { suppressed: args.suppress, actor: args.actor });
  } catch (err) {
    // Best effort: the change itself is already committed. Class and event id only (no message text, no addresses).
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ eventId: args.before.id, errName: e?.name, errCode: e?.code }, "[events] could not announce event change");
  }
}

/** Job handler `notify_event_changed`: dispatches the prepared message to the audience captured by the route. */
export async function handleEventChanged(job: JobContext): Promise<void> {
  const p = job.payload as Partial<EventChangedPayload>;
  if (!p.clubId || !p.refId || !p.kind || !p.audience || typeof p.title !== "string" || typeof p.body !== "string") return;
  try {
    await notify({
      clubId: p.clubId,
      class: "optional",
      eventKey: p.eventKey ?? `${p.kind}.${p.cancelled ? "cancelled" : "changed"}`,
      // Every change of the same event is a new message; a re-run of one change is the same delivery.
      refId: `${p.refId}#${p.discriminator ?? p.version ?? ""}`,
      audience: p.audience,
      content: { title: p.title, body: p.body, category: "events", template: "announcement" },
      // Push on top (never alone): the app opens the event / the calendar.
      channels: ["in_app", "email", "push"],
    });
  } catch (err) {
    // Too many recipients cannot succeed on a retry; everything else (database, ...) is retried by the queue.
    if (err instanceof AudienceLimitError) {
      logger.error({ kind: p.kind, refId: p.refId }, "[event-notify] audience too large, notification dropped");
      return;
    }
    throw err;
  }
}
