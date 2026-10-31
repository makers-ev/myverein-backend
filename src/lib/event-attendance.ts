import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { absenceReports, wardEventResponses } from "../db/schema/absences.js";
import type { CalendarRow } from "../db/schema/calendars.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import {
  ATTENDANCE_STATUSES,
  eventAttendance,
  eventAttendanceCorrections,
  eventAttendanceSheets,
  eventAttendanceSupervisors,
  type AttendanceStatus,
  type EventAttendanceSheetRow,
} from "../db/schema/event-attendance.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import type { EventRow } from "../db/schema/events.js";
import type { DbExecutor } from "./club-members.js";
import { clubTimezone } from "./event-notify.js";
import { ageOn, effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Attendance lists of events (Wave 12 B10/B11). One sheet per event; the roster (Soll-Liste) is computed on read from the
 * members of the calendar's department, the confirmed RSVPs (accounts, members without account answered by a guardian or the
 * board, and guardians' ward responses) and the people added by hand. Only a status is stored per person -- never a reason
 * (privacy): an absence report of Wave 10 merely pre-fills `entschuldigt`; its kind and note never reach the list.
 */

export { ATTENDANCE_STATUSES };

/** Minors are people younger than this on the day of the event. */
export const ADULT_AGE = 18;

const localDay = (date: Date, timezone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

/** First and last local day of an event in the club's time zone. */
export async function eventLocalDays(clubId: string, event: Pick<EventRow, "startsAt" | "endsAt">): Promise<{ from: string; to: string }> {
  const tz = await clubTimezone(clubId);
  return { from: localDay(event.startsAt, tz), to: localDay(event.endsAt ?? event.startsAt, tz) };
}

/** Members of `ids` with a not withdrawn absence report overlapping [from, to]. Returns ids only, never kind or note. */
export async function absentMemberIds(clubId: string, ids: string[], from: string, to: string, executor: DbExecutor = db): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await executor
    .select({ id: absenceReports.clubMemberId })
    .from(absenceReports)
    .where(and(eq(absenceReports.clubId, clubId), inArray(absenceReports.clubMemberId, ids), isNull(absenceReports.withdrawnAt), lte(absenceReports.startsOn, to), gte(absenceReports.endsOn, from)));
  return new Set(rows.map((r) => r.id));
}

export interface AttendanceEntryView {
  key: string;
  attendanceId: string | null;
  clubMemberId: string | null;
  guestName: string | null;
  displayName: string;
  status: AttendanceStatus | null;
  source: string | null;
  /** Pre-filled from an absence report, not stored yet (the report itself is never shown). */
  prefilled: boolean;
  rsvp: "angemeldet" | "warteliste" | null;
  /** Part of the department / RSVP roster (false = added by hand). */
  onRoster: boolean;
  isMinor: boolean;
  hasAccount: boolean;
}

export interface AttendanceView {
  eventId: string;
  tracking: boolean;
  closed: boolean;
  closedAt: Date | null;
  supervisors: Array<{ clubMemberId: string; displayName: string }>;
  entries: AttendanceEntryView[];
  summary: { anwesend: number; entschuldigt: number; unentschuldigt: number; offen: number };
  /** Minors are present and nobody is entered as supervisor (an aid, not a legal statement). */
  supervisionWarning: boolean;
  minorsPresent: number;
  corrections: Array<{ displayName: string | null; oldStatus: string | null; newStatus: string | null; reason: string; changedAt: Date }>;
}

/** Club members on the roster of an event: department members, confirmed RSVPs (any identity) and ward responses. */
export async function rosterMemberIds(clubId: string, event: Pick<EventRow, "id">, calendar: Pick<CalendarRow, "departmentId">, day: string, executor: DbExecutor = db): Promise<{ ids: Set<string>; rsvp: Map<string, "angemeldet" | "warteliste"> }> {
  const ids = new Set<string>();
  const rsvp = new Map<string, "angemeldet" | "warteliste">();
  if (calendar.departmentId) {
    const rows = await executor
      .select({ id: clubMemberDepartments.clubMemberId })
      .from(clubMemberDepartments)
      .innerJoin(clubMembers, eq(clubMembers.id, clubMemberDepartments.clubMemberId))
      .where(and(eq(clubMemberDepartments.departmentId, calendar.departmentId), eq(clubMembers.clubId, clubId), lte(clubMemberDepartments.since, day), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, day))));
    for (const r of rows) ids.add(r.id);
  }
  const attendees = await executor
    .select({ clubMemberId: eventAttendees.clubMemberId, accountClubMemberId: clubMembers.id, status: eventAttendees.status })
    .from(eventAttendees)
    .leftJoin(clubMembers, and(eq(clubMembers.memberId, eventAttendees.memberId), eq(clubMembers.clubId, clubId)))
    .where(and(eq(eventAttendees.eventId, event.id), inArray(eventAttendees.status, ["angemeldet", "warteliste"])));
  const wards = await executor.select({ id: wardEventResponses.wardClubMemberId, status: wardEventResponses.status }).from(wardEventResponses).where(and(eq(wardEventResponses.eventId, event.id), inArray(wardEventResponses.status, ["angemeldet", "warteliste"])));
  for (const a of [...attendees.map((r) => ({ id: r.clubMemberId ?? r.accountClubMemberId, status: r.status })), ...wards]) {
    if (!a.id) continue;
    if (a.status === "angemeldet" || a.status === "warteliste") {
      rsvp.set(a.id, a.status);
      // Only confirmed seats join the roster; the waitlist is shown as such for people already on it.
      if (a.status === "angemeldet") ids.add(a.id);
    }
  }
  return { ids, rsvp };
}

/** The attendance sheet of an event, if one exists. */
export async function findSheet(eventId: string, executor: DbExecutor = db): Promise<EventAttendanceSheetRow | null> {
  const [row] = await executor.select().from(eventAttendanceSheets).where(eq(eventAttendanceSheets.eventId, eventId));
  return row ?? null;
}

/** Composes the list shown to the person recording attendance. Read only: a missing sheet is not created. */
export async function buildAttendanceView(clubId: string, event: EventRow, calendar: CalendarRow): Promise<AttendanceView> {
  const { from, to } = await eventLocalDays(clubId, event);
  const sheet = await findSheet(event.id);
  const stored = sheet
    ? await db
        .select({ row: eventAttendance, displayName: clubMembers.displayName, birthDate: clubMembers.birthDate, memberId: clubMembers.memberId })
        .from(eventAttendance)
        .leftJoin(clubMembers, eq(clubMembers.id, eventAttendance.clubMemberId))
        .where(eq(eventAttendance.sheetId, sheet.id))
    : [];
  const { ids: rosterIds, rsvp } = await rosterMemberIds(clubId, event, calendar, from);
  const storedIds = new Set(stored.flatMap((s) => (s.row.clubMemberId ? [s.row.clubMemberId] : [])));
  const openIds = [...rosterIds].filter((id) => !storedIds.has(id));
  const members = openIds.length
    ? await db.select({ id: clubMembers.id, displayName: clubMembers.displayName, birthDate: clubMembers.birthDate, memberId: clubMembers.memberId, status: clubMembers.status, leftAt: clubMembers.leftAt }).from(clubMembers).where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.id, openIds)))
    : [];
  const today = todayBerlin();
  const active = members.filter((m) => !isLeftStatus(effectiveStatus(m, today)));
  const absent = await absentMemberIds(clubId, active.map((m) => m.id), from, to);
  const isMinor = (birthDate: string | null): boolean => birthDate !== null && ageOn(birthDate, from) < ADULT_AGE;

  const entries: AttendanceEntryView[] = [
    ...stored.map((s): AttendanceEntryView => ({
      key: s.row.clubMemberId ? `m:${s.row.clubMemberId}` : `g:${s.row.id}`,
      attendanceId: s.row.id,
      clubMemberId: s.row.clubMemberId,
      guestName: s.row.guestName,
      displayName: s.displayName ?? s.row.guestName ?? "",
      status: s.row.status as AttendanceStatus,
      source: s.row.source,
      prefilled: false,
      rsvp: s.row.clubMemberId ? (rsvp.get(s.row.clubMemberId) ?? null) : null,
      onRoster: s.row.clubMemberId ? rosterIds.has(s.row.clubMemberId) : false,
      isMinor: isMinor(s.birthDate),
      hasAccount: s.memberId !== null,
    })),
    ...active.map((m): AttendanceEntryView => {
      const prefilled = absent.has(m.id);
      return {
        key: `m:${m.id}`,
        attendanceId: null,
        clubMemberId: m.id,
        guestName: null,
        displayName: m.displayName,
        status: prefilled ? "entschuldigt" : null,
        source: prefilled ? "meldung" : null,
        prefilled,
        rsvp: rsvp.get(m.id) ?? null,
        onRoster: true,
        isMinor: isMinor(m.birthDate),
        hasAccount: m.memberId !== null,
      };
    }),
  ].sort((a, b) => a.displayName.localeCompare(b.displayName, "de") || a.key.localeCompare(b.key));

  const supervisors = sheet
    ? await db
        .select({ clubMemberId: eventAttendanceSupervisors.clubMemberId, displayName: clubMembers.displayName })
        .from(eventAttendanceSupervisors)
        .innerJoin(clubMembers, eq(clubMembers.id, eventAttendanceSupervisors.clubMemberId))
        .where(eq(eventAttendanceSupervisors.sheetId, sheet.id))
        .orderBy(asc(clubMembers.displayName))
    : [];
  const corrections = sheet
    ? await db
        .select({ displayName: clubMembers.displayName, oldStatus: eventAttendanceCorrections.oldStatus, newStatus: eventAttendanceCorrections.newStatus, reason: eventAttendanceCorrections.reason, changedAt: eventAttendanceCorrections.changedAt })
        .from(eventAttendanceCorrections)
        .leftJoin(clubMembers, eq(clubMembers.id, eventAttendanceCorrections.clubMemberId))
        .where(eq(eventAttendanceCorrections.sheetId, sheet.id))
        .orderBy(asc(eventAttendanceCorrections.changedAt))
        .limit(100)
    : [];

  const summary = { anwesend: 0, entschuldigt: 0, unentschuldigt: 0, offen: 0 };
  for (const e of entries) summary[e.status ?? "offen"] += 1;
  const minorsPresent = entries.filter((e) => e.status === "anwesend" && e.isMinor).length;
  return {
    eventId: event.id,
    tracking: event.attendanceTracking,
    closed: sheet?.closedAt != null,
    closedAt: sheet?.closedAt ?? null,
    supervisors,
    entries,
    summary,
    supervisionWarning: minorsPresent > 0 && supervisors.length === 0,
    minorsPresent,
    corrections,
  };
}
