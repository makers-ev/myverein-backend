import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { member, organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "../lib/member-lifecycle.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Session-only (no clubGuard -- the whole point is discovering which clubs
 * the caller belongs to before any clubId is known). Small, deliberate gap
 * closed here rather than in the original Technical Reference plan: a
 * client needs this to pick a clubId for every other club-scoped route.
 * Wave 1 has no "browse/join public clubs" directory, just this "what am I
 * already a member of" list -- joining a new one still goes through
 * POST /club-members/apply with a clubId the user already knows.
 */
export const myClubRoutes = new Hono<SessionEnv>();

myClubRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
myClubRoutes.use("*", sessionGuard);

myClubRoutes.get("/", async (c) => {
  const currentUser = c.get("user");
  const today = todayBerlin();

  // Clubs the person has left (effective status ausgetreten/ausgeschlossen/verstorben) are no longer listed: access
  // ended with the exit (see clubGuard). A missing club_members row (should not happen) does not hide the club.
  const rows = await db
    .select({ membership: member, clubName: organization.name, status: clubMembers.status, leftAt: clubMembers.leftAt })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .leftJoin(clubMembers, eq(clubMembers.memberId, member.id))
    .where(eq(member.userId, currentUser.id))
    .orderBy(asc(member.createdAt), asc(member.id));

  const clubs = rows
    .filter((r) => r.status === null || !isLeftStatus(effectiveStatus({ status: r.status, leftAt: r.leftAt }, today)))
    .map((r) => ({ clubId: r.membership.organizationId, memberId: r.membership.id, clubName: r.clubName, orgRole: r.membership.role }));

  return c.json({ data: clubs });
});
