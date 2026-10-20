import { zValidator } from "@hono/zod-validator";
import { and, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { calendars } from "../db/schema/calendars.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events, type EventRow } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { clubTimezone, composeEventMessage, essentialDiff, eventAudience, locationName, notifyWaitlistPromoted, scheduleEventChanged } from "../lib/event-notify.js";
import { buildIcs } from "../lib/ics.js";
import { getVisibleCalendarIds, isCalendarVisible } from "../lib/calendar-visibility.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
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

/** Read shape: the row plus a `cancelled` flag (`cancelledAt`/`cancelReason` are part of the row; old clients ignore them). */
function shapeEvent(row: EventRow) {
  return { ...row, cancelled: row.cancelledAt !== null };
}

/** A location must belong to the caller's club (404 otherwise, indistinguishable from unknown). */
async function assertClubLocation(locationId: string, clubId: string): Promise<void> {
  const [row] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, locationId), eq(locations.clubId, clubId)));
  if (!row) throw new NotFoundError("Location not found");
}

/**
 * Composes and schedules the notification for an essential change or cancellation (B10). Audience and texts come from
 * the state BEFORE the change; `notify: false` suppresses it (audited). Never throws.
 */
async function announceEventChange(args: {
  clubId: string;
  actor: string;
  before: EventRow;
  after: EventRow;
  departmentId: string | null;
  cancelled: boolean;
  reason?: string | null;
  suppress: boolean;
  /** Audience captured earlier (a deleted event no longer has its RSVPs). */
  audience?: Awaited<ReturnType<typeof eventAudience>>;
}): Promise<void> {
  try {
    const { clubId, before, after } = args;
    const audience = args.audience !== undefined ? args.audience : await eventAudience(clubId, before.id, args.departmentId, args.cancelled);
    const timezone = await clubTimezone(clubId);
    const [placeBefore, placeAfter] = await Promise.all([locationName(clubId, before.locationId), locationName(clubId, after.locationId)]);
    const message = composeEventMessage({
      noun: "Termin",
      title: after.title,
      timezone,
      before: { startsAt: before.startsAt, endsAt: before.endsAt, place: placeBefore },
      after: { startsAt: after.startsAt, endsAt: after.endsAt, place: placeAfter },
      cancelled: args.cancelled,
      reason: args.reason ?? null,
    });
    const payload = { clubId, kind: "event" as const, refId: before.id, version: after.updatedAt.getTime(), cancelled: args.cancelled, ...message, audience: audience ?? { memberIds: [], includeGuardians: false } };
    if (!args.suppress && audience === null) return;
    await scheduleEventChanged(payload, { suppressed: args.suppress, actor: args.actor });
  } catch (err) {
    // Best effort: the change itself is already committed. Class and event id only (no message text, no addresses).
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ eventId: args.before.id, errName: e?.name, errCode: e?.code }, "[events] could not announce event change");
  }
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
  return c.json({ data: rows.map(shapeEvent) });
});

eventRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const id = c.req.param("id");

  const { event } = await loadVisibleEvent(id, clubId, membership.id, roleTypes);
  return c.json({ data: shapeEvent(event) });
});

const createEventSchema = z.object({
  calendarId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  category: z.string().max(100).optional(),
  capacity: z.number().int().positive().optional(),
  locationId: z.string().uuid().optional(),
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
        locationId: body.locationId,
        createdBy: currentUser.id,
      })
      .returning();

    await db.insert(auditLog).values({ eventType: "event.create", subjectId: row.id, payload: { clubId, calendarId: body.calendarId } });

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
  locationId: z.string().uuid().nullable().optional(),
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

    await db.insert(auditLog).values({ eventType: "event.update", subjectId: id, payload: { clubId, changes: body, ...(notifyFlag === false ? { notify: false } : {}) } });

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
  const hadRsvps = audienceBefore !== null && (await db.query.eventAttendees.findFirst({ where: eq(eventAttendees.eventId, id) })) !== undefined;

  await db.delete(events).where(eq(events.id, id));
  await db.insert(auditLog).values({ eventType: "event.delete", subjectId: id, payload: { clubId, ...(notifyFlag === "false" ? { notify: false } : {}) } });
  if (hadRsvps) {
    await announceEventChange({ clubId, actor: c.get("user").id, before: existing, after: { ...existing, updatedAt: new Date() }, departmentId: calendar.departmentId, cancelled: true, suppress: notifyFlag === "false", audience: audienceBefore });
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

    await db.insert(auditLog).values({ eventType: "event.cancel", subjectId: id, payload: { clubId, hasReason: Boolean(body.reason?.trim()), ...(body.notify === false ? { notify: false } : {}) } });
    await announceEventChange({ clubId, actor: c.get("user").id, before: existing, after: row, departmentId: calendar.departmentId, cancelled: true, reason: row.cancelReason, suppress: body.notify === false });

    return c.json({ data: shapeEvent(row) });
  },
);

// --- RSVP ----------------------------------------------------------------

eventRoutes.post("/:id/rsvp", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const id = c.req.param("id");

  const { event } = await loadVisibleEvent(id, clubId, membership.id, roleTypes);
  if (event.cancelledAt !== null) throw new ConflictError("Event is cancelled");

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

  const promoted = await db.transaction(async (tx): Promise<{ memberId: string; respondedAt: Date } | null> => {
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
        return { memberId: nextInLine.memberId, respondedAt: nextInLine.respondedAt };
      }
    }
    return null;
  });
  // After the commit: tell the person who moved up (best effort, in addition to the audit entry).
  if (promoted !== null) await notifyWaitlistPromoted({ clubId, event, accountMemberId: promoted.memberId, respondedAt: promoted.respondedAt });

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

  const ics = buildIcs(rows.map((r) => ({ id: r.id, title: r.title, description: r.description, startsAt: r.startsAt, endsAt: r.endsAt, cancelled: r.cancelledAt !== null })));

  c.header("Content-Type", "text/calendar; charset=utf-8");
  return c.body(ics);
});
