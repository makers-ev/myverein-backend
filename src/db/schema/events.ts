import { relations } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, index, boolean, uniqueIndex } from "drizzle-orm/pg-core";

import { user } from "../../auth/auth-schema.js";
import { calendars } from "./calendars.js";
import { eventSeries } from "./event-series.js";
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
    // Series occurrence (Wave 12): `original_starts_at` is the instant the rule produced (stays when the occurrence is moved),
    // `is_override` marks an occurrence edited on its own ("only this one").
    seriesId: uuid("series_id").references(() => eventSeries.id, { onDelete: "set null" }),
    originalStartsAt: timestamp("original_starts_at", { withTimezone: true }),
    isOverride: boolean("is_override").notNull().default(false),
    // Display only (no payment handling): free text and/or amount in cents.
    costNote: text("cost_note"),
    costCents: integer("cost_cents"),
    // Whether an attendance list is kept for this event.
    attendanceTracking: boolean("attendance_tracking").notNull().default(false),
    // SHA-256 of the public registration link token (guests without account); NULL = no public link. The plain token is shown once.
    publicRegistrationTokenHash: text("public_registration_token_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("events_calendar_id_idx").on(table.calendarId),
    index("events_starts_at_idx").on(table.startsAt),
    index("events_ends_at_idx").on(table.endsAt),
    uniqueIndex("events_series_original_uidx").on(table.seriesId, table.originalStartsAt).where(sql`${table.seriesId} IS NOT NULL`),
    uniqueIndex("events_public_registration_token_uidx").on(table.publicRegistrationTokenHash).where(sql`${table.publicRegistrationTokenHash} IS NOT NULL`),
  ],
);

export const eventsRelations = relations(events, ({ one }) => ({
  calendar: one(calendars, { fields: [events.calendarId], references: [calendars.id] }),
  creator: one(user, { fields: [events.createdBy], references: [user.id] }),
  location: one(locations, { fields: [events.locationId], references: [locations.id] }),
  series: one(eventSeries, { fields: [events.seriesId], references: [eventSeries.id] }),
}));

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
