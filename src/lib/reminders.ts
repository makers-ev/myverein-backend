import { and, eq, gt, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import type { AnnouncementAudience } from "../db/schema/communication.js";
import { clubMemberInvites } from "../db/schema/club-member-invites.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { meetingInvitees, meetings } from "../db/schema/meetings.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { addDays, daysBetween, digestHour, isDigestTime, localDate, safeTimezone } from "./club-time.js";
import { AudienceLimitError } from "./audience.js";
import { credentialExpiry } from "./credentials.js";
import { canGuardianRead } from "./custom-field-access.js";
import { effectiveStatus, isLeftStatus } from "./member-lifecycle.js";
import { formatWhen } from "./event-notify.js";
import { isLoanOverdue, maintenanceDueDate } from "./inventory-status.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notify } from "./notify/dispatcher.js";
import { BOARD_CATEGORY } from "./notify/types.js";

/**
 * Reminders (Wave 9 B12). The recurring registry job `reminder-sweep` (every 15 min, see `registerAllJobs`) decides WHAT is
 * due per club (switches and lead times from `club_settings`, calendar days in the club time zone) and schedules one
 * `notify_reminder` job per reminder under the dedupe key `reminder:<kind>:<ref>:<date>`. The key makes every reminder
 * exactly-once: later sweeps, a double run or several instances find the key taken. The `notify_reminder` job hands the
 * prepared message to the dispatcher (class `optional`, category `reminders`, so members can switch it off). The reminders
 * about a person's own commitments (event, loan, RSVP) also reach the guardians of that person (`includeGuardians`), so the
 * texts are written neutrally ("liegt eine Zusage vor"), not "du".
 * Time-of-day: events use an absolute lead (hours before the start); everything date based (loans, maintenance, RSVP)
 * goes out from `REMINDER_DIGEST_HOUR` (default 8) club time on.
 */

export const REMINDER_SWEEP_JOB_TYPE = "reminder-sweep";
export const REMINDER_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
export const REMINDER_JOB_TYPE = "notify_reminder";

/** Reminders that also go out as push (personal, time-critical); board digests (maintenance, age transition, expiry notices) stay in-app + mail. */
export const PUSH_REMINDER_KINDS: readonly ReminderKind[] = ["event", "rsvp", "loan_due", "loan_overdue"];

/** Days after the due date on which an overdue loan is reminded again (limited repeats: three reminders, then silence). */
export const LOAN_OVERDUE_STEPS = [1, 4, 7] as const;
const MAX_LIST = 15;

/** How long after the due day an expired invitation / credential is still worth one message (older ones stay silent). */
export const EXPIRED_NOTICE_DAYS = 7;

export type ReminderKind = "event" | "loan_due" | "loan_overdue" | "maintenance" | "rsvp" | "age_transition" | "invite_expiring" | "invite_expired" | "credential_expiring" | "credential_expired";

/** Payload of `notify_reminder`: the prepared message and its audience (ids and club text only). */
export interface ReminderPayload extends Record<string, unknown> {
  clubId: string;
  kind: ReminderKind;
  refId: string;
  /** The date of the dedupe key (also in the key; informational). */
  date: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
}

export interface ReminderClub {
  clubId: string;
  timezone: string;
  eventEnabled: boolean;
  eventLeadHours: number;
  loanEnabled: boolean;
  loanLeadDays: number;
  maintenanceEnabled: boolean;
  maintenanceLeadDays: number;
  rsvpEnabled: boolean;
  rsvpLeadDays: number;
  invitationEnabled: boolean;
  invitationLeadDays: number;
  credentialEnabled: boolean;
  credentialLeadDays: number;
}

export interface ReminderSweepResult {
  scheduled: number;
  alreadyScheduled: number;
}

export const reminderDedupeKey = (kind: ReminderKind, ref: string, date: string): string => `reminder:${kind}:${ref}:${date}`;

async function loadClubs(onlyClubId?: string): Promise<Map<string, ReminderClub>> {
  const rows = await db
    .select({ id: organization.id, s: clubSettings })
    .from(organization)
    .leftJoin(clubSettings, eq(clubSettings.clubId, organization.id))
    .where(onlyClubId ? eq(organization.id, onlyClubId) : undefined);
  return new Map(
    rows.map(({ id, s }) => [
      id,
      {
        clubId: id,
        timezone: safeTimezone(s?.timezone),
        eventEnabled: s?.reminderEventEnabled ?? true,
        eventLeadHours: s?.reminderEventLeadHours ?? 24,
        loanEnabled: s?.reminderLoanEnabled ?? true,
        loanLeadDays: s?.reminderLoanLeadDays ?? 1,
        maintenanceEnabled: s?.reminderMaintenanceEnabled ?? true,
        maintenanceLeadDays: s?.reminderMaintenanceLeadDays ?? 7,
        rsvpEnabled: s?.reminderRsvpEnabled ?? true,
        rsvpLeadDays: s?.reminderRsvpLeadDays ?? 3,
        invitationEnabled: s?.reminderInvitationEnabled ?? true,
        invitationLeadDays: s?.reminderInvitationLeadDays ?? 3,
        credentialEnabled: s?.reminderCredentialEnabled ?? true,
        credentialLeadDays: s?.reminderCredentialLeadDays ?? 30,
      } satisfies ReminderClub,
    ]),
  );
}

/** `club_members.id` per `${clubId}:${accountMemberId}` for the given account memberships. */
async function clubMemberIndex(accountMemberIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(accountMemberIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ id: clubMembers.id, clubId: clubMembers.clubId, memberId: clubMembers.memberId })
      .from(clubMembers)
      .where(inArray(clubMembers.memberId, ids.slice(i, i + 500)));
    for (const r of rows) if (r.memberId) out.set(`${r.clubId}:${r.memberId}`, r.id);
  }
  return out;
}

function listLines(lines: string[]): string {
  const shown = lines.slice(0, MAX_LIST);
  return shown.join("\n") + (lines.length > shown.length ? `\n… und ${lines.length - shown.length} weitere` : "");
}

const dateDe = (date: string): string => date.split("-").reverse().join(".");

export interface DueReminder {
  kind: ReminderKind;
  refId: string;
  date: string;
  clubId: string;
  title: string;
  body: string;
  audience: AnnouncementAudience;
}

/** Event reminders: attendees ("angemeldet") of events starting within the lead time. */
export async function collectEventReminders(clubs: Map<string, ReminderClub>, now: Date): Promise<DueReminder[]> {
  const enabled = [...clubs.values()].filter((c) => c.eventEnabled);
  if (enabled.length === 0) return [];
  const horizon = new Date(now.getTime() + Math.max(...enabled.map((c) => c.eventLeadHours)) * 3_600_000);
  const rows = await db
    .select({ id: events.id, title: events.title, startsAt: events.startsAt, endsAt: events.endsAt, clubId: calendars.clubId })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(isNull(events.cancelledAt), gt(events.startsAt, now), lte(events.startsAt, horizon)));
  const due = rows.filter((r) => {
    const club = clubs.get(r.clubId);
    return club?.eventEnabled && r.startsAt.getTime() <= now.getTime() + club.eventLeadHours * 3_600_000;
  });
  if (due.length === 0) return [];
  const attendees = await db
    .select({ eventId: eventAttendees.eventId, memberId: eventAttendees.memberId })
    .from(eventAttendees)
    .where(and(inArray(eventAttendees.eventId, due.map((r) => r.id)), eq(eventAttendees.status, "angemeldet")));
  const index = await clubMemberIndex(attendees.map((a) => a.memberId));
  const out: DueReminder[] = [];
  for (const ev of due) {
    const club = clubs.get(ev.clubId)!;
    const memberIds = [...new Set(attendees.filter((a) => a.eventId === ev.id).flatMap((a) => index.get(`${ev.clubId}:${a.memberId}`) ?? []))];
    if (memberIds.length === 0) continue;
    out.push({
      kind: "event",
      refId: ev.id,
      date: localDate(ev.startsAt, club.timezone),
      clubId: ev.clubId,
      title: `Erinnerung: ${ev.title}`,
      body: `Für „${ev.title}“ liegt eine Zusage vor.\nWann: ${formatWhen(ev.startsAt, club.timezone, ev.endsAt)}`,
      audience: { memberIds, includeGuardians: true },
    });
  }
  return out;
}

/** Loan reminders: "due" from `loanLeadDays` before the due day until the due day, then "overdue" on days 1, 4 and 7. */
export async function collectLoanReminders(clubs: Map<string, ReminderClub>, now: Date): Promise<DueReminder[]> {
  const rows = await db
    .select({ id: inventoryLoans.id, memberId: inventoryLoans.memberId, dueAt: inventoryLoans.dueAt, returnedAt: inventoryLoans.returnedAt, status: inventoryLoans.status, itemName: inventoryItems.name, clubId: inventoryItems.clubId })
    .from(inventoryLoans)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLoans.itemId))
    .where(and(isNotNull(inventoryLoans.dueAt), isNull(inventoryLoans.returnedAt)));
  const candidates: Array<{ row: (typeof rows)[number]; due: string; today: string }> = [];
  for (const row of rows) {
    const club = clubs.get(row.clubId);
    if (!club?.loanEnabled || !isDigestTime(now, club.timezone)) continue;
    const due = localDate(row.dueAt!, club.timezone);
    const today = localDate(now, club.timezone);
    if (today < addDays(due, -club.loanLeadDays)) continue;
    candidates.push({ row, due, today });
  }
  if (candidates.length === 0) return [];
  const index = await clubMemberIndex(candidates.map((c) => c.row.memberId));
  const out: DueReminder[] = [];
  for (const { row, due, today } of candidates) {
    const memberId = index.get(`${row.clubId}:${row.memberId}`);
    if (!memberId) continue;
    // `isLoanOverdue` (inventory-status.ts) is the single definition of "overdue"; the repeat schedule counts calendar days.
    const overdueDays = isLoanOverdue(row, now) ? daysBetween(due, today) : 0;
    const audience: AnnouncementAudience = { memberIds: [memberId], includeGuardians: true };
    if (overdueDays <= 0) {
      const when = today === due ? "heute" : `am ${dateDe(due)}`;
      out.push({ kind: "loan_due", refId: row.id, date: due, clubId: row.clubId, title: `Rückgabe fällig: ${row.itemName}`, body: `„${row.itemName}“ ist ${when} zurückzugeben.`, audience });
      continue;
    }
    const step = [...LOAN_OVERDUE_STEPS].reverse().find((s) => s <= overdueDays);
    if (step === undefined) continue;
    out.push({
      kind: "loan_overdue",
      refId: row.id,
      date: addDays(due, step),
      clubId: row.clubId,
      title: `Rückgabe überfällig: ${row.itemName}`,
      body: `„${row.itemName}“ hätte am ${dateDe(due)} zurückgegeben werden sollen. Bitte gib es so bald wie möglich zurück.`,
      audience,
    });
  }
  return out;
}

/** Maintenance digest: one message per club and day to everyone with `inventory:write`, listing items due within the lead time. */
export async function collectMaintenanceReminders(clubs: Map<string, ReminderClub>, now: Date): Promise<DueReminder[]> {
  const items = await db
    .select({ id: inventoryItems.id, name: inventoryItems.name, clubId: inventoryItems.clubId, maintenanceIntervalDays: inventoryItems.maintenanceIntervalDays, lastMaintenanceAt: inventoryItems.lastMaintenanceAt, acquiredAt: inventoryItems.acquiredAt })
    .from(inventoryItems)
    .where(isNotNull(inventoryItems.maintenanceIntervalDays));
  const byClub = new Map<string, Array<{ name: string; dueDate: string }>>();
  for (const item of items) {
    const club = clubs.get(item.clubId);
    if (!club?.maintenanceEnabled || !isDigestTime(now, club.timezone)) continue;
    const dueDate = maintenanceDueDate(item);
    if (!dueDate || dueDate > addDays(localDate(now, club.timezone), club.maintenanceLeadDays)) continue;
    (byClub.get(item.clubId) ?? byClub.set(item.clubId, []).get(item.clubId)!).push({ name: item.name, dueDate });
  }
  const out: DueReminder[] = [];
  for (const [clubId, list] of byClub) {
    const club = clubs.get(clubId)!;
    const today = localDate(now, club.timezone);
    list.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
    const lines = list.map((i) => `• ${i.name}: ${i.dueDate < today ? "überfällig seit" : "fällig am"} ${dateDe(i.dueDate)}`);
    out.push({
      kind: "maintenance",
      refId: clubId,
      date: today,
      clubId,
      title: list.length === 1 ? "Wartung fällig: 1 Gegenstand" : `Wartung fällig: ${list.length} Gegenstände`,
      body: `Diese Gegenstände brauchen Wartung:\n${listLines(lines)}`,
      audience: { roleTypes: roleTypesWithPermission("inventory:write"), includeGuardians: false },
    });
  }
  return out;
}

/** Missing RSVP: invitees of a planned meeting who have not answered, from `rsvpLeadDays` before the meeting day. */
export async function collectRsvpReminders(clubs: Map<string, ReminderClub>, now: Date): Promise<DueReminder[]> {
  const rows = await db
    .select({ id: meetings.id, title: meetings.title, scheduledAt: meetings.scheduledAt, clubId: meetings.clubId })
    .from(meetings)
    .where(and(eq(meetings.status, "geplant"), isNotNull(meetings.scheduledAt), gt(meetings.scheduledAt, now)));
  const due: Array<{ row: (typeof rows)[number]; club: ReminderClub; day: string }> = [];
  for (const row of rows) {
    const club = clubs.get(row.clubId);
    if (!club?.rsvpEnabled || !isDigestTime(now, club.timezone)) continue;
    const day = localDate(row.scheduledAt!, club.timezone);
    if (localDate(now, club.timezone) < addDays(day, -club.rsvpLeadDays)) continue;
    due.push({ row, club, day });
  }
  if (due.length === 0) return [];
  const pending = await db
    .select({ meetingId: meetingInvitees.meetingId, memberId: meetingInvitees.memberId })
    .from(meetingInvitees)
    .where(and(inArray(meetingInvitees.meetingId, due.map((d) => d.row.id)), eq(meetingInvitees.response, "ausstehend")));
  const index = await clubMemberIndex(pending.map((p) => p.memberId));
  const out: DueReminder[] = [];
  for (const { row, club, day } of due) {
    const memberIds = [...new Set(pending.filter((p) => p.meetingId === row.id).flatMap((p) => index.get(`${row.clubId}:${p.memberId}`) ?? []))];
    if (memberIds.length === 0) continue;
    out.push({
      kind: "rsvp",
      refId: row.id,
      date: day,
      clubId: row.clubId,
      title: `Bitte antworten: ${row.title}`,
      body: `Für das Treffen „${row.title}“ fehlt noch eine Antwort.\nWann: ${formatWhen(row.scheduledAt, club.timezone)}\nBitte sag zu oder ab.`,
      audience: { memberIds, includeGuardians: true },
    });
  }
  return out;
}

/**
 * Member invitations (G6): an open invitation (not accepted, member still without account, not left) that expires within
 * `invitationLeadDays` gets ONE reminder (`invite_expiring`), and ONE notice (`invite_expired`) when it ran out unaccepted
 * (up to `EXPIRED_NOTICE_DAYS` after the expiry day, older ones stay silent). Recipients: the roles with `members:write`,
 * i.e. everybody who may send the invitation again. Keys use the expiry day, so a re-sent invitation (new row, new
 * expiry) is reminded on its own. The text names the member, never the invited address.
 */
export async function collectInvitationReminders(clubs: Map<string, ReminderClub>, now: Date): Promise<DueReminder[]> {
  const rows = await db
    .select({ id: clubMemberInvites.id, expiresAt: clubMemberInvites.expiresAt, clubId: clubMembers.clubId, name: clubMembers.displayName, status: clubMembers.status, leftAt: clubMembers.leftAt })
    .from(clubMemberInvites)
    .innerJoin(clubMembers, eq(clubMembers.id, clubMemberInvites.clubMemberId))
    .where(and(isNull(clubMemberInvites.acceptedAt), isNull(clubMembers.memberId)));
  const out: DueReminder[] = [];
  for (const row of rows) {
    const club = clubs.get(row.clubId);
    if (!club?.invitationEnabled || !isDigestTime(now, club.timezone)) continue;
    const today = localDate(now, club.timezone);
    if (isLeftStatus(effectiveStatus({ status: row.status, leftAt: row.leftAt }, today))) continue;
    const expiryDay = localDate(row.expiresAt, club.timezone);
    const expired = row.expiresAt.getTime() <= now.getTime();
    if (expired ? daysBetween(expiryDay, today) > EXPIRED_NOTICE_DAYS : expiryDay > addDays(today, club.invitationLeadDays)) continue;
    out.push({
      kind: expired ? "invite_expired" : "invite_expiring",
      refId: row.id,
      date: expiryDay,
      clubId: row.clubId,
      title: expired ? `Einladung abgelaufen: ${row.name}` : `Einladung läuft ab: ${row.name}`,
      body: expired
        ? `Die Einladung zu MyVerein für ${row.name} wurde nicht angenommen und ist am ${dateDe(expiryDay)} abgelaufen.\nDu kannst unter Verein, Mitglieder, Konto eine neue Einladung senden.`
        : `Die Einladung zu MyVerein für ${row.name} wurde noch nicht angenommen und läuft am ${dateDe(expiryDay)} ab.\nDu kannst unter Verein, Mitglieder, Konto die Einladung erneut senden oder die Person daran erinnern.`,
      audience: { roleTypes: roleTypesWithPermission("members:write"), includeGuardians: false },
    });
  }
  return out;
}

/**
 * Credentials (G6; custom fields of type `credential` with a `validUntil`, see `credentials.ts`): the holder is reminded once
 * when the credential is `expiring` (valid through `validUntil`, within `credentialLeadDays`), and once more when it ran out
 * (`credential_expired`, up to `EXPIRED_NOTICE_DAYS` after). Guardians are included only where a guardian may read the field
 * at all (`canGuardianRead`); **sensitive fields never trigger a reminder** (the message names the credential, so the mail would
 * leak it to a shared address). Archived definitions and members who left are skipped. The key is the value row plus the
 * `validUntil` day, so renewing the credential (a new date) starts a new cycle.
 */
export async function collectCredentialReminders(clubs: Map<string, ReminderClub>, now: Date): Promise<DueReminder[]> {
  const rows = await db
    .select({ id: memberFieldValues.id, value: memberFieldValues.value, label: memberFieldDefinitions.label, visibleTo: memberFieldDefinitions.visibleTo, editableBy: memberFieldDefinitions.editableBy, clubMemberId: clubMembers.id, name: clubMembers.displayName, clubId: clubMembers.clubId, status: clubMembers.status, leftAt: clubMembers.leftAt })
    .from(memberFieldValues)
    .innerJoin(memberFieldDefinitions, eq(memberFieldDefinitions.id, memberFieldValues.fieldId))
    .innerJoin(clubMembers, eq(clubMembers.id, memberFieldValues.clubMemberId))
    .where(and(eq(memberFieldDefinitions.fieldType, "credential"), eq(memberFieldDefinitions.sensitive, false), isNull(memberFieldDefinitions.archivedAt), sql`${memberFieldValues.value}->>'validUntil' IS NOT NULL`));
  const out: DueReminder[] = [];
  for (const row of rows) {
    const club = clubs.get(row.clubId);
    if (!club?.credentialEnabled || !isDigestTime(now, club.timezone)) continue;
    const today = localDate(now, club.timezone);
    if (isLeftStatus(effectiveStatus({ status: row.status, leftAt: row.leftAt }, today))) continue;
    const expiry = credentialExpiry(row.value, today, club.credentialLeadDays);
    if (expiry.validUntil === null || expiry.daysLeft === null) continue;
    const expired = expiry.status === "expired";
    if (expired ? expiry.daysLeft < -EXPIRED_NOTICE_DAYS : expiry.status !== "expiring") continue;
    const guardians = canGuardianRead({ visibleTo: row.visibleTo, editableBy: row.editableBy, sensitive: false, archivedAt: null });
    out.push({
      kind: expired ? "credential_expired" : "credential_expiring",
      refId: row.id,
      date: expiry.validUntil,
      clubId: row.clubId,
      title: expired ? `Qualifikation abgelaufen: ${row.label}` : `Qualifikation läuft ab: ${row.label}`,
      body: expired
        ? `Die Qualifikation „${row.label}“ von ${row.name} war nur bis zum ${dateDe(expiry.validUntil)} gültig und ist abgelaufen.\nBitte erneuern und im Profil aktualisieren.`
        : `Die Qualifikation „${row.label}“ von ${row.name} ist noch bis zum ${dateDe(expiry.validUntil)} gültig.\nBitte rechtzeitig erneuern und im Profil aktualisieren.`,
      audience: { memberIds: [row.clubMemberId], includeGuardians: guardians },
    });
  }
  return out;
}

/** One sweep: schedules every reminder that is due and not yet scheduled. Safe to run any number of times. */
export async function runReminderSweep(now: Date = new Date(), scope: { clubId?: string } = {}): Promise<ReminderSweepResult> {
  const clubs = await loadClubs(scope.clubId);
  const due = [
    ...(await collectEventReminders(clubs, now)),
    ...(await collectLoanReminders(clubs, now)),
    ...(await collectMaintenanceReminders(clubs, now)),
    ...(await collectRsvpReminders(clubs, now)),
    ...(await collectInvitationReminders(clubs, now)),
    ...(await collectCredentialReminders(clubs, now)),
  ];
  const result: ReminderSweepResult = { scheduled: 0, alreadyScheduled: 0 };
  for (const r of due) {
    const payload: ReminderPayload = { clubId: r.clubId, kind: r.kind, refId: r.refId, date: r.date, title: r.title, body: r.body, audience: r.audience };
    const { created } = await enqueue({ type: REMINDER_JOB_TYPE, payload, dedupeKey: reminderDedupeKey(r.kind, r.refId, r.date) });
    if (created) result.scheduled += 1;
    else result.alreadyScheduled += 1;
  }
  if (result.scheduled > 0) logger.info({ ...result, digestHour: digestHour() }, "[reminders] sweep scheduled reminders");
  return result;
}

export async function handleReminderSweep(_job: JobContext): Promise<void> {
  await runReminderSweep();
}

/** Job handler `notify_reminder`: dispatches one prepared reminder (the dispatcher skips opted-out and no longer reachable members). */
export async function handleReminder(job: JobContext): Promise<void> {
  const p = job.payload as Partial<ReminderPayload>;
  if (!p.clubId || !p.kind || !p.refId || !p.audience || typeof p.title !== "string" || typeof p.body !== "string") return;
  try {
    await notify({
      clubId: p.clubId,
      class: "optional",
      eventKey: `reminder.${p.kind}`,
      // The date makes a legitimately repeating reminder (overdue steps, daily digests) a new delivery, a re-run the same one.
      refId: `${p.refId}#${p.date ?? ""}`,
      audience: p.audience,
      // The age-transition summary is a leadership digest: its own switchable category, not tied to personal reminders.
      content: { title: p.title, body: p.body, template: "reminder", category: p.kind === "age_transition" ? BOARD_CATEGORY : "reminders" },
      channels: PUSH_REMINDER_KINDS.includes(p.kind) ? ["in_app", "email", "push"] : ["in_app", "email"],
    });
  } catch (err) {
    if (err instanceof AudienceLimitError) {
      logger.error({ kind: p.kind, refId: p.refId }, "[reminders] audience too large, reminder dropped");
      return;
    }
    throw err;
  }
}
