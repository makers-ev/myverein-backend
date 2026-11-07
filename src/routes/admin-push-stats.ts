import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/client.js";
import { messageDeliveries, pushTokens } from "../db/schema/communication.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Push delivery health for the admin dashboard, filtered out of the
 * omni-channel `message_deliveries` table (`channel = 'push'`) rather than a
 * dedicated outbox like myhome's `scheduled_notifications`. "Overdue" has no
 * separate `fire_at` column to compare against here, so it's approximated as
 * `queued`/`sending` rows older than 5 minutes, same threshold as myhome's
 * job runner uses for its own outbox. Counts only, never recipients or texts.
 */
export const adminPushStatsRoutes = new Hono<SessionEnv>();

adminPushStatsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
adminPushStatsRoutes.use("*", adminGuard);

adminPushStatsRoutes.get("/push-stats", async (c) => {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({
      sent: sql<number>`count(*) filter (where ${messageDeliveries.status} = 'sent')::int`,
      failed: sql<number>`count(*) filter (where ${messageDeliveries.status} in ('failed', 'bounced'))::int`,
      pending: sql<number>`count(*) filter (where ${messageDeliveries.status} in ('queued', 'sending'))::int`,
      overdue: sql<number>`count(*) filter (where ${messageDeliveries.status} in ('queued', 'sending') and ${messageDeliveries.createdAt} < now() - interval '5 minutes')::int`,
    })
    .from(messageDeliveries)
    .where(and(eq(messageDeliveries.channel, "push"), gte(messageDeliveries.createdAt, since)));
  const [tokens] = await db.select({ total: sql<number>`count(*)::int` }).from(pushTokens).where(isNull(pushTokens.disabledAt));
  return c.json({
    data: {
      windowDays: 7,
      sent: row.sent,
      failed: row.failed,
      pending: row.pending,
      overdue: row.overdue,
      deliveryRate: row.sent + row.failed === 0 ? null : Math.round((row.sent / (row.sent + row.failed)) * 1000) / 10,
      pushTokens: tokens.total,
    },
  });
});
