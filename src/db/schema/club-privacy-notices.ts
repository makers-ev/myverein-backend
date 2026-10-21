import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organization, user } from "../../auth/auth-schema.js";

/**
 * Versioned privacy notice (Art. 13/14 GDPR) of a club, generated from a template plus the club's master data and
 * retention rules (Wave 10 B11). Immutable once published. A notice informs; it is NOT a consent and never conditions
 * membership or any feature.
 */
export const clubPrivacyNotices = pgTable(
  "club_privacy_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    // SHA-256 (hex) of `body`, so a stored acknowledgement can be tied to the exact text.
    sha256: text("sha256").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("club_privacy_notices_club_version_uidx").on(table.clubId, table.version),
    index("club_privacy_notices_club_published_idx").on(table.clubId, table.publishedAt),
  ],
);

export type ClubPrivacyNoticeRow = typeof clubPrivacyNotices.$inferSelect;
