import { zValidator } from "@hono/zod-validator";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { calendars } from "../db/schema/calendars.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { buildIcs } from "../lib/ics.js";
import { getVisibleCalendarIds, isCalendarVisible } from "../lib/calendar-visibility.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const eventRoutes = new Hono<ClubEnv>();

eventRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
eventRoutes.use("*", sessionGuard);
eventRoutes.use("*", clubGuard);

/** Loads an event and 404s unless its calendar belongs to `clubId` AND is visible to the caller. Never leaks an invisible calendar's events. */
async function loadVisibleEvent(id: string, clubId: string, memberId: string, clubRoleTypes: readonly string[]) {
  const row = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!row) throw new NotFoundError("Event not found");

  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, row.calendarId), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Event not found");

  if (!(await isCalendarVisible(calendar.id, memberId, clubRoleTypes))) {
    throw new NotFoundError("Event not found");
  }

  return { event: row, calendar };
}

/** Loads a calendar scoped to `clubId` only -- used by the calendars:write-gated write handlers below (board scope, not the visibility algorithm). */
async function loadClubCalendar(calendarId: string, clubId: string) {
  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, calendarId), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Calendar not found");
  return calendar;
}

function parseDateQuery(raw: string | undefined, paramName: string): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${paramName} must be a valid ISO date string`);
  return date;
}

eventRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const from = parseDateQuery(c.req.query("from"), "from");
  const to = parseDateQuery(c.req.query("to"), "to");

  const calendarIds = await getVisibleCalendarIds(clubId, membership.id, roleTypes);
  if (calendarIds.length === 0) return c.json({ data: [] });

  const conditions = [inArray(events.calendarId, calendarIds)];
  if (from) conditions.push(gte(events.startsAt, from));
  if (to) conditions.push(lte(events.startsAt, to));

  // ponytail: no attendee count/caller-status inline -- plain event list,
  // add when a client actually needs it without a follow-up request.
  const rows = await db.query.events.findMany({ where: and(...conditions), orderBy: (e, { asc }) => [asc(e.startsAt)] });
  return c.json({ data: rows });
});

eventRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const id = c.req.param("id");

  const { event } = await loadVisibleEvent(id, clubId, membership.id, roleTypes);
  return c.json({ data: event });
});

const createEventSchema = z.object({
  calendarId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  category: z.string().max(100).optional(),
  capacity: z.number().int().positive().optional(),
});

eventRoutes.post(
  "/",
  zValidator("json", createEventSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    const currentUser = c.get("user");
    if (!hasClubPermission(roleTypes, "calendars:write")) {
      throw new ForbiddenError("Missing calendars:write permission");
    }
    const body = c.req.valid("json");
    await loadClubCalendar(body.calendarId, clubId);

    const [row] = await db
      .insert(events)
      .values({
        calendarId: body.calendarId,
        title: body.title,
        description: body.description,
        startsAt: new Date(body.startsAt),
        endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
        category: body.category,
        capacity: body.capacity,
        createdBy: currentUser.id,
      })
      .returning();

    await db.insert(auditLog).values({ eventType: "event.create", subjectId: row.id, payload: { clubId, calendarId: body.calendarId } });

    return c.json({ data: row }, 201);
  },
);

const updateEventSchema = z.object({
  calendarId: z.string().uuid().optional(),
  title: z.string().min(1).max(300).optional(),
  description: z.string().nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
});

eventRoutes.patch(
  "/:id",
  zValidator("json", updateEventSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "calendars:write")) {
      throw new ForbiddenError("Missing calendars:write permission");
    }
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query.events.findFirst({ where: eq(events.id, id) });
    if (!existing) throw new NotFoundError("Event not found");
    await loadClubCalendar(existing.calendarId, clubId);
    if (body.calendarId) await loadClubCalendar(body.calendarId, clubId);

    const [row] = await db
      .update(events)
      .set({
        ...body,
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: body.endsAt === undefined ? undefined : body.endsAt === null ? null : new Date(body.endsAt),
        updatedAt: new Date(),
      })
      .where(eq(events.id, id))
      .returning();

    await db.insert(auditLog).values({ eventType: "event.update", subjectId: id, payload: { clubId, changes: body } });

    return c.json({ data: row });
  },
);

eventRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "calendars:write")) {
    throw new ForbiddenError("Missing calendars:write permission");
  }
  const id = c.req.param("id");

  const existing = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!existing) throw new NotFoundError("Event not found");
  await loadClubCalendar(existing.calendarId, clubId);

  await db.delete(events).where(eq(events.id, id));
  await db.insert(auditLog).values({ eventType: "event.delete", subjectId: id, payload: { clubId } });

  return c.body(null, 204);
});

// --- RSVP ----------------------------------------------------------------

eventRoutes.post("/:id/rsvp", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const id = c.req.param("id");

  const { event } = await loadVisibleEvent(id, clubId, membership.id, roleTypes);

  const row = await db.transaction(async (tx) => {
    // Lock the event row for the duration of the tx -- without this, two
    // concurrent RSVPs at capacity-1 both read "count < capacity" under
    // READ COMMITTED before either commits, and both get seated (overbooking).
    // The lock serializes them: the second waiter re-reads the up-to-date
    // count once the first commits and releases it.
    await tx.select().from(events).where(eq(events.id, id)).for("update");

    // Count existing angemeldet rows EXCLUDING the caller's own row -- otherwise
    // re-confirming an already-angemeldet RSVP at capacity would demote them.
    const confirmed = await tx.query.eventAttendees.findMany({
      where: and(eq(eventAttendees.eventId, id), eq(eventAttendees.status, "angemeldet")),
    });
    const othersConfirmed = confirmed.filter((r) => r.memberId !== membership.id).length;
    const status = event.capacity === null || othersConfirmed < event.capacity ? "angemeldet" : "warteliste";

    const [created] = await tx
      .insert(eventAttendees)
      .values({ eventId: id, memberId: membership.id, status })
      .onConflictDoUpdate({
        target: [eventAttendees.eventId, eventAttendees.memberId],
        set: { status, respondedAt: new Date() },
      })
      .returning();

    await tx.insert(auditLog).values({ eventType: "event_attendee.rsvp", subjectId: id, payload: { clubId, memberId: membership.id, status } });

    return created;
  });

  return c.json({ data: { status: row.status } });
});

eventRoutes.delete("/:id/rsvp", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const id = c.req.param("id");

  const { event } = await loadVisibleEvent(id, clubId, membership.id, roleTypes);

  await db.transaction(async (tx) => {
    // Same lock as the RSVP handler -- without it, two concurrent
    // cancellations can both pick the same waitlisted row to promote (each
    // reads "next in line" before the other commits), leaving one freed
    // slot unfilled even though two members were waiting.
    await tx.select().from(events).where(eq(events.id, id)).for("update");

    const existing = await tx.query.eventAttendees.findFirst({
      where: and(eq(eventAttendees.eventId, id), eq(eventAttendees.memberId, membership.id)),
    });
    if (!existing) throw new NotFoundError("RSVP not found");

    await tx.delete(eventAttendees).where(eq(eventAttendees.id, existing.id));
    await tx.insert(auditLog).values({
      eventType: "event_attendee.cancel",
      subjectId: id,
      payload: { clubId, memberId: membership.id },
    });

    // FIFO promotion: the caller freed a confirmed spot -- bump the
    // earliest-responded waitlist row up, if there is one.
    if (existing.status === "angemeldet" && event.capacity !== null) {
      const nextInLine = await tx.query.eventAttendees.findFirst({
        where: and(eq(eventAttendees.eventId, id), eq(eventAttendees.status, "warteliste")),
        orderBy: (ea, { asc }) => [asc(ea.respondedAt)],
      });
      if (nextInLine) {
        await tx.update(eventAttendees).set({ status: "angemeldet" }).where(eq(eventAttendees.id, nextInLine.id));
        await tx.insert(auditLog).values({
          eventType: "event_attendee.promote",
          subjectId: id,
          payload: { clubId, memberId: nextInLine.memberId },
        });
      }
    }
  });

  return c.body(null, 204);
});

// --- iCal feed (mounted separately, at top-level /events.ics) -----------

export const icsRoutes = new Hono<ClubEnv>();

icsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
icsRoutes.use("*", sessionGuard);
icsRoutes.use("*", clubGuard);

/**
 * Session-gated iCal feed only. A static/token-based public link (so a
 * calendar app can subscribe without a login) is a real, still-open
 * question this repo's Wave 2 plan explicitly flags and defers -- not an
 * oversight -- so it isn't built here.
 */
icsRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");

  const calendarIds = await getVisibleCalendarIds(clubId, membership.id, roleTypes);
  const rows = calendarIds.length
    ? await db.query.events.findMany({ where: inArray(events.calendarId, calendarIds), orderBy: (e, { asc }) => [asc(e.startsAt)] })
    : [];

  const ics = buildIcs(rows.map((r) => ({ id: r.id, title: r.title, description: r.description, startsAt: r.startsAt, endsAt: r.endsAt })));

  c.header("Content-Type", "text/calendar; charset=utf-8");
  return c.body(ics);
});
