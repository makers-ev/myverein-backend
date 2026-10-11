/**
 * Member lifecycle (Wave 7 B5): status matrix, read-time derived status (`effectiveStatus`), age-based category
 * suggestions and the transactional transition itself. Nothing here is driven by a cron job -- "left" and "too old for
 * this category" are derived on every read from `left_at` / `birth_date` against `today` (same idea as
 * `inventory-status.ts`); the scheduler arrives with Wave 9.
 *
 * All dates are ISO `YYYY-MM-DD` strings. "Today" is the calendar day in Europe/Berlin (`todayBerlin`): a club's key
 * dates (exit at month end, birthdays) must not flip an hour early/late around midnight because of UTC.
 */
import { and, eq } from "drizzle-orm";

import { clubMembers, clubMemberStatusHistory, LEFT_STATUSES, type ClubMemberRow, type MemberCategoryRow, type MemberStatus } from "../db/schema/club-members.js";
import type { DbExecutor } from "./club-members.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";

/**
 * Allowed status changes (source = the member's EFFECTIVE status). Leaving statuses can only be left again by an
 * explicit `reopen` (to `aktiv`, with a reason); a re-join through an account never reopens `ausgeschlossen` /
 * `verstorben` (see `assertRejoinAllowed`).
 */
export const STATUS_TRANSITIONS: Record<MemberStatus, readonly MemberStatus[]> = {
  interessent: ["probe", "aktiv", "ausgetreten", "verstorben"],
  probe: ["aktiv", "ausgetreten", "ausgeschlossen", "verstorben"],
  aktiv: ["ruhend", "ausgetreten", "ausgeschlossen", "verstorben"],
  ruhend: ["aktiv", "ausgetreten", "ausgeschlossen", "verstorben"],
  ausgetreten: ["aktiv"],
  ausgeschlossen: ["aktiv"],
  verstorben: ["aktiv"],
};

/** Statuses that count towards the member total ("Mitgliederzahl"): everything that is currently a member. */
export const COUNTED_STATUSES: readonly MemberStatus[] = ["probe", "aktiv", "ruhend"];

export function isLeftStatus(status: string): boolean {
  return (LEFT_STATUSES as readonly string[]).includes(status);
}

const berlinDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/** The calendar day (`YYYY-MM-DD`) of `now` in Europe/Berlin, e.g. 00:30 CEST on 1 July is "2026-07-01" although UTC still says 30 June. */
export const todayBerlin = (now: Date = new Date()): string => {
  const parts = Object.fromEntries(berlinDate.formatToParts(now).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/**
 * The status to show/filter/count: a stored non-left status whose `left_at` is today or earlier is `ausgetreten`
 * (a cancellation effective on a key date needs no job to take effect).
 */
export function effectiveStatus(row: { status: string; leftAt: string | null }, today: string): string {
  if (isLeftStatus(row.status)) return row.status;
  if (row.leftAt !== null && row.leftAt <= today) return "ausgetreten";
  return row.status;
}

/** Whole years between `birthDate` and `today` (birthday counts on its day; 29 Feb is celebrated on 1 Mar). */
export function ageOn(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age;
}

/** `date` minus `years`, clamped to the last day of the month (29 Feb -> 28 Feb); comparable as a string. */
export function subtractYears(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y - years, m, 0)).getUTCDate();
  return `${String(y - years).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

export interface CategorySuggestion {
  from: MemberCategoryRow;
  to: MemberCategoryRow;
}

/**
 * Age transition proposal: the member's category has `auto_transition_to_key` + `max_age`, the member is older than
 * `max_age` and still belongs to the club. Needs `birth_date`. The target must exist and not be archived.
 * Pure -- nothing is changed; applying is an explicit board action.
 */
export function suggestCategory(
  row: Pick<ClubMemberRow, "categoryId" | "birthDate" | "status" | "leftAt">,
  categoriesById: ReadonlyMap<string, MemberCategoryRow>,
  categoriesByKey: ReadonlyMap<string, MemberCategoryRow>,
  today: string,
): CategorySuggestion | null {
  if (!row.categoryId || !row.birthDate) return null;
  if (isLeftStatus(effectiveStatus(row, today))) return null;
  const from = categoriesById.get(row.categoryId);
  if (!from || from.archivedAt || !from.autoTransitionToKey || from.maxAge === null) return null;
  if (ageOn(row.birthDate, today) <= from.maxAge) return null;
  const to = categoriesByKey.get(from.autoTransitionToKey);
  if (!to || to.archivedAt || to.id === from.id) return null;
  return { from, to };
}

/** True if setting `key -> targetKey` would create a cycle among the categories' auto transitions. */
export function wouldCreateCycle(categories: readonly Pick<MemberCategoryRow, "key" | "autoTransitionToKey">[], key: string, targetKey: string): boolean {
  const next = new Map(categories.map((c) => [c.key, c.autoTransitionToKey]));
  const seen = new Set<string>();
  let cursor: string | null | undefined = targetKey;
  while (cursor) {
    if (cursor === key) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = next.get(cursor);
  }
  return false;
}

export interface TransitionInput {
  toStatus?: MemberStatus;
  /** Already resolved (club-scoped, not archived) target category. */
  category?: MemberCategoryRow;
  effectiveOn?: string;
  reason?: string | null;
  reopen?: boolean;
}

export interface TransitionResult {
  row: ClubMemberRow;
  fromStatus: string;
  toStatus: string;
  fromCategoryId: string | null;
  toCategoryId: string | null;
  effectiveOn: string;
  /** `scheduled`: a future exit date was stored, the status flips by derivation on that date. */
  kind: "status" | "category" | "scheduled_exit" | "cancel_exit";
}

/**
 * Executes a status and/or category change inside `tx`: row lock, matrix check, update, history row. See README
 * "Member lifecycle" for the rules. Throws `NotFoundError` / `ConflictError` (matrix, no-op) / `ValidationError`.
 */
export async function transitionMember(tx: DbExecutor, clubId: string, memberRowId: string, input: TransitionInput, actorMemberId: string, today: string): Promise<TransitionResult> {
  const [row] = await tx
    .select()
    .from(clubMembers)
    .where(and(eq(clubMembers.id, memberRowId), eq(clubMembers.clubId, clubId)))
    .for("update");
  if (!row) throw new NotFoundError("Member not found");

  const from = effectiveStatus(row, today);
  const pendingExit = row.leftAt !== null && row.leftAt > today && !isLeftStatus(row.status);
  const effectiveOn = input.effectiveOn ?? today;
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const set: Partial<typeof clubMembers.$inferInsert> = {};
  let historyFrom: string = from;
  let historyTo: string = from;
  let kind: TransitionResult["kind"] = "category";

  if (input.toStatus !== undefined) {
    const to = input.toStatus;
    if (to === row.status && pendingExit) {
      // Same status as stored while an exit is scheduled: take the scheduled exit back.
      set.leftAt = null;
      set.exitReason = null;
      historyFrom = row.status;
      historyTo = row.status;
      kind = "cancel_exit";
    } else {
      if (to === from) throw new ConflictError(`Member already has status ${from}`);
      const allowed = STATUS_TRANSITIONS[from as MemberStatus] ?? [];
      if (!allowed.includes(to)) throw new ConflictError(`Status change ${from} -> ${to} is not allowed`, { details: { from, to, allowed } });
      if (isLeftStatus(from)) {
        if (!input.reopen) throw new ValidationError("Reopening a member who left requires reopen: true");
        if (!reason) throw new ValidationError("Reopening a member who left requires a reason");
      }
      kind = "status";
      historyTo = to;
      if (isLeftStatus(to)) {
        if (effectiveOn < row.joinedAt) throw new ValidationError("effectiveOn must not be before the join date");
        if (effectiveOn > today) {
          // Only a cancellation to a key date can be scheduled; the stored status stays until the date passes.
          if (to !== "ausgetreten") throw new ValidationError(`Status ${to} cannot be dated in the future`);
          set.leftAt = effectiveOn;
          set.exitReason = reason;
          kind = "scheduled_exit";
        } else {
          set.status = to;
          set.leftAt = effectiveOn;
          set.exitReason = reason;
        }
      } else {
        if (effectiveOn > today) throw new ValidationError("effectiveOn must not be in the future for this status");
        set.status = to;
        set.leftAt = null;
        set.exitReason = null;
      }
    }
  }

  let toCategoryId = row.categoryId;
  if (input.category && input.category.id !== row.categoryId) {
    if (input.toStatus === undefined && effectiveOn > today) throw new ValidationError("effectiveOn must not be in the future");
    set.categoryId = input.category.id;
    toCategoryId = input.category.id;
  }

  if (Object.keys(set).length === 0) throw new ConflictError("Nothing to change");

  const [updated] = await tx
    .update(clubMembers)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(clubMembers.id, row.id))
    .returning();

  await tx.insert(clubMemberStatusHistory).values({
    clubMemberId: row.id,
    fromStatus: historyFrom,
    toStatus: historyTo,
    fromCategoryId: row.categoryId,
    toCategoryId,
    effectiveOn,
    reason,
    changedBy: actorMemberId,
  });

  return { row: updated!, fromStatus: historyFrom, toStatus: historyTo, fromCategoryId: row.categoryId, toCategoryId, effectiveOn, kind };
}
