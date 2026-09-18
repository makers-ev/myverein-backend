import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { member, organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
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

  const memberships = await db.query.member.findMany({ where: eq(member.userId, currentUser.id) });
  const clubs = await Promise.all(
    memberships.map(async (m) => {
      const club = await db.query.organization.findFirst({ where: eq(organization.id, m.organizationId) });
      return { clubId: m.organizationId, memberId: m.id, clubName: club?.name ?? null, orgRole: m.role };
    }),
  );

  return c.json({ data: clubs });
});
