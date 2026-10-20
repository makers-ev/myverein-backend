import { boolean, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { organization } from "../../auth/auth-schema.js";

export const NOTICE_MODES = ["month_end", "quarter_end", "year_end", "immediate"] as const;
/** Reusable text snippet of a club (e.g. the default cancellation text); plain text, inserted by the client into the editor. */
export interface ClubTextBlock {
  key: string;
  title: string;
  text: string;
}

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
  // Club mail template (Wave 9). The sender ADDRESS stays EMAIL_FROM (SPF/DKIM), only name/signature/reply-to are per club.
  senderName: text("sender_name"),
  signature: text("signature"),
  replyTo: text("reply_to"),
  // Optional text blocks (Wave 9 B15): array of ClubTextBlock, validated by the route; NULL = none.
  textBlocks: jsonb("text_blocks").$type<ClubTextBlock[]>(),
  // IANA zone the club's time-based logic (reminders, sweeps) is computed in; instants are stored as UTC.
  timezone: text("timezone").notNull().default("Europe/Berlin"),
  reminderEventEnabled: boolean("reminder_event_enabled").notNull().default(true),
  reminderEventLeadHours: integer("reminder_event_lead_hours").notNull().default(24),
  reminderLoanEnabled: boolean("reminder_loan_enabled").notNull().default(true),
  reminderLoanLeadDays: integer("reminder_loan_lead_days").notNull().default(1),
  reminderMaintenanceEnabled: boolean("reminder_maintenance_enabled").notNull().default(true),
  reminderMaintenanceLeadDays: integer("reminder_maintenance_lead_days").notNull().default(7),
  reminderRsvpEnabled: boolean("reminder_rsvp_enabled").notNull().default(true),
  reminderRsvpLeadDays: integer("reminder_rsvp_lead_days").notNull().default(3),
  // Tell the reviewers (`members:write`) that a member invitation is about to expire / expired unaccepted.
  reminderInvitationEnabled: boolean("reminder_invitation_enabled").notNull().default(true),
  reminderInvitationLeadDays: integer("reminder_invitation_lead_days").notNull().default(3),
  // Tell holders (and guardians) that a credential (custom field type `credential`, `validUntil`) is about to expire / expired.
  reminderCredentialEnabled: boolean("reminder_credential_enabled").notNull().default(true),
  reminderCredentialLeadDays: integer("reminder_credential_lead_days").notNull().default(30),
  // Apply the age transition (member categories) automatically instead of only suggesting it. Default off.
  ageTransitionAuto: boolean("age_transition_auto").notNull().default(false),
  // Tell the members who review requests (`members:write`) about a new admission application / exit request (default on).
  notifyBoardRequests: boolean("notify_board_requests").notNull().default(true),
  // Tell people when they are invited to a meeting / a Terminfindung (default on).
  notifyMeetingInvites: boolean("notify_meeting_invites").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ClubSettingsRow = typeof clubSettings.$inferSelect;
