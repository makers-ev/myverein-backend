import { createHash } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { eventSeriesExceptions } from "../db/schema/event-series-exceptions.js";
import { eventSeries } from "../db/schema/event-series.js";
import { events } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { loadClubSettings } from "./club-settings.js";
import { buildIcs, type IcsEventInput, type IcsSeriesInput } from "./ics.js";

/** Plain-text place for the feed: name and address, never the access note. */
function placeText(name: string | null, address: string | null): string | null {
  const parts = [name, address].map((p) => p?.trim()).filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The iCal document for the given calendars (shared by the session feed `GET /events.ics` and the token feed
 * `GET /feeds/:token.ics`). The caller decides which calendars; this only renders. `etag` is a weak validator over the body
 * (DTSTAMP is the latest change, so the body only changes when an event does).
 */
export async function renderCalendarIcs(clubId: string, calendarIds: string[], options: { calendarName?: string } = {}): Promise<{ ics: string; etag: string }> {
  const settings = await loadClubSettings(db, clubId);
  const rows = calendarIds.length === 0 ? [] : await db.select({ event: events, placeName: locations.name, placeAddress: locations.address }).from(events).leftJoin(locations, eq(locations.id, events.locationId)).where(inArray(events.calendarId, calendarIds));
  const seriesRows = calendarIds.length === 0 ? [] : await db.select({ series: eventSeries, placeName: locations.name, placeAddress: locations.address }).from(eventSeries).leftJoin(locations, eq(locations.id, eventSeries.locationId)).where(inArray(eventSeries.calendarId, calendarIds));
  const exceptions = seriesRows.length === 0 ? [] : await db.select().from(eventSeriesExceptions).where(and(inArray(eventSeriesExceptions.seriesId, seriesRows.map((s) => s.series.id)), inArray(eventSeriesExceptions.kind, ["entfaellt", "feiertag"])));

  const eventInputs: IcsEventInput[] = rows.map(({ event: r, placeName, placeAddress }) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    cancelled: r.cancelledAt !== null,
    allDay: r.allDay,
    location: placeText(placeName, placeAddress),
    updatedAt: r.updatedAt,
    seriesId: r.seriesId,
    originalStartsAt: r.originalStartsAt,
    isOverride: r.isOverride,
  }));
  const seriesInputs: IcsSeriesInput[] = seriesRows.map(({ series: s, placeName, placeAddress }) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    location: placeText(placeName, placeAddress),
    timezone: s.timezone,
    allDay: s.allDay,
    startDate: s.startDate,
    startTime: s.startTime,
    durationMinutes: s.durationMinutes,
    durationDays: s.durationDays,
    freq: s.freq,
    interval: s.intervalCount,
    byDay: s.byDay,
    bySetPos: s.bySetPos,
    untilDate: s.untilDate,
    count: s.count,
    skipHolidays: s.skipHolidays,
    horizonUntil: s.horizonUntil,
    updatedAt: s.updatedAt,
    excluded: exceptions.filter((x) => x.seriesId === s.id).map((x) => x.originalStartsAt),
  }));
  const latest = Math.max(0, ...rows.map((r) => r.event.updatedAt.getTime()), ...seriesRows.map((s) => s.series.updatedAt.getTime()), ...exceptions.map((x) => x.createdAt.getTime()));
  const ics = buildIcs(eventInputs, { series: seriesInputs, stamp: new Date(latest), calendarName: options.calendarName, timezone: settings.timezone });
  return { ics, etag: `W/"${createHash("sha256").update(ics).digest("hex").slice(0, 32)}"` };
}
