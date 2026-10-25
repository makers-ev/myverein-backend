import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { eventAttendance, eventAttendanceSheets } from "../db/schema/event-attendance.js";
import { events } from "../db/schema/events.js";
import { clubTimezone } from "./event-notify.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Attendance report (Wave 12 B12). Only events WITH an attendance list count (an event nobody recorded says nothing); people who
 * are on the roster but have no status are not counted either. `rate` = present / (present + excused + unexcused).
 */

export interface Counts {
  present: number;
  excused: number;
  unexcused: number;
  recorded: number;
  rate: number | null;
}

export function withRate(c: { present: number; excused: number; unexcused: number }): Counts {
  const recorded = c.present + c.excused + c.unexcused;
  return { ...c, recorded, rate: recorded === 0 ? null : Math.round((c.present / recorded) * 1000) / 1000 };
}

export interface ReportScope {
  /** Restrict to events of calendars of these departments; null = the whole club. */
  departmentIds: string[] | null;
  from: string;
  to: string;
}

const counted = (status: "anwesend" | "entschuldigt" | "unentschuldigt") => sql<number>`count(*) filter (where ${eventAttendance.status} = ${status})::int`;

/** Condition shared by all report queries: club, not cancelled, local start day in range, department filter. */
async function eventFilter(clubId: string, scope: ReportScope): Promise<SQL> {
  const tz = await clubTimezone(clubId);
  const localDay = sql`((${events.startsAt} AT TIME ZONE ${tz})::date)`;
  const parts: Array<SQL | undefined> = [
    eq(calendars.clubId, clubId),
    isNull(events.cancelledAt),
    sql`${localDay} >= ${scope.from}::date`,
    sql`${localDay} <= ${scope.to}::date`,
    scope.departmentIds === null ? undefined : scope.departmentIds.length === 0 ? sql`false` : inArray(calendars.departmentId, scope.departmentIds),
  ];
  return and(...parts)!;
}

export interface MemberRow extends Counts {
  clubMemberId: string;
  displayName: string;
}

/** One row per club member with at least one recorded entry in scope, plus (optionally) the listed department members with zeros. */
export async function reportByMember(clubId: string, scope: ReportScope, rosterDepartmentIds: string[] = []): Promise<MemberRow[]> {
  const where = await eventFilter(clubId, scope);
  const rows = await db
    .select({ id: eventAttendance.clubMemberId, name: clubMembers.displayName, present: counted("anwesend"), excused: counted("entschuldigt"), unexcused: counted("unentschuldigt") })
    .from(eventAttendance)
    .innerJoin(eventAttendanceSheets, eq(eventAttendanceSheets.id, eventAttendance.sheetId))
    .innerJoin(events, eq(events.id, eventAttendanceSheets.eventId))
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .innerJoin(clubMembers, eq(clubMembers.id, eventAttendance.clubMemberId))
    .where(where)
    .groupBy(eventAttendance.clubMemberId, clubMembers.displayName)
    .orderBy(asc(clubMembers.displayName))
    .limit(5000);
  const out = new Map<string, MemberRow>(rows.map((r) => [r.id!, { clubMemberId: r.id!, displayName: r.name, ...withRate(r) }]));
  if (rosterDepartmentIds.length > 0) {
    const today = todayBerlin();
    const roster = await db
      .select({ id: clubMembers.id, name: clubMembers.displayName, status: clubMembers.status, leftAt: clubMembers.leftAt })
      .from(clubMemberDepartments)
      .innerJoin(clubMembers, eq(clubMembers.id, clubMemberDepartments.clubMemberId))
      .where(and(eq(clubMembers.clubId, clubId), inArray(clubMemberDepartments.departmentId, rosterDepartmentIds), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, today)), lte(clubMemberDepartments.since, today)));
    for (const m of roster) if (!out.has(m.id) && !isLeftStatus(effectiveStatus(m, today))) out.set(m.id, { clubMemberId: m.id, displayName: m.name, ...withRate({ present: 0, excused: 0, unexcused: 0 }) });
  }
  return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "de"));
}

export interface EventReportRow extends Counts {
  eventId: string;
  title: string;
  startsAt: Date;
  closed: boolean;
  departmentId: string | null;
  guests: number;
}

/** One row per event with a list in scope (guests of the list are counted as `guests`, not in the rate). */
export async function reportByEvent(clubId: string, scope: ReportScope): Promise<EventReportRow[]> {
  const where = await eventFilter(clubId, scope);
  const rows = await db
    .select({
      id: events.id,
      title: events.title,
      startsAt: events.startsAt,
      closedAt: eventAttendanceSheets.closedAt,
      departmentId: calendars.departmentId,
      present: sql<number>`count(*) filter (where ${eventAttendance.status} = 'anwesend' and ${eventAttendance.clubMemberId} is not null)::int`,
      excused: sql<number>`count(*) filter (where ${eventAttendance.status} = 'entschuldigt' and ${eventAttendance.clubMemberId} is not null)::int`,
      unexcused: sql<number>`count(*) filter (where ${eventAttendance.status} = 'unentschuldigt' and ${eventAttendance.clubMemberId} is not null)::int`,
      guests: sql<number>`count(*) filter (where ${eventAttendance.clubMemberId} is null)::int`,
    })
    .from(eventAttendanceSheets)
    .innerJoin(events, eq(events.id, eventAttendanceSheets.eventId))
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .leftJoin(eventAttendance, eq(eventAttendance.sheetId, eventAttendanceSheets.id))
    .where(where)
    .groupBy(events.id, events.title, events.startsAt, eventAttendanceSheets.closedAt, calendars.departmentId)
    .orderBy(asc(events.startsAt))
    .limit(2000);
  return rows.map((r) => ({ eventId: r.id, title: r.title, startsAt: r.startsAt, closed: r.closedAt !== null, departmentId: r.departmentId, guests: r.guests, ...withRate(r) }));
}

export interface MemberEntry {
  eventId: string;
  title: string;
  startsAt: Date;
  departmentId: string | null;
  status: string;
}

/** All recorded entries of one member in scope, oldest first. */
export async function entriesOfMember(clubId: string, clubMemberId: string, scope: ReportScope): Promise<MemberEntry[]> {
  const where = await eventFilter(clubId, scope);
  return db
    .select({ eventId: events.id, title: events.title, startsAt: events.startsAt, departmentId: calendars.departmentId, status: eventAttendance.status })
    .from(eventAttendance)
    .innerJoin(eventAttendanceSheets, eq(eventAttendanceSheets.id, eventAttendance.sheetId))
    .innerJoin(events, eq(events.id, eventAttendanceSheets.eventId))
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(where, eq(eventAttendance.clubMemberId, clubMemberId)))
    .orderBy(asc(events.startsAt))
    .limit(2000);
}
