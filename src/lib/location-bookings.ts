import { and, asc, eq, gt, isNull, lt, ne, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { locationBookings } from "../db/schema/event-extras.js";
import { events } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import type { DbExecutor } from "./club-members.js";
import { isCalendarVisible } from "./calendar-visibility.js";

/**
 * Occupancy of bookable locations (Wave 12 B19, P2). Bookings live in `location_bookings`; events with a `location_id` are NOT
 * copied there -- occupancy and conflicts read the events directly (one source of truth, "Konfliktwarnung statt zweiter
 * Datenquelle"). An event without end counts as one hour. Cancelled events do not occupy anything.
 */

export const DEFAULT_EVENT_HOURS = 1;
export const MAX_RANGE_DAYS = 92;

export interface OccupancyItem {
  type: "booking" | "event";
  id: string;
  /** `null` for an event of a calendar the caller cannot see: shown as "belegt" only. */
  title: string | null;
  startsAt: Date;
  endsAt: Date;
  eventId: string | null;
}

const eventEnd = sql<Date>`coalesce(${events.endsAt}, ${events.startsAt} + make_interval(hours => ${DEFAULT_EVENT_HOURS}))`;

/** Bookings and events of a location overlapping [from, to), oldest first. `visibleTo` decides which event titles are shown. */
export async function occupancyOf(
  executor: DbExecutor,
  clubId: string,
  locationId: string,
  from: Date,
  to: Date,
  opts: { excludeEventId?: string | undefined; excludeBookingId?: string | undefined; visibleTo?: { memberId: string; roleTypes: readonly string[] } | undefined } = {},
): Promise<OccupancyItem[]> {
  const bookings = await executor
    .select()
    .from(locationBookings)
    .where(and(eq(locationBookings.locationId, locationId), lt(locationBookings.startsAt, to), gt(locationBookings.endsAt, from), opts.excludeBookingId ? ne(locationBookings.id, opts.excludeBookingId) : undefined));
  const rows = await executor
    .select({ event: events, endsAt: eventEnd, calendarId: calendars.id })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(eq(events.locationId, locationId), eq(calendars.clubId, clubId), isNull(events.cancelledAt), lt(events.startsAt, to), sql`${eventEnd} > ${from}`, opts.excludeEventId ? ne(events.id, opts.excludeEventId) : undefined))
    .orderBy(asc(events.startsAt));
  const visible = new Map<string, boolean>();
  const items: OccupancyItem[] = bookings.map((b) => ({ type: "booking", id: b.id, title: b.title, startsAt: b.startsAt, endsAt: b.endsAt, eventId: b.eventId }));
  for (const r of rows) {
    // A booking linked to an event is the same occupation, not a second one.
    if (bookings.some((b) => b.eventId === r.event.id)) continue;
    let show = true;
    if (opts.visibleTo) {
      if (!visible.has(r.calendarId)) visible.set(r.calendarId, await isCalendarVisible(r.calendarId, opts.visibleTo.memberId, opts.visibleTo.roleTypes));
      show = visible.get(r.calendarId)!;
    }
    items.push({ type: "event", id: r.event.id, title: show ? r.event.title : null, startsAt: r.event.startsAt, endsAt: new Date(r.endsAt), eventId: r.event.id });
  }
  return items.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Occupation overlapping an event (warning when saving an event at a bookable location); empty for a location that is not bookable. */
export async function conflictsForEvent(clubId: string, event: { id: string; locationId: string | null; startsAt: Date; endsAt: Date | null }, visibleTo: { memberId: string; roleTypes: readonly string[] }): Promise<OccupancyItem[]> {
  if (!event.locationId) return [];
  const [loc] = await db.select({ bookable: locations.bookable }).from(locations).where(and(eq(locations.id, event.locationId), eq(locations.clubId, clubId)));
  if (!loc?.bookable) return [];
  const end = event.endsAt ?? new Date(event.startsAt.getTime() + DEFAULT_EVENT_HOURS * 3_600_000);
  return occupancyOf(db, clubId, event.locationId, event.startsAt, end, { excludeEventId: event.id, visibleTo });
}
