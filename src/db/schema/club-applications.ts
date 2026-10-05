import { relations, sql } from "drizzle-orm";
import { pgTable, text, timestamp, date, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";

import { member, organization, user } from "../../auth/auth-schema.js";

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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => member.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("club_applications_pending_user_club_uidx")
      .on(table.userId, table.clubId)
      .where(sql`${table.status} = 'pending'`),
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
