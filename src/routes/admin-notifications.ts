import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { notification } from "../db/schema/notifications.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Admin-authored notifications -- the "admin" content model from
 * ADR-006, pre-translated into a `translations` JSONB blob (ADR-009,
 * `Record<langCode, {title, body}>`) instead of `translationKey`, as
 * opposed to the system-generated welcome notification in
 * src/auth/auth.ts.
 */
export const adminNotificationRoutes = new Hono<SessionEnv>();

adminNotificationRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
adminNotificationRoutes.use("*", adminGuard);

/** Keyed by language id from the shared SUPPORTED_LANGUAGES registry (ADR-009); de/en are required. */
const createNotificationSchema = z.object({
  targetUserId: z.string().min(1).max(256).optional(),
  translations: z
    .record(z.string(), z.object({ title: z.string().min(1).max(200), body: z.string().min(1).max(2000) }))
    .refine((t) => t.de && t.en, { message: "translations must include at least 'de' and 'en'" }),
  deletable: z.boolean(),
});

adminNotificationRoutes.get("/", async (c) => {
  // Joined for display purposes only (the admin-panel list shows the
  // target's email, not just their id) -- the user-facing routes in
  // notifications.ts never need this join.
  const rows = await db
    .select({ notification, targetUserEmail: user.email })
    .from(notification)
    .leftJoin(user, eq(notification.targetUserId, user.id))
    .where(eq(notification.kind, "admin"))
    .orderBy(desc(notification.createdAt));

  return c.json({ data: rows.map(({ notification: n, targetUserEmail }) => ({ ...n, targetUserEmail })) });
});

adminNotificationRoutes.post(
  "/",
  zValidator("json", createNotificationSchema, (result) => {
    if (!result.success) {
      throw new ValidationError("Invalid request body", { details: result.error.issues });
    }
  }),
  async (c) => {
    const currentUser = c.get("user");
    const body = c.req.valid("json");

    const [row] = await db
      .insert(notification)
      .values({
        kind: "admin",
        targetUserId: body.targetUserId ?? null,
        translations: body.translations,
        deletable: body.deletable,
        createdByAdminId: currentUser.id,
      })
      .returning();

    return c.json({ data: row }, 201);
  },
);

adminNotificationRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");

  const [row] = await db.delete(notification).where(eq(notification.id, id)).returning();
  if (!row) throw new NotFoundError("Notification not found");

  return c.body(null, 204);
});
