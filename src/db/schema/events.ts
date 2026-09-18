import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, index } from "drizzle-orm/pg-core";

import { user } from "../../auth/auth-schema.js";
import { calendars } from "./calendars.js";

/**
 * A single calendar entry (training, match, board meeting, ...). See Data
 * Model - MyVerein Backend §7 "events".
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    // Freitext-Beispiele: "Training" | "Wettkampf" | "Vorstandssitzung" |
    // "Fest" | "Wartung".
    category: text("category"),
    capacity: integer("capacity"),
    // No FK yet -- the locations table doesn't exist until Wave 3. Add the
    // reference once it lands.
    locationId: uuid("location_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("events_calendar_id_idx").on(table.calendarId),
    index("events_starts_at_idx").on(table.startsAt),
  ],
);

export const eventsRelations = relations(events, ({ one }) => ({
  calendar: one(calendars, { fields: [events.calendarId], references: [calendars.id] }),
  creator: one(user, { fields: [events.createdBy], references: [user.id] }),
}));

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
