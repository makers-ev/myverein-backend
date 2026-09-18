import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, date, uuid, uniqueIndex } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";

/**
 * 1:1 extension of Better Auth's `member` row (organization membership) with
 * club-specific attributes Better Auth itself has no concept of. Mirrors
 * MyHome's `household_profiles` sidecar pattern, just hung off `member`
 * instead of `organization` -- see Data Model - MyVerein Backend §3
 * "club_memberships".
 *
 * "category"/"role_type"-style fields are deliberately free text, not a DB
 * enum -- see the vault's Data Model doc §2 "Design Principles". Validation
 * happens in the route via Zod.
 */
export const clubMemberships = pgTable(
  "club_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    memberNumber: text("member_number"),
    // Freitext-Beispiele: "aktiv" | "passiv" | "foerdernd" | "ehrenmitglied" | "jugend"
    category: text("category").notNull().default("aktiv"),
    joinedAt: date("joined_at", { mode: "string" }).notNull(),
    leftAt: date("left_at", { mode: "string" }),
    birthDate: date("birth_date", { mode: "string" }),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("club_memberships_member_id_uidx").on(table.memberId)],
);

export const clubMembershipsRelations = relations(clubMemberships, ({ one }) => ({
  member: one(member, { fields: [clubMemberships.memberId], references: [member.id] }),
}));

export type ClubMembershipRow = typeof clubMemberships.$inferSelect;
export type NewClubMembershipRow = typeof clubMemberships.$inferInsert;
