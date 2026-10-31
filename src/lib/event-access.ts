import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

import { db } from "../db/client.js";
import { calendars, type CalendarRow } from "../db/schema/calendars.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { events, type EventRow } from "../db/schema/events.js";
import { isCalendarVisible } from "./calendar-visibility.js";
import { hasClubPermission, type ClubPermission } from "./club-permissions.js";
import { ForbiddenError, NotFoundError } from "./errors.js";
import { todayBerlin } from "./member-lifecycle.js";
import { isUuid } from "./club-members.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Access to the events of a club (Wave 12). Reading follows the calendar visibility; the management permissions of
 * attendance, registrations and helper plans are club-wide for the board roles and, for `trainer` / `abteilungsleitung`,
 * limited to events of calendars of their OWN departments (the department comes from the department-bound `club_roles` row).
 */

/** Loads an event and 404s unless its calendar belongs to `clubId` AND is visible to the caller. Never leaks an invisible calendar's events. */
export async function loadVisibleEvent(id: string, clubId: string, memberId: string, clubRoleTypes: readonly string[]): Promise<{ event: EventRow; calendar: CalendarRow }> {
  if (!isUuid(id)) throw new NotFoundError("Event not found");
  const row = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!row) throw new NotFoundError("Event not found");

  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, row.calendarId), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Event not found");

  if (!(await isCalendarVisible(calendar.id, memberId, clubRoleTypes))) {
    throw new NotFoundError("Event not found");
  }

  return { event: row, calendar };
}

/** Roles whose permissions only reach their own departments. */
export const DEPARTMENT_SCOPED_ROLES = ["trainer", "abteilungsleitung"] as const;

/** Departments the account membership leads or trains (department-bound, currently effective roles only). */
export async function ownDepartmentIds(accountMemberId: string, roleTypes: readonly string[]): Promise<string[]> {
  const scoped = DEPARTMENT_SCOPED_ROLES.filter((r) => roleTypes.includes(r));
  if (scoped.length === 0) return [];
  const rows = await db.select({ departmentId: clubRoles.departmentId }).from(clubRoles).where(and(eq(clubRoles.memberId, accountMemberId), inArray(clubRoles.roleType, scoped), or(isNull(clubRoles.termEndsAt), gte(clubRoles.termEndsAt, todayBerlin()))));
  return [...new Set(rows.map((r) => r.departmentId).filter((v): v is string => v !== null))];
}

/** True when a role outside the department-scoped ones grants `permission` (board roles: the whole club). */
export function hasClubWidePermission(roleTypes: readonly string[], permission: ClubPermission): boolean {
  return roleTypes.some((r) => !(DEPARTMENT_SCOPED_ROLES as readonly string[]).includes(r) && hasClubPermission([r], permission));
}

/** Throws 403 unless the roles grant `permission` at all. Call BEFORE loading anything, so a plain member never learns whether an id exists. */
export function requirePermission(roleTypes: readonly string[], permission: ClubPermission): void {
  if (!hasClubPermission(roleTypes, permission)) throw new ForbiddenError(`Missing ${permission} permission`);
}

/** Scope check for a concrete event: club-wide roles pass; department-scoped roles need the event's calendar to belong to one of their departments. */
export async function assertEventScope(permission: ClubPermission, roleTypes: readonly string[], accountMemberId: string, calendar: Pick<CalendarRow, "departmentId">): Promise<void> {
  requirePermission(roleTypes, permission);
  if (hasClubWidePermission(roleTypes, permission)) return;
  if (calendar.departmentId !== null && (await ownDepartmentIds(accountMemberId, roleTypes)).includes(calendar.departmentId)) return;
  throw new ForbiddenError(`${permission} only applies to events of your own departments`);
}

/** Non-throwing variant of `assertEventScope`. */
export async function mayManageEvent(permission: ClubPermission, roleTypes: readonly string[], accountMemberId: string, calendar: Pick<CalendarRow, "departmentId">): Promise<boolean> {
  try {
    await assertEventScope(permission, roleTypes, accountMemberId, calendar);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError) return false;
    throw err;
  }
}

/** The caller's own club member row in this club (null for external guests without one). */
export async function ownClubMemberRow(clubId: string, accountMemberId: string): Promise<ClubMemberRow | null> {
  const [row] = await db.select().from(clubMembers).where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.memberId, accountMemberId)));
  return row ?? null;
}

/** Route middleware: 403 for callers whose roles do not grant `permission`, BEFORE the body is validated or any id is looked up. */
export const needsPermission = (permission: ClubPermission) =>
  createMiddleware<ClubEnv>(async (c, next) => {
    requirePermission(c.get("clubRoleTypes"), permission);
    await next();
  });

/** Event of the caller's club regardless of calendar visibility (board-scoped write routes, like the event write routes); 404 otherwise. */
export async function loadClubEvent(id: string, clubId: string): Promise<{ event: EventRow; calendar: CalendarRow }> {
  if (!isUuid(id)) throw new NotFoundError("Event not found");
  const row = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!row) throw new NotFoundError("Event not found");
  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, row.calendarId), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Event not found");
  return { event: row, calendar };
}
