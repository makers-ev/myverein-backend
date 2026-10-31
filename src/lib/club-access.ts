import { eq } from "drizzle-orm";

import type { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { IMPLICIT_ROLE_TYPE } from "./club-permissions.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";
import { suspendedRoleTypes } from "./term-status.js";

/**
 * The effective club roles of an account membership, exactly as `clubGuard` computes them for a request (single source:
 * the guard and the token feed both call this). `null` = the person has left the club (the guard answers 404).
 * `mitglied` is implicit for every account member except external guests; roles whose term ran out under
 * `term_expiry_effect = suspend_permissions` grant nothing.
 */
export async function resolveClubRoleTypes(membership: typeof member.$inferSelect, clubId: string): Promise<string[] | null> {
  const clubMember = await db.query.clubMembers.findFirst({
    where: eq(clubMembers.memberId, membership.id),
    columns: { status: true, leftAt: true },
  });
  if (clubMember && isLeftStatus(effectiveStatus(clubMember, todayBerlin()))) return null;

  const roleRows = await db.query.clubRoles.findMany({ where: eq(clubRoles.memberId, membership.id) });
  const roleTypes = new Set(roleRows.map((row) => row.roleType));
  roleTypes.delete(IMPLICIT_ROLE_TYPE);
  for (const suspended of await suspendedRoleTypes(clubId, roleRows, todayBerlin())) roleTypes.delete(suspended);
  const effective = [...roleTypes];
  if (membership.role !== "guest") effective.unshift(IMPLICIT_ROLE_TYPE);
  return effective;
}
