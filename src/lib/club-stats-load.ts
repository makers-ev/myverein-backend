import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers, clubMemberStatusHistory, LEFT_STATUSES, memberCategories } from "../db/schema/club-members.js";
import { departments } from "../db/schema/departments.js";
import { ensureDefaultCategories, markDetachedMembersLeft } from "./club-members.js";
import type { ClubStatsInput } from "./club-stats.js";
import { logger } from "./logger.js";

/**
 * Loads the raw rows `computeClubStats` aggregates (shared by `GET /club-stats` and the annual report PDF). Same housekeeping
 * as the route: members whose account membership vanished are closed first, default categories exist.
 */
export async function loadClubStatsInput(clubId: string): Promise<ClubStatsInput> {
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
  return { members, categories, departments: depts, assignments, exits };
}
