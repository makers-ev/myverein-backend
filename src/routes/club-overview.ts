import { Hono } from "hono";

import { buildToday } from "../lib/club-today.js";
import { normalizeLimit, normalizeQuery, searchClub } from "../lib/club-search.js";
import { buildPrincipal } from "../lib/document-access.js";
import { canSeeAllMembers } from "../lib/member-read-scope.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/** `/clubs/:clubId/today` and `/clubs/:clubId/search` (Wave 14). A non-member gets 404 from `clubGuard`. */
export const clubOverviewRoutes = new Hono<ClubEnv>();

clubOverviewRoutes.use("/:clubId/*", rateLimit({ windowMs: 60_000, max: 120 }));
clubOverviewRoutes.use("/:clubId/*", sessionGuard);
clubOverviewRoutes.use("/:clubId/*", clubGuard);
// Per user (after sessionGuard), on top of the per-IP limit above, so a shared NAT does not throttle a whole club.
const perUser = (bucket: string, max: number) => rateLimit({ windowMs: 60_000, max, key: (c) => `${bucket}:${c.get("user")?.id ?? "anonymous"}` });
clubOverviewRoutes.get("/:clubId/today", perUser("club-today", 120));
clubOverviewRoutes.get("/:clubId/search", perUser("club-search", 60));

clubOverviewRoutes.get("/:clubId/today", async (c) => {
  const membership = c.get("membership");
  const data = await buildToday({ clubId: c.get("clubId"), userId: c.get("user").id, accountMemberId: membership.id, isGuest: membership.role === "guest", roleTypes: c.get("clubRoleTypes") });
  c.header("Cache-Control", "private, no-store");
  return c.json({ data });
});

/** Global search (Wave 14 S2): `?q=` (>= 2 characters, else `400 QUERY_TOO_SHORT`), `?limit=` per group (default 5, max 10). */
clubOverviewRoutes.get("/:clubId/search", async (c) => {
  const q = normalizeQuery(c.req.query("q"));
  const limit = normalizeLimit(c.req.query("limit"));
  const principal = await buildPrincipal(c);
  const data = await searchClub({ ...principal, seesAllMembers: canSeeAllMembers(c) }, q, limit);
  c.header("Cache-Control", "private, no-store");
  return c.json({ data });
});
