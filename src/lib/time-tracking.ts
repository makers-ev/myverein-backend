import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { rateCards, timeEntries, type RateCardRow, type TimeEntryRow } from "../db/schema/event-extras.js";
import type { DbExecutor } from "./club-members.js";
import { hasClubPermission } from "./club-permissions.js";
import { hasClubWidePermission, ownDepartmentIds } from "./event-access.js";
import { ConflictError, ForbiddenError, ValidationError } from "./errors.js";
import { todayBerlin } from "./member-lifecycle.js";

/**
 * Time tracking of trainers (Wave 12 B20, P2). REPORT ONLY: hours and, for `time:read_rates`, hours x rate. There is no payout,
 * no booking, no payment status, no tax logic -- billing stays outside MyVerein. Entries are `offen` until a person with
 * `time:write` (department leads: only for members of their departments) confirms or rejects them; nobody confirms their own.
 */

export const MAX_ENTRY_HOURS = 16;
export const MAX_AGE_DAYS = 366;
export const TIME_SOURCES = ["stempeln", "aus_termin", "manuell"] as const;
export const TIME_STATUSES = ["offen", "bestaetigt", "abgelehnt"] as const;

/** Who clocks in: trainers and department leads (and everybody who confirms entries). Deny by default. */
export function mayTrackTime(roleTypes: readonly string[]): boolean {
  return roleTypes.includes("trainer") || roleTypes.includes("abteilungsleitung") || hasClubPermission(roleTypes, "time:write");
}

export function requireTracking(roleTypes: readonly string[]): void {
  if (!mayTrackTime(roleTypes)) throw new ForbiddenError("Time tracking is for trainers and department leads");
}

export interface TimeScope {
  /** `null` = the whole club. */
  clubMemberIds: Set<string> | null;
}

/** The members whose entries the caller may confirm / read with `time:write` (board: all; department roles: members of their departments). */
export async function timeScopeOf(clubId: string, roleTypes: readonly string[], accountMemberId: string): Promise<TimeScope> {
  if (hasClubWidePermission(roleTypes, "time:write")) return { clubMemberIds: null };
  const departments = await ownDepartmentIds(accountMemberId, roleTypes);
  if (departments.length === 0) return { clubMemberIds: new Set() };
  const today = todayBerlin();
  const rows = await db
    .select({ id: clubMemberDepartments.clubMemberId })
    .from(clubMemberDepartments)
    .innerJoin(clubMembers, eq(clubMembers.id, clubMemberDepartments.clubMemberId))
    .where(and(eq(clubMembers.clubId, clubId), inArray(clubMemberDepartments.departmentId, departments), lte(clubMemberDepartments.since, today), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, today))));
  return { clubMemberIds: new Set(rows.map((r) => r.id)) };
}

export const inScope = (scope: TimeScope, clubMemberId: string): boolean => scope.clubMemberIds === null || scope.clubMemberIds.has(clubMemberId);

export const minutesOf = (entry: Pick<TimeEntryRow, "startedAt" | "endedAt">): number | null => (entry.endedAt ? Math.max(0, Math.round((entry.endedAt.getTime() - entry.startedAt.getTime()) / 60_000)) : null);

/** Time window rules of a finished entry. */
export function assertEntryWindow(startedAt: Date, endedAt: Date, now = new Date()): void {
  if (endedAt <= startedAt) throw new ValidationError("endedAt must be after startedAt", { details: { code: "invalid_time" } });
  if (endedAt.getTime() > now.getTime() + 5 * 60_000) throw new ValidationError("An entry cannot end in the future", { details: { code: "in_future" } });
  if (endedAt.getTime() - startedAt.getTime() > MAX_ENTRY_HOURS * 3_600_000) throw new ValidationError(`An entry covers at most ${MAX_ENTRY_HOURS} hours`, { details: { code: "too_long" } });
  if (now.getTime() - startedAt.getTime() > MAX_AGE_DAYS * 86_400_000) throw new ValidationError("The entry is too old to be recorded", { details: { code: "too_old" } });
}

/** Another entry of the person overlapping [startedAt, endedAt) (a running entry counts until now). */
export async function assertNoOverlap(tx: DbExecutor, clubMemberId: string, startedAt: Date, endedAt: Date, exceptId?: string): Promise<void> {
  const rows = await tx.select().from(timeEntries).where(and(eq(timeEntries.clubMemberId, clubMemberId), lte(timeEntries.startedAt, endedAt)));
  const clash = rows.find((r) => r.id !== exceptId && r.status !== "abgelehnt" && (r.endedAt ?? new Date()) > startedAt);
  if (clash) throw new ConflictError("There is already a time entry at this time", { details: { code: "entry_overlap", entryId: clash.id } });
}

/** The hourly rate that applies to a person on a day: a personal card beats a role card; the newest `valid_from` wins. */
export function rateOn(cards: readonly RateCardRow[], clubMemberId: string, roleTypes: readonly string[], day: string): number | null {
  const valid = (c: RateCardRow) => c.validFrom <= day && (c.validUntil === null || c.validUntil >= day);
  const pick = (list: RateCardRow[]) => list.filter(valid).sort((a, b) => (a.validFrom < b.validFrom ? 1 : a.validFrom > b.validFrom ? -1 : b.hourlyRateCents - a.hourlyRateCents))[0];
  const personal = pick(cards.filter((c) => c.clubMemberId === clubMemberId));
  if (personal) return personal.hourlyRateCents;
  return pick(cards.filter((c) => c.roleType !== null && roleTypes.includes(c.roleType)))?.hourlyRateCents ?? null;
}

export interface ReportPerson {
  clubMemberId: string;
  displayName: string;
  entries: number;
  minutes: number;
  hours: number;
  rateCents: number | null;
  amountCents: number | null;
  rateMissing: boolean;
}

/** Confirmed entries of a period, summed per person; amounts only when `withRates`. */
export async function buildReport(clubId: string, opts: { from: Date; to: Date; scope: TimeScope; withRates: boolean; departmentId?: string | undefined }): Promise<{ people: ReportPerson[]; totals: { minutes: number; hours: number; amountCents: number | null } }> {
  const rows = await db
    .select({ entry: timeEntries, name: clubMembers.displayName, accountId: clubMembers.memberId })
    .from(timeEntries)
    .innerJoin(clubMembers, eq(clubMembers.id, timeEntries.clubMemberId))
    .where(and(eq(timeEntries.clubId, clubId), eq(timeEntries.status, "bestaetigt"), gte(timeEntries.startedAt, opts.from), lte(timeEntries.startedAt, opts.to)))
    .limit(20_000);
  let inReport = rows.filter((r) => r.entry.endedAt !== null && inScope(opts.scope, r.entry.clubMemberId));
  if (opts.departmentId) {
    const today = todayBerlin();
    const members = await db
      .select({ id: clubMemberDepartments.clubMemberId })
      .from(clubMemberDepartments)
      .where(and(eq(clubMemberDepartments.departmentId, opts.departmentId), lte(clubMemberDepartments.since, today), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, today))));
    const set = new Set(members.map((m) => m.id));
    inReport = inReport.filter((r) => set.has(r.entry.clubMemberId));
  }
  const cards = opts.withRates ? await db.select().from(rateCards).where(eq(rateCards.clubId, clubId)) : [];
  const accounts = [...new Set(inReport.flatMap((r) => (r.accountId ? [r.accountId] : [])))];
  const roleRows = opts.withRates && accounts.length ? await db.select({ memberId: clubRoles.memberId, roleType: clubRoles.roleType }).from(clubRoles).where(inArray(clubRoles.memberId, accounts)) : [];

  const byPerson = new Map<string, ReportPerson & { rates: Set<number> }>();
  for (const { entry, name, accountId } of inReport) {
    const minutes = minutesOf(entry)!;
    const person = byPerson.get(entry.clubMemberId) ?? { clubMemberId: entry.clubMemberId, displayName: name, entries: 0, minutes: 0, hours: 0, rateCents: null, amountCents: opts.withRates ? 0 : null, rateMissing: false, rates: new Set<number>() };
    person.entries += 1;
    person.minutes += minutes;
    if (opts.withRates) {
      const roles = accountId ? roleRows.filter((r) => r.memberId === accountId).map((r) => r.roleType) : [];
      const rate = rateOn(cards, entry.clubMemberId, roles, entry.startedAt.toISOString().slice(0, 10));
      if (rate === null) person.rateMissing = true;
      else {
        person.rates.add(rate);
        person.amountCents = (person.amountCents ?? 0) + Math.round((minutes * rate) / 60);
      }
    }
    byPerson.set(entry.clubMemberId, person);
  }
  const people = [...byPerson.values()]
    .map(({ rates, ...p }): ReportPerson => ({ ...p, hours: Math.round((p.minutes / 60) * 100) / 100, rateCents: rates.size === 1 ? [...rates][0]! : null }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "de"));
  const minutes = people.reduce((n, p) => n + p.minutes, 0);
  return { people, totals: { minutes, hours: Math.round((minutes / 60) * 100) / 100, amountCents: opts.withRates ? people.reduce((n, p) => n + (p.amountCents ?? 0), 0) : null } };
}
