import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { eventSeries } from "../db/schema/event-series.js";
import { writeAudit } from "./audit.js";
import { addDays, localDate } from "./club-time.js";
import { loadClubSettings } from "./club-settings.js";
import { addMonthsUtc, extendHorizon, HORIZON_MONTHS, lockSeries } from "./event-series.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";

/**
 * Horizon refill of event series (Wave 12 B6, ADR-009): the weekly job `event_series_refill` (scheduler of Wave 9) and the
 * read fallback `refillForRead` keep the materialized occurrences 12 months ahead. Idempotent: occurrences are inserted under
 * the unique key `(series_id, original_starts_at)`, dropped / moved / holiday days stay out (exceptions), so repeated and
 * parallel runs create nothing twice.
 */

export const SERIES_REFILL_JOB_TYPE = "event_series_refill";
export const SERIES_REFILL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Series handled per run; the rest follows on the next run (oldest horizon first). */
export const REFILL_BATCH = 200;
/** The read fallback never materializes further than this many months ahead of today, and extends a series by at most `READ_STEP_MONTHS` per read. */
const READ_CAP_MONTHS = 120;
const READ_STEP_MONTHS = 24;

export interface RefillResult {
  series: number;
  created: number;
}

/**
 * Extends series whose horizon lies before `target` (default: today + 12 months). `clubId` / `calendarIds` narrow the set.
 * A failing series is logged and skipped; the others continue.
 */
export async function refillSeries(options: { now?: Date; target?: Date; clubId?: string; calendarIds?: string[]; limit?: number; maxStepMonths?: number } = {}): Promise<RefillResult> {
  const now = options.now ?? new Date();
  const target = options.target ?? addMonthsUtc(now, HORIZON_MONTHS);
  // Series that ended long ago need no work; a day of slack covers every time zone.
  const stillRunning = or(isNull(eventSeries.untilDate), gte(eventSeries.untilDate, addDays(localDate(now, "UTC"), -2)));
  const scope = [lt(eventSeries.horizonUntil, target), stillRunning, options.clubId ? eq(calendars.clubId, options.clubId) : undefined, options.calendarIds ? inArray(eventSeries.calendarId, options.calendarIds) : undefined];
  const due = await db
    .select({ id: eventSeries.id, clubId: calendars.clubId, horizonUntil: eventSeries.horizonUntil })
    .from(eventSeries)
    .innerJoin(calendars, eq(calendars.id, eventSeries.calendarId))
    .where(and(...scope.filter((c) => c !== undefined)))
    .orderBy(asc(eventSeries.horizonUntil))
    .limit(options.limit ?? REFILL_BATCH);

  const result: RefillResult = { series: 0, created: 0 };
  for (const { id, clubId, horizonUntil } of due) {
    const seriesTarget = options.maxStepMonths ? new Date(Math.min(target.getTime(), addMonthsUtc(horizonUntil, options.maxStepMonths).getTime())) : target;
    try {
      await db.transaction(async (tx) => {
        const series = await lockSeries(tx, id);
        if (!series || series.horizonUntil.getTime() >= seriesTarget.getTime()) return; // refilled meanwhile by a parallel run
        const settings = await loadClubSettings(tx, clubId);
        const { created } = await extendHorizon(tx, series, settings.state, seriesTarget);
        result.series++;
        result.created += created;
        if (created > 0) await writeAudit(tx, { eventType: "event_series.extend", subjectId: id, clubId, actorUserId: null, payload: { clubId, created } });
      });
    } catch (err) {
      logger.error({ seriesId: id, errName: (err as Error)?.name }, "[event-series] refill failed for a series");
    }
  }
  return result;
}

/**
 * Fallback without a running worker: a read for a range reaching beyond some series' horizon materializes that range first
 * (capped at 10 years ahead of today, 24 months per series and 25 series per read). Never throws.
 */
export async function refillForRead(clubId: string, calendarIds: string[], to: Date, now: Date = new Date()): Promise<void> {
  try {
    const cap = addMonthsUtc(now, READ_CAP_MONTHS);
    const wanted = new Date(Math.min(addMonthsUtc(to, 1).getTime(), cap.getTime()));
    if (wanted.getTime() <= now.getTime() || calendarIds.length === 0) return;
    const [probe] = await db
      .select({ one: sql<number>`1` })
      .from(eventSeries)
      .where(and(inArray(eventSeries.calendarId, calendarIds), lt(eventSeries.horizonUntil, to)))
      .limit(1);
    if (!probe) return;
    await refillSeries({ now, target: wanted, clubId, calendarIds, limit: 25, maxStepMonths: READ_STEP_MONTHS });
  } catch (err) {
    logger.error({ clubId, errName: (err as Error)?.name }, "[event-series] read refill failed");
  }
}

export async function handleSeriesRefill(_job: JobContext): Promise<void> {
  const { series, created } = await refillSeries();
  if (created > 0) logger.info({ series, created }, "[event-series] horizon refilled");
}
