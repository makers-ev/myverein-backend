import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organization } from "../../auth/auth-schema.js";

export const NOTICE_MODES = ["month_end", "quarter_end", "year_end", "immediate"] as const;
export type NoticeMode = (typeof NOTICE_MODES)[number];

/** Club-wide parameters (1:1 with `organization`). A missing row means "all defaults". */
export const clubSettings = pgTable("club_settings", {
  clubId: text("club_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  noticePeriodDays: integer("notice_period_days"),
  // One of NOTICE_MODES (validated via Zod, free text in the DB).
  noticeMode: text("notice_mode"),
  memberNumberPrefix: text("member_number_prefix"),
  allowSelfLoans: boolean("allow_self_loans").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ClubSettingsRow = typeof clubSettings.$inferSelect;
