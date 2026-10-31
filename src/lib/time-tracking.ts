import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { events } from "../db/schema/events.js";
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

/** Trainers, department leads and everybody who confirms entries track time regardless of a rate card (existing rights stay). */
export function mayTrackTime(roleTypes: readonly string[]): boolean {
  return roleTypes.includes("trainer") || roleTypes.includes("abteilungsleitung") || hasClubPermission(roleTypes, "time:write");
}

/** Role types of an account that count for rate cards: the explicit roles still in term plus the implicit `mitglied`. */
async function accountRoleTypes(accountIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (accountIds.length === 0) return out;
  const today = todayBerlin();
  const rows = await db
    .select({ memberId: clubRoles.memberId, roleType: clubRoles.roleType })
    .from(clubRoles)
    .where(and(inArray(clubRoles.memberId, accountIds), or(isNull(clubRoles.termEndsAt), gte(clubRoles.termEndsAt, today))));
  for (const r of rows) out.set(r.memberId, [...(out.get(r.memberId) ?? []), r.roleType]);
  return out;
}

/**
 * `hasRate`: an hourly rate applies today (personal card or card of one of the caller's club role types).
 * `canTrack`: trainers, department leads and `time:write` holders as before, or anybody with an applicable rate.
 */
export async function trackingCapability(clubId: string, clubMemberId: string | null, roleTypes: readonly string[]): Promise<{ canTrack: boolean; hasRate: boolean }> {
  const cards = await db.select().from(rateCards).where(eq(rateCards.clubId, clubId));
  const hasRate = clubMemberId !== null && rateOn(cards, clubMemberId, roleTypes, todayBerlin()) !== null;
  return { canTrack: hasRate || mayTrackTime(roleTypes), hasRate };
}

/** Deny by default: 403 `no_rate` unless the caller may track (see `trackingCapability`). */
export async function requireTracking(clubId: string, clubMemberId: string | null, roleTypes: readonly string[]): Promise<void> {
  if (mayTrackTime(roleTypes)) return;
  const { canTrack } = await trackingCapability(clubId, clubMemberId, roleTypes);
  if (!canTrack) throw new ForbiddenError("No hourly rate is set for you", { details: { code: "no_rate" } });
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

export const REPORT_GROUPS = ["person", "event", "person_event"] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

export interface ReportRow {
  clubMemberId: string | null;
  displayName: string | null;
  roleTypes: string[];
  eventId: string | null;
  eventTitle: string | null;
  eventDate: string | null;
  entries: number;
  minutes: number;
  hours: number;
  rateCents: number | null;
  amountCents: number | null;
  rateMissing: boolean;
}

export interface ReportOptions {
  from: Date;
  to: Date;
  scope: TimeScope;
  withRates: boolean;
  departmentId?: string | undefined;
  clubMemberIds?: string[] | undefined;
  roleTypes?: string[] | undefined;
  eventId?: string | undefined;
  groupBy?: ReportGroup | undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Confirmed entries of a period, filtered and grouped; amounts only when `withRates`. `people` is always the per-person sum. */
export async function buildReport(clubId: string, opts: ReportOptions): Promise<{ groupBy: ReportGroup; rows: ReportRow[]; people: ReportRow[]; totals: { minutes: number; hours: number; amountCents: number | null } }> {
  const groupBy = opts.groupBy ?? "person";
  const wanted = opts.clubMemberIds && opts.clubMemberIds.length > 0 ? new Set(opts.clubMemberIds) : null;
  const rows = await db
    .select({ entry: timeEntries, name: clubMembers.displayName, accountId: clubMembers.memberId, eventTitle: events.title, eventStartsAt: events.startsAt })
    .from(timeEntries)
    .innerJoin(clubMembers, eq(clubMembers.id, timeEntries.clubMemberId))
    .leftJoin(events, eq(events.id, timeEntries.eventId))
    .where(and(eq(timeEntries.clubId, clubId), eq(timeEntries.status, "bestaetigt"), gte(timeEntries.startedAt, opts.from), lte(timeEntries.startedAt, opts.to), opts.eventId ? eq(timeEntries.eventId, opts.eventId) : undefined))
    .limit(20_000);
  let inReport = rows.filter((r) => r.entry.endedAt !== null && inScope(opts.scope, r.entry.clubMemberId) && (wanted === null || wanted.has(r.entry.clubMemberId)));
  if (opts.departmentId) {
    const today = todayBerlin();
    const members = await db
      .select({ id: clubMemberDepartments.clubMemberId })
      .from(clubMemberDepartments)
      .where(and(eq(clubMemberDepartments.departmentId, opts.departmentId), lte(clubMemberDepartments.since, today), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, today))));
    const set = new Set(members.map((m) => m.id));
    inReport = inReport.filter((r) => set.has(r.entry.clubMemberId));
  }
  const accounts = [...new Set(inReport.flatMap((r) => (r.accountId ? [r.accountId] : [])))];
  const rolesByAccount = await accountRoleTypes(accounts);
  if (opts.roleTypes && opts.roleTypes.length > 0) {
    const want = new Set(opts.roleTypes);
    inReport = inReport.filter((r) => r.accountId !== null && (rolesByAccount.get(r.accountId) ?? []).some((t) => want.has(t)));
  }
  const cards = opts.withRates ? await db.select().from(rateCards).where(eq(rateCards.clubId, clubId)) : [];

  type Acc = ReportRow & { rates: Set<number> };
  const make = (key: { memberId: string | null; name: string | null; roles: string[]; eventId: string | null; title: string | null; date: string | null }): Acc => ({
    clubMemberId: key.memberId, displayName: key.name, roleTypes: key.roles, eventId: key.eventId, eventTitle: key.title, eventDate: key.date,
    entries: 0, minutes: 0, hours: 0, rateCents: null, amountCents: opts.withRates ? 0 : null, rateMissing: false, rates: new Set<number>(),
  });
  const grouped = new Map<string, Acc>();
  const perPerson = new Map<string, Acc>();
  const add = (map: Map<string, Acc>, key: string, init: () => Acc, minutes: number, rate: number | null) => {
    const acc = map.get(key) ?? init();
    acc.entries += 1;
    acc.minutes += minutes;
    if (opts.withRates) {
      if (rate === null) acc.rateMissing = true;
      else {
        acc.rates.add(rate);
        acc.amountCents = (acc.amountCents ?? 0) + Math.round((minutes * rate) / 60);
      }
    }
    map.set(key, acc);
  };
  for (const { entry, name, accountId, eventTitle, eventStartsAt } of inReport) {
    const minutes = minutesOf(entry)!;
    const explicit = accountId ? (rolesByAccount.get(accountId) ?? []).filter((t, i, a) => a.indexOf(t) === i).sort() : [];
    const rate = opts.withRates ? rateOn(cards, entry.clubMemberId, accountId ? ["mitglied", ...explicit] : [], entry.startedAt.toISOString().slice(0, 10)) : null;
    const eventDate = eventStartsAt ? eventStartsAt.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) : null;
    const person = () => make({ memberId: entry.clubMemberId, name, roles: explicit, eventId: null, title: null, date: null });
    const eventRow = () => make({ memberId: null, name: null, roles: [], eventId: entry.eventId, title: eventTitle, date: eventDate });
    const both = () => make({ memberId: entry.clubMemberId, name, roles: explicit, eventId: entry.eventId, title: eventTitle, date: eventDate });
    add(perPerson, entry.clubMemberId, person, minutes, rate);
    if (groupBy === "person") continue;
    if (groupBy === "event") add(grouped, entry.eventId ?? "none", eventRow, minutes, rate);
    else add(grouped, `${entry.clubMemberId}|${entry.eventId ?? "none"}`, both, minutes, rate);
  }
  const finish = (map: Map<string, Acc>): ReportRow[] =>
    [...map.values()]
      .map(({ rates, ...r }): ReportRow => ({ ...r, hours: round2(r.minutes / 60), rateCents: rates.size === 1 ? [...rates][0]! : null }))
      .sort((a, b) => (a.displayName ?? "").localeCompare(b.displayName ?? "", "de") || (a.eventDate ?? "").localeCompare(b.eventDate ?? "") || (a.eventTitle ?? "").localeCompare(b.eventTitle ?? "", "de"));
  const people = finish(perPerson);
  const out = groupBy === "person" ? people : finish(grouped);
  const minutes = people.reduce((n, p) => n + p.minutes, 0);
  return { groupBy, rows: out, people, totals: { minutes, hours: round2(minutes / 60), amountCents: opts.withRates ? people.reduce((n, p) => n + (p.amountCents ?? 0), 0) : null } };
}

/** People (members with confirmed entries in the period, or with an applicable rate) and role types for the report selector. */
export async function reportPeople(clubId: string, opts: { from: Date; to: Date; scope: TimeScope; withRates: boolean }) {
  const entryRows = await db
    .select({ id: timeEntries.clubMemberId, eventId: timeEntries.eventId })
    .from(timeEntries)
    .where(and(eq(timeEntries.clubId, clubId), eq(timeEntries.status, "bestaetigt"), gte(timeEntries.startedAt, opts.from), lte(timeEntries.startedAt, opts.to)))
    .limit(20_000);
  const ids = new Set(entryRows.filter((r) => inScope(opts.scope, r.id)).map((r) => r.id));
  const eventIds = new Set(entryRows.filter((r) => inScope(opts.scope, r.id) && r.eventId).map((r) => r.eventId!));
  const members = await db.select({ id: clubMembers.id, name: clubMembers.displayName, accountId: clubMembers.memberId }).from(clubMembers).where(eq(clubMembers.clubId, clubId));
  const rolesByAccount = await accountRoleTypes(members.flatMap((m) => (m.accountId ? [m.accountId] : [])));
  if (opts.withRates) {
    const cards = await db.select().from(rateCards).where(eq(rateCards.clubId, clubId));
    const today = todayBerlin();
    for (const m of members) if (rateOn(cards, m.id, m.accountId ? ["mitglied", ...(rolesByAccount.get(m.accountId) ?? [])] : [], today) !== null) ids.add(m.id);
  }
  const people = members
    .filter((m) => ids.has(m.id))
    .map((m) => ({ clubMemberId: m.id, displayName: m.name, roleTypes: [...new Set(m.accountId ? (rolesByAccount.get(m.accountId) ?? []) : [])].sort() }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "de"))
    .slice(0, 1000);
  const roleTypes = [...new Set(people.flatMap((p) => p.roleTypes))].sort();
  const eventList = eventIds.size
    ? await db.select({ id: events.id, title: events.title, startsAt: events.startsAt }).from(events).where(inArray(events.id, [...eventIds])).orderBy(desc(events.startsAt)).limit(300)
    : [];
  return { people, roleTypes, events: eventList.map((e) => ({ eventId: e.id, title: e.title, startsAt: e.startsAt })) };
}
