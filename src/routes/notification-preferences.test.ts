import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { messageDeliveries, notificationPreferences } from "../db/schema/communication.js";
import { createUnsubscribeToken, handleEmailDelivery, installUnsubscribeProvider, notify, setMailSender, setUnsubscribeUrlProvider, verifyUnsubscribeToken, type MailSender } from "../lib/notify/index.js";
import { toAppError } from "../lib/errors.js";
import { notificationPreferenceRoutes, unsubscribeRoutes } from "./notification-preferences.js";

/** Wave 9 B9: own preferences, mandatory classes, signed unsubscribe links (also account-less), leadership yes/no view. */

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
type Actor = { userId: string; cookie: string; memberId: string; clubMemberId: string };

async function signUp(label: string) {
  const email = `b9-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `B9 ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

let club: string;
const json = async (res: Response) => (await res.json()) as Json;
const call = (who: { cookie: string }, url: string, init: { method?: string; body?: object } = {}) =>
  app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const open = (method: string, token: string, headers: Record<string, string> = {}) => app.request(`/unsubscribe/${token}`, { method, headers: { "x-forwarded-for": randomUUID(), ...headers } });

describe("notification preferences and unsubscribe (B9)", () => {
  let board: Actor;
  let anna: Actor;
  let ben: Actor;
  let accountless: string; // club_members.id without account
  const userIds: string[] = [];
  const sent: Array<Parameters<MailSender>[0]> = [];
  const double: MailSender = async (mail) => {
    sent.push(mail);
  };

  async function join(label: string, roles: string[] = []): Promise<Actor> {
    const s = await signUp(label);
    userIds.push(s.userId);
    const account = (await auth.api.addMember({ body: { userId: s.userId, organizationId: club, role: "member" } }))!;
    for (const roleType of roles) await db.insert(clubRoles).values({ memberId: account.id, roleType });
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
    return { ...s, memberId: account.id, clubMemberId: row.id };
  }

  beforeAll(async () => {
    process.env.MAIL_SEND_RATE = "0";
    setMailSender(double);
    installUnsubscribeProvider();
    const f = await signUp("founder");
    userIds.push(f.userId);
    club = (await auth.api.createOrganization({ body: { name: `B9 Club ${suffix}`, slug: `b9-${suffix}`, userId: f.userId } }))!.id;
    const fm = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, f.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: fm.id, roleType: "vorsitz" });
    board = { ...f, memberId: fm.id, clubMemberId: (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, fm.id) }))!.id };
    anna = await join("anna");
    ben = await join("ben");
    const [row] = await db.insert(clubMembers).values({ clubId: club, displayName: "Ohne Konto", firstName: "Ohne", contactEmail: `nokonto-${suffix}@example.com`, joinedAt: "2020-01-01" }).returning();
    accountless = row!.id;
  }, 90_000);

  afterEach(() => {
    sent.length = 0;
  });

  afterAll(async () => {
    setMailSender(null);
    setUnsubscribeUrlProvider(null);
    await db.delete(organization).where(eq(organization.id, club));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("own preferences", () => {
    it("lists the board category only for accounts with a role that holds members:write, and any account can store it", async () => {
      const asBoard = await json(await call(board, "/notification-preferences"));
      expect(asBoard.data.categories.map((c: Json) => c.category)).toEqual(["announcements", "events", "reminders", "board"]);
      const asMember = await json(await call(anna, "/notification-preferences"));
      expect(asMember.data.categories.map((c: Json) => c.category)).not.toContain("board");

      const off = await call(board, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "board", channel: "email", enabled: false }] } });
      expect(off.status).toBe(200);
      const after = await json(off);
      expect(after.data.categories.find((c: Json) => c.category === "board").channels.find((ch: Json) => ch.channel === "email").enabled).toBe(false);
      // the personal reminders stay on: the board digest is its own switch
      expect(after.data.categories.find((c: Json) => c.category === "reminders").channels.find((ch: Json) => ch.channel === "email").enabled).toBe(true);
      await call(board, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "board", channel: "email", enabled: true }] } });
    });

    it("needs a session (401) and starts with everything on; in-app and mandatory classes are read-only", async () => {
      expect((await app.request("/notification-preferences")).status).toBe(401);
      const res = await json(await call(anna, "/notification-preferences"));
      expect(res.data.categories.map((c: Json) => c.category)).toEqual(["announcements", "events", "reminders"]);
      for (const cat of res.data.categories) {
        expect(cat.channels).toEqual([
          { channel: "in_app", enabled: true, switchable: false },
          { channel: "email", enabled: true, switchable: true },
          { channel: "push", enabled: true, switchable: true },
        ]);
      }
      expect(res.data.mandatory.every((m: Json) => m.switchable === false)).toBe(true);
    });

    it("switches a category x channel off and on again (own row only)", async () => {
      const off = await call(anna, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "events", channel: "email", enabled: false }] } });
      expect(off.status).toBe(200);
      const events = (await json(off)).data.categories.find((c: Json) => c.category === "events");
      expect(events.channels.find((c: Json) => c.channel === "email").enabled).toBe(false);
      expect((await json(await call(ben, "/notification-preferences"))).data.categories.find((c: Json) => c.category === "events").channels[1].enabled).toBe(true);
      await call(anna, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "events", channel: "email", enabled: true }] } });
      const rows = await db.select().from(notificationPreferences).where(and(eq(notificationPreferences.userId, anna.userId), eq(notificationPreferences.category, "events")));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.enabled).toBe(true);
    });

    it("refuses mandatory classes, in-app and unknown values (422) without changing anything", async () => {
      for (const p of [{ category: "decisions", channel: "email", enabled: false }, { category: "account_security", channel: "email", enabled: false }, { category: "announcements", channel: "in_app", enabled: false }, { category: "nope", channel: "email", enabled: false }, { category: "announcements", channel: "sms", enabled: false }]) {
        const res = await call(anna, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "reminders", channel: "email", enabled: false }, p] } });
        expect(res.status, JSON.stringify(p)).toBe(422);
      }
      const rows = await db.select().from(notificationPreferences).where(and(eq(notificationPreferences.userId, anna.userId), eq(notificationPreferences.category, "reminders")));
      expect(rows).toHaveLength(0); // the valid first entry was not applied either
    });

    it("a disabled category is honoured by notify, a mandatory message still arrives", async () => {
      await call(ben, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "announcements", channel: "email", enabled: false }] } });
      const optional = await notify({ clubId: club, class: "optional", eventKey: `b9-opt-${suffix}`, recipients: [{ userId: ben.userId, clubMemberId: ben.clubMemberId, email: "ben@example.com" }], content: { title: "A", body: "B" }, channels: ["in_app", "email"] });
      expect(optional).toMatchObject({ inApp: 1, queuedEmail: 0, skippedOptout: 1 });
      const mandatory = await notify({ clubId: club, class: "mandatory", eventKey: `b9-man-${suffix}`, recipients: [{ userId: ben.userId, clubMemberId: ben.clubMemberId, email: "ben@example.com" }], content: { title: "A", body: "B" }, channels: ["email"] });
      expect(mandatory.queuedEmail).toBe(1);
      await call(ben, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "announcements", channel: "email", enabled: true }] } });
    });
  });

  describe("unsubscribe links", () => {
    async function mailFor(who: { userId: string | null; clubMemberId: string; email: string }, key: string) {
      await notify({ clubId: club, class: "optional", eventKey: key, recipients: [{ userId: who.userId, clubMemberId: who.clubMemberId, email: who.email }], content: { title: "Hallo", body: "Welt" }, channels: ["email"] });
      const [row] = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, key), eq(messageDeliveries.channel, "email")));
      if (row!.status === "queued") await handleEmailDelivery({ id: randomUUID(), type: "notify.email", payload: { deliveryId: row!.id }, attempt: 1, maxAttempts: 3 });
      return { row: row!, mail: sent[sent.length - 1] };
    }
    const tokenOf = (mail: { headers?: Record<string, string> } | undefined) => /\/unsubscribe\/([^>]+)>/.exec(mail!.headers!["List-Unsubscribe"]!)![1]!;

    it("mails carry a List-Unsubscribe URL with one-click POST; the link works end to end for an account holder", async () => {
      const { mail } = await mailFor({ userId: anna.userId, clubMemberId: anna.clubMemberId, email: "anna@example.com" }, `b9-link-${suffix}`);
      expect(mail!.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      const token = tokenOf(mail);
      expect(mail!.html).toContain(`/unsubscribe/${token}`);
      expect(verifyUnsubscribeToken(token)).toMatchObject({ s: "u", p: anna.userId, c: "announcements", k: club });

      // confirmation payload (GET) changes nothing
      const get = await json(await open("GET", token));
      expect(get.data).toEqual({ category: "announcements", channel: "email", clubName: `B9 Club ${suffix}`, unsubscribed: false });
      // one-click POST with the RFC 8058 body
      const post = await app.request(`/unsubscribe/${token}`, { method: "POST", headers: { "x-forwarded-for": randomUUID(), "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
      expect(post.status).toBe(200);
      expect((await json(post)).data).toEqual({ category: "announcements", channel: "email", unsubscribed: true });
      expect((await json(await open("GET", token))).data.unsubscribed).toBe(true);

      // the preference is visible in the settings and respected by the next send
      const prefs = await json(await call(anna, "/notification-preferences"));
      expect(prefs.data.categories[0].channels[1]).toMatchObject({ channel: "email", enabled: false });
      const next = await notify({ clubId: club, class: "optional", eventKey: `b9-after-${suffix}`, recipients: [{ userId: anna.userId, clubMemberId: anna.clubMemberId, email: "anna@example.com" }], content: { title: "A", body: "B" }, channels: ["email"] });
      expect(next.skippedOptout).toBe(1);
      // other categories stay on
      expect(prefs.data.categories[1].channels[1].enabled).toBe(true);
    });

    it("works for a member without account and without login (club member subject)", async () => {
      const { mail } = await mailFor({ userId: null, clubMemberId: accountless, email: `nokonto-${suffix}@example.com` }, `b9-nolog-${suffix}`);
      const token = tokenOf(mail);
      expect(verifyUnsubscribeToken(token)).toMatchObject({ s: "m", p: accountless });
      expect((await open("POST", token)).status).toBe(200);
      const [pref] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.clubMemberId, accountless));
      expect(pref).toMatchObject({ userId: null, category: "announcements", channel: "email", enabled: false });
      const next = await notify({ clubId: club, class: "optional", eventKey: `b9-after2-${suffix}`, recipients: [{ clubMemberId: accountless, email: `nokonto-${suffix}@example.com` }], content: { title: "A", body: "B" }, channels: ["email"] });
      expect(next.skippedOptout).toBe(1);
    });

    it("mandatory mail has no unsubscribe header", async () => {
      await notify({ clubId: club, class: "mandatory", eventKey: `b9-mand-${suffix}`, recipients: [{ userId: board.userId, clubMemberId: board.clubMemberId, email: "board@example.com" }], content: { title: "Entscheidung", body: "Angenommen" }, channels: ["email"] });
      const [row] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.eventKey, `b9-mand-${suffix}`));
      await handleEmailDelivery({ id: randomUUID(), type: "notify.email", payload: { deliveryId: row!.id }, attempt: 1, maxAttempts: 3 });
      expect(sent[0]!.headers).toBeUndefined();
    });

    it("can be reused (idempotent) until the user switches back; a reuse re-applies the opt-out", async () => {
      const token = createUnsubscribeToken({ clubId: club, userId: ben.userId, clubMemberId: ben.clubMemberId, category: "reminders" })!;
      expect((await open("POST", token)).status).toBe(200);
      expect((await open("POST", token)).status).toBe(200);
      const rows = await db.select().from(notificationPreferences).where(and(eq(notificationPreferences.userId, ben.userId), eq(notificationPreferences.category, "reminders")));
      expect(rows).toHaveLength(1);
      await call(ben, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "reminders", channel: "email", enabled: true }] } });
      expect((await json(await call(ben, "/notification-preferences"))).data.categories[2].channels[1].enabled).toBe(true);
      expect((await open("POST", token)).status).toBe(200);
      expect((await json(await call(ben, "/notification-preferences"))).data.categories[2].channels[1].enabled).toBe(false);
      await call(ben, "/notification-preferences", { method: "PUT", body: { preferences: [{ category: "reminders", channel: "email", enabled: true }] } });
    });

    it("answers tampered, expired, foreign and garbage tokens identically (404, no oracle) and changes nothing", async () => {
      const good = createUnsubscribeToken({ clubId: club, userId: ben.userId, clubMemberId: ben.clubMemberId, category: "events" })!;
      const [payload, sig] = good.split(".") as [string, string];
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), p: anna.userId })).toString("base64url");
      const expired = createUnsubscribeToken({ clubId: club, userId: ben.userId, clubMemberId: ben.clubMemberId, category: "events" }, Date.now() - 10_000, 1000)!;
      const ghost = createUnsubscribeToken({ clubId: "no-such-club", userId: "no-such-user", clubMemberId: null, category: "events" })!;
      const bodies = new Set<string>();
      for (const token of [`${forged}.${sig}`, `${payload}.${sig.slice(0, 10)}`, expired, "garbage", "a.b", "x".repeat(2000)]) {
        for (const method of ["GET", "POST"]) {
          const res = await open(method, token);
          expect(res.status, `${method} ${token.slice(0, 20)}`).toBe(404);
          bodies.add(JSON.stringify(((await json(res)) as Json).error ?? (await Promise.resolve("x"))));
        }
      }
      expect(bodies.size).toBe(1);
      // a validly signed token of a deleted person is indistinguishable from a real one
      expect((await open("GET", ghost)).status).toBe(200);
      expect((await open("POST", ghost)).status).toBe(200);
      const ghostRows = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, "no-such-user"));
      expect(ghostRows).toHaveLength(0);
      const rows = await db.select().from(notificationPreferences).where(and(eq(notificationPreferences.userId, anna.userId), eq(notificationPreferences.category, "events")));
      expect(rows.filter((r) => r.enabled === false)).toHaveLength(0);
    });

    it("never accepts a mandatory category in a token, and renders a confirmation page for browsers", async () => {
      expect(createUnsubscribeToken({ clubId: club, userId: ben.userId, clubMemberId: null, category: "decisions" })).toBeNull();
      const token = createUnsubscribeToken({ clubId: club, userId: ben.userId, clubMemberId: ben.clubMemberId, category: "events" })!;
      const html = await open("GET", token, { accept: "text/html,application/xhtml+xml" });
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("referrer-policy")).toBe("no-referrer");
      const text = await html.text();
      expect(text).toContain("Abbestellen");
      expect(text).toContain("B9 Club");
      const bad = await open("GET", "garbage", { accept: "text/html" });
      expect(bad.status).toBe(404);
    });

    it("is rate limited per client (429)", async () => {
      let last = 200;
      for (let i = 0; i < 40; i++) {
        const res = await app.request("/unsubscribe/garbage", { headers: { "x-forwarded-for": "198.51.100.77" } });
        last = res.status;
        if (last === 429) break;
      }
      expect(last).toBe(429);
    });
  });

  describe("leadership view", () => {
    it("shows unsubscribed yes/no per member and nothing more; plain members are denied", async () => {
      const res = await call(board, "/notification-preferences/members?pageSize=100");
      expect(res.status).toBe(200);
      const data = (await json(res)).data as Json[];
      const byId = new Map(data.map((r) => [r.clubMemberId, r]));
      expect(byId.get(anna.clubMemberId)).toEqual({ clubMemberId: anna.clubMemberId, displayName: expect.any(String), unsubscribed: true });
      expect(byId.get(accountless)!.unsubscribed).toBe(true);
      expect(byId.get(ben.clubMemberId)!.unsubscribed).toBe(false);
      for (const row of data) expect(Object.keys(row).sort()).toEqual(["clubMemberId", "displayName", "unsubscribed"]);

      const only = await json(await call(board, "/notification-preferences/members?unsubscribed=true"));
      expect(only.data.map((r: Json) => r.clubMemberId).sort()).toEqual([anna.clubMemberId, accountless].sort());
      expect((await call(anna, "/notification-preferences/members")).status).toBe(403);
    });

    it("is club-scoped: a user of another club gets 404", async () => {
      const outsider = await signUp("outsider");
      userIds.push(outsider.userId);
      expect((await call(outsider, "/notification-preferences/members")).status).toBe(404);
    });
  });
});
