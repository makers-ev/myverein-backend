import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import type { CalendarRow } from "../db/schema/calendars.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { helperShifts, helperSignups, helperStations } from "../db/schema/event-helpers.js";
import type { EventRow } from "../db/schema/events.js";
import { computeAvailability, type AvailabilityInput } from "./availability-match.js";
import { ADULT_AGE } from "./event-attendance.js";
import { clubTimezone } from "./event-notify.js";
import { ageOn, effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Availability hints for the helper plan (Wave 12 B17). Raw data only -- "verfuegbar / nicht_verfuegbar / unbekannt" per person and
 * shift -- and NO ranking: the list is sorted by name, the organiser decides. Availability (`availability_slots` /
 * `availability_exceptions`) belongs to the account (`member.id`); people without account, and accounts that never entered anything,
 * are "unbekannt" (default-closed data must not read as "not available").
 */

export const MAX_CANDIDATES = 500;

export type Availability = "verfuegbar" | "nicht_verfuegbar" | "unbekannt";

export interface Candidate {
  clubMemberId: string;
  displayName: string;
  availability: Availability;
  hasAccount: boolean;
  isMinor: boolean;
  alreadyOnShift: boolean;
  /** Has another shift overlapping this one. */
  conflicting: boolean;
}

/** The club-local wall clock of an instant as a `Date` in the server zone, which is what `computeAvailability` reads. */
export function wallClock(instant: Date, timezone: string): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant).map((p) => [p.type, p.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

/** Per shift of the event: the people who could be asked (department members of a department calendar, else all active members). */
export async function suggestHelpers(clubId: string, event: EventRow, calendar: Pick<CalendarRow, "departmentId">): Promise<Array<{ shiftId: string; candidates: Candidate[] }>> {
  const shifts = await db
    .select({ shift: helperShifts })
    .from(helperShifts)
    .innerJoin(helperStations, eq(helperStations.id, helperShifts.stationId))
    .where(eq(helperStations.eventId, event.id))
    .orderBy(asc(helperShifts.startsAt), asc(helperShifts.id));
  if (shifts.length === 0) return [];

  const today = todayBerlin();
  const pool = calendar.departmentId
    ? await db
        .selectDistinct({ id: clubMembers.id, name: clubMembers.displayName, memberId: clubMembers.memberId, birthDate: clubMembers.birthDate, status: clubMembers.status, leftAt: clubMembers.leftAt })
        .from(clubMemberDepartments)
        .innerJoin(clubMembers, eq(clubMembers.id, clubMemberDepartments.clubMemberId))
        .where(and(eq(clubMemberDepartments.departmentId, calendar.departmentId), eq(clubMembers.clubId, clubId), lte(clubMemberDepartments.since, today), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, today))))
        .limit(MAX_CANDIDATES * 2)
    : await db
        .select({ id: clubMembers.id, name: clubMembers.displayName, memberId: clubMembers.memberId, birthDate: clubMembers.birthDate, status: clubMembers.status, leftAt: clubMembers.leftAt })
        .from(clubMembers)
        .where(eq(clubMembers.clubId, clubId))
        .orderBy(asc(clubMembers.displayName))
        .limit(MAX_CANDIDATES * 2);
  const people = pool.filter((p) => !isLeftStatus(effectiveStatus(p, today)) && p.status !== "interessent").sort((a, b) => a.name.localeCompare(b.name, "de")).slice(0, MAX_CANDIDATES);
  const accounts = people.flatMap((p) => (p.memberId ? [p.memberId] : []));
  const slots = accounts.length ? await db.select().from(availabilitySlots).where(inArray(availabilitySlots.memberId, accounts)) : [];
  const exceptions = accounts.length ? await db.select().from(availabilityExceptions).where(inArray(availabilityExceptions.memberId, accounts)) : [];
  const inputs = new Map<string, AvailabilityInput>();
  for (const a of accounts) inputs.set(a, { memberId: a, slots: [], exceptions: [] });
  for (const s of slots) inputs.get(s.memberId)?.slots.push({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime });
  for (const e of exceptions) inputs.get(e.memberId)?.exceptions.push({ date: e.date, isAvailable: e.isAvailable });

  const tz = await clubTimezone(clubId);
  const personIds = people.map((p) => p.id);
  const signups = personIds.length
    ? await db
        .select({ clubMemberId: helperSignups.clubMemberId, shiftId: helperSignups.shiftId, startsAt: helperShifts.startsAt, endsAt: helperShifts.endsAt })
        .from(helperSignups)
        .innerJoin(helperShifts, eq(helperShifts.id, helperSignups.shiftId))
        .where(inArray(helperSignups.clubMemberId, personIds))
    : [];

  return shifts.map(({ shift }) => {
    const start = wallClock(shift.startsAt, tz);
    const end = wallClock(new Date(shift.endsAt.getTime() - 60_000), tz);
    return {
      shiftId: shift.id,
      candidates: people.map((p): Candidate => {
        const input = p.memberId ? inputs.get(p.memberId) : undefined;
        const known = input !== undefined && (input.slots.length > 0 || input.exceptions.length > 0);
        const availability: Availability = !known ? "unbekannt" : computeAvailability(start, [input]).every((r) => r.available) && computeAvailability(end, [input]).every((r) => r.available) ? "verfuegbar" : "nicht_verfuegbar";
        const mine = signups.filter((s) => s.clubMemberId === p.id);
        return {
          clubMemberId: p.id,
          displayName: p.name,
          availability,
          hasAccount: p.memberId !== null,
          isMinor: p.birthDate !== null && ageOn(p.birthDate, today) < ADULT_AGE,
          alreadyOnShift: mine.some((s) => s.shiftId === shift.id),
          conflicting: mine.some((s) => s.shiftId !== shift.id && s.startsAt < shift.endsAt && s.endsAt > shift.startsAt),
        };
      }),
    };
  });
}
