import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries, notificationPreferences } from "../db/schema/communication.js";
import { notifyApplicationReceived, notifyExitRequestToBoard } from "../lib/decision-notify.js";
import { toAppError } from "../lib/errors.js";
import { clubExitRequestRoutes } from "./club-exit-requests.js";
import { clubMemberRoutes } from "./club-members.js";
import { withConsent } from "./forms-test-support.js";

/** G1: a new admission application or exit request tells the reviewers (optional); the applicant gets a mandatory receipt. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-exit-requests", clubExitRequestRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `intake-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Intake ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("request intake notifications (G1)", () => {
  let clubId: string;
  const userIds: string[] = [];
  let vorsitz: Awaited<ReturnType<typeof signUp>>;
  let schrift: Awaited<ReturnType<typeof signUp>>;
  let plain: Awaited<ReturnType<typeof signUp>>;
  const clubMemberOf: Record<string, string> = {};

  const call = (who: { cookie: string }, url: string, init: { method?: string; body?: object } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const rows = (eventKey: string, refId: string) => db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, eventKey), eq(messageDeliveries.refId, refId)));
  const setSwitch = (value: boolean) => db.insert(clubSettings).values({ clubId, notifyBoardRequests: value }).onConflictDoUpdate({ target: clubSettings.clubId, set: { notifyBoardRequests: value } });

  async function addMember(label: string, role?: string) {
    const s = await signUp(label);
    userIds.push(s.userId);
    const account = (await auth.api.addMember({ body: { userId: s.userId, organizationId: clubId, role: "member" } }))!;
    if (role) await db.insert(clubRoles).values({ memberId: account.id, roleType: role });
    clubMemberOf[s.userId] = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!.id;
    return s;
  }

  beforeAll(async () => {
    vorsitz = await signUp("vorsitz");
    userIds.push(vorsitz.userId);
    const club = await auth.api.createOrganization({ body: { name: `Intake Club ${suffix}`, slug: `intake-club-${suffix}`, userId: vorsitz.userId } });
    clubId = club!.id;
    const own = (await db.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, vorsitz.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: own.id, roleType: "vorsitz" });
    clubMemberOf[vorsitz.userId] = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, own.id) }))!.id;
    schrift = await addMember("schrift", "schriftfuehrer");
    plain = await addMember("plain");
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  async function apply() {
    const applicant = await signUp(`applicant-${randomUUID().slice(0, 6)}`);
    userIds.push(applicant.userId);
    const res = await call(applicant, "/club-members/apply", { method: "POST", body: withConsent({ clubId }) });
    expect(res.status).toBe(201);
    return { applicant, applicationId: (((await res.json()) as Json).data.application as Json).id as string };
  }

  it("an application tells the reviewers (optional) and sends the applicant a mandatory receipt", async () => {
    await setSwitch(true);
    const { applicant, applicationId } = await apply();

    const receipt = await rows("application.received", applicationId);
    expect(receipt.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);
    expect(receipt.every((r) => r.userId === applicant.userId && (r.content as { class: string }).class === "mandatory")).toBe(true);

    const notice = await rows("application.new", applicationId);
    const inApp = notice.filter((r) => r.channel === "in_app");
    expect(inApp.map((r) => r.userId).sort()).toEqual([vorsitz.userId, schrift.userId].sort());
    expect(notice.filter((r) => r.channel === "email")).toHaveLength(2);
    expect(notice.some((r) => r.userId === plain.userId || r.userId === applicant.userId)).toBe(false);
    const content = inApp[0]!.content as { class: string; category: string };
    expect(content).toMatchObject({ class: "optional", category: "reminders" });
  });

  it("is idempotent: filing the same application again and re-dispatching create no second message", async () => {
    const { applicant, applicationId } = await apply();
    const before = (await rows("application.new", applicationId)).length + (await rows("application.received", applicationId)).length;
    const again = await call(applicant, "/club-members/apply", { method: "POST", body: withConsent({ clubId }) });
    expect([200, 409]).toContain(again.status);
    await notifyApplicationReceived({ clubId, applicationId, userId: applicant.userId });
    const after = (await rows("application.new", applicationId)).length + (await rows("application.received", applicationId)).length;
    expect(after).toBe(before);
  });

  it("respects a board member's mail opt-out (in-app stays) and the club switch (the receipt stays)", async () => {
    await db.insert(notificationPreferences).values({ userId: schrift.userId, category: "reminders", channel: "email", enabled: false });
    const { applicationId } = await apply();
    const notice = await rows("application.new", applicationId);
    expect(notice.find((r) => r.userId === schrift.userId && r.channel === "email")?.status).toBe("skipped_optout");
    expect(notice.find((r) => r.userId === schrift.userId && r.channel === "in_app")).toBeDefined();
    expect(notice.find((r) => r.userId === vorsitz.userId && r.channel === "email")?.status).toBe("queued");

    await setSwitch(false);
    const off = await apply();
    expect(await rows("application.new", off.applicationId)).toHaveLength(0);
    expect((await rows("application.received", off.applicationId)).length).toBe(2);
    await setSwitch(true);
  });

  it("a member's exit request tells the reviewers once; a board-booked exit does not", async () => {
    const leaver = await addMember("leaver");
    const res = await call(leaver, "/club-exit-requests", { method: "POST", body: { reason: "Umzug" } });
    expect(res.status).toBe(201);
    const requestId = (((await res.json()) as Json).data as Json).id as string;
    const notice = await rows("exit.new", requestId);
    expect(notice.filter((r) => r.channel === "in_app").map((r) => r.userId).sort()).toEqual([vorsitz.userId, schrift.userId].sort());
    expect((await rows("exit.received", requestId)).length).toBe(2);

    await notifyExitRequestToBoard({ clubId, requestId, clubMemberId: clubMemberOf[leaver.userId]! });
    expect(await rows("exit.new", requestId)).toHaveLength(notice.length);

    const booked = await call(vorsitz, "/club-exit-requests", { method: "POST", body: { clubMemberId: clubMemberOf[plain.userId], effectiveOn: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10) } });
    expect(booked.status).toBe(201);
    const bookedId = (((await booked.json()) as Json).data as Json).id as string;
    expect(await rows("exit.new", bookedId)).toHaveLength(0);

    await setSwitch(false);
    const other = await addMember("leaver2");
    const r2 = await call(other, "/club-exit-requests", { method: "POST", body: {} });
    expect(r2.status).toBe(201);
    expect(await rows("exit.new", (((await r2.json()) as Json).data as Json).id as string)).toHaveLength(0);
    await setSwitch(true);
  });
});
