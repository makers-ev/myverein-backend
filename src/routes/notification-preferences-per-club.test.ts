import { createHmac, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { messageDeliveries, notificationPreferences, pushTokens } from "../db/schema/communication.js";
import { toAppError } from "../lib/errors.js";
import { createUnsubscribeToken, handleEmailDelivery, installUnsubscribeProvider, notify, setMailSender, setUnsubscribeUrlProvider, verifyUnsubscribeToken } from "../lib/notify/index.js";
import { notificationPreferenceRoutes, unsubscribeRoutes } from "./notification-preferences.js";

/** G12: preferences per club (club-specific > global > on), unsubscribe scope, old tokens, leadership view per club. */

const app = new Hono();
app.route("/notification-preferences", notificationPreferenceRoutes);
app.route("/unsubscribe", unsubscribeRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  if (appError.status >= 500) console.error("[test] 500 caused by", err); // eslint-disable-line no-console
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let clubA: string;
let clubB: string;
const userIds: string[] = [];
let ann: { userId: string; cookie: string; cmA: string; cmB: string };
let lead: { userId: string; cookie: string };
let outsider: { userId: string; cookie: string };

async function signUp(label: string) {
  const email = `pc-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `PC ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]!, email };
}
const json = async (res: Response) => (await res.json()) as Json;
const req = (who: { cookie: string }, url: string, init: { method?: string; body?: object } = {}) =>
  app.request(url, { method: init.method ?? "GET", headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" }, body: init.body ? JSON.stringify(init.body) : undefined });
const put = (who: { cookie: string }, preferences: Array<{ category: string; channel: string; enabled: boolean | null }>, clubId?: string) => req(who, "/notification-preferences", { method: "PUT", body: { ...(clubId ? { clubId } : {}), preferences } });
const emailSwitch = (data: Json, category = "announcements") => data.categories.find((c: Json) => c.category === category).channels.find((ch: Json) => ch.channel === "email").enabled as boolean;

const send = (clubId: string, key: string, clubMemberId: string) =>
  notify({ clubId, class: "optional", eventKey: key, recipients: [{ userId: ann.userId, clubMemberId, email: `pc-ann-${suffix}@example.com` }], content: { title: "T", body: "B" }, channels: ["in_app", "email", "push"] });
const rowOf = async (key: string, channel: string) => (await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, key), eq(messageDeliveries.channel, channel))))[0]!;

beforeAll(async () => {
  process.env.MAIL_SEND_RATE = "0";
  setMailSender(async () => undefined);
  installUnsubscribeProvider();
  lead = await signUp("lead");
  outsider = await signUp("outsider");
  const a = await signUp("ann");
  clubA = (await auth.api.createOrganization({ body: { name: `PC A ${suffix}`, slug: `pc-a-${suffix}`, userId: lead.userId } }))!.id;
  clubB = (await auth.api.createOrganization({ body: { name: `PC B ${suffix}`, slug: `pc-b-${suffix}`, userId: lead.userId } }))!.id;
  const leadMemberA = (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, clubA), same(m.userId, lead.userId)) }))!;
  await db.insert(clubRoles).values({ memberId: leadMemberA.id, roleType: "vorsitz" });
  const mA = (await auth.api.addMember({ body: { userId: a.userId, organizationId: clubA, role: "member" } }))!;
  const mB = (await auth.api.addMember({ body: { userId: a.userId, organizationId: clubB, role: "member" } }))!;
  const cmA = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, mA.id) }))!.id;
  const cmB = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, mB.id) }))!.id;
  ann = { userId: a.userId, cookie: a.cookie, cmA, cmB };
  await db.insert(pushTokens).values({ userId: a.userId, token: `ExponentPushToken[pc${suffix}xxxxxxxxxxxx]`, platform: "ios" });
}, 90_000);

afterAll(async () => {
  setMailSender(null);
  setUnsubscribeUrlProvider(null);
  await db.delete(organization).where(eq(organization.id, clubA));
  await db.delete(organization).where(eq(organization.id, clubB));
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await closeDatabase();
});

describe("API", () => {
  it("global view has no overrides block; club view shows the effective switches and the club-specific rows", async () => {
    const global = await json(await req(ann, "/notification-preferences"));
    expect(global.data.clubId).toBeNull();
    expect(global.data).not.toHaveProperty("overrides");
    expect(emailSwitch(global.data)).toBe(true);

    expect((await put(ann, [{ category: "announcements", channel: "email", enabled: false }], clubA)).status).toBe(200);
    const inA = await json(await req(ann, `/notification-preferences?clubId=${clubA}`));
    expect(inA.data.clubId).toBe(clubA);
    expect(emailSwitch(inA.data)).toBe(false);
    expect(inA.data.overrides).toEqual([{ category: "announcements", channel: "email", enabled: false }]);
    const inB = await json(await req(ann, `/notification-preferences?clubId=${clubB}`));
    expect(emailSwitch(inB.data)).toBe(true);
    expect(inB.data.overrides).toEqual([]);
    expect(emailSwitch((await json(await req(ann, "/notification-preferences"))).data)).toBe(true);
  });

  it("a club-specific ON wins over a global OFF", async () => {
    expect((await put(ann, [{ category: "events", channel: "email", enabled: false }])).status).toBe(200);
    expect((await put(ann, [{ category: "events", channel: "email", enabled: true }], clubB)).status).toBe(200);
    expect(emailSwitch((await json(await req(ann, `/notification-preferences?clubId=${clubB}`))).data, "events")).toBe(true);
    expect(emailSwitch((await json(await req(ann, `/notification-preferences?clubId=${clubA}`))).data, "events")).toBe(false);
    expect(emailSwitch((await json(await req(ann, "/notification-preferences"))).data, "events")).toBe(false);
  });

  it("refuses a club the account does not belong to (404, no oracle), a reset without a club (422) and keeps mandatory classes read-only", async () => {
    expect((await req(outsider, `/notification-preferences?clubId=${clubA}`)).status).toBe(404);
    expect((await put(outsider, [{ category: "events", channel: "email", enabled: false }], clubA)).status).toBe(404);
    expect((await req(outsider, `/notification-preferences?clubId=does-not-exist`)).status).toBe(404);
    const reset = await put(ann, [{ category: "events", channel: "email", enabled: null }]);
    expect(reset.status).toBe(422);
    expect((await json(reset)).error.details.code).toBe("reset_needs_club");
    expect((await put(ann, [{ category: "decisions", channel: "email", enabled: false }], clubA)).status).toBe(422);
    expect(await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, outsider.userId))).toHaveLength(0);
  });

  it("a PUT is idempotent and a second club-specific write updates the same row", async () => {
    await put(ann, [{ category: "reminders", channel: "push", enabled: false }], clubA);
    await put(ann, [{ category: "reminders", channel: "push", enabled: false }], clubA);
    await put(ann, [{ category: "reminders", channel: "push", enabled: true }], clubA);
    const rows = await db.select().from(notificationPreferences).where(and(eq(notificationPreferences.userId, ann.userId), eq(notificationPreferences.clubId, clubA), eq(notificationPreferences.category, "reminders")));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.enabled).toBe(true);
  });
});

describe("dispatcher and send-time guards", () => {
  it("a club-specific off silences that club only, for mail and push; in-app stays", async () => {
    await put(ann, [{ category: "announcements", channel: "email", enabled: false }, { category: "announcements", channel: "push", enabled: false }], clubA);
    const keyA = `pc-a-${suffix}`;
    const keyB = `pc-b-${suffix}`;
    await send(clubA, keyA, ann.cmA);
    await send(clubB, keyB, ann.cmB);
    expect((await rowOf(keyA, "email")).status).toBe("skipped_optout");
    expect((await rowOf(keyA, "push")).status).toBe("skipped_optout");
    expect((await rowOf(keyA, "in_app")).status).toBe("sent");
    expect((await rowOf(keyB, "email")).status).toBe("queued");
    expect((await rowOf(keyB, "push")).status).toBe("queued");
  });

  it("is re-checked at send time with the club of the message", async () => {
    await put(ann, [{ category: "announcements", channel: "email", enabled: true }], clubA); // back on in A
    const key = `pc-late-${suffix}`;
    await send(clubA, key, ann.cmA);
    const row = await rowOf(key, "email");
    expect(row.status).toBe("queued");
    await put(ann, [{ category: "announcements", channel: "email", enabled: false }], clubB); // unrelated club: no effect
    await handleEmailDelivery({ id: randomUUID(), type: "notify.email", payload: { deliveryId: row.id }, attempt: 1, maxAttempts: 3 });
    expect((await rowOf(key, "email")).status).toBe("sent");

    const key2 = `pc-late2-${suffix}`;
    await send(clubA, key2, ann.cmA);
    const row2 = await rowOf(key2, "email");
    await put(ann, [{ category: "announcements", channel: "email", enabled: false }], clubA);
    await handleEmailDelivery({ id: randomUUID(), type: "notify.email", payload: { deliveryId: row2.id }, attempt: 1, maxAttempts: 3 });
    expect((await rowOf(key2, "email")).status).toBe("skipped_optout");
  });

  it("mandatory messages ignore club-specific switches", async () => {
    const key = `pc-mand-${suffix}`;
    await notify({ clubId: clubA, class: "mandatory", eventKey: key, recipients: [{ userId: ann.userId, clubMemberId: ann.cmA, email: `pc-ann-${suffix}@example.com` }], content: { title: "Entscheidung", body: "x" }, channels: ["in_app", "email"] });
    expect((await rowOf(key, "email")).status).toBe("queued");
  });
});

describe("unsubscribe tokens", () => {
  /** A token as issued before G12: no `v`, so it keeps the old, global effect. */
  function legacyToken(payload: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const secret = process.env.UNSUBSCRIBE_SECRET || process.env.BETTER_AUTH_SECRET!;
    return `${encoded}.${createHmac("sha256", secret).update(`unsubscribe:v1:${encoded}`).digest().toString("base64url")}`;
  }
  const prefRows = (category: string) => db.select().from(notificationPreferences).where(and(eq(notificationPreferences.userId, ann.userId), eq(notificationPreferences.category, category), eq(notificationPreferences.channel, "email")));

  it("a current token unsubscribes for the club of the mail only", async () => {
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, ann.userId));
    const token = createUnsubscribeToken({ clubId: clubB, userId: ann.userId, clubMemberId: ann.cmB, category: "reminders" })!;
    expect(verifyUnsubscribeToken(token)).toMatchObject({ v: 2, k: clubB });
    expect((await app.request(`/unsubscribe/${token}`, { method: "POST", headers: { "x-forwarded-for": randomUUID() } })).status).toBe(200);
    expect((await prefRows("reminders")).map((r) => [r.clubId, r.enabled])).toEqual([[clubB, false]]);
    // repeating changes nothing
    await app.request(`/unsubscribe/${token}`, { method: "POST", headers: { "x-forwarded-for": randomUUID() } });
    expect(await prefRows("reminders")).toHaveLength(1);
    expect(emailSwitch((await json(await req(ann, `/notification-preferences?clubId=${clubA}`))).data, "reminders")).toBe(true);
    expect(emailSwitch((await json(await req(ann, `/notification-preferences?clubId=${clubB}`))).data, "reminders")).toBe(false);
    // the page names the club
    const page = await app.request(`/unsubscribe/${token}`, { headers: { accept: "text/html", "x-forwarded-for": randomUUID() } });
    expect(await page.text()).toContain(`PC B ${suffix}`);
  });

  it("an old token (issued before the club scope existed) still works and switches the category off globally", async () => {
    const old = legacyToken({ s: "u", p: ann.userId, c: "events", k: clubA, e: Date.now() + 60_000 });
    expect(verifyUnsubscribeToken(old)).toMatchObject({ k: clubA });
    expect(verifyUnsubscribeToken(old)).not.toHaveProperty("v");
    const get = await json(await app.request(`/unsubscribe/${old}`, { headers: { "x-forwarded-for": randomUUID() } }));
    expect(get.data).toMatchObject({ scope: "all", unsubscribed: expect.any(Boolean) });
    const post = await app.request(`/unsubscribe/${old}`, { method: "POST", headers: { "x-forwarded-for": randomUUID() } });
    expect((await json(post)).data).toMatchObject({ scope: "all", unsubscribed: true });
    const rows = await prefRows("events");
    expect(rows.filter((r) => r.clubId === null && r.enabled === false)).toHaveLength(1);
    // global off applies to every club that has no club-specific row of its own ...
    const keyA = `pc-old-a-${suffix}`;
    await notify({ clubId: clubA, class: "optional", eventKey: keyA, recipients: [{ userId: ann.userId, clubMemberId: ann.cmA, email: "x@example.com" }], content: { title: "E", body: "B", category: "events" }, channels: ["email"] });
    expect((await rowOf(keyA, "email")).status).toBe("skipped_optout");
    // ... while an explicit club-specific ON of club B still wins there
    await put(ann, [{ category: "events", channel: "email", enabled: true }], clubB);
    const keyB = `pc-old-b-${suffix}`;
    await notify({ clubId: clubB, class: "optional", eventKey: keyB, recipients: [{ userId: ann.userId, clubMemberId: ann.cmB, email: "x@example.com" }], content: { title: "E", body: "B", category: "events" }, channels: ["email"] });
    expect((await rowOf(keyB, "email")).status).toBe("queued");
    // the HTML page of an old link says so
    const html = await app.request(`/unsubscribe/${old}`, { headers: { accept: "text/html", "x-forwarded-for": randomUUID() } });
    expect(await html.text()).toMatch(/Bereits abgemeldet|in allen Vereinen/);
  });

  it("an account-less member's token is club-scoped too", async () => {
    const [cm] = await db.insert(clubMembers).values({ clubId: clubA, displayName: "Ohne Konto", contactEmail: `pc-nokonto-${suffix}@example.com`, joinedAt: "2020-01-01" }).returning();
    const token = createUnsubscribeToken({ clubId: clubA, userId: null, clubMemberId: cm!.id, category: "announcements" })!;
    expect((await app.request(`/unsubscribe/${token}`, { method: "POST", headers: { "x-forwarded-for": randomUUID() } })).status).toBe(200);
    const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.clubMemberId, cm!.id));
    expect(row).toMatchObject({ clubId: clubA, enabled: false, userId: null });
    const key = `pc-nokonto-${suffix}`;
    const res = await notify({ clubId: clubA, class: "optional", eventKey: key, recipients: [{ clubMemberId: cm!.id, email: `pc-nokonto-${suffix}@example.com` }], content: { title: "A", body: "B" }, channels: ["email"] });
    expect(res.skippedOptout).toBe(1);
  });
});

describe("leadership view per club", () => {
  it("shows the effective state for THIS club only", async () => {
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, ann.userId));
    await put(ann, [{ category: "announcements", channel: "email", enabled: false }], clubA);
    const view = async (club: string) => (await json(await req(lead, `/notification-preferences/members?clubId=${club}&pageSize=100`))).data as Json[];
    expect((await view(clubA)).find((r) => r.clubMemberId === ann.cmA)!.unsubscribed).toBe(true);
    // club B has its own board; ann is not switched off there (the lead is owner of B too)
    const asLeadInB = await req(lead, `/notification-preferences/members?clubId=${clubB}&pageSize=100`);
    expect(asLeadInB.status).toBe(403); // no board role in B: deny by default
    // global off + club-specific on = reachable in A
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, ann.userId));
    await put(ann, [{ category: "announcements", channel: "email", enabled: false }]);
    expect((await view(clubA)).find((r) => r.clubMemberId === ann.cmA)!.unsubscribed).toBe(true);
    await put(ann, [{ category: "announcements", channel: "email", enabled: true }], clubA);
    expect((await view(clubA)).find((r) => r.clubMemberId === ann.cmA)!.unsubscribed).toBe(false);
  });
});
