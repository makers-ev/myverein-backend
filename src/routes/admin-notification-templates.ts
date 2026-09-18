import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { notificationTemplate } from "../db/schema/notifications.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Registry of `translationKey`s a client can render as a system
 * notification (see NotificationTranslation.ts, both clients) that admins
 * are allowed to override the content of. Adding a new automated trigger
 * (a new `db.insert(notification)` call somewhere with a new
 * `translationKey`) means adding its key here too, or PATCH rejects it.
 */
export const NOTIFICATION_TEMPLATE_KEYS = ["notification.welcome"] as const;
export type NotificationTemplateKey = (typeof NOTIFICATION_TEMPLATE_KEYS)[number];

export const adminNotificationTemplateRoutes = new Hono<SessionEnv>();

adminNotificationTemplateRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
adminNotificationTemplateRoutes.use("*", adminGuard);

const translationEntrySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
});

/** Keyed by language id from the shared SUPPORTED_LANGUAGES registry (ADR-009); de/en are required, the rest are whatever the admin has filled in so far. */
const upsertTemplateSchema = z.object({
  translations: z.record(z.string(), translationEntrySchema).refine((t) => t.de && t.en, {
    message: "translations must include at least 'de' and 'en'",
  }),
});

/** One row per known key -- a missing DB override still needs to show up so admins know it exists and can be edited. */
adminNotificationTemplateRoutes.get("/", async (c) => {
  const overrides = await db.query.notificationTemplate.findMany();
  const byKey = new Map(overrides.map((row) => [row.translationKey, row]));

  const data = NOTIFICATION_TEMPLATE_KEYS.map((translationKey) => {
    const override = byKey.get(translationKey);
    return {
      translationKey,
      translations: override?.translations ?? null,
      updatedAt: override?.updatedAt ?? null,
    };
  });

  return c.json({ data });
});

adminNotificationTemplateRoutes.patch(
  "/:key",
  zValidator("json", upsertTemplateSchema, (result) => {
    if (!result.success) {
      throw new ValidationError("Invalid request body", { details: result.error.issues });
    }
  }),
  async (c) => {
    const currentUser = c.get("user");
    const key = c.req.param("key");
    if (!NOTIFICATION_TEMPLATE_KEYS.includes(key as NotificationTemplateKey)) {
      throw new NotFoundError("Unknown notification template key");
    }
    const { translations } = c.req.valid("json");

    const [row] = await db
      .insert(notificationTemplate)
      .values({ translationKey: key, translations, updatedByAdminId: currentUser.id })
      .onConflictDoUpdate({
        target: notificationTemplate.translationKey,
        set: { translations, updatedAt: new Date(), updatedByAdminId: currentUser.id },
      })
      .returning();

    return c.json({ data: row });
  },
);

/** Reverts a key to its built-in translationKey text (both clients' fallback) by deleting the override. Idempotent. */
adminNotificationTemplateRoutes.delete("/:key", async (c) => {
  const key = c.req.param("key");
  if (!NOTIFICATION_TEMPLATE_KEYS.includes(key as NotificationTemplateKey)) {
    throw new NotFoundError("Unknown notification template key");
  }

  await db.delete(notificationTemplate).where(eq(notificationTemplate.translationKey, key));

  return c.body(null, 204);
});
