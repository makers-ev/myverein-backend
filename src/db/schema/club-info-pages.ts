import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";

import { organization } from "../../auth/auth-schema.js";

/**
 * Generic "info page" for a club's Vereinsinfo section (Satzung, Leitbild,
 * Geschichte, Beitragsordnung, ...). Deliberately generic instead of one
 * column per document type -- a club can add arbitrary further pages (e.g.
 * "Hausordnung") without a schema change. See Data Model - MyVerein Backend
 * §3 "club_info_pages".
 */
export const clubInfoPages = pgTable(
  "club_info_pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Freitext-Beispiele: "satzung" | "leitbild" | "geschichte" | "beitragsordnung"
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    contentMarkdown: text("content_markdown"),
    externalUrl: text("external_url"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("club_info_pages_club_slug_uidx").on(table.clubId, table.slug)],
);

export const clubInfoPagesRelations = relations(clubInfoPages, ({ one }) => ({
  club: one(organization, { fields: [clubInfoPages.clubId], references: [organization.id] }),
}));

export type ClubInfoPageRow = typeof clubInfoPages.$inferSelect;
export type NewClubInfoPageRow = typeof clubInfoPages.$inferInsert;
