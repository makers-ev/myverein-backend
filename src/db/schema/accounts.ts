import { pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";

import { user } from "../../auth/auth-schema.js";

/**
 * Generic example CRUD resource. This is intentionally NOT fixed business
 * logic -- a real project deletes this table/route pair and replaces it with
 * its own domain, per NEW-ARCHITECTURE-README §7 ("domain logic baked into a
 * template" was a documented pain point of the old suite).
 *
 * It exists here only to demonstrate the shape of a session-guarded,
 * Drizzle-backed CRUD resource: ownership via `owner_id` -> Better Auth's
 * `user.id`, soft-delete via `archived`, and an audit-friendly timestamp.
 */
export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
