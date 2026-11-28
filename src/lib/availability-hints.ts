import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { wardEventResponses } from "../db/schema/absences.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import type { CalendarRow } from "../db/schema/calendars.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { windowAvailability, type AvailabilityInput, type WindowAvailability } from "./availability-match.js";
import { DEPARTMENT_SCOPED_ROLES } from "./event-access.js";
import { clubTimezone } from "./event-notify.js";
import { wallClock } from "./helper-suggestions.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * "Wer hat Zeit?" for planning a calendar event (Wave 16 T6). A HINT only -- it never blocks saving and has no ranking. For the expected
 * participants of a calendar (department members of a department calendar; the people the visibility grants of a restricted calendar
 * point at; otherwise all active members) plus the RSVPs of an existing event, the weekly pattern (`availability_slots`) and the
 * exceptions/holidays (`availability_exceptions`) are matched in the club time zone. People without an account, and accounts without any
 * relevant entry, are `unbekannt` -- never "not available". Notes of slots/exceptions are never read; absence/sick reports are not used
 * (health data, other permission). Batch queries only (a handful per call, independent of the group size), capped at `MAX_POOL`.
 */

export const MAX_POOL = 500;
/** Longest window that is evaluated (multi-day events, camps). */
export const MAX_WINDOW_DAYS = 14;

export type HintPool = "department" | "calendar_grants" | "club";

export interface AvailabilityHints {
  timezone: string;
  pool: HintPool;
  counts: { total: number; verfuegbar: number; nicht_verfuegbar: number; unbekannt: number };
  /** Ordered by name; only computed when the caller may see names. */
  unavailablePeople: Array<{ clubMemberId: string; displayName: string }>;
  truncated: boolean;
}

interface PoolRow {
  id: string;
  name: string;
  memberId: string | null;
  status: string;
  leftAt: string | null;
}

const poolColumns = { id: clubMembers.id, name: clubMembers.displayName, memberId: clubMembers.memberId, status: clubMembers.status, leftAt: clubMembers.leftAt };

/** Club members currently in one of the departments. */
async function departmentMembers(clubId: string, departmentIds: string[], today: string): Promise<PoolRow[]> {
  if (departmentIds.length === 0) return [];
  return db
    .selectDistinct(poolColumns)
    .from(clubMemberDepartments)
    .innerJoin(clubMembers, eq(clubMembers.id, clubMemberDepartments.clubMemberId))
    .where(and(eq(clubMembers.clubId, clubId), inArray(clubMemberDepartments.departmentId, departmentIds), lte(clubMemberDepartments.since, today), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, today))))
    .limit(MAX_POOL * 2);
}

/** The expected participants of a calendar (see the module comment), before the left/interessent filter. */
async function calendarPool(clubId: string, calendar: Pick<CalendarRow, "id" | "departmentId">, today: string): Promise<{ pool: HintPool; rows: PoolRow[] }> {
  if (calendar.departmentId) return { pool: "department", rows: await departmentMembers(clubId, [calendar.departmentId], today) };
  const grants = await db.select().from(calendarVisibility).where(eq(calendarVisibility.calendarId, calendar.id));
  if (grants.length === 0) return { pool: "club", rows: await db.select(poolColumns).from(clubMembers).where(eq(clubMembers.clubId, clubId)).orderBy(asc(clubMembers.displayName)).limit(MAX_POOL * 2) };

  const accountIds = new Set(grants.flatMap((g) => (g.memberId ? [g.memberId] : [])));
  const roleTypes = [...new Set(grants.flatMap((g) => (g.roleType ? [g.roleType] : [])))];
  const departmentIds = [...new Set(grants.flatMap((g) => (g.departmentId ? [g.departmentId] : [])))];
  const rows: PoolRow[] = [];
  // Role grants: holders of the role (still in term); `mitglied` is the implicit role of every member with an account.
  const explicitRoles = roleTypes.filter((r) => r !== "mitglied");
  if (explicitRoles.length > 0) {
    const holders = await db.select({ memberId: clubRoles.memberId }).from(clubRoles).where(and(inArray(clubRoles.roleType, explicitRoles), or(isNull(clubRoles.termEndsAt), gte(clubRoles.termEndsAt, today))));
    for (const h of holders) accountIds.add(h.memberId);
  }
  // Department grants: department members, and (as the visibility rule does) holders of a department-scoped role of that department.
  if (departmentIds.length > 0) {
    rows.push(...(await departmentMembers(clubId, departmentIds, today)));
    const leads = await db.select({ memberId: clubRoles.memberId }).from(clubRoles).where(and(inArray(clubRoles.departmentId, departmentIds), inArray(clubRoles.roleType, [...DEPARTMENT_SCOPED_ROLES])));
    for (const l of leads) accountIds.add(l.memberId);
  }
  if (roleTypes.includes("mitglied")) rows.push(...(await db.select(poolColumns).from(clubMembers).where(and(eq(clubMembers.clubId, clubId), isNotNull(clubMembers.memberId))).limit(MAX_POOL * 2)));
  else if (accountIds.size > 0) rows.push(...(await db.select(poolColumns).from(clubMembers).where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.memberId, [...accountIds]))).limit(MAX_POOL * 2)));
  return { pool: "calendar_grants", rows };
}

/** People with a confirmed RSVP of the event (account RSVPs and guardians' answers for wards). */
async function rsvpPool(clubId: string, eventId: string): Promise<PoolRow[]> {
  const attendees = await db.select({ clubMemberId: eventAttendees.clubMemberId, memberId: eventAttendees.memberId }).from(eventAttendees).where(and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.status, "angemeldet")));
  const wards = await db.select({ id: wardEventResponses.wardClubMemberId }).from(wardEventResponses).where(and(eq(wardEventResponses.eventId, eventId), eq(wardEventResponses.status, "angemeldet")));
  const ids = [...new Set([...attendees.flatMap((a) => (a.clubMemberId ? [a.clubMemberId] : [])), ...wards.map((w) => w.id)])];
  const accounts = [...new Set(attendees.flatMap((a) => (!a.clubMemberId && a.memberId ? [a.memberId] : [])))];
  if (ids.length === 0 && accounts.length === 0) return [];
  const match = ids.length > 0 && accounts.length > 0 ? or(inArray(clubMembers.id, ids), inArray(clubMembers.memberId, accounts)) : ids.length > 0 ? inArray(clubMembers.id, ids) : inArray(clubMembers.memberId, accounts);
  return db.select(poolColumns).from(clubMembers).where(and(eq(clubMembers.clubId, clubId), match)).limit(MAX_POOL * 2);
}

export async function availabilityHints(clubId: string, calendar: Pick<CalendarRow, "id" | "departmentId">, window: { startsAt: Date; endsAt: Date | null; eventId: string | null }, withNames: boolean): Promise<AvailabilityHints> {
  const today = todayBerlin();
  const { pool, rows } = await calendarPool(clubId, calendar, today);
  if (window.eventId) rows.push(...(await rsvpPool(clubId, window.eventId)));
  const unique = new Map<string, PoolRow>();
  for (const r of rows) unique.set(r.id, r);
  const active = [...unique.values()].filter((p) => !isLeftStatus(effectiveStatus(p, today)) && p.status !== "interessent").sort((a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id));
  const truncated = active.length > MAX_POOL || rows.length >= MAX_POOL * 2;
  const people = active.slice(0, MAX_POOL);

  const accounts = [...new Set(people.flatMap((p) => (p.memberId ? [p.memberId] : [])))];
  // Only the columns needed for matching -- never `note`.
  const slots = accounts.length ? await db.select({ memberId: availabilitySlots.memberId, weekday: availabilitySlots.weekday, startTime: availabilitySlots.startTime, endTime: availabilitySlots.endTime }).from(availabilitySlots).where(inArray(availabilitySlots.memberId, accounts)) : [];
  const exceptions = accounts.length ? await db.select({ memberId: availabilityExceptions.memberId, date: availabilityExceptions.date, isAvailable: availabilityExceptions.isAvailable }).from(availabilityExceptions).where(inArray(availabilityExceptions.memberId, accounts)) : [];
  const inputs = new Map<string, AvailabilityInput>();
  for (const a of accounts) inputs.set(a, { memberId: a, slots: [], exceptions: [] });
  for (const s of slots) inputs.get(s.memberId)?.slots.push({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime });
  for (const e of exceptions) inputs.get(e.memberId)?.exceptions.push({ date: e.date, isAvailable: e.isAvailable });

  const timezone = await clubTimezone(clubId);
  const start = wallClock(window.startsAt, timezone);
  const end = window.endsAt ? wallClock(new Date(Math.max(window.startsAt.getTime(), window.endsAt.getTime() - 60_000)), timezone) : start;
  const counts = { total: people.length, verfuegbar: 0, nicht_verfuegbar: 0, unbekannt: 0 };
  const unavailablePeople: AvailabilityHints["unavailablePeople"] = [];
  for (const p of people) {
    const input = p.memberId ? inputs.get(p.memberId) : undefined;
    const status: WindowAvailability = input ? windowAvailability(start, end, input) : "unbekannt";
    counts[status] += 1;
    if (withNames && status === "nicht_verfuegbar") unavailablePeople.push({ clubMemberId: p.id, displayName: p.name });
  }
  return { timezone, pool, counts, unavailablePeople, truncated };
}
