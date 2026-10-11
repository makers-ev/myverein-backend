import { eq } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { clubRoles } from "../db/schema/club-roles.js";
import type { ClubMemberRow } from "../db/schema/club-members.js";
import { hasClubPermission } from "./club-permissions.js";
import type { DbExecutor } from "./club-members.js";
import { ConflictError, ForbiddenError } from "./errors.js";

/** Board roles whose holders only an authorised caller (`roles:write` = vorsitz / stellv_vorsitz) may remove from the club. */
export const PROTECTED_ROLE_TYPES: readonly string[] = ["vorsitz", "stellv_vorsitz"];

export function isOwnerRole(role: string | null | undefined): boolean {
  return (role ?? "").split(",").map((r) => r.trim()).includes("owner");
}

/**
 * Exclusion / board-recorded cancellation / approval must not be a way to lock the leadership out: the account of an
 * organization `owner` is never removable this way (409 `owner_protected`), and a holder of `vorsitz` / `stellv_vorsitz`
 * only by a caller with `roles:write` (403 `board_protected`). Members without account are never protected.
 */
export async function assertExitAllowed(tx: DbExecutor, row: ClubMemberRow, callerRoleTypes: readonly string[]): Promise<void> {
  if (!row.memberId) return;
  const account = await tx.query.member.findFirst({ where: eq(member.id, row.memberId) });
  if (!account) return;
  if (isOwnerRole(account.role)) throw new ConflictError("The club owner cannot leave or be excluded through the exit workflow", { details: { code: "owner_protected" } });
  const roles = await tx.select({ roleType: clubRoles.roleType }).from(clubRoles).where(eq(clubRoles.memberId, account.id));
  if (roles.some((r) => PROTECTED_ROLE_TYPES.includes(r.roleType)) && !hasClubPermission(callerRoleTypes, "roles:write")) {
    throw new ForbiddenError("Removing a chairperson requires the roles:write permission", { details: { code: "board_protected" } });
  }
}
