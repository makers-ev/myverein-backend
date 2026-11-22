import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { departments } from "./departments.js";

export const LEAD_STATUSES = ["neu", "kontaktiert", "probetraining", "mitglied", "abgelehnt"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_SOURCES = ["oeffentliche_seite", "manuell"] as const;

/**
 * Interested people and trial training (Wave 15 B4): enquiries from the public club page or entered by the board. Personal data
 * of non-members, so it is kept short: closed and stale leads are deleted by the retention rule `club_leads`. A lead becomes a
 * member record (`interessent`) through the explicit conversion (`converted_club_member_id`); the waitlist is per department,
 * ordered by `waitlisted_at`.
 */
export const clubLeads = pgTable(
  "club_leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Lower-cased; NULL only for manual leads without address.
    email: text("email"),
    phone: text("phone"),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    message: text("message"),
    source: text("source").notNull(),
    status: text("status").notNull().default("neu"),
    trialRequested: boolean("trial_requested").notNull().default(false),
    trialOn: date("trial_on", { mode: "string" }),
    waitlistedAt: timestamp("waitlisted_at", { withTimezone: true }),
    // Internal notes of the board.
    notes: text("notes"),
    privacyAcceptedAt: timestamp("privacy_accepted_at", { withTimezone: true }),
    requestCount: integer("request_count").notNull().default(1),
    lastRequestAt: timestamp("last_request_at", { withTimezone: true }).notNull().defaultNow(),
    convertedClubMemberId: uuid("converted_club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("club_leads_club_status_idx").on(table.clubId, table.status),
    index("club_leads_club_email_idx").on(table.clubId, table.email),
    index("club_leads_waitlist_idx").on(table.clubId, table.departmentId, table.waitlistedAt),
    check("club_leads_status_chk", sql`${table.status} IN ('neu', 'kontaktiert', 'probetraining', 'mitglied', 'abgelehnt')`),
    check("club_leads_source_chk", sql`${table.source} IN ('oeffentliche_seite', 'manuell')`),
  ],
);

export type ClubLeadRow = typeof clubLeads.$inferSelect;
