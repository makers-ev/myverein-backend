import { Hono } from "hono";

import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError } from "../lib/errors.js";
import { storageUsage } from "../lib/media-quota.js";
import { clubGuard, denyExternalGuests, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/** Storage usage of the club (Wave 13 B3): numbers only, never file names. Needs `storage:read`. */
export const clubStorageRoutes = new Hono<ClubEnv>();

clubStorageRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubStorageRoutes.use("*", sessionGuard);
clubStorageRoutes.use("*", clubGuard);

clubStorageRoutes.get("/", async (c) => {
  denyExternalGuests(c);
  if (!hasClubPermission(c.get("clubRoleTypes"), "storage:read")) throw new ForbiddenError("Missing storage:read permission");
  return c.json({ data: await storageUsage(c.get("clubId")) });
});
