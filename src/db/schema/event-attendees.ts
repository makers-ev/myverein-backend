import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";
import { events } from "./events.js";

/**
 * A member's RSVP for an event. See Data Model - MyVerein Backend §7
 * "event_attendees".
 */
export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    // Freitext-Beispiele: "angemeldet" | "abgesagt" | "warteliste".
    status: text("status").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("event_attendees_event_member_uidx").on(table.eventId, table.memberId)],
);

export const eventAttendeesRelations = relations(eventAttendees, ({ one }) => ({
  event: one(events, { fields: [eventAttendees.eventId], references: [events.id] }),
  member: one(member, { fields: [eventAttendees.memberId], references: [member.id] }),
}));

export type EventAttendeeRow = typeof eventAttendees.$inferSelect;
export type NewEventAttendeeRow = typeof eventAttendees.$inferInsert;
