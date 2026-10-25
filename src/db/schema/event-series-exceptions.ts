import { index, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";

import { events } from "./events.js";
import { eventSeries } from "./event-series.js";

/** Kinds of a series exception. `feiertag` = skipped because of `skip_holidays` (kept so the horizon refill does not recreate it). */
export const SERIES_EXCEPTION_KINDS = ["entfaellt", "verschoben", "feiertag"] as const;
export type SeriesExceptionKind = (typeof SERIES_EXCEPTION_KINDS)[number];

/** An occurrence of a series that does not follow the rule: dropped, moved/overridden, or skipped for a holiday. */
export const eventSeriesExceptions = pgTable(
  "event_series_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seriesId: uuid("series_id")
      .notNull()
      .references(() => eventSeries.id, { onDelete: "cascade" }),
    // The instant the rule produces for this occurrence (the identity of the occurrence within the series).
    originalStartsAt: timestamp("original_starts_at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    // The override event (`verschoben`); NULL for dropped / holiday occurrences.
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("event_series_exceptions_series_original_uidx").on(table.seriesId, table.originalStartsAt), index("event_series_exceptions_event_id_idx").on(table.eventId)],
);

export type EventSeriesExceptionRow = typeof eventSeriesExceptions.$inferSelect;
