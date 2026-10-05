import { asc, count, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { member, organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubRegistrations } from "../db/schema/club-registrations.js";
import { ValidationError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Club aggregates for the admin panel: total club count + open registration count (dashboard KPI / navbar badge) and
 * the clubs each of a page of users belongs to (user list column).
 */
export const adminClubRoutes = new Hono<SessionEnv>();

adminClubRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
adminClubRoutes.use("*", adminGuard);

const MAX_USER_IDS = 100;

adminClubRoutes.get("/club-stats", async (c) => {
  const [[clubRow], [pendingRow]] = await Promise.all([
    db.select({ total: count() }).from(organization),
    db.select({ pending: count() }).from(clubRegistrations).where(eq(clubRegistrations.status, "pending")),
  ]);
  return c.json({
    clubs: { total: Number(clubRow?.total ?? 0) },
    registrations: { pending: Number(pendingRow?.pending ?? 0) },
  });
});

adminClubRoutes.get("/user-clubs", async (c) => {
  const raw = c.req.query("userIds") ?? "";
  const userIds = [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0))];

  if (userIds.length === 0) {
    throw new ValidationError("userIds must contain at least one user id");
  }
  if (userIds.length > MAX_USER_IDS) {
    throw new ValidationError(`userIds may contain at most ${MAX_USER_IDS} ids`);
  }

  const rows = await db
    .select({ userId: member.userId, clubId: organization.id, name: organization.name, slug: organization.slug })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(inArray(member.userId, userIds))
    .orderBy(asc(organization.name), asc(organization.slug));

  const data: Record<string, Array<{ clubId: string; name: string; slug: string }>> = {};
  for (const id of userIds) data[id] = [];
  for (const r of rows) {
    const list = data[r.userId];
    if (list && !list.some((club) => club.clubId === r.clubId)) {
      list.push({ clubId: r.clubId, name: r.name, slug: r.slug });
    }
  }

  return c.json({ data });
});
