import { and, asc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import type { CalendarRow } from "../db/schema/calendars.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { helperShifts, helperSignups, helperStations, helperSwapRequests } from "../db/schema/event-helpers.js";
import type { EventRow } from "../db/schema/events.js";
import type { DbExecutor } from "./club-members.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { ConflictError } from "./errors.js";
import { DEPARTMENT_SCOPED_ROLES } from "./event-access.js";
import { clubTimezone, formatWhen } from "./event-notify.js";
import { clubMailLanguage } from "./club-settings.js";
import { notifySafely } from "./notify/dispatcher.js";
import { tr } from "./notify/i18n.js";
import { logger } from "./logger.js";
import { envInt } from "./rate-limits.js";

/** Helper plan of an event (Wave 12 B16): stations, shifts with capacity, sign-ups and swap requests. */

export const MAX_STATIONS_PER_EVENT = 50;
export const MAX_SHIFTS_PER_EVENT = 200;
export const MAX_SHIFT_CAPACITY = 500;
/** A withdrawal closer than this to the start of the shift warns the organisers. */
export const lateCancelHours = () => envInt("HELPER_LATE_CANCEL_HOURS", 24, 1, 168);

/** Serialises everything one person does with shifts (sign-up, swap) so the overlap check cannot be raced. */
export async function lockMemberShifts(tx: DbExecutor, clubMemberId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`helper:${clubMemberId}`}, 0))`);
}

/** Another shift of the person overlapping [startsAt, endsAt) (the shift `exceptShiftId` itself is ignored). */
export async function overlappingShift(tx: DbExecutor, clubMemberId: string, startsAt: Date, endsAt: Date, exceptShiftId: string): Promise<{ shiftId: string; eventId: string } | null> {
  const [row] = await tx
    .select({ shiftId: helperShifts.id, eventId: helperStations.eventId })
    .from(helperSignups)
    .innerJoin(helperShifts, eq(helperShifts.id, helperSignups.shiftId))
    .innerJoin(helperStations, eq(helperStations.id, helperShifts.stationId))
    .where(and(eq(helperSignups.clubMemberId, clubMemberId), ne(helperShifts.id, exceptShiftId), lt(helperShifts.startsAt, endsAt), gt(helperShifts.endsAt, startsAt)))
    .limit(1);
  return row ?? null;
}

export function assertNoOverlap(conflict: { shiftId: string; eventId: string } | null): void {
  if (conflict) throw new ConflictError("The person already has a shift at this time", { details: { code: "shift_overlap", shiftId: conflict.shiftId, eventId: conflict.eventId } });
}

export interface PlanShift {
  id: string;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
  minStaff: number;
  filled: number;
  free: number;
  full: boolean;
  understaffed: boolean;
  signups: Array<{ signupId: string; clubMemberId: string; displayName: string | null; mine: boolean }>;
  mine: boolean;
  mySignupId: string | null;
  swaps: Array<{ id: string; signupId: string; fromClubMemberId: string; fromName: string | null; toClubMemberId: string | null; toMe: boolean; mine: boolean; createdAt: Date }>;
}

export interface PlanStation {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  shifts: PlanShift[];
}

/** The plan with occupation. Names only for `showNames` (not for external guests); `myIds` = the caller and the wards of the caller. */
export async function loadPlan(eventId: string, myIds: ReadonlySet<string>, showNames: boolean): Promise<PlanStation[]> {
  const stations = await db.select().from(helperStations).where(eq(helperStations.eventId, eventId)).orderBy(asc(helperStations.sortOrder), asc(helperStations.createdAt), asc(helperStations.id));
  if (stations.length === 0) return [];
  const shifts = await db.select().from(helperShifts).where(inArray(helperShifts.stationId, stations.map((s) => s.id))).orderBy(asc(helperShifts.startsAt), asc(helperShifts.id));
  const shiftIds = shifts.map((s) => s.id);
  const signups = shiftIds.length
    ? await db
        .select({ id: helperSignups.id, shiftId: helperSignups.shiftId, clubMemberId: helperSignups.clubMemberId, name: clubMembers.displayName })
        .from(helperSignups)
        .innerJoin(clubMembers, eq(clubMembers.id, helperSignups.clubMemberId))
        .where(inArray(helperSignups.shiftId, shiftIds))
        .orderBy(asc(helperSignups.createdAt), asc(helperSignups.id))
    : [];
  const signupIds = signups.map((s) => s.id);
  const swaps = signupIds.length ? await db.select().from(helperSwapRequests).where(and(inArray(helperSwapRequests.signupId, signupIds), eq(helperSwapRequests.status, "offen"))) : [];
  const signupById = new Map(signups.map((s) => [s.id, s]));

  return stations.map((station): PlanStation => ({
    id: station.id,
    name: station.name,
    description: station.description,
    sortOrder: station.sortOrder,
    shifts: shifts
      .filter((s) => s.stationId === station.id)
      .map((shift): PlanShift => {
        const here = signups.filter((s) => s.shiftId === shift.id);
        const mine = here.find((s) => myIds.has(s.clubMemberId));
        return {
          id: shift.id,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          capacity: shift.capacity,
          minStaff: shift.minStaff,
          filled: here.length,
          free: Math.max(0, shift.capacity - here.length),
          full: here.length >= shift.capacity,
          understaffed: here.length < shift.minStaff,
          signups: here.map((s) => ({ signupId: s.id, clubMemberId: s.clubMemberId, displayName: showNames || myIds.has(s.clubMemberId) ? s.name : null, mine: myIds.has(s.clubMemberId) })),
          mine: mine !== undefined,
          mySignupId: mine?.id ?? null,
          swaps: swaps
            .filter((w) => here.some((s) => s.id === w.signupId))
            .map((w) => {
              const from = signupById.get(w.signupId)!;
              return { id: w.id, signupId: w.signupId, fromClubMemberId: from.clubMemberId, fromName: showNames || myIds.has(from.clubMemberId) ? from.name : null, toClubMemberId: w.toClubMemberId, toMe: w.toClubMemberId !== null && myIds.has(w.toClubMemberId), mine: myIds.has(from.clubMemberId), createdAt: w.createdAt };
            }),
        };
      }),
  }));
}

/** Accounts who run the helper plan of an event: board roles with `helpers:write`, plus the department roles of the calendar's department. */
export async function helperManagers(clubId: string, calendar: Pick<CalendarRow, "departmentId">): Promise<Array<{ userId: string; clubMemberId: string | null; name: string | null }>> {
  const wide = roleTypesWithPermission("helpers:write").filter((r) => !(DEPARTMENT_SCOPED_ROLES as readonly string[]).includes(r));
  const scoped = DEPARTMENT_SCOPED_ROLES.filter((r) => roleTypesWithPermission("helpers:write").includes(r));
  const rows = await db
    .selectDistinct({ userId: member.userId, clubMemberId: clubMembers.id, name: clubMembers.displayName })
    .from(clubRoles)
    .innerJoin(member, eq(member.id, clubRoles.memberId))
    .leftJoin(clubMembers, eq(clubMembers.memberId, member.id))
    .where(and(eq(member.organizationId, clubId), or(inArray(clubRoles.roleType, wide), calendar.departmentId && scoped.length ? and(inArray(clubRoles.roleType, scoped), eq(clubRoles.departmentId, calendar.departmentId)) : undefined)));
  return rows;
}

/** Tells the organisers that somebody withdrew shortly before the start of a shift. Best effort, never throws. */
export async function notifyLateCancel(args: { clubId: string; event: EventRow; calendar: CalendarRow; shiftId: string; stationName: string; startsAt: Date; endsAt: Date; clubMemberId: string; actorUserId: string }): Promise<void> {
  try {
    const recipients = (await helperManagers(args.clubId, args.calendar)).filter((r) => r.userId !== args.actorUserId);
    if (recipients.length === 0) return;
    const lang = await clubMailLanguage(db, args.clubId);
    const when = formatWhen(args.startsAt, await clubTimezone(args.clubId), args.endsAt, lang);
    await notifySafely({
      clubId: args.clubId,
      class: "optional",
      eventKey: "helper.late_cancel",
      refId: `${args.shiftId}#${args.clubMemberId}:${Date.now()}`,
      recipients: recipients.map((r) => ({ userId: r.userId, clubMemberId: r.clubMemberId, name: r.name })),
      content: {
        title: `${tr(lang, "Helfer:in hat kurzfristig abgesagt", "A helper cancelled at short notice")}: ${args.event.title}`,
        body: tr(lang, `Für „${args.event.title}“, Station „${args.stationName}“, ${when} ist jemand abgesprungen. Die Schicht ist jetzt möglicherweise unterbesetzt.`, `For “${args.event.title}”, station “${args.stationName}”, ${when}, a helper dropped out. The shift may now be understaffed.`),
        category: "events",
        template: "reminder",
        lang,
      },
      channels: ["in_app", "push"],
    });
  } catch (err) {
    logger.error({ shiftId: args.shiftId, errName: (err as Error)?.name }, "[helpers] could not warn the organisers about a late cancellation");
  }
}

/** Tells club members (and their guardians) something about a shift; used for removals, swaps. Best effort. */
export async function notifyHelpers(args: { clubId: string; clubMemberIds: string[]; eventKey: string; refId: string; title: string; body: string; /** Also by e-mail: for people the organiser entered (they may have no account). */ email?: boolean }): Promise<void> {
  if (args.clubMemberIds.length === 0) return;
  try {
    const lang = await clubMailLanguage(db, args.clubId);
    await notifySafely({
      clubId: args.clubId,
      class: "optional",
      eventKey: args.eventKey,
      refId: args.refId,
      audience: { memberIds: [...new Set(args.clubMemberIds)], includeGuardians: true },
      content: { title: args.title, body: args.body, category: "events", template: "announcement", lang },
      channels: args.email ? ["in_app", "email", "push"] : ["in_app", "push"],
    });
  } catch (err) {
    logger.error({ eventKey: args.eventKey, errName: (err as Error)?.name }, "[helpers] could not notify");
  }
}
