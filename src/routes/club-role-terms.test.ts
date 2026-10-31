import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { jobs } from "../db/schema/jobs.js";
import { addDays } from "../lib/club-time.js";
import { toAppError } from "../lib/errors.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { crossedThreshold, runTermSweep } from "../lib/term-jobs.js";
import { termStatus } from "../lib/term-status.js";
import { clubInfoRoutes } from "./club-info.js";
import { clubRoleRoutes } from "./club-roles.js";
import { clubSettingsRoutes } from "./club-settings.js";

/** Wave 11 B8: term status, `GET /club-roles/expiring`, the reminder sweep and the suspend effect in clubGuard. */

const app = new Hono();
app.route("/club-roles", clubRoleRoutes);
app.route("/club-info", clubInfoRoutes);
app.route("/club-settings", clubSettingsRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { userId: string; cookie: string; memberId: string };
const userIds: string[] = [];
let club: string;
let chair: Who;
let clerk: Who;
let plain: Who;
const today = todayBerlin();

async function signUp(label: string): Promise<Who> {
  const email = `w11t-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `W11T ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]!, memberId: "" };
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
  clerk = await signUp("clerk");
  plain = await signUp("plain");
  club = (await auth.api.createOrganization({ body: { name: `TV Amtszeit ${suffix}`, slug: `w11t-${suffix}`, userId: chair.userId } }))!.id;
  for (const who of [chair, clerk, plain]) {
    const account = who === chair ? await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, club), e(m.userId, chair.userId)) }) : await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } });
    who.memberId = account!.id;
  }
  await db.insert(clubRoles).values([
    { memberId: chair.memberId, roleType: "vorsitz" },
    { memberId: clerk.memberId, roleType: "schriftfuehrer", termEndsAt: addDays(today, 20) },
  ]);
}, 60_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("term status (pure)", () => {
  it("derives aktiv / laeuft_bald_ab / abgelaufen, the end day itself is still valid", () => {
    expect(termStatus(null, today, null)).toBe("aktiv");
    expect(termStatus(addDays(today, 200), today, null)).toBe("aktiv");
    expect(termStatus(addDays(today, 90), today, null)).toBe("laeuft_bald_ab");
    expect(termStatus(addDays(today, 90), today, [30])).toBe("aktiv");
    expect(termStatus(today, today, [30])).toBe("laeuft_bald_ab");
    expect(termStatus(addDays(today, -1), today, [30])).toBe("abgelaufen");
  });

  it("picks the smallest crossed threshold and always knows day 0", () => {
    expect(crossedThreshold(120, [90, 30])).toBeNull();
    expect(crossedThreshold(80, [90, 30])).toBe(90);
    expect(crossedThreshold(20, [90, 30])).toBe(30);
    expect(crossedThreshold(0, [90, 30])).toBe(0);
    expect(crossedThreshold(-2, [90, 30])).toBe(0);
  });
});

describe("expiring roles and club info", () => {
  it("lists expiring roles for assembly:manage only and adds the status to the board", async () => {
    expect((await call(plain, "/club-roles/expiring")).status).toBe(403);
    const res = await json(await call(clerk, "/club-roles/expiring"));
    expect(res.termExpiryEffect).toBe("none");
    expect(res.data).toHaveLength(1);
    expect(res.data[0]).toMatchObject({ roleType: "schriftfuehrer", termEndsAt: addDays(today, 20), termStatus: "laeuft_bald_ab", termDaysLeft: 20 });
    const info = await json(await call(plain, "/club-info"));
    const board = info.data.board.find((b: Json) => b.roleType === "schriftfuehrer");
    expect(board).toMatchObject({ termStatus: "laeuft_bald_ab", termDaysLeft: 20 });
    expect(info.data.board.find((b: Json) => b.roleType === "vorsitz")).toMatchObject({ termStatus: "aktiv", termDaysLeft: null });
  });
});

describe("reminders", () => {
  it("schedules nothing without stated warning days, then exactly one job per threshold", async () => {
    expect(await runTermSweep(new Date(), { clubId: club })).toBe(0);
    expect((await call(chair, "/club-settings/assembly", { method: "PATCH", body: { termWarningDays: [90, 30] } })).status).toBe(200);
    expect(await runTermSweep(new Date(), { clubId: club })).toBe(1);
    expect(await runTermSweep(new Date(), { clubId: club })).toBe(0);
    const role = await db.query.clubRoles.findFirst({ where: eq(clubRoles.memberId, clerk.memberId) });
    const rows = await db.select().from(jobs).where(eq(jobs.type, "term_notify"));
    expect(rows.filter((j) => (j.payload as Json).roleId === role!.id)).toHaveLength(1);
    expect((rows.find((j) => (j.payload as Json).roleId === role!.id)!.payload as Json).threshold).toBe(30);
  });
});

describe("term_expiry_effect", () => {
  it("keeps the rights by default and suspends an expired role when the club chose so", async () => {
    await db.update(clubRoles).set({ termEndsAt: addDays(today, -3) }).where(eq(clubRoles.memberId, clerk.memberId));
    expect((await call(clerk, "/club-roles/expiring")).status).toBe(200);
    expect((await call(chair, "/club-settings/assembly", { method: "PATCH", body: { termExpiryEffect: "suspend_permissions" } })).status).toBe(200);
    expect((await call(clerk, "/club-roles/expiring")).status).toBe(403);
    expect((await call(chair, "/club-roles/expiring")).status).toBe(200);
  });

  it("never suspends the last standing chair", async () => {
    await db.update(clubRoles).set({ termEndsAt: addDays(today, -1) }).where(eq(clubRoles.memberId, chair.memberId));
    expect((await call(chair, "/club-roles/expiring")).status).toBe(200);
  });
});
