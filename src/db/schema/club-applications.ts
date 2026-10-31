import { relations, sql } from "drizzle-orm";
import { pgTable, text, timestamp, date, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";

import { member, organization, user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { clubPrivacyNotices } from "./club-privacy-notices.js";
import { formSubmissions } from "./forms.js";

/**
 * Pending-approval queue for "digitaler Aufnahmeantrag". POST
 * /club-members/apply only writes here; a member + club_memberships row is
 * created when a board member with `members:write` approves the application
 * (POST /club-applications/:id/approve).
 *
 * `status` is free text ("pending" | "approved" | "rejected"), validated in
 * the routes -- same "no DB enums" principle as the rest of the schema. The
 * partial unique index allows only ONE pending application per user+club, but
 * a fresh application after a rejection is fine.
 */
export const clubApplications = pgTable(
  "club_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    category: text("category").notNull().default("aktiv"),
    birthDate: date("birth_date", { mode: "string" }),
    status: text("status").notNull().default("pending"),
    // Wave 8 B8: `self` (the applicant joins) or `guardian` (a parent applies for a child; `user_id` is the PARENT's account).
    onBehalfOf: text("on_behalf_of").notNull().default("self"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => member.id, { onDelete: "set null" }),
    // Wave 8: the filled-in application form (NULL for legacy applications, which keep `category`/`birth_date`).
    formSubmissionId: uuid("form_submission_id").references(() => formSubmissions.id, { onDelete: "set null" }),
    // Set when the application is accepted: the club_members row that was created or reused.
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    // Privacy notice shown to the applicant and when they acknowledged it (Wave 10 B11); NULL for older applications.
    privacyNoticeVersionId: uuid("privacy_notice_version_id").references(() => clubPrivacyNotices.id, { onDelete: "set null" }),
    privacyNoticeAcknowledgedAt: timestamp("privacy_notice_acknowledged_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("club_applications_pending_user_club_uidx")
      .on(table.userId, table.clubId)
      // Only a person's OWN application is limited to one open one per club; a parent may have several children pending
      // (capped at 5 open child applications per account in the routes).
      .where(sql`${table.status} = 'pending' AND ${table.onBehalfOf} = 'self'`),
    index("club_applications_club_status_idx").on(table.clubId, table.status),
  ],
);

export const clubApplicationsRelations = relations(clubApplications, ({ one }) => ({
  user: one(user, { fields: [clubApplications.userId], references: [user.id] }),
  club: one(organization, { fields: [clubApplications.clubId], references: [organization.id] }),
  decider: one(member, { fields: [clubApplications.decidedBy], references: [member.id] }),
}));

export type ClubApplicationRow = typeof clubApplications.$inferSelect;
export type NewClubApplicationRow = typeof clubApplications.$inferInsert;
