import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubAnnouncements } from "../db/schema/communication.js";
import { rateLimitEvents } from "../db/schema/rate-limits.js";
import { handlePublishAnnouncement, PUBLISH_JOB_TYPE } from "../lib/announcements.js";
import { toAppError } from "../lib/errors.js";
import { enforceLimit, purgeRateLimitEvents, tryConsume } from "../lib/rate-limits.js";
import { setMailSender } from "../lib/notify/index.js";
import { clubAnnouncementRoutes } from "./club-announcements.js";
import { unsubscribeRoutes } from "./notification-preferences.js";

/** Wave 9 B14: DB-backed rate limits and anti-spam for announcements. */

const app = new Hono();
app.route("/club-announcements", clubAnnouncementRoutes);
app.route("/unsubscribe", unsubscribeRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let club: string;
let cookie: string;
let userId: string;
const extraUsers: string[] = [];
const ENV_KEYS = ["ANNOUNCEMENT_MAX_PER_CLUB_DAY", "ANNOUNCEMENT_MAX_PER_AUTHOR_HOUR", "ANNOUNCEMENT_MAX_URGENT_PER_DAY", "ANNOUNCEMENT_MAX_RECIPIENTS", "ANNOUNCEMENT_CONFIRM_THRESHOLD", "ANNOUNCEMENT_DUPLICATE_WINDOW_MINUTES"];

const call = (url: string, init: { method?: string; body?: object } = {}) =>
  app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (res: Response) => (await res.json()) as Json;

async function draft(extra: object = {}): Promise<string> {
  const res = await call("/club-announcements", { method: "POST", body: { title: `T ${randomUUID()}`, body: `B ${randomUUID()}`, audience: { all: true }, ...extra } });
  expect(res.status).toBe(201);
  return (await json(res)).data.id as string;
}
const send = (id: string, body: object = {}) => call(`/club-announcements/${id}/send`, { method: "POST", body });
const audits = async (rule: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.eventType, "club_announcement.limit_exceeded"))).filter((r) => (r.payload as Json).clubId === club && (r.payload as Json).rule === rule);

beforeAll(async () => {
  process.env.MAIL_SEND_RATE = "0";
  setMailSender(async () => undefined);
  const email = `b14-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: "B14" } });
  userId = created.id;
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0]!;
  club = (await auth.api.createOrganization({ body: { name: `B14 ${suffix}`, slug: `b14-${suffix}`, userId } }))!.id;
  const fm = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, userId)) }))!;
  await db.insert(clubRoles).values({ memberId: fm.id, roleType: "vorsitz" });
}, 60_000);

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterAll(async () => {
  setMailSender(null);
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(user).where(inArray(user.id, [userId, ...extraUsers]));
  await closeDatabase();
});

describe("announcement limits (B14)", () => {
  it("limits announcements per author and hour (429, audit)", async () => {
    process.env.ANNOUNCEMENT_MAX_PER_AUTHOR_HOUR = "2";
    process.env.ANNOUNCEMENT_MAX_PER_CLUB_DAY = "1000";
    const before = (await audits("announcement.author_hour")).length;
    const ok1 = await send(await draft());
    const ok2 = await send(await draft());
    expect([ok1.status, ok2.status]).toEqual([200, 200]);
    const over = await draft();
    const res = await send(over);
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.error.code).toBe("TOO_MANY_REQUESTS");
    expect(body.error.message).toContain("last hour");
    expect(body.error.details.rule).toBe("announcement.author_hour");
    expect((await audits("announcement.author_hour")).length).toBe(before + 1);
    // The refused announcement is still a draft and can be sent later.
    const [row] = await db.select().from(clubAnnouncements).where(eq(clubAnnouncements.id, over));
    expect(row!.status).toBe("draft");
  });

  it("limits announcements per club and day", async () => {
    const sent = await db.select().from(clubAnnouncements).where(and(eq(clubAnnouncements.clubId, club), eq(clubAnnouncements.status, "sent")));
    process.env.ANNOUNCEMENT_MAX_PER_CLUB_DAY = String(sent.length);
    const res = await send(await draft());
    expect(res.status).toBe(429);
    expect((await json(res)).error.details.rule).toBe("announcement.club_day");
  });

  it("limits urgent announcements per day", async () => {
    process.env.ANNOUNCEMENT_MAX_URGENT_PER_DAY = "1";
    expect((await send(await draft({ urgent: true }))).status).toBe(200);
    const res = await send(await draft({ urgent: true }));
    expect(res.status).toBe(429);
    expect((await json(res)).error.details.rule).toBe("announcement.urgent_day");
    // A normal announcement is not affected by the urgent limit.
    expect((await send(await draft())).status).toBe(200);
  });

  it("refuses a duplicate (same text and audience) within the window, allows it after / for other text", async () => {
    const payload = { title: `Dup ${suffix}`, body: "Gleicher Text" };
    expect((await send(await draft(payload))).status).toBe(200);
    const res = await send(await draft(payload));
    expect(res.status).toBe(429);
    expect((await json(res)).error.details.rule).toBe("announcement.duplicate");
    expect((await send(await draft({ ...payload, body: "Anderer Text" }))).status).toBe(200);
    process.env.ANNOUNCEMENT_DUPLICATE_WINDOW_MINUTES = "0";
    expect((await send(await draft(payload))).status).toBe(200);
  });

  it("refuses more recipients than ANNOUNCEMENT_MAX_RECIPIENTS", async () => {
    process.env.ANNOUNCEMENT_MAX_RECIPIENTS = "1";
    // two club members: the founder and one more row
    await db.insert(clubMembers).values({ clubId: club, displayName: "Zweite Person", joinedAt: "2020-01-01", contactEmail: `b14-second-${suffix}@example.test` });
    const res = await send(await draft());
    expect(res.status).toBe(429);
    const body = await json(res);
    expect(body.error.details).toMatchObject({ rule: "announcement.max_recipients", recipients: 2, limit: 1 });
  });

  it("requires confirmRecipients above the threshold and accepts the exact count", async () => {
    process.env.ANNOUNCEMENT_CONFIRM_THRESHOLD = "1";
    const id = await draft();
    const first = await send(id);
    expect(first.status).toBe(422);
    const body = await json(first);
    expect(body.error.code).toBe("RECIPIENT_CONFIRMATION_REQUIRED");
    expect(body.error.details).toMatchObject({ recipients: 2, threshold: 1 });
    expect((await send(id, { confirmRecipients: 1 })).status).toBe(422);
    const ok = await send(id, { confirmRecipients: 2 });
    expect(ok.status).toBe(200);
  });

  it("requires the confirmation when scheduling too, and a scheduled send that hits a limit becomes a draft again", async () => {
    process.env.ANNOUNCEMENT_CONFIRM_THRESHOLD = "1";
    const id = await draft();
    const at = new Date(Date.now() + 3_600_000).toISOString();
    expect((await send(id, { publishAt: at })).status).toBe(422);
    expect((await send(id, { publishAt: at, confirmRecipients: 2 })).status).toBe(200);
    // When the time comes the club is over its daily limit.
    process.env.ANNOUNCEMENT_MAX_PER_CLUB_DAY = "1";
    const [row] = await db.select().from(clubAnnouncements).where(eq(clubAnnouncements.id, id));
    await handlePublishAnnouncement({ id: randomUUID(), type: PUBLISH_JOB_TYPE, payload: { announcementId: id, publishAt: row!.publishAt!.toISOString() }, attempt: 1, maxAttempts: 5 });
    const [after] = await db.select().from(clubAnnouncements).where(eq(clubAnnouncements.id, id));
    expect(after!.status).toBe("draft");
    expect((await audits("announcement.club_day")).some((a) => a.subjectId === id)).toBe(true);
  });

  it("keeps the Zod validation of confirmRecipients", async () => {
    const res = await send(await draft(), { confirmRecipients: -1 });
    expect(res.status).toBe(422);
  });
});

describe("DB-backed rate limits (B14)", () => {
  it("counts hits in a sliding window, shared through the database", async () => {
    const spec = { bucket: `t.window.${suffix}`, subject: "s1", windowMs: 60_000, max: 3 };
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await tryConsume(spec)).allowed);
    expect(results).toEqual([true, true, true, false, false]);
    // another subject is independent; hits older than the window do not count (also after a "restart": state is in the DB)
    expect((await tryConsume({ ...spec, subject: "s2" })).allowed).toBe(true);
    await db.update(rateLimitEvents).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(rateLimitEvents.bucket, spec.bucket));
    expect((await tryConsume(spec)).allowed).toBe(true);
  });

  it("is atomic under concurrency", async () => {
    const spec = { bucket: `t.atomic.${suffix}`, subject: "s", windowMs: 60_000, max: 5 };
    const results = await Promise.all(Array.from({ length: 20 }, () => tryConsume(spec)));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it("enforceLimit throws 429 with a message and audits once per window", async () => {
    const spec = { bucket: `t.enforce.${suffix}`, subject: "abc", windowMs: 60_000, max: 1 };
    await enforceLimit(spec);
    await expect(enforceLimit(spec)).rejects.toMatchObject({ status: 429, details: { rule: spec.bucket } });
    await expect(enforceLimit(spec)).rejects.toMatchObject({ status: 429 });
    const rows = (await db.select().from(auditLog).where(eq(auditLog.eventType, "rate_limit.exceeded"))).filter((r) => (r.payload as Json).rule === spec.bucket);
    expect(rows).toHaveLength(1);
  });

  it("limits the public unsubscribe endpoint per client IP and never stores the raw IP", async () => {
    process.env.UNSUBSCRIBE_IP_LIMIT_PER_HOUR = "3";
    const ip = `203.0.113.${suffix % 250}`;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await app.request("/unsubscribe/garbage", { headers: { "x-forwarded-for": ip } })).status);
    delete process.env.UNSUBSCRIBE_IP_LIMIT_PER_HOUR;
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
    const rows = await db.select().from(rateLimitEvents).where(eq(rateLimitEvents.bucket, "unsubscribe.ip"));
    expect(rows.some((r) => r.subject.includes(ip))).toBe(false);
  });

  it("purges old hits", async () => {
    await db.insert(rateLimitEvents).values({ bucket: `t.purge.${suffix}`, subject: "x", createdAt: new Date(Date.now() - 3 * 24 * 3_600_000) });
    expect(await purgeRateLimitEvents()).toBeGreaterThanOrEqual(1);
  });
});
