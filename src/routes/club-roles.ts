import { and, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { loadAssemblyRules } from "../lib/assembly-rules.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError } from "../lib/errors.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { termInfo } from "../lib/term-status.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/** Term monitoring of the club roles (Wave 11 B8). */
export const clubRoleRoutes = new Hono<ClubEnv>();

clubRoleRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubRoleRoutes.use("*", sessionGuard);
clubRoleRoutes.use("*", clubGuard);

/**
 * Roles whose term runs out soon or has run out, soonest first. `assembly:manage` / `roles:write` only. Each row carries
 * what the UI needs for the "plan a new election" hint (`POST /elections` with `roleType`/`departmentId`).
 */
clubRoleRoutes.get("/expiring", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "assembly:manage") && !hasClubPermission(roleTypes, "roles:write")) throw new ForbiddenError("Missing assembly:manage permission");

  const today = todayBerlin();
  const rules = await loadAssemblyRules(db, clubId);
  const rows = await db
    .select({
      id: clubRoles.id,
      clubMemberId: clubMembers.id,
      name: clubMembers.displayName,
      accountName: user.name,
      roleType: clubRoles.roleType,
      departmentId: clubRoles.departmentId,
      termEndsAt: clubRoles.termEndsAt,
    })
    .from(clubRoles)
    .innerJoin(member, eq(member.id, clubRoles.memberId))
    .innerJoin(user, eq(user.id, member.userId))
    .leftJoin(clubMembers, eq(clubMembers.memberId, member.id))
    .where(and(eq(member.organizationId, clubId), isNotNull(clubRoles.termEndsAt)));

  const data = rows
    .map((r) => ({ id: r.id, clubMemberId: r.clubMemberId, name: r.name ?? r.accountName, roleType: r.roleType, departmentId: r.departmentId, termEndsAt: r.termEndsAt, ...termInfo(r.termEndsAt, today, rules.termWarningDays) }))
    .filter((r) => r.termStatus !== "aktiv")
    .sort((a, b) => (a.termEndsAt ?? "").localeCompare(b.termEndsAt ?? ""));
  return c.json({ data, termExpiryEffect: rules.termExpiryEffect });
});
