import { gt, inArray, isNull, or, and, type SQL } from "drizzle-orm";

import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { hasClubPermission } from "./club-permissions.js";
import { NotFoundError } from "./errors.js";
import { COUNTED_STATUSES, effectiveStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Read scoping of single member rows (Wave 7 B7/B8), shared by the member routes and the custom-field routes: what a
 * caller may reach of OTHER members. The answer is 404, never 403, so existence is not leaked.
 */

/** Members whose effective status is probe, aktiv or ruhend (what a plain member may see of the others). */
export const VISIBLE_STATUSES: readonly string[] = COUNTED_STATUSES;

export function visibleStatusCondition(today: string): SQL {
  return and(inArray(clubMembers.status, [...VISIBLE_STATUSES]), or(isNull(clubMembers.leftAt), gt(clubMembers.leftAt, today)))!;
}

/** Callers who manage members (members:write) or may read sensitive data also see former members and interessenten. */
export function canSeeAllMembers(c: { get(k: "clubRoleTypes"): string[] }): boolean {
  return hasClubPermission(c.get("clubRoleTypes"), "members:write") || hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive");
}

/**
 * Read gate for ONE member row (detail and its sub-resources). 404 -- never 403 -- so existence is not leaked:
 * external guests only reach their own row; callers without members:write / members:read_sensitive only reach members
 * with an effective status probe|aktiv|ruhend and their own row.
 */
export function assertMemberReadable(c: { get(k: "membership"): { id: string; role: string }; get(k: "clubRoleTypes"): string[] }, row: ClubMemberRow, today = todayBerlin()): void {
  const own = row.memberId !== null && row.memberId === c.get("membership").id;
  if (own) return;
  if (c.get("membership").role === "guest") throw new NotFoundError("Member not found");
  if (!canSeeAllMembers(c) && !VISIBLE_STATUSES.includes(effectiveStatus(row, today))) throw new NotFoundError("Member not found");
}
