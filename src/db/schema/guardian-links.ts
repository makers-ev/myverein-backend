import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";

/**
 * Links an external guardian membership (member.role = "guest", club_roles
 * role_type = "erziehungsberechtigt") to the youth member(s) they're
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
    wardMemberId: text("ward_member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("guardian_links_pair_uidx").on(table.guardianMemberId, table.wardMemberId),
    index("guardian_links_ward_id_idx").on(table.wardMemberId),
  ],
);

export const guardianLinksRelations = relations(guardianLinks, ({ one }) => ({
  guardian: one(member, { fields: [guardianLinks.guardianMemberId], references: [member.id] }),
  ward: one(member, { fields: [guardianLinks.wardMemberId], references: [member.id] }),
}));

export type GuardianLinkRow = typeof guardianLinks.$inferSelect;
export type NewGuardianLinkRow = typeof guardianLinks.$inferInsert;
