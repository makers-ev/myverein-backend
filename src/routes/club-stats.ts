import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers, clubMemberStatusHistory, LEFT_STATUSES, memberCategories } from "../db/schema/club-members.js";
import { departments } from "../db/schema/departments.js";
import { computeClubStats } from "../lib/club-stats.js";
import { ensureDefaultCategories, markDetachedMembersLeft } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const clubStatsRoutes = new Hono<ClubEnv>();

clubStatsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
clubStatsRoutes.use("*", sessionGuard);
clubStatsRoutes.use("*", clubGuard);

/**
 * Association KPIs for the board (vorsitz, stellv_vorsitz, schriftfuehrer, kassenwart, beisitzer): counts only, no
 * personal data. Rules and shape: README "Club KPIs" and `lib/club-stats.ts`.
 */
clubStatsRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "club_stats:read")) throw new ForbiddenError("Missing board role for club statistics");

  await markDetachedMembersLeft(db, clubId).catch((err) => logger.error({ err, clubId }, "[club-stats] could not close detached members"));
  await ensureDefaultCategories(clubId);

  const [members, categories, depts, assignments, exits] = await Promise.all([
    db
      .select({ id: clubMembers.id, memberId: clubMembers.memberId, status: clubMembers.status, joinedAt: clubMembers.joinedAt, leftAt: clubMembers.leftAt, birthDate: clubMembers.birthDate, categoryId: clubMembers.categoryId })
      .from(clubMembers)
      .where(eq(clubMembers.clubId, clubId)),
    db.select({ id: memberCategories.id, key: memberCategories.key, name: memberCategories.name, archivedAt: memberCategories.archivedAt, sortOrder: memberCategories.sortOrder }).from(memberCategories).where(eq(memberCategories.clubId, clubId)).orderBy(memberCategories.sortOrder, memberCategories.name),
    db.select({ id: departments.id, name: departments.name }).from(departments).where(eq(departments.clubId, clubId)).orderBy(departments.name),
    db
      .select({ clubMemberId: clubMemberDepartments.clubMemberId, departmentId: clubMemberDepartments.departmentId, until: clubMemberDepartments.until })
      .from(clubMemberDepartments)
      .innerJoin(clubMembers, eq(clubMembers.id, clubMemberDepartments.clubMemberId))
      .where(eq(clubMembers.clubId, clubId)),
    db
      .select({ clubMemberId: clubMemberStatusHistory.clubMemberId, effectiveOn: clubMemberStatusHistory.effectiveOn })
      .from(clubMemberStatusHistory)
      .innerJoin(clubMembers, eq(clubMembers.id, clubMemberStatusHistory.clubMemberId))
      .where(and(eq(clubMembers.clubId, clubId), inArray(clubMemberStatusHistory.toStatus, [...LEFT_STATUSES]))),
  ]);

  return c.json({ data: computeClubStats({ members, categories, departments: depts, assignments, exits }, todayBerlin()) });
});
