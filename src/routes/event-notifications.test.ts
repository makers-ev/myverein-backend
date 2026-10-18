import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { departments } from "../db/schema/departments.js";
import { jobs } from "../db/schema/jobs.js";
import { toAppError } from "../lib/errors.js";
import { EVENT_CHANGED_JOB_TYPE, handleEventChanged } from "../lib/event-notify.js";
import { eventRoutes } from "./events.js";
import { meetingRoutes } from "./meetings.js";

/** Wave 9 B10: essential changes / cancellation of events and meetings are announced through the job `notify_event_changed`. */

const app = new Hono();
app.route("/events", eventRoutes);
app.route("/meetings", meetingRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `evn-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: label } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("event and meeting change notifications (B10)", () => {
  let clubId: string;
  let board: Awaited<ReturnType<typeof signUp>>;
  let m1: Awaited<ReturnType<typeof signUp>>;
  let m2: Awaited<ReturnType<typeof signUp>>;
  let m3: Awaited<ReturnType<typeof signUp>>;
  const clubMemberOf: Record<string, string> = {};
  let calendarId: string;
  const userIds: string[] = [];

  const call = (who: { cookie: string }, url: string, init: { method?: string; body?: object } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const data = async (res: Response) => ((await res.json()) as Json).data as Json;
  const jobsFor = (refId: string) => db.select().from(jobs).where(and(eq(jobs.type, EVENT_CHANGED_JOB_TYPE), sql`${jobs.payload}->>'refId' = ${refId}`));
  const run = async (refId: string, index = 0) => {
    const [job] = (await jobsFor(refId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(index);
    await handleEventChanged({ id: job!.id, type: job!.type, payload: job!.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 });
    return job!.payload as Json;
  };
  const deliveredTo = async (refId: string, eventKey: string) =>
    (await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.refId, refId), eq(messageDeliveries.eventKey, eventKey), eq(messageDeliveries.channel, "in_app")))).map((d) => d.clubMemberId).sort();
  const newEvent = async (title: string, extra: Json = {}) => {
    const res = await call(board, "/events", { method: "POST", body: { calendarId, title, startsAt: "2030-06-01T16:00:00.000Z", endsAt: "2030-06-01T17:30:00.000Z", ...extra } });
    expect(res.status).toBe(201);
    return data(res);
  };

  beforeAll(async () => {
    board = await signUp("board");
    m1 = await signUp("m1");
    m2 = await signUp("m2");
    m3 = await signUp("m3");
    userIds.push(board.userId, m1.userId, m2.userId, m3.userId);
    const club = await auth.api.createOrganization({ body: { name: `Evn Club ${suffix}`, slug: `evn-club-${suffix}`, userId: board.userId } });
    clubId = club!.id;
    for (const u of [m1, m2, m3]) await auth.api.addMember({ body: { userId: u.userId, organizationId: clubId, role: "member" } });
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    const boardAccount = accounts.find((a) => a.userId === board.userId)!;
    await db.insert(clubRoles).values({ memberId: boardAccount.id, roleType: "vorsitz" });
    for (const [label, u] of [["m1", m1], ["m2", m2], ["m3", m3]] as const) {
      const account = accounts.find((a) => a.userId === u.userId)!;
      const [row] = await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, account.id));
      clubMemberOf[label] = row!.id;
    }
    const [dept] = await db.insert(departments).values({ clubId, name: "Jugend" }).returning();
    await db.insert(clubMemberDepartments).values({ clubMemberId: clubMemberOf.m3!, departmentId: dept!.id });
    const [calendar] = await db.insert(calendars).values({ clubId, departmentId: dept!.id, name: "Jugendkalender", createdBy: board.userId }).returning();
    calendarId = calendar!.id;
  }, 40_000);

  afterAll(async () => {
    await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`);
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("announces a time change to attendees and waitlist only, with old and new time, as an opt-out-able events message", async () => {
    const event = await newEvent("Training", { capacity: 1 });
    expect((await call(m1, `/events/${event.id}/rsvp`, { method: "POST" })).status).toBe(200);
    expect((await call(m2, `/events/${event.id}/rsvp`, { method: "POST" })).status).toBe(200); // waitlist
    expect(await jobsFor(event.id)).toHaveLength(0);

    // an unrelated edit announces nothing
    expect((await call(board, `/events/${event.id}`, { method: "PATCH", body: { title: "Training Halle", description: "neu" } })).status).toBe(200);
    expect(await jobsFor(event.id)).toHaveLength(0);

    const res = await call(board, `/events/${event.id}`, { method: "PATCH", body: { startsAt: "2030-06-02T17:00:00.000Z", endsAt: "2030-06-02T18:30:00.000Z" } });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ cancelled: false, cancelledAt: null });
    expect(await jobsFor(event.id)).toHaveLength(1);

    const payload = await run(event.id);
    expect(payload.body).toContain("Bisher: ");
    expect(payload.body).toContain("01.06.2030, 18:00 Uhr bis 19:30 Uhr");
    expect(payload.body).toContain("Neu: ");
    expect(payload.body).toContain("02.06.2030, 19:00 Uhr bis 20:30 Uhr");
    expect(await deliveredTo(event.id, "event.changed")).toEqual([clubMemberOf.m1, clubMemberOf.m2].sort());
    const [row] = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.refId, event.id), eq(messageDeliveries.clubMemberId, clubMemberOf.m1!), eq(messageDeliveries.channel, "email")));
    expect((row!.content as { class: string; category: string }).class).toBe("optional");
    expect((row!.content as { category: string }).category).toBe("events");
  });

  it("notify:false suppresses the message and leaves an audit entry", async () => {
    const event = await newEvent("Stilles Training");
    expect((await call(m1, `/events/${event.id}/rsvp`, { method: "POST" })).status).toBe(200);
    const res = await call(board, `/events/${event.id}`, { method: "PATCH", body: { startsAt: "2030-06-05T17:00:00.000Z", notify: false } });
    expect(res.status).toBe(200);
    expect(await jobsFor(event.id)).toHaveLength(0);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, event.id), eq(auditLog.eventType, "event.notify_suppressed")));
    expect(audit).toHaveLength(1);
  });

  it("announces a location change", async () => {
    const [location] = await db.execute(sql`INSERT INTO locations (club_id, name) VALUES (${clubId}, 'Halle Nord') RETURNING id`).then((r) => r.rows as Array<{ id: string }>);
    const event = await newEvent("Ortswechsel");
    expect((await call(m1, `/events/${event.id}/rsvp`, { method: "POST" })).status).toBe(200);
    expect((await call(board, `/events/${event.id}`, { method: "PATCH", body: { locationId: randomUUID() } })).status).toBe(404);
    expect((await call(board, `/events/${event.id}`, { method: "PATCH", body: { locationId: location!.id } })).status).toBe(200);
    const payload = await run(event.id);
    expect(payload.body).toContain("Ort neu: Halle Nord");
  });

  it("cancel needs calendars:write, tells attendees AND the department, is idempotent-safe and blocks new RSVPs", async () => {
    const event = await newEvent("Spiel");
    expect((await call(m1, `/events/${event.id}/rsvp`, { method: "POST" })).status).toBe(200);
    expect((await call(m1, `/events/${event.id}/cancel`, { method: "POST", body: {} })).status).toBe(403);

    const res = await call(board, `/events/${event.id}/cancel`, { method: "POST", body: { reason: "Platz gesperrt" } });
    expect(res.status).toBe(200);
    expect(await data(res)).toMatchObject({ cancelled: true, cancelReason: "Platz gesperrt" });
    expect((await call(board, `/events/${event.id}/cancel`, { method: "POST", body: {} })).status).toBe(409);
    expect((await call(m2, `/events/${event.id}/rsvp`, { method: "POST" })).status).toBe(409);

    const payload = await run(event.id);
    expect(payload.cancelled).toBe(true);
    expect(payload.body).toContain("Grund: Platz gesperrt");
    expect(await deliveredTo(event.id, "event.cancelled")).toEqual([clubMemberOf.m1, clubMemberOf.m3].sort());

    // the cancelled state is part of every read response; a later time change of a cancelled event stays silent
    expect(await data(await call(m2, `/events/${event.id}`))).toMatchObject({ cancelled: true, cancelledAt: expect.any(String) });
    const list = (await (await call(m2, "/events")).json()) as { data: Json[] };
    expect(list.data.find((e) => e.id === event.id)).toMatchObject({ cancelled: true });
    expect((await call(board, `/events/${event.id}`, { method: "PATCH", body: { startsAt: "2030-07-01T10:00:00.000Z" } })).status).toBe(200);
    expect(await jobsFor(event.id)).toHaveLength(1);
  });

  it("cancel with notify:false stays silent but is audited", async () => {
    const event = await newEvent("Stille Absage");
    expect((await call(m1, `/events/${event.id}/rsvp`, { method: "POST" })).status).toBe(200);
    expect((await call(board, `/events/${event.id}/cancel`, { method: "POST", body: { notify: false } })).status).toBe(200);
    expect(await jobsFor(event.id)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.subjectId, event.id), eq(auditLog.eventType, "event.notify_suppressed")))).toHaveLength(1);
  });

  it("deleting an event with RSVPs counts as a cancellation; without RSVPs nobody is bothered", async () => {
    const withRsvp = await newEvent("Wird gelöscht");
    expect((await call(m1, `/events/${withRsvp.id}/rsvp`, { method: "POST" })).status).toBe(200);
    expect((await call(board, `/events/${withRsvp.id}`, { method: "DELETE" })).status).toBe(204);
    const payload = await run(withRsvp.id);
    expect(payload.cancelled).toBe(true);
    expect(await deliveredTo(withRsvp.id, "event.cancelled")).toEqual([clubMemberOf.m1, clubMemberOf.m3].sort());

    const empty = await newEvent("Leer gelöscht");
    expect((await call(board, `/events/${empty.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await jobsFor(empty.id)).toHaveLength(0);
  });

  it("a rescheduled or cancelled meeting is announced to its invitees", async () => {
    const created = await data(await call(board, "/meetings", { method: "POST", body: { type: "vorstandssitzung", title: "Sitzung", scheduledAt: "2030-06-10T17:00:00.000Z" } }));
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    const m1Account = accounts.find((a) => a.userId === m1.userId)!;
    await db.execute(sql`INSERT INTO meeting_invitees (meeting_id, member_id, response) VALUES (${created.id}, ${m1Account.id}, 'ausstehend')`);

    expect((await call(board, `/meetings/${created.id}`, { method: "PATCH", body: { title: "Sitzung (Vorstand)" } })).status).toBe(200);
    expect(await jobsFor(created.id)).toHaveLength(0);

    expect((await call(board, `/meetings/${created.id}`, { method: "PATCH", body: { scheduledAt: "2030-06-11T17:00:00.000Z" } })).status).toBe(200);
    const moved = await run(created.id, 0);
    expect(moved.cancelled).toBe(false);
    expect(moved.body).toContain("10.06.2030");
    expect(moved.body).toContain("11.06.2030");
    expect(await deliveredTo(created.id, "meeting.changed")).toEqual([clubMemberOf.m1]);

    expect((await call(board, `/meetings/${created.id}`, { method: "PATCH", body: { status: "abgesagt" } })).status).toBe(200);
    const cancelled = await run(created.id, 1);
    expect(cancelled.cancelled).toBe(true);
    expect(await deliveredTo(created.id, "meeting.cancelled")).toEqual([clubMemberOf.m1]);

    const quiet = await data(await call(board, "/meetings", { method: "POST", body: { type: "vorstandssitzung", title: "Leise", scheduledAt: "2030-06-12T17:00:00.000Z" } }));
    await db.execute(sql`INSERT INTO meeting_invitees (meeting_id, member_id, response) VALUES (${quiet.id}, ${m1Account.id}, 'ausstehend')`);
    expect((await call(board, `/meetings/${quiet.id}`, { method: "PATCH", body: { scheduledAt: "2030-06-13T17:00:00.000Z", notify: false } })).status).toBe(200);
    expect(await jobsFor(quiet.id)).toHaveLength(0);
  });
});
