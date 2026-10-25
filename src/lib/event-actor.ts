import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "../db/client.js";
import type { CalendarRow } from "../db/schema/calendars.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { events, type EventRow } from "../db/schema/events.js";
import { ageOn, effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";
import { calendars } from "../db/schema/calendars.js";
import { hasClubPermission, type ClubPermission } from "./club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { loadVisibleEvent, mayManageEvent, ownClubMemberRow } from "./event-access.js";
import { liveLinkOf } from "./guardian-scope.js";
import { ADULT_AGE, eventLocalDays } from "./event-attendance.js";
import { wardCalendarIds } from "./ward-events.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Who acts on an event (Wave 12 helpers, rides): the caller for themselves, a guardian for a ward (live link), or - with the
 * management permission and event scope - the organiser for any member. Self-service rows are only ever changed for the
 * resolved target, never for an id the caller merely names.
 */

export type ActingVia = "self" | "guardian" | "manager";

export interface ActingMember {
  event: EventRow;
  calendar: CalendarRow;
  target: ClubMemberRow;
  via: ActingVia;
  /** The target is younger than 18 on the day of the event. */
  targetIsMinor: boolean;
}

/**
 * Resolves event + target. `managerPermission`: the permission that lets an organiser act for others (scope applied).
 * Minors may not act for themselves (`minor_needs_guardian`, 403): a guardian or an organiser enters them.
 */
export async function resolveActingMember(c: Context<ClubEnv>, eventId: string, forClubMemberId: string | undefined, managerPermission: ClubPermission, opts: { minorsMaySelfServe?: boolean } = {}): Promise<ActingMember> {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roles = c.get("clubRoleTypes");
  const own = await ownClubMemberRow(clubId, membership.id);

  let target: ClubMemberRow;
  let via: ActingVia;
  let event: EventRow;
  let calendar: CalendarRow;

  if (!forClubMemberId || own?.id === forClubMemberId) {
    if (!own) throw new ForbiddenError("Only club members can do this");
    target = own;
    via = "self";
    ({ event, calendar } = await loadVisibleEvent(eventId, clubId, membership.id, roles));
  } else {
    const [other] = await db.select().from(clubMembers).where(and(eq(clubMembers.id, forClubMemberId), eq(clubMembers.clubId, clubId)));
    if (!other) throw new NotFoundError("Member not found");
    target = other;
    const link = await liveLinkOf(membership.id, other.id);
    if (link) {
      via = "guardian";
      // A guardian sees the events of the ward's calendars (Wave 10 B4), not those of the club.
      const calendarIds = await wardCalendarIds(other);
      const [row] = await db.select({ event: events, calendar: calendars }).from(events).innerJoin(calendars, eq(calendars.id, events.calendarId)).where(eq(events.id, eventId));
      if (!row || !calendarIds.includes(row.event.calendarId)) throw new NotFoundError("Event not found");
      ({ event, calendar } = { event: row.event, calendar: row.calendar });
    } else {
      if (!hasClubPermission(roles, managerPermission)) throw new ForbiddenError(`Acting for somebody else needs a linked guardian relation or ${managerPermission}`);
      ({ event, calendar } = await loadVisibleEvent(eventId, clubId, membership.id, roles));
      if (!(await mayManageEvent(managerPermission, roles, membership.id, calendar))) throw new ForbiddenError(`${managerPermission} only applies to events of your own departments`);
      via = "manager";
    }
  }

  if (isLeftStatus(effectiveStatus(target, todayBerlin()))) throw new ValidationError("The member has left the club", { details: { code: "member_left" } });
  const { from } = await eventLocalDays(clubId, event);
  const targetIsMinor = target.birthDate !== null && ageOn(target.birthDate, from) < ADULT_AGE;
  if (via === "self" && targetIsMinor && !opts.minorsMaySelfServe) throw new ForbiddenError("Minors are entered by a guardian or the organiser", { details: { code: "minor_needs_guardian" } });
  return { event, calendar, target, via, targetIsMinor };
}
