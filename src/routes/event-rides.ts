import { zValidator } from "@hono/zod-validator";
import { and, asc, count, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { eventRideRequests, eventRides } from "../db/schema/event-extras.js";
import { writeAudit } from "../lib/audit.js";
import { isUuid } from "../lib/club-members.js";
import { clubMailLanguage } from "../lib/club-settings.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { loadVisibleEvent, mayManageEvent, ownClubMemberRow } from "../lib/event-access.js";
import { resolveActingMember } from "../lib/event-actor.js";
import { notifyHelpers } from "../lib/event-helpers.js";
import { clubTimezone, formatWhen } from "../lib/event-notify.js";
import { activeWardLinks } from "../lib/guardian-scope.js";
import { tr } from "../lib/notify/i18n.js";
import { cleanText } from "../lib/text-policy.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Ride sharing for events (Wave 12 B18, P2). A driver (an ADULT club member; a guardian can offer for an adult ward only) offers
 * seats; members ask for a seat and the driver confirms. Minors take part only through their guardians (`minor_needs_guardian`),
 * and the departure place and note are shown to the people involved only: the driver, people with a request (and their guardians),
 * and organisers with `calendars:write` -- never to everybody who can see the event. Mounted into `eventRoutes`.
 */
export const eventRideRoutes = new Hono<ClubEnv>();

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};
const MAX_RIDES_PER_DRIVER = 3;
const MAX_SEATS = 8;

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

eventRideRoutes.get("/:id/rides", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roles = c.get("clubRoleTypes");
  const { event, calendar } = await loadVisibleEvent(c.req.param("id"), clubId, membership.id, roles);
  const own = await ownClubMemberRow(clubId, membership.id);
  const wards = await activeWardLinks(c.get("user").id, { clubId });
  const myIds = new Set<string>([...(own ? [own.id] : []), ...wards.map((w) => w.ward.id)]);
  // Organisers of this event (helpers:write within the event scope) may see the places; a department lead only for the own departments.
  const organiser = await mayManageEvent("helpers:write", roles, membership.id, calendar);
  const showNames = membership.role !== "guest";

  const rides = await db
    .select({ ride: eventRides, driverName: clubMembers.displayName })
    .from(eventRides)
    .innerJoin(clubMembers, eq(clubMembers.id, eventRides.driverClubMemberId))
    .where(eq(eventRides.eventId, event.id))
    .orderBy(asc(eventRides.departureAt), asc(eventRides.createdAt), asc(eventRides.id));
  const requests = rides.length
    ? await db
        .select({ request: eventRideRequests, name: clubMembers.displayName })
        .from(eventRideRequests)
        .innerJoin(clubMembers, eq(clubMembers.id, eventRideRequests.passengerClubMemberId))
        .where(inArray(eventRideRequests.rideId, rides.map((r) => r.ride.id)))
        .orderBy(asc(eventRideRequests.createdAt))
    : [];

  return c.json({
    data: {
      eventId: event.id,
      rides: rides.map(({ ride, driverName }) => {
        const here = requests.filter((r) => r.request.rideId === ride.id);
        const taken = here.filter((r) => r.request.status === "zugesagt").length;
        const isDriver = myIds.has(ride.driverClubMemberId);
        const mine = here.filter((r) => myIds.has(r.request.passengerClubMemberId));
        const involved = isDriver || mine.length > 0 || organiser;
        return {
          id: ride.id,
          driver: { clubMemberId: ride.driverClubMemberId, displayName: showNames || isDriver ? driverName : null },
          seats: ride.seats,
          seatsTaken: taken,
          seatsFree: Math.max(0, ride.seats - taken),
          departureAt: ride.departureAt,
          // Place and note only for the people involved; everybody else sees that there is a ride and when it leaves.
          departurePlace: involved ? ride.departurePlace : null,
          note: involved ? ride.note : null,
          placeHidden: !involved,
          mine: isDriver,
          myRequests: mine.map((r) => ({ requestId: r.request.id, clubMemberId: r.request.passengerClubMemberId, status: r.request.status })),
          requests: isDriver || organiser ? here.map((r) => ({ requestId: r.request.id, clubMemberId: r.request.passengerClubMemberId, displayName: r.name, status: r.request.status, createdAt: r.request.createdAt })) : undefined,
          pendingCount: here.filter((r) => r.request.status === "angefragt").length,
        };
      }),
    },
  });
});

const rideSchema = z.object({
  seats: z.number().int().min(1).max(MAX_SEATS),
  departurePlace: cleanText(z.string().trim().min(1).max(200)),
  departureAt: z.string().datetime({ offset: true }).nullable().optional(),
  note: z.union([cleanText(z.string().trim().max(500)), z.null()]).optional(),
  /** Offer a ride for another adult member (a guardian for an adult ward, an organiser for anybody). */
  clubMemberId: z.uuid().optional(),
});

eventRideRoutes.post("/:id/rides", zValidator("json", rideSchema, hook), async (c) => {
  const body = c.req.valid("json");
  const acting = await resolveActingMember(c, c.req.param("id"), body.clubMemberId, "calendars:write", { minorsMaySelfServe: true });
  if (acting.targetIsMinor) throw new ValidationError("Only adults offer rides", { details: { code: "driver_must_be_adult" } });
  if (acting.event.cancelledAt !== null) throw new ConflictError("Event is cancelled");
  const clubId = c.get("clubId");
  const row = await db.transaction(async (tx) => {
    const [n] = await tx.select({ n: count() }).from(eventRides).where(and(eq(eventRides.eventId, acting.event.id), eq(eventRides.driverClubMemberId, acting.target.id)));
    if ((n?.n ?? 0) >= MAX_RIDES_PER_DRIVER) throw new ConflictError(`At most ${MAX_RIDES_PER_DRIVER} rides per driver and event`, { details: { code: "too_many_rides" } });
    const [created] = await tx.insert(eventRides).values({ eventId: acting.event.id, driverClubMemberId: acting.target.id, seats: body.seats, departurePlace: body.departurePlace, departureAt: body.departureAt ? new Date(body.departureAt) : null, note: body.note ?? null }).returning();
    await writeAudit(tx, { eventType: "event_ride.create", subjectId: acting.target.id, payload: { clubId, eventId: acting.event.id, rideId: created!.id, clubMemberId: acting.target.id } });
    return created!;
  });
  return c.json({ data: row }, 201);
});

/** The ride of this event; the driver's side (driver, their guardian, an organiser) is resolved by `resolveActingMember`. */
async function loadRide(eventId: string, rideId: string, lockTx?: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  if (!isUuid(rideId)) throw new NotFoundError("Ride not found");
  const q = (lockTx ?? db).select().from(eventRides).where(and(eq(eventRides.id, rideId), eq(eventRides.eventId, eventId)));
  const [row] = lockTx ? await q.for("update") : await q;
  if (!row) throw new NotFoundError("Ride not found");
  return row;
}

async function actAsDriver(c: Context<ClubEnv>, rideId: string) {
  const eventId = c.req.param("id") ?? "";
  if (!isUuid(eventId)) throw new NotFoundError("Event not found");
  const ride = await loadRide(eventId, rideId);
  const acting = await resolveActingMember(c, eventId, ride.driverClubMemberId, "calendars:write", { minorsMaySelfServe: true });
  return { ride, acting };
}

const ridePatchSchema = rideSchema.omit({ clubMemberId: true }).partial().refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

eventRideRoutes.patch("/:id/rides/:rideId", zValidator("json", ridePatchSchema, hook), async (c) => {
  const body = c.req.valid("json");
  const { ride, acting } = await actAsDriver(c, c.req.param("rideId"));
  const clubId = c.get("clubId");
  const row = await db.transaction(async (tx) => {
    await loadRide(acting.event.id, ride.id, tx);
    const [taken] = await tx.select({ n: count() }).from(eventRideRequests).where(and(eq(eventRideRequests.rideId, ride.id), eq(eventRideRequests.status, "zugesagt")));
    if (body.seats !== undefined && body.seats < (taken?.n ?? 0)) throw new ConflictError("More passengers are confirmed than the new number of seats", { details: { code: "seats_below_confirmed", confirmed: taken?.n ?? 0 } });
    const [updated] = await tx
      .update(eventRides)
      .set({
        ...(body.seats !== undefined ? { seats: body.seats } : {}),
        ...(body.departurePlace !== undefined ? { departurePlace: body.departurePlace } : {}),
        ...(body.departureAt !== undefined ? { departureAt: body.departureAt === null ? null : new Date(body.departureAt) } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      })
      .where(eq(eventRides.id, ride.id))
      .returning();
    await writeAudit(tx, { eventType: "event_ride.update", subjectId: ride.driverClubMemberId, payload: { clubId, eventId: acting.event.id, rideId: ride.id, clubMemberId: ride.driverClubMemberId } });
    return updated!;
  });
  return c.json({ data: row });
});

eventRideRoutes.delete("/:id/rides/:rideId", async (c) => {
  const { ride, acting } = await actAsDriver(c, c.req.param("rideId"));
  const clubId = c.get("clubId");
  const passengers = await db.select({ id: eventRideRequests.passengerClubMemberId }).from(eventRideRequests).where(and(eq(eventRideRequests.rideId, ride.id), inArray(eventRideRequests.status, ["angefragt", "zugesagt"])));
  await db.delete(eventRides).where(eq(eventRides.id, ride.id));
  await writeAudit(db, { eventType: "event_ride.delete", subjectId: ride.driverClubMemberId, payload: { clubId, eventId: acting.event.id, rideId: ride.id, clubMemberId: ride.driverClubMemberId } });
  const lang = await clubMailLanguage(db, clubId);
  await notifyHelpers({ clubId, clubMemberIds: passengers.map((p) => p.id), eventKey: "ride.cancelled", refId: `${ride.id}#cancelled`, title: `${tr(lang, "Fahrgemeinschaft abgesagt", "Ride cancelled")}: ${acting.event.title}`, body: tr(lang, `Die Fahrt, bei der du mitfahren wolltest, wurde vom Fahrer abgesagt. Bitte such dir eine andere Mitfahrgelegenheit.`, `The driver cancelled the ride you wanted to join. Please look for another ride.`) });
  return c.body(null, 204);
});

// --- Requests ---------------------------------------------------------------------------------------------------------------------

eventRideRoutes.post("/:id/rides/:rideId/requests", async (c) => {
  const raw = await readJson(c);
  const forId = z.uuid().optional().safeParse(raw.clubMemberId);
  if (!forId.success) throw new ValidationError("clubMemberId must be a uuid");
  const acting = await resolveActingMember(c, c.req.param("id"), forId.data, "calendars:write");
  if (acting.event.cancelledAt !== null) throw new ConflictError("Event is cancelled");
  const clubId = c.get("clubId");
  const ride = await loadRide(acting.event.id, c.req.param("rideId"));
  if (ride.driverClubMemberId === acting.target.id) throw new ValidationError("The driver is not a passenger");
  try {
    const [created] = await db.insert(eventRideRequests).values({ rideId: ride.id, passengerClubMemberId: acting.target.id, status: "angefragt", requestedByUserId: c.get("user").id }).returning();
    await writeAudit(db, { eventType: "event_ride.request", subjectId: acting.target.id, payload: { clubId, eventId: acting.event.id, rideId: ride.id, clubMemberId: acting.target.id } });
    const lang = await clubMailLanguage(db, clubId);
    const when = ride.departureAt ? formatWhen(ride.departureAt, await clubTimezone(clubId), null, lang) : null;
    await notifyHelpers({ clubId, clubMemberIds: [ride.driverClubMemberId], eventKey: "ride.requested", refId: `${created!.id}#requested`, title: `${tr(lang, "Mitfahranfrage", "Ride request")}: ${acting.event.title}`, body: tr(lang, `${acting.target.displayName} möchte bei dir mitfahren${when ? ` (${when})` : ""}. Du kannst in der Fahrgemeinschaft zusagen oder ablehnen.`, `${acting.target.displayName} would like to ride with you${when ? ` (${when})` : ""}. You can accept or decline in the ride list.`) });
    return c.json({ data: { requestId: created!.id, rideId: ride.id, clubMemberId: acting.target.id, status: "angefragt" } }, 201);
  } catch (err) {
    if ((err as { code?: string; cause?: { code?: string } })?.code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505") throw new ConflictError("There is already a request for this ride", { details: { code: "request_exists" } });
    throw err;
  }
});

const decisionSchema = z.object({ status: z.enum(["zugesagt", "abgelehnt"]) });

/** The driver decides. Seats are counted under a lock on the ride, so a full car cannot be over-confirmed. */
eventRideRoutes.patch("/:id/rides/:rideId/requests/:requestId", zValidator("json", decisionSchema, hook), async (c) => {
  const { ride, acting } = await actAsDriver(c, c.req.param("rideId"));
  const clubId = c.get("clubId");
  const requestId = c.req.param("requestId");
  if (!isUuid(requestId)) throw new NotFoundError("Request not found");
  const { status } = c.req.valid("json");
  const done = await db.transaction(async (tx) => {
    const locked = await loadRide(acting.event.id, ride.id, tx);
    const [request] = await tx.select().from(eventRideRequests).where(and(eq(eventRideRequests.id, requestId), eq(eventRideRequests.rideId, ride.id))).for("update");
    if (!request) throw new NotFoundError("Request not found");
    if (status === "zugesagt" && request.status !== "zugesagt") {
      const [taken] = await tx.select({ n: count() }).from(eventRideRequests).where(and(eq(eventRideRequests.rideId, ride.id), eq(eventRideRequests.status, "zugesagt")));
      if ((taken?.n ?? 0) >= locked.seats) throw new ConflictError("The car is full", { details: { code: "ride_full" } });
    }
    await tx.update(eventRideRequests).set({ status }).where(eq(eventRideRequests.id, request.id));
    await writeAudit(tx, { eventType: "event_ride.decide", subjectId: request.passengerClubMemberId, payload: { clubId, eventId: acting.event.id, rideId: ride.id, clubMemberId: request.passengerClubMemberId, status } });
    return request;
  });
  const lang = await clubMailLanguage(db, clubId);
  await notifyHelpers({ clubId, clubMemberIds: [done.passengerClubMemberId], eventKey: "ride.decided", refId: `${done.id}#${status}`, title: `${status === "zugesagt" ? tr(lang, "Mitfahrt zugesagt", "Ride confirmed") : tr(lang, "Mitfahrt abgelehnt", "Ride declined")}: ${acting.event.title}`, body: status === "zugesagt" ? tr(lang, "Du fährst mit. Abfahrtsort und Zeit findest du in der Fahrgemeinschaft.", "You have a seat. Departure place and time are in the ride list.") : tr(lang, "Leider ist in diesem Auto kein Platz für dich. Bitte frag bei einer anderen Fahrt an.", "Sorry, there is no seat for you in this car. Please ask for another ride.") });
  return c.json({ data: { requestId: done.id, status } });
});

/** The passenger (or a guardian / organiser) withdraws, or the driver removes a passenger. A confirmed seat is free again. */
eventRideRoutes.delete("/:id/rides/:rideId/requests/:requestId", async (c) => {
  const eventId = c.req.param("id") ?? "";
  if (!isUuid(eventId)) throw new NotFoundError("Event not found");
  const ride = await loadRide(eventId, c.req.param("rideId"));
  const requestId = c.req.param("requestId");
  if (!isUuid(requestId)) throw new NotFoundError("Request not found");
  const [request] = await db.select().from(eventRideRequests).where(and(eq(eventRideRequests.id, requestId), eq(eventRideRequests.rideId, ride.id)));
  if (!request) throw new NotFoundError("Request not found");
  // Who may remove it: the passenger side or the driver side -- whichever the caller can act as.
  let acting: Awaited<ReturnType<typeof resolveActingMember>>;
  try {
    acting = await resolveActingMember(c, eventId, request.passengerClubMemberId, "calendars:write");
  } catch (err) {
    if (!(err instanceof ForbiddenError)) throw err;
    acting = await resolveActingMember(c, eventId, ride.driverClubMemberId, "calendars:write", { minorsMaySelfServe: true });
  }
  await db.delete(eventRideRequests).where(eq(eventRideRequests.id, request.id));
  await writeAudit(db, { eventType: "event_ride.request_cancel", subjectId: request.passengerClubMemberId, payload: { clubId: c.get("clubId"), eventId: acting.event.id, rideId: ride.id, clubMemberId: request.passengerClubMemberId } });
  return c.body(null, 204);
});
