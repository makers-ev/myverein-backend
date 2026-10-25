import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { meetingAttendance, meetingInvitees, meetings } from "../db/schema/meetings.js";
import { toAppError } from "../lib/errors.js";
import { meetingRoutes } from "./meetings.js";
import { clubSettingsRoutes } from "./club-settings.js";

/** Wave 11 B10: participation mode and join link, link visible to the invited only, self check-in and leaving. */

const app = new Hono();
app.route("/meetings", meetingRoutes);
app.route("/club-settings", clubSettingsRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { userId: string; cookie: string; accountId: string };
const userIds: string[] = [];
let club: string;
let chair: Who;
let guest1: Who;
let guest2: Who;
let outsider: Who;
let meetingId: string;
const URL_OK = "https://meet.example.org/room-1";

async function signUp(label: string): Promise<Who> {
  const email = `w11o-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `W11O ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]!, accountId: "" };
}
const call = (who: Who, url: string, init: { method?: string; body?: object } = {}) =>
  app.request(`${url}?clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (res: Response) => (await res.json()) as Json;

beforeAll(async () => {
  chair = await signUp("chair");
  guest1 = await signUp("one");
  guest2 = await signUp("two");
  outsider = await signUp("out");
  club = (await auth.api.createOrganization({ body: { name: `TV Online ${suffix}`, slug: `w11o-${suffix}`, userId: chair.userId } }))!.id;
  const chairMember = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, club), e(m.userId, chair.userId)) });
  chair.accountId = chairMember!.id;
  await db.insert(clubRoles).values({ memberId: chairMember!.id, roleType: "vorsitz" });
  for (const who of [guest1, guest2, outsider]) who.accountId = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!.id;
  meetingId = (await db.insert(meetings).values({ clubId: club, type: "mitgliederversammlung", title: "MV online", scheduledAt: new Date(), status: "geplant" }).returning({ id: meetings.id }))[0]!.id;
  for (const who of [guest1, guest2]) {
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, who.accountId) });
    await db.insert(meetingInvitees).values({ meetingId, clubMemberId: cm!.id, response: "ausstehend" });
  }
}, 60_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("participation mode and join link", () => {
  it("stays in the room until the statute parameters allow online participation", async () => {
    const refused = await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { participationMode: "hybrid", onlineUrl: URL_OK } });
    expect(refused.status).toBe(422);
    expect((await json(refused)).error.details).toMatchObject({ code: "online_not_allowed", allowed: ["praesenz"] });
    expect((await call(chair, "/club-settings/assembly", { method: "PATCH", body: { onlineAllowed: "hybrid" } })).status).toBe(200);
    const virtual = await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { participationMode: "virtual" } });
    expect((await json(virtual)).error.details.code).toBe("online_not_allowed");
    const ok = await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { participationMode: "hybrid", onlineUrl: URL_OK } });
    expect(ok.status).toBe(200);
    expect((await json(ok)).data).toMatchObject({ participationMode: "hybrid", onlineUrl: URL_OK });
  });

  it("accepts only https links", async () => {
    expect((await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { onlineUrl: "javascript:alert(1)" } })).status).toBe(422);
    expect((await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { onlineUrl: "http://meet.example.org" } })).status).toBe(422);
  });

  it("shows the link to the invited and to managers, not to other members", async () => {
    expect((await json(await call(guest1, `/meetings/${meetingId}`))).data.onlineUrl).toBe(URL_OK);
    expect((await json(await call(outsider, `/meetings/${meetingId}`))).data.onlineUrl).toBeNull();
    const list = (await json(await call(outsider, "/meetings"))).data as Json[];
    expect(list.find((m) => m.id === meetingId)!.onlineUrl).toBeNull();
    expect(((await json(await call(chair, "/meetings"))).data as Json[]).find((m) => m.id === meetingId)!.onlineUrl).toBe(URL_OK);
  });
});

describe("self check-in", () => {
  it("lets an invited account join, leave and rejoin; strangers get 404", async () => {
    expect((await call(outsider, `/meetings/${meetingId}/online/join`, { method: "POST" })).status).toBe(404);
    const joined = await json(await call(guest1, `/meetings/${meetingId}/online/join`, { method: "POST" }));
    expect(joined.data).toMatchObject({ present: true, leftAt: null });
    const first = joined.data.checkedInAt;
    const again = await json(await call(guest1, `/meetings/${meetingId}/online/join`, { method: "POST" }));
    expect(again.data.checkedInAt).toBe(first);
    const left = await json(await call(guest1, `/meetings/${meetingId}/online/leave`, { method: "POST" }));
    expect(left.data).toMatchObject({ present: false });
    expect(left.data.leftAt).not.toBeNull();
    const back = await json(await call(guest1, `/meetings/${meetingId}/online/join`, { method: "POST" }));
    expect(back.data).toMatchObject({ present: true, leftAt: null, checkedInAt: first });
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, guest1.accountId) });
    const [row] = await db.select().from(meetingAttendance).where(and(eq(meetingAttendance.meetingId, meetingId), eq(meetingAttendance.clubMemberId, cm!.id)));
    expect(row).toMatchObject({ present: true, checkInMethod: "self_online" });
  });

  it("does not end a check-in the secretary made in the room", async () => {
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, guest2.accountId) });
    await db.insert(meetingAttendance).values({ meetingId, clubMemberId: cm!.id, present: true, checkedInAt: new Date(), checkInMethod: "schriftfuehrer" });
    const res = await call(guest2, `/meetings/${meetingId}/online/leave`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await json(res)).error.details.code).toBe("not_self_online");
  });

  it("is closed for a room meeting and outside the check-in window", async () => {
    const room = (await db.insert(meetings).values({ clubId: club, type: "sonstige", title: "Raum", scheduledAt: new Date(), status: "geplant" }).returning({ id: meetings.id }))[0]!.id;
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, guest1.accountId) });
    await db.insert(meetingInvitees).values({ meetingId: room, clubMemberId: cm!.id, response: "zugesagt" });
    expect((await json(await call(guest1, `/meetings/${room}/online/join`, { method: "POST" }))).error.details.code).toBe("not_online");
    const late = (await db.insert(meetings).values({ clubId: club, type: "sonstige", title: "Spaeter", scheduledAt: new Date(Date.now() + 3 * 3_600_000), status: "geplant", participationMode: "hybrid", onlineUrl: URL_OK }).returning({ id: meetings.id }))[0]!.id;
    await db.insert(meetingInvitees).values({ meetingId: late, clubMemberId: cm!.id, response: "zugesagt" });
    expect((await json(await call(guest1, `/meetings/${late}/online/join`, { method: "POST" }))).error.details.code).toBe("outside_check_in_window");
  });
});
