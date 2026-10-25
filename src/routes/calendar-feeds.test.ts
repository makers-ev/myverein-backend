import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { calendarFeedTokens } from "../db/schema/calendar-feed-tokens.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { calendarFeedRoutes, feedRoutes, MAX_ACTIVE_FEEDS } from "./calendar-feeds.js";
import { calendarRoutes } from "./calendars.js";
import { eventSeriesRoutes } from "./event-series.js";
import { eventRoutes } from "./events.js";

/** Integration test (real Postgres): token links, public fetch without session, rights at fetch time, revocation, rate limits, IDOR. */

const app = new Hono();
app.route("/calendars", calendarRoutes);
app.route("/events", eventRoutes);
app.route("/event-series", eventSeriesRoutes);
app.route("/calendar-feeds", calendarFeedRoutes);
app.route("/feeds", feedRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUp(email: string, name: string) {
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("calendar feed links", () => {
  let clubA: string;
  let board: string;
  let member: string;
  let member2: string;
  let guest: string;
  let memberAccountId: string;
  let calendarId: string;
  let secondCalendarId: string;
  const userIds: string[] = [];

  const call = (cookie: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(`${path}${path.includes("?") ? "&" : "?"}clubId=${clubA}`, { method: init.method ?? "GET", headers: { cookie, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const fetchFeed = (token: string, headers: Record<string, string> = {}) => app.request(`/feeds/${token}.ics`, { headers: { "x-forwarded-for": randomUUID(), ...headers } });
  type Created = { data: { id: string; token: string; url: string; webcalUrl: string; calendarId: string | null } };
  const createLink = async (cookie: string, body: Record<string, unknown> = {}) => {
    const res = await call(cookie, "/calendar-feeds", { method: "POST", body });
    expect(res.status).toBe(201);
    return ((await res.json()) as Created).data;
  };

  beforeAll(async () => {
    const [b, m, m2, g] = await Promise.all([
      signUp(`feed-board-${suffix}@example.com`, "Feed Board"),
      signUp(`feed-member-${suffix}@example.com`, "Feed Member"),
      signUp(`feed-member2-${suffix}@example.com`, "Feed Member Two"),
      signUp(`feed-guest-${suffix}@example.com`, "Feed Guest"),
    ]);
    userIds.push(b.userId, m.userId, m2.userId, g.userId);
    board = b.cookie;
    member = m.cookie;
    member2 = m2.cookie;
    guest = g.cookie;
    memberAccountId = m.userId;
    clubA = (await auth.api.createOrganization({ body: { name: `Feed A ${suffix}`, slug: `feed-a-${suffix}`, userId: b.userId } }))!.id;
    await auth.api.addMember({ body: { userId: m.userId, organizationId: clubA, role: "member" } });
    await auth.api.addMember({ body: { userId: m2.userId, organizationId: clubA, role: "member" } });
    await auth.api.addMember({ body: { userId: g.userId, organizationId: clubA, role: "guest" } });
    const boardMember = await db.query.member.findFirst({ where: (x, { and, eq: e }) => and(e(x.organizationId, clubA), e(x.userId, b.userId)) });
    await db.insert(clubRoles).values({ memberId: boardMember!.id, roleType: "vorsitz" });
    const mk = async (name: string) => ((await (await call(board, "/calendars", { method: "POST", body: { name } })).json()) as { data: { id: string } }).data.id;
    calendarId = await mk("Feed Kalender");
    secondCalendarId = await mk("Feed Zweitkalender");
    await call(board, "/events", { method: "POST", body: { calendarId, title: "Feed-Termin", startsAt: "2031-05-01T08:00:00Z", endsAt: "2031-05-01T09:00:00Z", locationId: undefined } });
    await call(board, "/events", { method: "POST", body: { calendarId: secondCalendarId, title: "Zweit-Termin", startsAt: "2031-05-02T08:00:00Z" } });
    await call(board, "/event-series", { method: "POST", body: { calendarId, title: "Feed-Serie", startDate: "2031-06-02", startTime: "18:00", durationMinutes: 60, freq: "weekly", count: 3 } });
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubA));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("creates a link: token shown once, only the hash is stored, list and responses never contain the token", async () => {
    const link = await createLink(member, { label: "Handy" });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.url.endsWith(`/feeds/${link.token}.ics`)).toBe(true);
    expect(link.webcalUrl.startsWith("webcal://") || link.webcalUrl.startsWith("/feeds/")).toBe(true);
    const [stored] = await db.select().from(calendarFeedTokens).where(eq(calendarFeedTokens.id, link.id));
    expect(stored!.tokenHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(link.token);

    const list = (await (await call(member, "/calendar-feeds")).json()) as { data: Array<Record<string, unknown>> };
    expect(list.data.map((l) => l.id)).toContain(link.id);
    expect(JSON.stringify(list)).not.toContain(link.token);
    expect(list.data[0]).not.toHaveProperty("token");
    expect(list.data[0]).not.toHaveProperty("tokenHash");
  });

  it("serves the feed without any session, with event data only, private caching and an ETag", async () => {
    const link = await createLink(member);
    const res = await fetchFeed(link.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    expect(res.headers.get("cache-control")).toContain("private");
    const text = (await res.text()).replace(/\r\n /g, "");
    expect(text).toContain("SUMMARY:Feed-Termin");
    expect(text).toContain("SUMMARY:Feed-Serie");
    expect(text).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO;WKST=MO;COUNT=3");
    expect(text).not.toContain("@example.com");
    expect(text).not.toContain("Feed Member");
    const etag = res.headers.get("etag")!;
    expect((await fetchFeed(link.token, { "if-none-match": etag })).status).toBe(304);
    const [row] = await db.select().from(calendarFeedTokens).where(eq(calendarFeedTokens.id, link.id));
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it("limits a link to one calendar", async () => {
    const link = await createLink(member, { calendarId: secondCalendarId });
    const text = await (await fetchFeed(link.token)).text();
    expect(text).toContain("SUMMARY:Zweit-Termin");
    expect(text).not.toContain("Feed-Termin");
    expect((await call(member, "/calendar-feeds", { method: "POST", body: { calendarId: randomUUID() } })).status).toBe(404);
  });

  it("answers 404 for unknown, malformed and non-.ics links without telling them apart", async () => {
    for (const file of [`${randomUUID()}.ics`, "x.ics", `${"A".repeat(43)}`, `${"A".repeat(43)}.ics`, `${"A".repeat(43)}.txt`]) {
      const res = await app.request(`/feeds/${file}`, { headers: { "x-forwarded-for": randomUUID() } });
      expect(res.status).toBe(404);
    }
  });

  it("revocation and rotation take effect on the next fetch; foreign links are 404", async () => {
    const link = await createLink(member);
    expect((await call(member2, `/calendar-feeds/${link.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(member2, `/calendar-feeds/${link.id}/rotate`, { method: "POST" })).status).toBe(404);
    expect((await fetchFeed(link.token)).status).toBe(200);

    const rotated = (await (await call(member, `/calendar-feeds/${link.id}/rotate`, { method: "POST" })).json()) as Created;
    expect(rotated.data.token).not.toBe(link.token);
    expect((await fetchFeed(link.token)).status).toBe(404);
    expect((await fetchFeed(rotated.data.token)).status).toBe(200);

    expect((await call(member, `/calendar-feeds/${rotated.data.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await fetchFeed(rotated.data.token)).status).toBe(404);
    expect((await call(member, `/calendar-feeds/${rotated.data.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("applies the member's rights at fetch time: restricting a calendar hides it, leaving the club ends the link", async () => {
    const link = await createLink(member2);
    expect(await (await fetchFeed(link.token)).text()).toContain("Zweit-Termin");
    const grant = await call(board, `/calendars/${secondCalendarId}/visibility`, { method: "POST", body: { roleType: "trainer" } });
    expect(grant.status).toBe(201);
    const restricted = await (await fetchFeed(link.token)).text();
    expect(restricted).not.toContain("Zweit-Termin");
    expect(restricted).toContain("Feed-Termin");

    const account = await db.query.member.findFirst({ where: (x, { and, eq: e }) => and(e(x.organizationId, clubA), e(x.userId, memberAccountId)) });
    const own = await createLink(member);
    expect((await fetchFeed(own.token)).status).toBe(200);
    await call(member, "/events"); // makes sure the club_members row exists
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.memberId, account!.id));
    expect((await fetchFeed(own.token)).status).toBe(404);
  });

  it("is available to account members only, and capped per member", async () => {
    expect((await call(guest, "/calendar-feeds", { method: "POST", body: {} })).status).toBe(403);
    expect((await call(guest, "/calendar-feeds")).status).toBe(403);
    expect((await app.request(`/calendar-feeds?clubId=${clubA}`)).status).toBe(401);
    for (let i = 0; i < MAX_ACTIVE_FEEDS; i++) {
      const res = await call(board, "/calendar-feeds", { method: "POST", body: {} });
      if (res.status !== 201) {
        expect(res.status).toBe(409);
        return;
      }
    }
    expect((await call(board, "/calendar-feeds", { method: "POST", body: {} })).status).toBe(409);
  });

  it("stops a client that keeps guessing links (429 after the invalid-link budget)", async () => {
    const headers = { "x-forwarded-for": `198.51.100.${(suffix % 200) + 1}` };
    let last = 0;
    for (let i = 0; i < 25; i++) {
      last = (await app.request(`/feeds/${randomUUID()}.ics`, { headers })).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});
