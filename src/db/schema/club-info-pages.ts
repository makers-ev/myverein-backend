import { relations } from "drizzle-orm";
import { date, index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";

import { organization, user } from "../../auth/auth-schema.js";
import { documents } from "./documents.js";

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
    // Wave 13 B4: number of the current version in `club_info_page_versions`, who changed it last, from when it applies,
    // and an optional PDF attachment (e.g. the adopted Satzung) from the document archive.
    currentVersion: integer("current_version").notNull().default(1),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    validFrom: date("valid_from", { mode: "string" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  },
  (table) => [uniqueIndex("club_info_pages_club_slug_uidx").on(table.clubId, table.slug)],
);

/** Change history of an info page (Wave 13 B4): every write is a new version, restoring writes a new one as well. */
export const clubInfoPageVersions = pgTable(
  "club_info_page_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Versions die with their page (deleting a page removes its history; the deletion is audited).
    pageId: uuid("page_id")
      .notNull()
      .references(() => clubInfoPages.id, { onDelete: "cascade" }),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    title: text("title").notNull(),
    contentMarkdown: text("content_markdown"),
    externalUrl: text("external_url"),
    validFrom: date("valid_from", { mode: "string" }),
    documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
    note: text("note"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("club_info_page_versions_page_no_uidx").on(table.pageId, table.versionNo), index("club_info_page_versions_club_idx").on(table.clubId)],
);

export const clubInfoPagesRelations = relations(clubInfoPages, ({ one }) => ({
  club: one(organization, { fields: [clubInfoPages.clubId], references: [organization.id] }),
}));

export type ClubInfoPageRow = typeof clubInfoPages.$inferSelect;
export type NewClubInfoPageRow = typeof clubInfoPages.$inferInsert;
