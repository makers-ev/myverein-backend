import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import type { AnnouncementAudience } from "../db/schema/communication.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { locations } from "../db/schema/locations.js";
import { meetingInvitees } from "../db/schema/meetings.js";
import { AudienceLimitError } from "./audience.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notify } from "./notify/dispatcher.js";

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
}

const DEFAULT_TIMEZONE = "Europe/Berlin";

export async function clubTimezone(clubId: string): Promise<string> {
  const [row] = await db.select({ timezone: clubSettings.timezone }).from(clubSettings).where(eq(clubSettings.clubId, clubId));
  return row?.timezone || DEFAULT_TIMEZONE;
}

/** "Mo., 12.10.2026, 18:00" in the club's time zone; "ohne Termin" for none. */
export function formatWhen(date: Date | null | undefined, timezone: string, endsAt?: Date | null): string {
  if (!date) return "noch ohne Termin";
  const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("de-DE", { timeZone: timezone, ...options });
  const day = fmt({ weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
  const time = fmt({ hour: "2-digit", minute: "2-digit" });
  const start = `${day}, ${time.format(date)} Uhr`;
  if (!endsAt) return start;
  const sameDay = fmt({ dateStyle: "short" }).format(date) === fmt({ dateStyle: "short" }).format(endsAt);
  return sameDay ? `${start} bis ${time.format(endsAt)} Uhr` : `${start} bis ${fmt({ weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).format(endsAt)}, ${time.format(endsAt)} Uhr`;
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
async function clubMemberIdsOf(clubId: string, accountMemberIds: string[]): Promise<string[]> {
  if (accountMemberIds.length === 0) return [];
  const rows = await db.select({ id: clubMembers.id }).from(clubMembers).where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.memberId, accountMemberIds)));
  return rows.map((r) => r.id);
}

/**
 * Audience of an event change: everyone who answered with yes or sits on the waitlist; on a cancellation additionally the
 * members of the calendar's department and their guardians.
 */
export async function eventAudience(clubId: string, eventId: string, departmentId: string | null, cancelled: boolean): Promise<AnnouncementAudience | null> {
  const rows = await db
    .select({ memberId: eventAttendees.memberId })
    .from(eventAttendees)
    .where(and(eq(eventAttendees.eventId, eventId), inArray(eventAttendees.status, ["angemeldet", "warteliste"])));
  const memberIds = await clubMemberIdsOf(clubId, rows.map((r) => r.memberId));
  const departmentIds = cancelled && departmentId ? [departmentId] : [];
  if (memberIds.length === 0 && departmentIds.length === 0) return null;
  return { ...(departmentIds.length ? { departmentIds } : {}), ...(memberIds.length ? { memberIds } : {}), includeGuardians: cancelled && departmentIds.length > 0 };
}

export async function meetingAudience(clubId: string, meetingId: string): Promise<AnnouncementAudience | null> {
  const rows = await db.select({ memberId: meetingInvitees.memberId }).from(meetingInvitees).where(eq(meetingInvitees.meetingId, meetingId));
  const memberIds = await clubMemberIdsOf(clubId, rows.map((r) => r.memberId));
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
}

/** Plain-text title and body; the old and the new time are always spelled out. */
export function composeEventMessage(input: EventMessageInput): { title: string; body: string } {
  const { noun, timezone } = input;
  const old = formatWhen(input.before.startsAt, timezone, input.before.endsAt);
  const place = (value: string | null) => (value ? `\nOrt: ${value}` : "");
  if (input.cancelled) {
    const reason = input.reason?.trim() ? `\nGrund: ${input.reason.trim()}` : "";
    return { title: `Abgesagt: ${input.title}`, body: `${noun === "Termin" ? "Der Termin" : "Das Treffen"} „${input.title}“ wurde abgesagt.\nGeplant war: ${old}${place(input.before.place)}${reason}` };
  }
  const lines = [`${noun === "Termin" ? "Der Termin" : "Das Treffen"} „${input.title}“ wurde geändert.`];
  const timeChanged = !sameInstant(input.before.startsAt, input.after.startsAt) || !sameInstant(input.before.endsAt, input.after.endsAt);
  if (timeChanged) {
    lines.push(`Bisher: ${old}`, `Neu: ${formatWhen(input.after.startsAt, timezone, input.after.endsAt)}`);
  } else {
    lines.push(`Zeit: ${formatWhen(input.after.startsAt, timezone, input.after.endsAt)}`);
  }
  if (input.before.place !== input.after.place) lines.push(`Ort bisher: ${input.before.place ?? "nicht angegeben"}`, `Ort neu: ${input.after.place ?? "nicht angegeben"}`);
  else if (input.after.place) lines.push(`Ort: ${input.after.place}`);
  return { title: `${noun === "Termin" ? "Terminänderung" : "Treffen verschoben"}: ${input.title}`, body: lines.join("\n") };
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
      await db.insert(auditLog).values({
        eventType: `${payload.kind}.notify_suppressed`,
        subjectId: payload.refId,
        payload: { clubId: payload.clubId, cancelled: payload.cancelled, actor: options.actor },
      });
      return "suppressed";
    }
    await enqueue({ type: EVENT_CHANGED_JOB_TYPE, payload, dedupeKey: `${EVENT_CHANGED_JOB_TYPE}:${payload.kind}:${payload.refId}:${payload.version}` });
    return "queued";
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ kind: payload.kind, refId: payload.refId, errName: e?.name, errCode: e?.code }, "[event-notify] could not schedule notification");
    return "failed";
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
      eventKey: `${p.kind}.${p.cancelled ? "cancelled" : "changed"}`,
      refId: p.refId,
      audience: p.audience,
      content: { title: p.title, body: p.body, category: "events", template: "announcement" },
      channels: ["in_app", "email"],
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
