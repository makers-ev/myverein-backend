import { pgTable, text, timestamp, uuid, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

import { user } from "../../auth/auth-schema.js";

/**
 * Two content models share one table (see ADR-006): a "system" notification
 * carries `translationKey`/`paramsJson` so every client renders it in the
 * viewer's own language (mirrors the mobile/website `t()` pattern); an
 * "admin" notification is pre-translated into a `translations` JSONB blob
 * instead (ADR-009 -- `Record<langCode, {title, body}>`, replaces the old
 * fixed `titleDe`/`titleEn`/`bodyDe`/`bodyEn` columns so a new language is a
 * registry entry, not a migration). `targetUserId` null means a broadcast to
 * every user.
 */
export const notification = pgTable("notification", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull().$type<"system" | "admin">(),
  targetUserId: text("target_user_id").references(() => user.id, { onDelete: "cascade" }),
  translationKey: text("translation_key"),
  paramsJson: jsonb("params_json").$type<Record<string, unknown>>(),
  translations: jsonb("translations").$type<Record<string, { title: string; body: string }>>(),
  deletable: boolean("deletable").notNull().default(true),
  createdByAdminId: text("created_by_admin_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Lazy per-user state (ADR-006): no row here means "unread, not deleted" for
 * that user -- read/delete only ever upserts a row instead of pre-seeding
 * one per recipient, which would be a fan-out write on every broadcast.
 */
export const notificationState = pgTable(
  "notification_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notification.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    read: boolean("read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    deleted: boolean("deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("notification_state_notification_user_uidx").on(table.notificationId, table.userId)],
);

/**
 * Admin-editable override for a "system" notification's content, keyed by
 * the same `translationKey` the client-side translation files use (see
 * `notification.welcome` in NotificationTranslation.ts, both clients). A
 * missing row means "no override yet" -- the welcome hook (auth.ts) and
 * both clients fall back to the built-in translationKey text, so this
 * table shipping empty is not a breaking change for existing deployments.
 */
export const notificationTemplate = pgTable("notification_template", {
  translationKey: text("translation_key").primaryKey(),
  translations: jsonb("translations").$type<Record<string, { title: string; body: string }>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedByAdminId: text("updated_by_admin_id").references(() => user.id, { onDelete: "set null" }),
});

export type NotificationRow = typeof notification.$inferSelect;
export type NewNotificationRow = typeof notification.$inferInsert;
export type NotificationStateRow = typeof notificationState.$inferSelect;
export type NewNotificationStateRow = typeof notificationState.$inferInsert;
export type NotificationTemplateRow = typeof notificationTemplate.$inferSelect;
export type NewNotificationTemplateRow = typeof notificationTemplate.$inferInsert;
