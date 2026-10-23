import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { loadAssemblyRules } from "./assembly-rules.js";
import { daysBetween } from "./club-time.js";

/**
 * Term monitoring (Wave 11 B8). `club_roles.term_ends_at` is the LAST day of the term. The status is derived, never stored:
 * `aktiv` (no end or far away), `laeuft_bald_ab` (within the longest warning period of the club) and `abgelaufen` (end day passed).
 * Without stated warning days the display falls back to 90 days; reminders (see `term-jobs.ts`) only go out with stated warning days.
 */

export const TERM_STATUSES = ["aktiv", "laeuft_bald_ab", "abgelaufen"] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

export const DEFAULT_TERM_DISPLAY_DAYS = 90;

export function termDisplayDays(warningDays: readonly number[] | null | undefined): number {
  return warningDays && warningDays.length > 0 ? Math.max(...warningDays) : DEFAULT_TERM_DISPLAY_DAYS;
}

export function termStatus(termEndsAt: string | null | undefined, today: string, warningDays: readonly number[] | null | undefined): TermStatus {
  if (!termEndsAt) return "aktiv";
  const left = daysBetween(today, termEndsAt);
  if (left < 0) return "abgelaufen";
  return left <= termDisplayDays(warningDays) ? "laeuft_bald_ab" : "aktiv";
}

/** `termStatus` plus the remaining days (negative once expired, null without an end) for API responses. */
export function termInfo(termEndsAt: string | null | undefined, today: string, warningDays: readonly number[] | null | undefined): { termStatus: TermStatus; termDaysLeft: number | null } {
  return { termStatus: termStatus(termEndsAt, today, warningDays), termDaysLeft: termEndsAt ? daysBetween(today, termEndsAt) : null };
}

/**
 * Role types whose rights are suspended for one account because EVERY row of that role type has an expired term. Only applies with
 * `term_expiry_effect = suspend_permissions`. The club must stay able to act: if nobody in the club keeps an unexpired
 * `vorsitz`/`stellv_vorsitz` role, nothing is suspended.
 */
export async function suspendedRoleTypes(clubId: string, rows: ReadonlyArray<{ roleType: string; termEndsAt: string | null }>, today: string): Promise<Set<string>> {
  const expired = new Set<string>();
  const alive = new Set<string>();
  for (const r of rows) (r.termEndsAt && r.termEndsAt < today ? expired : alive).add(r.roleType);
  for (const t of alive) expired.delete(t);
  if (expired.size === 0) return expired;

  const rules = await loadAssemblyRules(db, clubId);
  if (rules.termExpiryEffect !== "suspend_permissions") return new Set();

  // Safety net: somebody with an unexpired chair role must remain, otherwise the club could not even renew a term.
  const standing = await db
    .select({ id: clubRoles.id })
    .from(clubRoles)
    .innerJoin(member, eq(member.id, clubRoles.memberId))
    .where(and(eq(member.organizationId, clubId), inArray(clubRoles.roleType, ["vorsitz", "stellv_vorsitz"]), or(isNull(clubRoles.termEndsAt), gte(clubRoles.termEndsAt, today))))
    .limit(1);
  return standing.length > 0 ? expired : new Set();
}
