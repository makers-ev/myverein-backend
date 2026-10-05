import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRegistrations } from "../db/schema/club-registrations.js";
import { toAppError } from "../lib/errors.js";
import type { SessionEnv } from "../middleware/session-guard.js";
import { adminClubRoutes } from "./admin-clubs.js";

const app = new Hono<SessionEnv>();
app.route("/admin", adminClubRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type ClubEntry = { clubId: string; name: string; slug: string };

async function createUser(label: string, role: "user" | "admin") {
  const email = `admin-clubs-${label}-${suffix}@example.com`;
  const password = "test-password-123!";
  const { user: created } = await auth.api.createUser({ body: { email, password, name: `Admin Clubs ${label}` } });
  await db.update(user).set({ emailVerified: true, role }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error("sign-in did not return a session cookie");
  return { userId: created.id, cookie };
}

describe("admin club endpoints", () => {
  let admin: { userId: string; cookie: string };
  let plain: { userId: string; cookie: string };
  let none: { userId: string };
  let one: { userId: string };
  let two: { userId: string };
  const clubIds: string[] = [];
  const clubs: Record<string, { id: string; name: string; slug: string }> = {};

  async function makeClub(key: string, name: string, ownerId: string) {
    const club = await auth.api.createOrganization({ body: { name, slug: `admin-clubs-${key}-${suffix}`, userId: ownerId } });
    clubIds.push(club!.id);
    clubs[key] = { id: club!.id, name, slug: club!.slug };
    return club!;
  }

  const get = (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} });

  beforeAll(async () => {
    admin = await createUser("admin", "admin");
    plain = await createUser("plain", "user");
    none = await createUser("none", "user");
    one = await createUser("one", "user");
    two = await createUser("two", "user");
    // Created out of alphabetical order on purpose.
    await makeClub("b", `Bravo Verein ${suffix}`, two.userId);
    await makeClub("a", `Alpha Verein ${suffix}`, two.userId);
    await makeClub("c", `Charlie Verein ${suffix}`, one.userId);
  }, 60_000);

  afterAll(async () => {
    if (clubIds.length) await db.delete(organization).where(inArray(organization.id, clubIds));
    await db.delete(user).where(inArray(user.id, [admin.userId, plain.userId, none.userId, one.userId, two.userId]));
    await closeDatabase();
  });

  describe("GET /admin/club-stats", () => {
    it("rejects no session and non-admin sessions with 401", async () => {
      expect((await get("/admin/club-stats")).status).toBe(401);
      expect((await get("/admin/club-stats", plain.cookie)).status).toBe(401);
    });

    it("counts all clubs, relative to the state before a new club", async () => {
      const before = (await (await get("/admin/club-stats", admin.cookie)).json()) as { clubs: { total: number } };
      expect(Number.isInteger(before.clubs.total)).toBe(true);
      expect(before.clubs.total).toBeGreaterThanOrEqual(3);

      await makeClub("d", `Delta Verein ${suffix}`, one.userId);
      const afterRes = await get("/admin/club-stats", admin.cookie);
      expect(afterRes.status).toBe(200);
      const after = (await afterRes.json()) as { clubs: { total: number } };
      expect(after.clubs.total).toBe(before.clubs.total + 1);
    });
  });

  describe("GET /admin/club-stats registrations.pending", () => {
    it("counts only pending registrations, relative to the state before", async () => {
      type Stats = { registrations: { pending: number } };
      const before = (await (await get("/admin/club-stats", admin.cookie)).json()) as Stats;
      expect(Number.isInteger(before.registrations.pending)).toBe(true);

      const values = { userId: plain.userId, clubName: `Pending Club ${suffix}`, legalForm: "eV", street: "Teststr. 1", postalCode: "12345", city: "Teststadt" };
      const [reg] = await db.insert(clubRegistrations).values({ ...values, status: "draft" }).returning({ id: clubRegistrations.id });
      const draft = (await (await get("/admin/club-stats", admin.cookie)).json()) as Stats;
      expect(draft.registrations.pending).toBe(before.registrations.pending);

      await db.update(clubRegistrations).set({ status: "pending", submittedAt: new Date() }).where(eq(clubRegistrations.id, reg.id));
      const pending = (await (await get("/admin/club-stats", admin.cookie)).json()) as Stats;
      expect(pending.registrations.pending).toBe(before.registrations.pending + 1);

      await db.update(clubRegistrations).set({ status: "rejected" }).where(eq(clubRegistrations.id, reg.id));
      const done = (await (await get("/admin/club-stats", admin.cookie)).json()) as Stats;
      expect(done.registrations.pending).toBe(before.registrations.pending);
      await db.delete(clubRegistrations).where(eq(clubRegistrations.id, reg.id));
    });
  });

  describe("GET /admin/user-clubs", () => {
    it("rejects no session and non-admin sessions with 401", async () => {
      expect((await get(`/admin/user-clubs?userIds=${one.userId}`)).status).toBe(401);
      expect((await get(`/admin/user-clubs?userIds=${one.userId}`, plain.cookie)).status).toBe(401);
    });

    it("returns clubs per user: 0, 1 and 2 memberships, every requested id as a key", async () => {
      const res = await get(`/admin/user-clubs?userIds=${none.userId},${one.userId},${two.userId}`, admin.cookie);
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: Record<string, ClubEntry[]> };
      expect(Object.keys(data).sort()).toEqual([none.userId, one.userId, two.userId].sort());
      expect(data[none.userId]).toEqual([]);
      expect(data[one.userId].map((x) => x.clubId)).toContain(clubs.c.id);
      expect(data[one.userId].find((x) => x.clubId === clubs.c.id)).toEqual({
        clubId: clubs.c.id,
        name: clubs.c.name,
        slug: clubs.c.slug,
      });
      expect(data[two.userId]).toHaveLength(2);
    });

    it("orders a user's clubs alphabetically by name", async () => {
      const res = await get(`/admin/user-clubs?userIds=${two.userId}`, admin.cookie);
      const { data } = (await res.json()) as { data: Record<string, ClubEntry[]> };
      expect(data[two.userId].map((x) => x.clubId)).toEqual([clubs.a.id, clubs.b.id]);
    });

    it("returns an empty array for an unknown user id", async () => {
      const res = await get("/admin/user-clubs?userIds=does-not-exist", admin.cookie);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: Record<string, ClubEntry[]> }).data).toEqual({ "does-not-exist": [] });
    });

    it("trims, de-duplicates and drops empty ids", async () => {
      const res = await get(`/admin/user-clubs?userIds=${one.userId},, ${one.userId} ,${none.userId},`, admin.cookie);
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: Record<string, ClubEntry[]> };
      expect(Object.keys(data).sort()).toEqual([none.userId, one.userId].sort());
    });

    it("422s for missing or empty userIds", async () => {
      expect((await get("/admin/user-clubs", admin.cookie)).status).toBe(422);
      expect((await get("/admin/user-clubs?userIds=", admin.cookie)).status).toBe(422);
      expect((await get("/admin/user-clubs?userIds=,,%20,", admin.cookie)).status).toBe(422);
    });

    it("accepts 100 distinct ids and 422s for 101", async () => {
      const ids = Array.from({ length: 101 }, (_, i) => `fake-user-${i}`);
      const ok = await get(`/admin/user-clubs?userIds=${ids.slice(0, 100).join(",")}`, admin.cookie);
      expect(ok.status).toBe(200);
      expect(Object.keys(((await ok.json()) as { data: object }).data)).toHaveLength(100);
      expect((await get(`/admin/user-clubs?userIds=${ids.join(",")}`, admin.cookie)).status).toBe(422);
    });

    it("does not count duplicates towards the limit", async () => {
      const ids = [...Array.from({ length: 100 }, (_, i) => `fake-user-${i}`), "fake-user-0", "fake-user-1"];
      expect((await get(`/admin/user-clubs?userIds=${ids.join(",")}`, admin.cookie)).status).toBe(200);
    });
  });
});
