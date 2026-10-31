import { relations, sql } from "drizzle-orm";
import { boolean, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";

/**
 * Links an external guardian membership (an account `member`) (member.role = "guest", club_roles
 * role_type = "erziehungsberechtigt") to the youth club member(s) (`club_members`, with or without account) they're
 * responsible for. Many-to-many: one guardian can have several kids in the
 * club, one kid can have several guardians.
 *
 * This table is THE scoping boundary for the external guardian role -- any
 * route that returns calendar/attendance data for a specific memberId while
 * the caller is a guest must additionally verify a row exists here for
 * (caller, requested member). See Data Model - MyVerein Backend §6.
 */
export const guardianLinks = pgTable(
  "guardian_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    guardianMemberId: text("guardian_member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    // Wave 7 (ADR-003): the ward is a club_members row (children without an account); the guardian stays an account.
    wardClubMemberId: uuid("ward_club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    // Wave 10 B1: what the guardian may do for the ward. Valid from/until are checked at READ time (no cron dependency).
    relationship: text("relationship"),
    hasCustody: boolean("has_custody").notNull().default(true),
    canConsent: boolean("can_consent").notNull().default(true),
    canReportAbsence: boolean("can_report_absence").notNull().default(true),
    validFrom: date("valid_from", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
    validUntil: date("valid_until", { mode: "string" }),
    // The board confirms a link; NULL = not yet confirmed (the link then grants nothing).
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    confirmedBy: text("confirmed_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("guardian_links_pair_uidx").on(table.guardianMemberId, table.wardClubMemberId),
    index("guardian_links_ward_id_idx").on(table.wardClubMemberId),
  ],
);

export const guardianLinksRelations = relations(guardianLinks, ({ one }) => ({
  guardian: one(member, { fields: [guardianLinks.guardianMemberId], references: [member.id] }),
  ward: one(clubMembers, { fields: [guardianLinks.wardClubMemberId], references: [clubMembers.id] }),
}));

export type GuardianLinkRow = typeof guardianLinks.$inferSelect;
export type NewGuardianLinkRow = typeof guardianLinks.$inferInsert;
