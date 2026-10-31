import { relations } from "drizzle-orm";
import { pgTable, text, uuid, integer, time, date, boolean, index } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";

/**
 * A recurring weekly availability window for a member. Member-scoped, not
 * club-scoped -- a person can theoretically belong to several clubs, and
 * availability belongs to the specific membership. See Data Model -
 * MyVerein Backend §2 and §7 "availability_slots".
 */
export const availabilitySlots = pgTable(
  "availability_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    // 0-6, Monday-Sunday.
    weekday: integer("weekday").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    note: text("note"),
  },
  (table) => [index("availability_slots_member_id_idx").on(table.memberId)],
);

/** A one-off override of a member's recurring availability for a single date. */
export const availabilityExceptions = pgTable(
  "availability_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    date: date("date", { mode: "string" }).notNull(),
    isAvailable: boolean("is_available").notNull(),
    note: text("note"),
  },
  (table) => [index("availability_exceptions_member_id_idx").on(table.memberId)],
);

export const availabilitySlotsRelations = relations(availabilitySlots, ({ one }) => ({
  member: one(member, { fields: [availabilitySlots.memberId], references: [member.id] }),
}));

export const availabilityExceptionsRelations = relations(availabilityExceptions, ({ one }) => ({
  member: one(member, { fields: [availabilityExceptions.memberId], references: [member.id] }),
}));

export type AvailabilitySlotRow = typeof availabilitySlots.$inferSelect;
export type NewAvailabilitySlotRow = typeof availabilitySlots.$inferInsert;
export type AvailabilityExceptionRow = typeof availabilityExceptions.$inferSelect;
export type NewAvailabilityExceptionRow = typeof availabilityExceptions.$inferInsert;
