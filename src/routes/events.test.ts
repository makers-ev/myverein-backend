import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { toAppError } from "../lib/errors.js";
import { calendarRoutes } from "./calendars.js";
import { eventRoutes, icsRoutes } from "./events.js";

/**
 * Integration test against a real Postgres (DATABASE_URL). Covers event
 * CRUD scoping, cross-club IDOR, the RSVP capacity/waitlist flow (FIFO
 * promotion on cancel), and the session-gated .ics feed -- pattern copied
 * from club-members.test.ts.
 */

const app = new Hono();
app.route("/calendars", calendarRoutes);
app.route("/events", eventRoutes);
app.route("/events.ics", icsRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUpAndVerify(email: string, name: string) {
  const { user: created } = await auth.api.createUser({
    body: { email, password: "test-password-123!", name },
  });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  const cookie = signIn.headers.get("set-cookie") ?? "";
  return { userId: created.id, cookie: cookie.split(";")[0] };
}

describe("events scoping and RSVP", () => {
  let clubAId: string;
  let clubBId: string;
  let cookieBoard: string;
  let cookieMember1: string;
  let cookieMember2: string;
  let cookieClubB: string;
  let member1Id: string;
  let member2Id: string;
  let calendarId: string;
  let otherClubCalendarId: string;
  let userIds: string[] = [];

  beforeAll(async () => {
    const board = await signUpAndVerify(`evt-board-${suffix}@example.com`, "Board Founder");
    const m1 = await signUpAndVerify(`evt-member1-${suffix}@example.com`, "Member One");
    const m2 = await signUpAndVerify(`evt-member2-${suffix}@example.com`, "Member Two");
    const clubBFounder = await signUpAndVerify(`evt-clubb-${suffix}@example.com`, "Club B Founder");
    userIds = [board.userId, m1.userId, m2.userId, clubBFounder.userId];

    cookieBoard = board.cookie;
    cookieMember1 = m1.cookie;
    cookieMember2 = m2.cookie;
    cookieClubB = clubBFounder.cookie;

    const clubA = await auth.api.createOrganization({ body: { name: `Evt Club A ${suffix}`, slug: `evt-club-a-${suffix}`, userId: board.userId } });
    const clubB = await auth.api.createOrganization({ body: { name: `Evt Club B ${suffix}`, slug: `evt-club-b-${suffix}`, userId: clubBFounder.userId } });
    clubAId = clubA!.id;
    clubBId = clubB!.id;

    await auth.api.addMember({ body: { userId: m1.userId, organizationId: clubAId, role: "member" } });
    await auth.api.addMember({ body: { userId: m2.userId, organizationId: clubAId, role: "member" } });

    const boardMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, board.userId)) });
    const member1 = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, m1.userId)) });
    const member2 = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, m2.userId)) });
    member1Id = member1!.id;
    member2Id = member2!.id;

    await db.insert(clubRoles).values({ memberId: boardMember!.id, roleType: "vorsitz" });

    const calRes = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Events Test Calendar" }),
    });
    const { data: calendar } = (await calRes.json()) as { data: { id: string } };
    calendarId = calendar.id;

    const [otherCalendar] = await db
      .insert(calendars)
      .values({ clubId: clubBId, name: `Other Club Calendar ${suffix}`, createdBy: clubBFounder.userId })
      .returning();
    otherClubCalendarId = otherCalendar.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubAId));
    await db.delete(organization).where(eq(organization.id, clubBId));
    for (const id of userIds) {
      await db.delete(user).where(eq(user.id, id));
    }
    await closeDatabase();
  });

  it("rejects event creation from a caller without calendars:write", async () => {
    const res = await app.request(`/events?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieMember1, "content-type": "application/json" },
      body: JSON.stringify({ calendarId, title: "No Permission Event", startsAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(403);
  });

  it("404s creating an event on a calendarId from a different club", async () => {
    const res = await app.request(`/events?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ calendarId: otherClubCalendarId, title: "Cross-club event", startsAt: new Date().toISOString() }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 (not another club's event) for cross-club IDOR", async () => {
    const createRes = await app.request(`/events?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ calendarId, title: "IDOR Target Event", startsAt: new Date().toISOString() }),
    });
    const { data: event } = (await createRes.json()) as { data: { id: string } };

    const res = await app.request(`/events/${event.id}?clubId=${clubBId}`, { headers: { cookie: cookieClubB } });
    expect(res.status).toBe(404);
  });

  it("capacity=1 waitlist flow: second RSVP gets warteliste, then gets promoted after the first cancels", async () => {
    const startsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const createRes = await app.request(`/events?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ calendarId, title: "Waitlist Event", startsAt, capacity: 1 }),
    });
    expect(createRes.status).toBe(201);
    const { data: event } = (await createRes.json()) as { data: { id: string } };

    const rsvp1 = await app.request(`/events/${event.id}/rsvp?clubId=${clubAId}`, { method: "POST", headers: { cookie: cookieMember1 } });
    expect(rsvp1.status).toBe(200);
    const body1 = (await rsvp1.json()) as { data: { status: string } };
    expect(body1.data.status).toBe("angemeldet");

    const rsvp2 = await app.request(`/events/${event.id}/rsvp?clubId=${clubAId}`, { method: "POST", headers: { cookie: cookieMember2 } });
    expect(rsvp2.status).toBe(200);
    const body2 = (await rsvp2.json()) as { data: { status: string } };
    expect(body2.data.status).toBe("warteliste");

    const cancelRes = await app.request(`/events/${event.id}/rsvp?clubId=${clubAId}`, { method: "DELETE", headers: { cookie: cookieMember1 } });
    expect(cancelRes.status).toBe(204);

    const promoted = await db.query.eventAttendees.findFirst({
      where: and(eq(eventAttendees.eventId, event.id), eq(eventAttendees.memberId, member2Id)),
    });
    expect(promoted?.status).toBe("angemeldet");

    const cancelledGone = await db.query.eventAttendees.findFirst({
      where: and(eq(eventAttendees.eventId, event.id), eq(eventAttendees.memberId, member1Id)),
    });
    expect(cancelledGone).toBeUndefined();
  });

  it("404s cancelling an RSVP that doesn't exist", async () => {
    const createRes = await app.request(`/events?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ calendarId, title: "No RSVP Event", startsAt: new Date().toISOString() }),
    });
    const { data: event } = (await createRes.json()) as { data: { id: string } };

    const res = await app.request(`/events/${event.id}/rsvp?clubId=${clubAId}`, { method: "DELETE", headers: { cookie: cookieMember1 } });
    expect(res.status).toBe(404);
  });

  it("GET /events.ics is session-gated and returns a VCALENDAR body", async () => {
    const unauth = await app.request(`/events.ics?clubId=${clubAId}`);
    expect(unauth.status).toBe(401);

    const res = await app.request(`/events.ics?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const text = await res.text();
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(text).toContain("END:VCALENDAR");
  });
});
