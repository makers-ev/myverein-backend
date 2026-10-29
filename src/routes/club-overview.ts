import { Hono } from "hono";

import { buildToday } from "../lib/club-today.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/** `/clubs/:clubId/today` and `/clubs/:clubId/search` (Wave 14). A non-member gets 404 from `clubGuard`. */
export const clubOverviewRoutes = new Hono<ClubEnv>();

clubOverviewRoutes.use("/:clubId/*", rateLimit({ windowMs: 60_000, max: 120 }));
clubOverviewRoutes.use("/:clubId/*", sessionGuard);
clubOverviewRoutes.use("/:clubId/*", clubGuard);

clubOverviewRoutes.get("/:clubId/today", async (c) => {
  const membership = c.get("membership");
  const data = await buildToday({ clubId: c.get("clubId"), userId: c.get("user").id, accountMemberId: membership.id, isGuest: membership.role === "guest", roleTypes: c.get("clubRoleTypes") });
  c.header("Cache-Control", "private, no-store");
  return c.json({ data });
});
