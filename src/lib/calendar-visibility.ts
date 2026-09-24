import { eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { calendarVisibility, type CalendarVisibilityRow } from "../db/schema/calendar-visibility.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { hasClubPermission } from "./club-permissions.js";

/**
 * Calendar visibility algorithm, shared by calendars.ts (visibility config)
 * and events.ts (event filtering) -- see Data Model - MyVerein Backend §7.
 * A caller can see calendar X if ANY of:
 *  1. X has zero calendar_visibility rows at all (club-wide default).
 *  2. A row grants `memberId` = the caller's own membership id.
 *  3. A row grants `roleType` matching any club_roles the caller holds.
 *  4. A row grants `departmentId` matching a department the caller holds a
 *     department-scoped club_roles row for (abteilungsleitung/trainer).
 *
 * Rule 4 is the only existing signal for "member belongs to a department" --
 * there is no generic department-membership table. A rank-and-file member
 * with no department-scoped role can never match rule 4, only rules 1-3.
 * That's a real, documented limitation, not an oversight.
 *
 * Callers with calendars:write see every calendar (they manage the grants).
 */

async function callerDepartmentIds(memberId: string): Promise<Set<string>> {
  const rows = await db.query.clubRoles.findMany({ where: eq(clubRoles.memberId, memberId) });
  return new Set(rows.map((r) => r.departmentId).filter((id): id is string => id !== null));
}

function grantAllows(
  grant: CalendarVisibilityRow,
  memberId: string,
  clubRoleTypes: readonly string[],
  callerDepartments: Set<string>,
): boolean {
  if (grant.memberId !== null && grant.memberId === memberId) return true;
  if (grant.roleType !== null && clubRoleTypes.includes(grant.roleType)) return true;
  if (grant.departmentId !== null && callerDepartments.has(grant.departmentId)) return true;
  return false;
}

/** Whether `calendarId` is visible to the caller. Does not check club scoping -- callers verify that separately. */
export async function isCalendarVisible(calendarId: string, memberId: string, clubRoleTypes: readonly string[]): Promise<boolean> {
  if (hasClubPermission(clubRoleTypes, "calendars:write")) return true;
  const grants = await db.query.calendarVisibility.findMany({ where: eq(calendarVisibility.calendarId, calendarId) });
  if (grants.length === 0) return true; // rule 1

  const callerDepartments = await callerDepartmentIds(memberId);
  return grants.some((g) => grantAllows(g, memberId, clubRoleTypes, callerDepartments));
}

/** All calendar ids in `clubId` visible to the caller. */
export async function getVisibleCalendarIds(clubId: string, memberId: string, clubRoleTypes: readonly string[]): Promise<string[]> {
  const clubCalendars = await db.query.calendars.findMany({ where: eq(calendars.clubId, clubId) });
  if (clubCalendars.length === 0) return [];
  if (hasClubPermission(clubRoleTypes, "calendars:write")) return clubCalendars.map((cal) => cal.id);

  const grants = await db.query.calendarVisibility.findMany({
    where: inArray(calendarVisibility.calendarId, clubCalendars.map((cal) => cal.id)),
  });
  const grantsByCalendar = new Map<string, CalendarVisibilityRow[]>();
  for (const g of grants) {
    const list = grantsByCalendar.get(g.calendarId) ?? [];
    list.push(g);
    grantsByCalendar.set(g.calendarId, list);
  }

  const callerDepartments = await callerDepartmentIds(memberId);

  return clubCalendars
    .filter((cal) => {
      const rows = grantsByCalendar.get(cal.id);
      if (!rows || rows.length === 0) return true; // rule 1
      return rows.some((g) => grantAllows(g, memberId, clubRoleTypes, callerDepartments));
    })
    .map((cal) => cal.id);
}
