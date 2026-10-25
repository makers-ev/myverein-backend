import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { locationBookings } from "../db/schema/event-extras.js";
import { events } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { writeAudit } from "../lib/audit.js";
import { isUuid } from "../lib/club-members.js";
import { needsPermission } from "../lib/event-access.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { MAX_RANGE_DAYS, occupancyOf } from "../lib/location-bookings.js";
import { cleanText } from "../lib/text-policy.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Occupancy plan and bookings of bookable locations (Wave 12 B19, P2), mounted into `locationRoutes`. Reading the plan: every
 * member (not external guests). Booking: `locations:write`. A booking is checked against other bookings AND events at the
 * location in one transaction that holds a lock on the location row, so two parallel bookings cannot both win.
 */
export const locationBookingRoutes = new Hono<ClubEnv>();

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

async function location(c: Context<ClubEnv>) {
  const id = c.req.param("id") ?? "";
  if (!isUuid(id)) throw new NotFoundError("Location not found");
  const [row] = await db.select().from(locations).where(and(eq(locations.id, id), eq(locations.clubId, c.get("clubId"))));
  if (!row) throw new NotFoundError("Location not found");
  return row;
}

function denyGuests(c: Context<ClubEnv>) {
  if (c.get("membership").role === "guest") throw new ForbiddenError("Not available for external guests");
}

const range = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() });

locationBookingRoutes.get("/:id/bookings", zValidator("query", range, hook), async (c) => {
  denyGuests(c);
  const loc = await location(c);
  const q = c.req.valid("query");
  const from = q.from ? new Date(q.from) : new Date();
  const to = q.to ? new Date(q.to) : new Date(from.getTime() + 14 * 86_400_000);
  if (to <= from) throw new ValidationError("`to` must be after `from`");
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new ValidationError(`The range covers at most ${MAX_RANGE_DAYS} days`);
  const items = await occupancyOf(db, c.get("clubId"), loc.id, from, to, { visibleTo: { memberId: c.get("membership").id, roleTypes: c.get("clubRoleTypes") } });
  return c.json({ data: { locationId: loc.id, locationName: loc.name, bookable: loc.bookable, from, to, items } });
});

const conflictQuery = z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), excludeEventId: z.uuid().optional(), excludeBookingId: z.uuid().optional() });

/** Free or not for a time window (used by the event and booking editors before saving). `bookable: false` locations never conflict. */
locationBookingRoutes.get("/:id/conflicts", zValidator("query", conflictQuery, hook), async (c) => {
  denyGuests(c);
  const loc = await location(c);
  const q = c.req.valid("query");
  const from = new Date(q.startsAt);
  const to = new Date(q.endsAt);
  if (to <= from) throw new ValidationError("endsAt must be after startsAt");
  const conflicts = loc.bookable ? await occupancyOf(db, c.get("clubId"), loc.id, from, to, { excludeEventId: q.excludeEventId, excludeBookingId: q.excludeBookingId, visibleTo: { memberId: c.get("membership").id, roleTypes: c.get("clubRoleTypes") } }) : [];
  return c.json({ data: { locationId: loc.id, bookable: loc.bookable, free: conflicts.length === 0, conflicts } });
});

const bookingSchema = z.object({
  title: cleanText(z.string().trim().min(1).max(200)),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  /** Link to an event of the club (the occupation is then that event's, not a second one). */
  eventId: z.uuid().nullable().optional(),
});

async function assertFree(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], c: Context<ClubEnv>, locationId: string, from: Date, to: Date, exclude: { eventId?: string | undefined; bookingId?: string | undefined }) {
  const conflicts = await occupancyOf(tx, c.get("clubId"), locationId, from, to, { excludeEventId: exclude.eventId, excludeBookingId: exclude.bookingId, visibleTo: { memberId: c.get("membership").id, roleTypes: c.get("clubRoleTypes") } });
  if (conflicts.length > 0) throw new ConflictError("The location is already occupied at this time", { details: { code: "location_busy", conflicts } });
}

locationBookingRoutes.post("/:id/bookings", needsPermission("locations:write"), zValidator("json", bookingSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const loc = await location(c);
  const body = c.req.valid("json");
  const from = new Date(body.startsAt);
  const to = new Date(body.endsAt);
  if (to <= from) throw new ValidationError("endsAt must be after startsAt");
  if (body.eventId) {
    const [ev] = await db.select({ id: events.id }).from(events).innerJoin(calendars, eq(calendars.id, events.calendarId)).where(and(eq(events.id, body.eventId), eq(calendars.clubId, clubId)));
    if (!ev) throw new NotFoundError("Event not found");
  }
  const row = await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(locations).where(eq(locations.id, loc.id)).for("update");
    if (!locked?.bookable) throw new ConflictError("The location is not bookable", { details: { code: "not_bookable" } });
    await assertFree(tx, c, loc.id, from, to, { eventId: body.eventId ?? undefined });
    const [created] = await tx.insert(locationBookings).values({ locationId: loc.id, eventId: body.eventId ?? null, title: body.title, startsAt: from, endsAt: to, bookedBy: c.get("user").id }).returning();
    await writeAudit(tx, { eventType: "location_booking.create", subjectId: loc.id, payload: { clubId, locationId: loc.id, bookingId: created!.id } });
    return created!;
  });
  return c.json({ data: row }, 201);
});

async function loadBooking(c: Context<ClubEnv>, locationId: string) {
  const id = c.req.param("bookingId") ?? "";
  if (!isUuid(id)) throw new NotFoundError("Booking not found");
  const [row] = await db.select().from(locationBookings).where(and(eq(locationBookings.id, id), eq(locationBookings.locationId, locationId)));
  if (!row) throw new NotFoundError("Booking not found");
  return row;
}

locationBookingRoutes.patch("/:id/bookings/:bookingId", needsPermission("locations:write"), zValidator("json", bookingSchema.partial().refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }), hook), async (c) => {
  const clubId = c.get("clubId");
  const loc = await location(c);
  const existing = await loadBooking(c, loc.id);
  const body = c.req.valid("json");
  const from = body.startsAt ? new Date(body.startsAt) : existing.startsAt;
  const to = body.endsAt ? new Date(body.endsAt) : existing.endsAt;
  if (to <= from) throw new ValidationError("endsAt must be after startsAt");
  const row = await db.transaction(async (tx) => {
    await tx.select().from(locations).where(eq(locations.id, loc.id)).for("update");
    await assertFree(tx, c, loc.id, from, to, { eventId: (body.eventId === undefined ? existing.eventId : body.eventId) ?? undefined, bookingId: existing.id });
    const [updated] = await tx.update(locationBookings).set({ ...(body.title !== undefined ? { title: body.title } : {}), startsAt: from, endsAt: to, ...(body.eventId !== undefined ? { eventId: body.eventId } : {}) }).where(eq(locationBookings.id, existing.id)).returning();
    await writeAudit(tx, { eventType: "location_booking.update", subjectId: loc.id, payload: { clubId, locationId: loc.id, bookingId: existing.id } });
    return updated!;
  });
  return c.json({ data: row });
});

locationBookingRoutes.delete("/:id/bookings/:bookingId", needsPermission("locations:write"), async (c) => {
  const loc = await location(c);
  const existing = await loadBooking(c, loc.id);
  await db.delete(locationBookings).where(eq(locationBookings.id, existing.id));
  await writeAudit(db, { eventType: "location_booking.delete", subjectId: loc.id, payload: { clubId: c.get("clubId"), locationId: loc.id, bookingId: existing.id } });
  return c.body(null, 204);
});
