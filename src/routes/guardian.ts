import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { wardEventResponses } from "../db/schema/absences.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMemberDepartments, clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { departmentIdsOf, createAbsence, listAbsencesOf, shapeAbsence, updateAbsence, withdrawAbsence } from "../lib/absences.js";
import { writeAudit } from "../lib/audit.js";
import { isUuid } from "../lib/club-members.js";
import { memberConsentViews } from "../lib/consent.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { levelAllows, levelsOf } from "../lib/field-visibility.js";
import { activeWardLinks, requireWard, type WardLink } from "../lib/guardian-scope.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { openRequest } from "../lib/privacy/requests.js";
import { respondWithExport } from "../lib/privacy/respond.js";
import { dbRateLimit, envInt, HOUR_MS } from "../lib/rate-limits.js";
import { confirmedAccountSeats, confirmedWardSeats, promoteWaitingWard, wardCalendarIds } from "../lib/ward-events.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";
import { absenceCreateSchema, absenceUpdateSchema, validationHook } from "./absences.js";

/**
 * Guardian access (Wave 10 B4). Everything here is bound to a WARD through `guardianScope` (lib/guardian-scope.ts): a live,
 * confirmed `guardian_links` row, checked at read time. No role string opens these routes, a guardian gets NO implicit
 * `mitglied` role and reaches no club-wide read path (members, meetings, locations, inventory). A ward that is not
 * the caller's (other child, other club, expired link, adult ward, unknown id) answers 404 -- the same answer for all.
 */

/** `GET /my-wards`: the wards of the account across all clubs, grouped by club. Session only. */
export const myWardsRoutes = new Hono<SessionEnv>();
myWardsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
myWardsRoutes.use("*", sessionGuard);

myWardsRoutes.get("/", async (c) => {
  const links = await activeWardLinks(c.get("user").id);
  const byClub = new Map<string, { clubId: string; clubName: string; wards: Array<Record<string, unknown>> }>();
  for (const { link, ward, clubId, clubName } of links) {
    const group = byClub.get(clubId) ?? { clubId, clubName, wards: [] };
    const views = await memberConsentViews(clubId, ward.id);
    group.wards.push({
      wardId: ward.id,
      name: ward.displayName,
      firstName: ward.firstName,
      relationship: link.relationship,
      canConsent: link.canConsent,
      canReportAbsence: link.canReportAbsence,
      hasCustody: link.hasCustody,
      validUntil: link.validUntil,
      openConsents: views.filter((v) => v.open).length,
    });
    byClub.set(clubId, group);
  }
  return c.json({ data: [...byClub.values()] });
});

/** `/guardian/wards/:wardId/...` -- detail routes of one ward; the club comes from `?clubId=` / `X-Club-Id`. */
export const guardianRoutes = new Hono<ClubEnv>();
guardianRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
guardianRoutes.use("*", sessionGuard);
guardianRoutes.use("*", clubGuard);

const wardOf = (c: { get(k: "user"): { id: string }; get(k: "clubId"): string; req: { param(k: string): string | undefined } }): Promise<WardLink> => requireWard(c.get("user").id, c.get("clubId"), c.req.param("wardId")!);

guardianRoutes.get("/wards/:wardId/overview", async (c) => {
  const { link, ward } = await wardOf(c);
  const [category] = ward.categoryId ? await db.select({ key: memberCategories.key, name: memberCategories.name }).from(memberCategories).where(eq(memberCategories.id, ward.categoryId)) : [];
  const deptRows = await db
    .select({ id: departments.id, name: departments.name })
    .from(clubMemberDepartments)
    .innerJoin(departments, eq(departments.id, clubMemberDepartments.departmentId))
    .where(and(eq(clubMemberDepartments.clubMemberId, ward.id), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, todayBerlin()))))
    .orderBy(asc(departments.name));
  const consents = await memberConsentViews(ward.clubId, ward.id);
  const absences = await listAbsencesOf(ward.clubId, ward.id, { from: todayBerlin() });
  return c.json({
    data: {
      ward: { id: ward.id, name: ward.displayName, firstName: ward.firstName, lastName: ward.lastName, category: category ?? null, departments: deptRows },
      link: { relationship: link.relationship, hasCustody: link.hasCustody, canConsent: link.canConsent, canReportAbsence: link.canReportAbsence, validUntil: link.validUntil },
      openConsents: consents.filter((v) => v.open).length,
      activeAbsences: absences.length,
    },
  });
});

const eventsQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() });
const EVENTS_MAX_DAYS = 366;

guardianRoutes.get("/wards/:wardId/events", zValidator("query", eventsQuery, validationHook), async (c) => {
  const { ward } = await wardOf(c);
  const q = c.req.valid("query");
  const from = new Date(`${q.from ?? todayBerlin()}T00:00:00Z`);
  const to = q.to ? new Date(`${q.to}T23:59:59Z`) : new Date(from.getTime() + 90 * 86_400_000);
  if (to < from) throw new ValidationError("`to` must not be before `from`");
  if (to.getTime() - from.getTime() > EVENTS_MAX_DAYS * 86_400_000) throw new ValidationError(`The range covers at most ${EVENTS_MAX_DAYS} days`);

  const calendarIds = await wardCalendarIds(ward);
  if (calendarIds.length === 0) return c.json({ data: [] });
  const rows = await db
    .select({ event: events, calendarName: calendars.name, locationName: locations.name })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .leftJoin(locations, and(eq(locations.id, events.locationId), eq(locations.clubId, ward.clubId)))
    .where(and(inArray(events.calendarId, calendarIds), gte(events.startsAt, from), lte(events.startsAt, to)))
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(200);
  const ids = rows.map((r) => r.event.id);
  const status = new Map<string, string>();
  if (ids.length > 0) {
    // A ward with an own account answers through the account (read here); a ward without one through the guardian's response.
    const rsvps = ward.memberId
      ? await db.select({ eventId: eventAttendees.eventId, status: eventAttendees.status }).from(eventAttendees).where(and(inArray(eventAttendees.eventId, ids), eq(eventAttendees.memberId, ward.memberId)))
      : await db.select({ eventId: wardEventResponses.eventId, status: wardEventResponses.status }).from(wardEventResponses).where(and(inArray(wardEventResponses.eventId, ids), eq(wardEventResponses.wardClubMemberId, ward.id)));
    for (const r of rsvps) status.set(r.eventId, r.status);
  }
  return c.json({
    data: rows.map(({ event, calendarName, locationName }) => ({
      id: event.id,
      calendarId: event.calendarId,
      calendarName,
      title: event.title,
      description: event.description,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      category: event.category,
      capacity: event.capacity,
      locationName,
      cancelledAt: event.cancelledAt,
      cancelReason: event.cancelReason,
      response: status.get(event.id) ?? null,
      canRespond: ward.memberId === null && event.cancelledAt === null,
    })),
  });
});

const responseSchema = z.object({ status: z.enum(["angemeldet", "abgesagt"]) });

async function visibleEventOf(ward: WardLink["ward"], eventId: string) {
  if (!isUuid(eventId)) throw new NotFoundError("Event not found");
  const calendarIds = await wardCalendarIds(ward);
  if (calendarIds.length === 0) throw new NotFoundError("Event not found");
  const [event] = await db.select().from(events).where(and(eq(events.id, eventId), inArray(events.calendarId, calendarIds)));
  if (!event) throw new NotFoundError("Event not found");
  return event;
}

/** Yes / no for a ward WITHOUT account. Capacity and waitlist count together with the account RSVPs. */
guardianRoutes.put("/wards/:wardId/events/:eventId/response", zValidator("json", responseSchema, validationHook), async (c) => {
  const { ward } = await wardOf(c);
  if (ward.memberId !== null) throw new ConflictError("The ward has an own account and responds there", { details: { code: "ward_has_account" } });
  const event = await visibleEventOf(ward, c.req.param("eventId"));
  if (event.cancelledAt !== null) throw new ConflictError("Event is cancelled");
  const wanted = c.req.valid("json").status;

  const outcome = await db.transaction(async (tx) => {
    // Same lock as the account RSVP: capacity cannot be overbooked by parallel responses.
    await tx.select({ id: events.id }).from(events).where(eq(events.id, event.id)).for("update");
    const [before] = await tx.select().from(wardEventResponses).where(and(eq(wardEventResponses.eventId, event.id), eq(wardEventResponses.wardClubMemberId, ward.id)));
    let status: "angemeldet" | "abgesagt" | "warteliste" = wanted;
    if (wanted === "angemeldet" && event.capacity !== null) {
      const taken = (await confirmedAccountSeats(tx, event.id)) + (await confirmedWardSeats(tx, event.id, ward.id));
      status = taken < event.capacity ? "angemeldet" : "warteliste";
    }
    await tx
      .insert(wardEventResponses)
      .values({ eventId: event.id, wardClubMemberId: ward.id, status, respondedByUserId: c.get("user").id })
      .onConflictDoUpdate({ target: [wardEventResponses.eventId, wardEventResponses.wardClubMemberId], set: { status, respondedByUserId: c.get("user").id, respondedAt: new Date() } });
    // A confirmed seat that is given up frees a place for somebody waiting.
    if (before?.status === "angemeldet" && status !== "angemeldet" && event.capacity !== null) await promoteWaitingWard(tx, event.id);
    await writeAudit(tx, { eventType: "ward_event_response.set", subjectId: event.id, payload: { clubId: ward.clubId, eventId: event.id, wardClubMemberId: ward.id, status } });
    return status;
  });
  return c.json({ data: { eventId: event.id, status: outcome } });
});

guardianRoutes.delete("/wards/:wardId/events/:eventId/response", async (c) => {
  const { ward } = await wardOf(c);
  const event = await visibleEventOf(ward, c.req.param("eventId"));
  await db.transaction(async (tx) => {
    await tx.select({ id: events.id }).from(events).where(eq(events.id, event.id)).for("update");
    const [removed] = await tx.delete(wardEventResponses).where(and(eq(wardEventResponses.eventId, event.id), eq(wardEventResponses.wardClubMemberId, ward.id))).returning();
    if (!removed) throw new NotFoundError("Response not found");
    if (removed.status === "angemeldet" && event.capacity !== null) await promoteWaitingWard(tx, event.id);
  });
  return c.body(null, 204);
});

/**
 * Trainers / department leads of the ward's departments: name, role, department and ONLY the contact ways they opened
 * (`member_field_visibility` level `mitglieder`; default: none, the name alone is shown).
 */
guardianRoutes.get("/wards/:wardId/contacts", async (c) => {
  const { ward } = await wardOf(c);
  const departmentIds = await departmentIdsOf(ward.id);
  if (departmentIds.length === 0) return c.json({ data: [] });
  const rows = await db
    .select({ roleType: clubRoles.roleType, departmentId: departments.id, departmentName: departments.name, person: clubMembers, accountEmail: user.email })
    .from(clubRoles)
    .innerJoin(departments, and(eq(departments.id, clubRoles.departmentId), eq(departments.clubId, ward.clubId)))
    .innerJoin(member, and(eq(member.id, clubRoles.memberId), eq(member.organizationId, ward.clubId)))
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(clubMembers, eq(clubMembers.memberId, member.id))
    .where(and(inArray(clubRoles.roleType, ["trainer", "abteilungsleitung"]), inArray(clubRoles.departmentId, departmentIds)))
    .orderBy(asc(departments.name), asc(clubMembers.displayName));
  const levels = await levelsOf([...new Set(rows.map((r) => r.person.id))]);
  return c.json({
    data: rows.map((r) => {
      const l = levels.get(r.person.id);
      return {
        clubMemberId: r.person.id,
        name: r.person.displayName,
        roleType: r.roleType,
        department: { id: r.departmentId, name: r.departmentName },
        phone: l && levelAllows(l.phone, "member") ? r.person.phone : null,
        email: l && levelAllows(l.email, "member") ? (r.person.contactEmail ?? r.accountEmail) : null,
      };
    }),
  });
});

guardianRoutes.get("/wards/:wardId/consents", async (c) => {
  const { link, ward } = await wardOf(c);
  const consents = await memberConsentViews(ward.clubId, ward.id);
  // Granting and revoking: POST / DELETE /club-members/:wardId/consents/:purposeId (same service, same rules).
  return c.json({ data: { clubMemberId: ward.id, canConsent: link.canConsent, consents, open: consents.filter((v) => v.open).length } });
});

/** Art. 15 for the child: the guardian receives the data export of the ward (same document as the board's). */
guardianRoutes.get("/wards/:wardId/data-export", dbRateLimit({ bucket: "data-export.user", windowMs: HOUR_MS, max: () => envInt("DATA_EXPORT_PER_HOUR", 5), subject: (c) => c.get("user").id, message: "Too many exports, try again later" }), async (c) => {
  const { ward } = await wardOf(c);
  const format = c.req.query("format") === "html" ? "html" : "json";
  return respondWithExport(c, { clubId: ward.clubId, clubMemberId: ward.id, format, via: "guardian", userId: c.get("user").id, closeAccessRequests: true });
});

/** The guardian asks for the child's data to be erased: a request with a deadline for the board. */
guardianRoutes.post("/wards/:wardId/erasure-request", async (c) => {
  const { ward } = await wardOf(c);
  const { row, created } = await db.transaction((tx) => openRequest(tx, { clubId: ward.clubId, clubMemberId: ward.id, kind: "erasure", requestedByUserId: c.get("user").id }));
  return c.json({ data: { id: row.id, kind: row.kind, status: row.status, receivedAt: row.receivedAt, dueAt: row.dueAt } }, created ? 201 : 200);
});

guardianRoutes.get("/wards/:wardId/absences", async (c) => {
  const { ward } = await wardOf(c);
  const includeWithdrawn = c.req.query("includeWithdrawn") === "true";
  const rows = await listAbsencesOf(ward.clubId, ward.id, { includeWithdrawn, from: includeWithdrawn ? undefined : todayBerlin() });
  return c.json({ data: rows.map(shapeAbsence) });
});

async function reportingWard(c: Parameters<typeof wardOf>[0]) {
  const found = await wardOf(c);
  if (!found.link.canReportAbsence) throw new ForbiddenError("This guardian link does not allow reporting absences", { details: { code: "guardian_cannot_report_absence" } });
  return found.ward;
}

guardianRoutes.post("/wards/:wardId/absences", zValidator("json", absenceCreateSchema, validationHook), async (c) => {
  const ward = await reportingWard(c);
  const row = await createAbsence(ward.clubId, ward, c.req.valid("json"), { userId: c.get("user").id, kind: "guardian" });
  return c.json({ data: shapeAbsence(row) }, 201);
});

guardianRoutes.patch("/wards/:wardId/absences/:id", zValidator("json", absenceUpdateSchema, validationHook), async (c) => {
  const ward = await reportingWard(c);
  return c.json({ data: shapeAbsence(await updateAbsence(ward.clubId, ward, c.req.param("id"), c.req.valid("json"), c.get("user").id)) });
});

guardianRoutes.delete("/wards/:wardId/absences/:id", async (c) => {
  const ward = await reportingWard(c);
  await withdrawAbsence(ward.clubId, ward, c.req.param("id"), c.get("user").id);
  return c.body(null, 204);
});
