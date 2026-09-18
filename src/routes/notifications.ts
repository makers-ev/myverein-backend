import { and, desc, eq, isNull, or } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/client.js";
import { notification, notificationState } from "../db/schema/notifications.js";
import { ForbiddenError, NotFoundError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Own-notifications routes. Lazy-state model (ADR-006): a missing
 * `notification_state` row means "unread, not deleted" for that user --
 * read/delete only ever upsert one row rather than pre-seeding a row per
 * recipient on every broadcast.
 */
export const notificationRoutes = new Hono<SessionEnv>();

notificationRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
notificationRoutes.use("*", sessionGuard);

/** Notifications broadcast to everyone or targeted at `userId`, joined with that user's own state. */
function visibleToUser(userId: string) {
  return db
    .select({ notification, state: notificationState })
    .from(notification)
    .leftJoin(
      notificationState,
      and(eq(notificationState.notificationId, notification.id), eq(notificationState.userId, userId)),
    )
    .where(
      and(
        or(isNull(notification.targetUserId), eq(notification.targetUserId, userId)),
        or(isNull(notificationState.deleted), eq(notificationState.deleted, false)),
      ),
    )
    .orderBy(desc(notification.createdAt));
}

notificationRoutes.get("/", async (c) => {
  const currentUser = c.get("user");
  const filter = c.req.query("filter");

  const rows = await visibleToUser(currentUser.id);
  const filtered =
    filter === "unread"
      ? rows.filter((row) => !row.state?.read)
      : filter === "read"
        ? rows.filter((row) => row.state?.read)
        : rows;

  return c.json({
    data: filtered.map(({ notification: n, state }) => ({
      ...n,
      read: state?.read ?? false,
      readAt: state?.readAt ?? null,
    })),
  });
});

notificationRoutes.get("/unread-count", async (c) => {
  const currentUser = c.get("user");
  const rows = await visibleToUser(currentUser.id);
  const count = rows.filter((row) => !row.state?.read).length;
  return c.json({ data: { count } });
});

/** Loads a notification and throws NotFoundError unless it's visible to `userId`. */
async function loadVisibleNotification(id: string, userId: string) {
  const row = await db.query.notification.findFirst({ where: eq(notification.id, id) });
  if (!row || (row.targetUserId !== null && row.targetUserId !== userId)) {
    throw new NotFoundError("Notification not found");
  }
  return row;
}

async function upsertState(
  notificationId: string,
  userId: string,
  values: Partial<typeof notificationState.$inferInsert>,
) {
  await db
    .insert(notificationState)
    .values({ notificationId, userId, ...values })
    .onConflictDoUpdate({
      target: [notificationState.notificationId, notificationState.userId],
      set: values,
    });
}

notificationRoutes.post("/:id/read", async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");

  await loadVisibleNotification(id, currentUser.id);
  await upsertState(id, currentUser.id, { read: true, readAt: new Date() });

  return c.json({ status: true });
});

notificationRoutes.post("/:id/unread", async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");

  await loadVisibleNotification(id, currentUser.id);
  await upsertState(id, currentUser.id, { read: false, readAt: null });

  return c.json({ status: true });
});

notificationRoutes.delete("/:id", async (c) => {
  const currentUser = c.get("user");
  const id = c.req.param("id");

  const row = await loadVisibleNotification(id, currentUser.id);
  if (!row.deletable) throw new ForbiddenError("This notification cannot be deleted");

  await upsertState(id, currentUser.id, { deleted: true, deletedAt: new Date() });

  return c.body(null, 204);
});
