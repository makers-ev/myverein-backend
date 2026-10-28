import { Hono } from "hono";

import { computeClubStats } from "../lib/club-stats.js";
import { loadClubStatsInput } from "../lib/club-stats-load.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError } from "../lib/errors.js";
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

  const input = await loadClubStatsInput(clubId);
  return c.json({ data: computeClubStats(input, todayBerlin()) });
});
