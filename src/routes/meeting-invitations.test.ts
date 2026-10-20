import { randomUUID } from "node:crypto";

import { and, eq, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries, notificationPreferences } from "../db/schema/communication.js";
import { jobs } from "../db/schema/jobs.js";
import { toAppError } from "../lib/errors.js";
import { EVENT_CHANGED_JOB_TYPE, handleEventChanged } from "../lib/event-notify.js";
import { meetingRoutes } from "./meetings.js";

/** G2: inviting someone to a meeting / Terminfindung and deleting an open meeting tell the invitees (optional, events). */

const app = new Hono();
app.route("/meetings", meetingRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `mtg-inv-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: label } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("meeting invitation and deletion notifications (G2)", () => {
  let clubId: string;
  let board: Awaited<ReturnType<typeof signUp>>;
  let m1: Awaited<ReturnType<typeof signUp>>;
  let m2: Awaited<ReturnType<typeof signUp>>;
  const accountOf: Record<string, string> = {};
  const clubMemberOf: Record<string, string> = {};
  const userIds: string[] = [];

  const call = (who: { cookie: string }, url: string, init: { method?: string; body?: object } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const data = async (res: Response) => ((await res.json()) as Json).data as Json;
  const jobsFor = (refId: string) => db.select().from(jobs).where(and(eq(jobs.type, EVENT_CHANGED_JOB_TYPE), sql`${jobs.payload}->>'refId' = ${refId}`));
  const runAll = async (refId: string) => {
    for (const job of (await jobsFor(refId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      await handleEventChanged({ id: job.id, type: job.type, payload: job.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 });
    }
  };
  const inApp = async (refId: string, eventKey: string) =>
    (await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${refId}%`), eq(messageDeliveries.eventKey, eventKey), eq(messageDeliveries.channel, "in_app")))).map((d) => d.clubMemberId).sort();
  const newMeeting = async (body: Json) => {
    const res = await call(board, "/meetings", { method: "POST", body: { type: "sonstige", title: "Treffen", ...body } });
    expect(res.status).toBe(201);
    return data(res);
  };
  const invite = (meetingId: string, who: string, extra: Json = {}) => call(board, `/meetings/${meetingId}/invitees`, { method: "POST", body: { memberId: accountOf[who], ...extra } });
  const setSwitch = (value: boolean) => db.insert(clubSettings).values({ clubId, notifyMeetingInvites: value }).onConflictDoUpdate({ target: clubSettings.clubId, set: { notifyMeetingInvites: value } });

  beforeAll(async () => {
    board = await signUp("board");
    m1 = await signUp("m1");
    m2 = await signUp("m2");
    userIds.push(board.userId, m1.userId, m2.userId);
    const club = await auth.api.createOrganization({ body: { name: `Mtg Club ${suffix}`, slug: `mtg-club-${suffix}`, userId: board.userId } });
    clubId = club!.id;
    for (const u of [m1, m2]) await auth.api.addMember({ body: { userId: u.userId, organizationId: clubId, role: "member" } });
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    await db.insert(clubRoles).values({ memberId: accounts.find((a) => a.userId === board.userId)!.id, roleType: "vorsitz" });
    for (const [label, u] of [["m1", m1], ["m2", m2]] as const) {
      const account = accounts.find((a) => a.userId === u.userId)!;
      accountOf[label] = account.id;
      clubMemberOf[label] = (await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, account.id)))[0]!.id;
    }
  }, 40_000);

  afterAll(async () => {
    await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`);
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("adding an invitee to a Terminfindung tells only that person, once, as an optional events message", async () => {
    const meeting = await newMeeting({});
    expect(meeting.status).toBe("terminfindung");
    expect((await invite(meeting.id, "m1")).status).toBe(201);
    expect(await jobsFor(meeting.id)).toHaveLength(1);
    await runAll(meeting.id);
    await runAll(meeting.id); // a re-run of the same job is the same delivery
    expect(await inApp(meeting.id, "meeting.invited")).toEqual([clubMemberOf.m1]);

    const payload = (await jobsFor(meeting.id))[0]!.payload as Json;
    expect(payload.title).toBe("Terminfindung: Treffen");
    expect(payload.body).toContain("Verfügbarkeit");
    const mail = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${meeting.id}%`), eq(messageDeliveries.eventKey, "meeting.invited"), eq(messageDeliveries.channel, "email")));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.content).toMatchObject({ class: "optional", category: "events" });

    // a second invitee does not re-notify the first one
    expect((await invite(meeting.id, "m2")).status).toBe(201);
    await runAll(meeting.id);
    expect(await inApp(meeting.id, "meeting.invited")).toEqual([clubMemberOf.m1, clubMemberOf.m2].sort());
  });

  it("a planned meeting names date and place; a failed duplicate add sends nothing new", async () => {
    const meeting = await newMeeting({ scheduledAt: "2030-09-10T16:00:00.000Z", title: "Jahresversammlung" });
    expect((await invite(meeting.id, "m1")).status).toBe(201);
    expect((await invite(meeting.id, "m1")).status).toBe(409);
    expect(await jobsFor(meeting.id)).toHaveLength(1);
    const payload = (await jobsFor(meeting.id))[0]!.payload as Json;
    expect(payload.title).toBe("Einladung: Jahresversammlung");
    expect(payload.body).toContain("10.09.2030, 18:00 Uhr");
  });

  it("notify:false, the club switch and a finished or past meeting send nothing; notify:false is audited", async () => {
    const quiet = await newMeeting({});
    expect((await invite(quiet.id, "m1", { notify: false })).status).toBe(201);
    expect(await jobsFor(quiet.id)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.subjectId, quiet.id), eq(auditLog.eventType, "meeting.notify_suppressed")))).toHaveLength(1);

    await setSwitch(false);
    const off = await newMeeting({});
    expect((await invite(off.id, "m1")).status).toBe(201);
    expect(await jobsFor(off.id)).toHaveLength(0);
    await setSwitch(true);

    const done = await newMeeting({});
    expect((await call(board, `/meetings/${done.id}`, { method: "PATCH", body: { status: "abgehalten" } })).status).toBe(200);
    expect((await invite(done.id, "m1")).status).toBe(201);
    expect(await jobsFor(done.id)).toHaveLength(0);
  });

  it("honours the mail opt-out of the invitee (the in-app copy stays)", async () => {
    await db.insert(notificationPreferences).values({ userId: m2.userId, category: "events", channel: "email", enabled: false });
    const meeting = await newMeeting({});
    expect((await invite(meeting.id, "m2")).status).toBe(201);
    await runAll(meeting.id);
    const rows = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${meeting.id}%`), eq(messageDeliveries.eventKey, "meeting.invited")));
    expect(rows.find((r) => r.channel === "email")?.status).toBe("skipped_optout");
    expect(rows.find((r) => r.channel === "in_app")).toBeDefined();
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, m2.userId));
  });

  it("deleting an open meeting tells the invitees like a cancellation; notify=false, a held or empty meeting do not", async () => {
    const meeting = await newMeeting({ scheduledAt: "2030-10-01T16:00:00.000Z", title: "Klausur" });
    await invite(meeting.id, "m1", { notify: false });
    await invite(meeting.id, "m2", { notify: false });
    expect((await call(board, `/meetings/${meeting.id}`, { method: "DELETE" })).status).toBe(204);
    const jobsAfter = await jobsFor(meeting.id);
    expect(jobsAfter).toHaveLength(1);
    expect((jobsAfter[0]!.payload as Json).title).toBe("Abgesagt: Klausur");
    await runAll(meeting.id);
    expect(await inApp(meeting.id, "meeting.cancelled")).toEqual([clubMemberOf.m1, clubMemberOf.m2].sort());

    const terminfindung = await newMeeting({ title: "Ohne Datum" });
    await invite(terminfindung.id, "m1", { notify: false });
    expect((await call(board, `/meetings/${terminfindung.id}`, { method: "DELETE" })).status).toBe(204);
    expect((((await jobsFor(terminfindung.id))[0]!.payload as Json).body as string)).toContain("Terminfindung ist damit beendet");

    const quiet = await newMeeting({ scheduledAt: "2030-10-02T16:00:00.000Z" });
    await invite(quiet.id, "m1", { notify: false });
    expect((await call(board, `/meetings/${quiet.id}?notify=false`, { method: "DELETE" })).status).toBe(204);
    expect(await jobsFor(quiet.id)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.subjectId, quiet.id), eq(auditLog.eventType, "meeting.notify_suppressed")))).toHaveLength(2);

    const held = await newMeeting({ scheduledAt: "2030-10-03T16:00:00.000Z" });
    await invite(held.id, "m1", { notify: false });
    await call(board, `/meetings/${held.id}`, { method: "PATCH", body: { status: "abgehalten" } });
    expect((await call(board, `/meetings/${held.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await jobsFor(held.id)).toHaveLength(0);

    const empty = await newMeeting({ scheduledAt: "2030-10-04T16:00:00.000Z" });
    expect((await call(board, `/meetings/${empty.id}`, { method: "DELETE" })).status).toBe(204);
    expect(await jobsFor(empty.id)).toHaveLength(0);
  });
});
