import { zValidator } from "@hono/zod-validator";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { wardEventResponses } from "../db/schema/absences.js";
import { events, type EventRow } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { AudienceLimitError, resolveClubAudience, summarizeAudience } from "../lib/audience.js";
import { announceEventChange, essentialDiff, eventAudience, eventGuests, notifyPromoted } from "../lib/event-notify.js";
import { lockEvent } from "../lib/event-registration.js";
import { promoteWaitlist } from "../lib/event-seats.js";
import { refillForRead } from "../lib/event-series-refill.js";
import { markOverride, recordDroppedOccurrence } from "../lib/event-series.js";
import { renderCalendarIcs } from "../lib/event-feed.js";
import { getVisibleCalendarIds } from "../lib/calendar-visibility.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { loadVisibleEvent } from "../lib/event-access.js";
import { eventAttendanceRoutes } from "./event-attendance.js";
import { eventRegistrationRoutes } from "./event-registration.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";
import { writeAudit } from "../lib/audit.js";

export const eventRoutes = new Hono<ClubEnv>();

eventRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
eventRoutes.use("*", sessionGuard);
eventRoutes.use("*", clubGuard);

/** Loads a calendar scoped to `clubId` only -- used by the calendars:write-gated write handlers below (board scope, not the visibility algorithm). */
async function loadClubCalendar(calendarId: string, clubId: string) {
  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, calendarId), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Calendar not found");
  return calendar;
}

/** Read shape: the row plus a `cancelled` flag (`cancelledAt`/`cancelReason` are part of the row; old clients ignore them). */
function shapeEvent(row: EventRow, extra?: EventParticipation) {
  return { ...row, cancelled: row.cancelledAt !== null, ...(extra ?? {}) };
}

/** Participation figures added to the read shape (Wave 12 B3): the caller's own RSVP and the head counts. */
interface EventParticipation {
  myRsvp: "angemeldet" | "warteliste" | null;
  /** Confirmed seats (sum of `party_size` plus guardians' answers for wards without account). */
  attendeeCount: number;
  /** Seats waiting on the waitlist. */
  waitlistCount: number;
}

/**
 * Participation of the given events in two grouped queries (no N+1): the caller's own RSVP status and the number of
 * confirmed / waiting entries. Guardian responses for wards without account (`ward_event_responses`) take seats and wait
 * like account RSVPs, so they count too. `abgesagt` rows are not counted.
 */
async function loadParticipation(eventIds: string[], memberId: string): Promise<Map<string, EventParticipation>> {
  const result = new Map<string, EventParticipation>();
  for (const id of eventIds) result.set(id, { myRsvp: null, attendeeCount: 0, waitlistCount: 0 });
  if (eventIds.length === 0) return result;

  // Seats, not rows: a registration takes `party_size` seats; a guardian's answer for a ward without account takes one.
  const seats = (status: "angemeldet" | "warteliste") => sql<number>`coalesce(sum(${eventAttendees.partySize}) filter (where ${eventAttendees.status} = ${status}), 0)::int`;
  const wardCounted = (status: "angemeldet" | "warteliste") => sql<number>`count(*) filter (where ${wardEventResponses.status} = ${status})::int`;
  const [accountRows, wardRows, ownRows] = await Promise.all([
    db
      .select({ eventId: eventAttendees.eventId, confirmed: seats("angemeldet"), waiting: seats("warteliste") })
      .from(eventAttendees)
      .where(inArray(eventAttendees.eventId, eventIds))
      .groupBy(eventAttendees.eventId),
    db
      .select({ eventId: wardEventResponses.eventId, confirmed: wardCounted("angemeldet"), waiting: wardCounted("warteliste") })
      .from(wardEventResponses)
      .where(inArray(wardEventResponses.eventId, eventIds))
      .groupBy(wardEventResponses.eventId),
    db.select({ eventId: eventAttendees.eventId, status: eventAttendees.status }).from(eventAttendees).where(and(inArray(eventAttendees.eventId, eventIds), eq(eventAttendees.memberId, memberId))),
  ]);
  for (const row of [...accountRows, ...wardRows]) {
    const entry = result.get(row.eventId)!;
    entry.attendeeCount += row.confirmed;
    entry.waitlistCount += row.waiting;
  }
  for (const row of ownRows) {
    if (row.status === "angemeldet" || row.status === "warteliste") result.get(row.eventId)!.myRsvp = row.status;
  }
  return result;
}

/** `endsAt` must not lie before `startsAt` (422). */
function assertTimeOrder(startsAt: Date, endsAt: Date | null | undefined): void {
  if (endsAt && endsAt.getTime() < startsAt.getTime()) throw new ValidationError("endsAt must not be before startsAt");
}

/** A location must belong to the caller's club (404 otherwise, indistinguishable from unknown). */
async function assertClubLocation(locationId: string, clubId: string): Promise<void> {
  const [row] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, locationId), eq(locations.clubId, clubId)));
  if (!row) throw new NotFoundError("Location not found");
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
  // No worker needed: a range beyond the materialized horizon of a series fills it first (capped).
  if (to) await refillForRead(clubId, calendarIds, to);

  const conditions = [inArray(events.calendarId, calendarIds)];
  // Overlap, not start: a multi-day event that began before `from` and is still running at `from` belongs to the range.
  if (from) conditions.push(gte(sql`coalesce(${events.endsAt}, ${events.startsAt})`, from));
  if (to) conditions.push(lte(events.startsAt, to));

  const rows = await db.query.events.findMany({ where: and(...conditions), orderBy: (e, { asc }) => [asc(e.startsAt)] });
  const participation = await loadParticipation(rows.map((r) => r.id), membership.id);
  return c.json({ data: rows.map((r) => shapeEvent(r, participation.get(r.id))) });
});

eventRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const id = c.req.param("id");

  const { event } = await loadVisibleEvent(id, clubId, membership.id, roleTypes);
  const participation = await loadParticipation([event.id], membership.id);
  return c.json({ data: shapeEvent(event, participation.get(event.id)) });
});

const createEventSchema = z.object({
  calendarId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  category: z.string().max(100).optional(),
  capacity: z.number().int().positive().optional(),
  allDay: z.boolean().optional(),
  locationId: z.string().uuid().optional(),
  /** Display only (no payment handling). */
  costNote: z.string().trim().max(300).optional(),
  costCents: z.number().int().min(0).max(10_000_000).optional(),
  attendanceTracking: z.boolean().optional(),
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
    if (body.locationId) await assertClubLocation(body.locationId, clubId);
    assertTimeOrder(new Date(body.startsAt), body.endsAt ? new Date(body.endsAt) : null);

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
        allDay: body.allDay,
        locationId: body.locationId,
        costNote: body.costNote,
        costCents: body.costCents,
        attendanceTracking: body.attendanceTracking,
        createdBy: currentUser.id,
      })
      .returning();

    await writeAudit(db, { eventType: "event.create", subjectId: row.id, payload: { clubId, calendarId: body.calendarId } });

    return c.json({ data: shapeEvent(row) }, 201);
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
  allDay: z.boolean().optional(),
  locationId: z.string().uuid().nullable().optional(),
  costNote: z.string().trim().max(300).nullable().optional(),
  costCents: z.number().int().min(0).max(10_000_000).nullable().optional(),
  attendanceTracking: z.boolean().optional(),
  /** `false` saves the change without telling the attendees (audited). Default: essential changes are announced. */
  notify: z.boolean().optional(),
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
    const { notify: notifyFlag, ...body } = c.req.valid("json");

    const existing = await db.query.events.findFirst({ where: eq(events.id, id) });
    if (!existing) throw new NotFoundError("Event not found");
    const calendar = await loadClubCalendar(existing.calendarId, clubId);
    if (body.calendarId) await loadClubCalendar(body.calendarId, clubId);
    if (body.locationId) await assertClubLocation(body.locationId, clubId);
    const newStart = body.startsAt ? new Date(body.startsAt) : existing.startsAt;
    let newEnd = body.endsAt === undefined ? existing.endsAt : body.endsAt === null ? null : new Date(body.endsAt);
    // Moving only the start past the stored end keeps the duration (the end moves along) instead of leaving an inverted event.
    if (body.endsAt === undefined && newEnd && newEnd.getTime() < newStart.getTime()) newEnd = new Date(newStart.getTime() + (existing.endsAt!.getTime() - existing.startsAt.getTime()));
    assertTimeOrder(newStart, newEnd);
    if (existing.seriesId && body.calendarId && body.calendarId !== existing.calendarId) throw new ValidationError("An occurrence of a series stays in the calendar of its series");

    const [row] = await db
      .update(events)
      .set({
        ...body,
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: body.endsAt === undefined ? (newEnd === existing.endsAt ? undefined : newEnd) : newEnd,
        updatedAt: new Date(),
      })
      .where(eq(events.id, id))
      .returning();

    // Edited on its own: the occurrence becomes an override that a later "all occurrences" edit of the series leaves alone.
    if (existing.seriesId) {
      await markOverride(db, existing, row!);
      row!.isOverride = true;
    }
    await writeAudit(db, { eventType: "event.update", subjectId: id, payload: { clubId, changedFields: Object.keys(body), ...(notifyFlag === false ? { notify: false } : {}) } });

    // More room (or no limit any more): the waitlist moves up.
    if (body.capacity !== undefined && (row!.capacity === null ? existing.capacity !== null : existing.capacity !== null && row!.capacity > existing.capacity)) {
      const promoted = await db.transaction(async (tx) => promoteWaitlist(tx, await lockEvent(tx, id), clubId));
      await notifyPromoted({ clubId, event: row!, promoted });
    }

    // Essential change (start, end, location) of an event that has not been cancelled: tell attendees and waitlist (B10).
    const diff = essentialDiff(existing, row!);
    if ((diff.time || diff.place) && existing.cancelledAt === null) {
      await announceEventChange({ clubId, actor: c.get("user").id, before: existing, after: row!, departmentId: calendar.departmentId, cancelled: false, suppress: notifyFlag === false });
    }

    return c.json({ data: shapeEvent(row!) });
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
  const calendar = await loadClubCalendar(existing.calendarId, clubId);

  // Deleting an event that people signed up for is a cancellation for them (B10): resolve the audience before the RSVPs vanish.
  const notifyFlag = c.req.query("notify");
  const audienceBefore = existing.cancelledAt === null ? await eventAudience(clubId, id, calendar.departmentId, true) : null;
  const guestsBefore = existing.cancelledAt === null ? await eventGuests(id) : [];
  const hadRsvps = (audienceBefore !== null || guestsBefore.length > 0) && (await db.query.eventAttendees.findFirst({ where: eq(eventAttendees.eventId, id) })) !== undefined;

  await db.transaction(async (tx) => {
    // A deleted occurrence stays deleted when the horizon is refilled.
    if (existing.seriesId) await recordDroppedOccurrence(tx, existing);
    await tx.delete(events).where(eq(events.id, id));
  });
  await writeAudit(db, { eventType: "event.delete", subjectId: id, payload: { clubId, ...(notifyFlag === "false" ? { notify: false } : {}) } });
  if (hadRsvps) {
    await announceEventChange({ clubId, actor: c.get("user").id, before: existing, after: { ...existing, updatedAt: new Date() }, departmentId: calendar.departmentId, cancelled: true, suppress: notifyFlag === "false", audience: audienceBefore, guests: guestsBefore });
  }

  return c.body(null, 204);
});

const cancelEventSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  /** `false` cancels without telling anybody (audited). */
  notify: z.boolean().optional(),
});

/** Cancels instead of deleting: the event stays visible as "abgesagt" and the attendees, the waitlist and the department are told. */
eventRoutes.post(
  "/:id/cancel",
  zValidator("json", cancelEventSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    if (!hasClubPermission(c.get("clubRoleTypes"), "calendars:write")) {
      throw new ForbiddenError("Missing calendars:write permission");
    }
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query.events.findFirst({ where: eq(events.id, id) });
    if (!existing) throw new NotFoundError("Event not found");
    const calendar = await loadClubCalendar(existing.calendarId, clubId);
    if (existing.cancelledAt !== null) throw new ConflictError("Event is already cancelled");

    const now = new Date();
    const [row] = await db
      .update(events)
      .set({ cancelledAt: now, cancelReason: body.reason?.trim() || null, updatedAt: now })
      .where(and(eq(events.id, id), isNull(events.cancelledAt)))
      .returning();
    if (!row) throw new ConflictError("Event is already cancelled");

    await writeAudit(db, { eventType: "event.cancel", subjectId: id, payload: { clubId, hasReason: Boolean(body.reason?.trim()), ...(body.notify === false ? { notify: false } : {}) } });
    await announceEventChange({ clubId, actor: c.get("user").id, before: existing, after: row, departmentId: calendar.departmentId, cancelled: true, reason: row.cancelReason, suppress: body.notify === false });

    return c.json({ data: shapeEvent(row) });
  },
);

/**
 * Audience preview before cancelling (counts only, never names or addresses; same permission as the cancellation). Resolves the
 * very audience `POST /:id/cancel` would address (RSVP `angemeldet` + `warteliste`, the department of a department calendar,
 * guardians) with the resolver the dispatcher uses, for the channels in-app + mail. Individual mail opt-outs are only known to the
 * dispatcher at send time, so `email` is an upper bound. Read-only: no job, no audit entry.
 */
eventRoutes.get("/:id/cancel-preview", async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "calendars:write")) {
    throw new ForbiddenError("Missing calendars:write permission");
  }
  const id = c.req.param("id");
  const existing = await db.query.events.findFirst({ where: eq(events.id, id) });
  if (!existing) throw new NotFoundError("Event not found");
  const calendar = await loadClubCalendar(existing.calendarId, clubId);

  const attendeeRows = await db.select({ status: eventAttendees.status }).from(eventAttendees).where(eq(eventAttendees.eventId, id));
  const confirmed = attendeeRows.filter((r) => r.status === "angemeldet").length;
  const waitlisted = attendeeRows.filter((r) => r.status === "warteliste").length;
  const audience = await eventAudience(clubId, id, calendar.departmentId, true);
  const empty = { total: 0, reachable: 0, inApp: 0, email: 0, emailOnly: 0, unreachable: 0, sharedAddress: 0 };
  let summary: typeof empty & { tooLarge: boolean } = { ...empty, tooLarge: false };
  if (audience !== null) {
    try {
      const counts = summarizeAudience((await resolveClubAudience(clubId, audience)).recipients, ["in_app", "email"]);
      summary = { total: counts.total, reachable: counts.reachable, inApp: counts.inApp, email: counts.email, emailOnly: counts.emailOnly, unreachable: counts.unreachable, sharedAddress: counts.sharedAddress, tooLarge: false };
    } catch (err) {
      // An audience beyond the limit is not sent either; the preview says so instead of failing.
      if (!(err instanceof AudienceLimitError)) throw err;
      summary = { ...empty, total: err.size, tooLarge: true };
    }
  }
  return c.json({ data: { alreadyCancelled: existing.cancelledAt !== null, confirmed, waitlisted, departmentCalendar: calendar.departmentId !== null, audience: summary } });
});

// --- iCal feed (mounted separately, at top-level /events.ics) -----------

export const icsRoutes = new Hono<ClubEnv>();

icsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
icsRoutes.use("*", sessionGuard);
icsRoutes.use("*", clubGuard);

/**
 * Session-gated iCal feed of the calendars visible to the caller: event series as RRULE (+ EXDATE, RECURRENCE-ID), place, status
 * and all-day events (`src/lib/ics.ts`, `src/lib/event-feed.ts`). The subscribable token link is `GET /feeds/:token.ics`.
 */
icsRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const calendarIds = await getVisibleCalendarIds(clubId, c.get("membership").id, c.get("clubRoleTypes"));
  const { ics, etag } = await renderCalendarIcs(clubId, calendarIds);

  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Cache-Control", "private, no-cache");
  c.header("ETag", etag);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.body(ics);
});

// --- Wave 12: attendance, registration, helpers (session + club guard come from this router) ----------

eventRoutes.route("/", eventAttendanceRoutes);
eventRoutes.route("/", eventRegistrationRoutes);
