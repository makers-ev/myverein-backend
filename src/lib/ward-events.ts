import { and, eq, inArray, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import type { ClubMemberRow } from "../db/schema/club-members.js";
import { departmentIdsOf } from "./absences.js";

/**
 * Events of a ward for a guardian (Wave 10 B4). A ward without an account has no `member`, so the calendar visibility
 * algorithm (which starts from a membership) cannot apply; the rule here is deliberately narrower than "the club calendar":
 * a calendar is visible for the ward if it is a calendar of one of the ward's departments, or has an explicit visibility
 * grant for one of those departments (or for the ward's own account). Calendars without grants (club-wide default) and
 * role grants such as `mitglied` do NOT reach a guardian.
 */
export async function wardCalendarIds(ward: ClubMemberRow): Promise<string[]> {
  const departments = await departmentIdsOf(ward.id);
  const conditions = [departments.length > 0 ? inArray(calendarVisibility.departmentId, departments) : undefined, ward.memberId ? eq(calendarVisibility.memberId, ward.memberId) : undefined].filter((c) => c !== undefined);
  const viaGrant = conditions.length === 0 ? [] : await db.select({ id: calendarVisibility.calendarId }).from(calendarVisibility).innerJoin(calendars, eq(calendars.id, calendarVisibility.calendarId)).where(and(eq(calendars.clubId, ward.clubId), or(...conditions)));
  const own = departments.length > 0 ? await db.select({ id: calendars.id }).from(calendars).where(and(eq(calendars.clubId, ward.clubId), inArray(calendars.departmentId, departments))) : [];
  return [...new Set([...viaGrant, ...own].map((r) => r.id))];
}
