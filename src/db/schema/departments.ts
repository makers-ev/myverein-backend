import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";

/**
 * A sub-unit of a club (e.g. "Fußball", "Tennis", "Jugendfeuerwehr").
 * Optional -- a small club may never create one and everything stays
 * club-wide. See Data Model - MyVerein Backend §3 "departments".
 */
export const departments = pgTable(
  "departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Quick "who's responsible" pointer for the Vereinsinfo page. The
    // authoritative role assignment still lives in club_roles
    // (role_type: "abteilungsleitung", scoped to this department) -- this
    // field is a denormalized convenience, not the source of truth.
    leadMemberId: text("lead_member_id").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("departments_club_id_idx").on(table.clubId)],
);

export const departmentsRelations = relations(departments, ({ one }) => ({
  club: one(organization, { fields: [departments.clubId], references: [organization.id] }),
  lead: one(member, { fields: [departments.leadMemberId], references: [member.id] }),
}));

export type DepartmentRow = typeof departments.$inferSelect;
export type NewDepartmentRow = typeof departments.$inferInsert;
