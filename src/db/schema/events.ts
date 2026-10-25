import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, index, boolean } from "drizzle-orm/pg-core";

import { user } from "../../auth/auth-schema.js";
import { calendars } from "./calendars.js";
import { locations } from "./locations.js";

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
    // All-day entry (Wave 12): clients show no time of day; `starts_at`/`ends_at` stay the instants of the club-local day boundaries.
    allDay: boolean("all_day").notNull().default(false),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    // NULL once the creating account was deleted (the calendar / event stays, it belongs to the club).
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    // Cancellation instead of deletion (Wave 9): NULL = event takes place. Existing routes ignore these columns.
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("events_calendar_id_idx").on(table.calendarId),
    index("events_starts_at_idx").on(table.startsAt),
    index("events_ends_at_idx").on(table.endsAt),
  ],
);

export const eventsRelations = relations(events, ({ one }) => ({
  calendar: one(calendars, { fields: [events.calendarId], references: [calendars.id] }),
  creator: one(user, { fields: [events.createdBy], references: [user.id] }),
  location: one(locations, { fields: [events.locationId], references: [locations.id] }),
}));

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
