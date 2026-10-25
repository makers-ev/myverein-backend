import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, text, time, timestamp, uuid } from "drizzle-orm/pg-core";

import { user } from "../../auth/auth-schema.js";
import { calendars } from "./calendars.js";
import { locations } from "./locations.js";

/** Supported repeat frequencies (subset of RFC 5545 `FREQ`). */
export const SERIES_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type SeriesFrequency = (typeof SERIES_FREQUENCIES)[number];

/** Weekday codes of `by_day` (RFC 5545). */
export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * Rule and template of a recurring event (Wave 12, ADR-009). Every occurrence is materialized as a row in `events`
 * (`series_id`, `original_starts_at`) up to `horizon_until`; the rule is a subset of RFC 5545 RRULE. Dates and times are
 * LOCAL values in `timezone`, so "18:00" stays 18:00 across daylight saving switches.
 */
export const eventSeries = pgTable(
  "event_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    // Template copied to the occurrences.
    title: text("title").notNull(),
    description: text("description"),
    category: text("category"),
    capacity: integer("capacity"),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    allDay: boolean("all_day").notNull().default(false),
    // Local start of the FIRST occurrence; `start_time` is NULL for all-day series.
    startDate: date("start_date", { mode: "string" }).notNull(),
    startTime: time("start_time"),
    // Timed series: length in minutes (NULL = no end). All-day series: number of days (>= 1).
    durationMinutes: integer("duration_minutes"),
    durationDays: integer("duration_days").notNull().default(1),
    timezone: text("timezone").notNull().default("Europe/Berlin"),
    // Rule (one of SERIES_FREQUENCIES), step, weekdays (WEEKDAYS; weekly) and the n-th weekday of a month (monthly:
    // `by_day` of one weekday + `by_set_pos` 1..4 or -1; NULL set_pos = same day of the month as `start_date`).
    freq: text("freq").notNull(),
    intervalCount: integer("interval_count").notNull().default(1),
    byDay: text("by_day").array(),
    bySetPos: integer("by_set_pos"),
    // End: at most one of `until_date` (inclusive, local date) and `count`; both NULL = open (horizon only).
    untilDate: date("until_date", { mode: "string" }),
    count: integer("count"),
    skipHolidays: boolean("skip_holidays").notNull().default(false),
    // Occurrences exist up to here; the worker / read path extends it.
    horizonUntil: timestamp("horizon_until", { withTimezone: true }).notNull().defaultNow(),
    // Set when a "this and following" edit split the series: the series this one continues.
    splitFromSeriesId: uuid("split_from_series_id"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("event_series_calendar_id_idx").on(table.calendarId),
    check("event_series_end_chk", sql`${table.untilDate} IS NULL OR ${table.count} IS NULL`),
    check("event_series_interval_chk", sql`${table.intervalCount} >= 1`),
  ],
);

export type EventSeriesRow = typeof eventSeries.$inferSelect;
export type NewEventSeriesRow = typeof eventSeries.$inferInsert;
