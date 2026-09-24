import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, date, uuid, index, unique } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";
import { departments } from "./departments.js";

/**
 * Fine-grained club role assigned to a membership, layered on top of Better
 * Auth's coarse `member.role` ("admin"/"member"/"guest"). A member can hold
 * several rows at once (e.g. "kassenwart" + "trainer" of one department).
 *
 * Module permissions are NOT stored here -- they're derived from `roleType`
 * in `src/lib/club-permissions.ts` (config code, not a DB rights matrix).
 * See Architecture Overview - MyVerein §7 and Data Model §5 "Alternatives
 * Considered" for why.
 */
export const clubRoles = pgTable(
  "club_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    // Freitext-Beispiele: "vorsitz" | "stellv_vorsitz" | "kassenwart" |
    // "schriftfuehrer" | "beisitzer" | "abteilungsleitung" | "trainer" |
    // "erziehungsberechtigt" -- see club-permissions.ts for the full set this
    // backend actually understands.
    roleType: text("role_type").notNull(),
    // Only set for department-bound roles (abteilungsleitung, trainer).
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
    termEndsAt: date("term_ends_at", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("club_roles_member_id_idx").on(table.memberId),
    index("club_roles_department_id_idx").on(table.departmentId),
    // Same role twice for one member is meaningless; NULLS NOT DISTINCT so department-less roles count too.
    unique("club_roles_member_role_department_uq").on(table.memberId, table.roleType, table.departmentId).nullsNotDistinct(),
  ],
);

export const clubRolesRelations = relations(clubRoles, ({ one }) => ({
  member: one(member, { fields: [clubRoles.memberId], references: [member.id] }),
  department: one(departments, { fields: [clubRoles.departmentId], references: [departments.id] }),
}));

export type ClubRoleRow = typeof clubRoles.$inferSelect;
export type NewClubRoleRow = typeof clubRoles.$inferInsert;
