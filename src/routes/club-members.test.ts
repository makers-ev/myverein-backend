import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { clubMemberRoutes } from "./club-members.js";

/**
 * Integration test against a real Postgres (DATABASE_URL). Locks in the
 * behaviour manually verified via curl during Wave 1 B4: club-scoping IDOR
 * (a member of club A gets 404, not data, for club B), sensitive-field
 * filtering by permission, and the Aufnahmeantrag self-service join flow
 * (see the "Wave 1 deliberately simplifies..." comment in club-members.ts).
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUpAndVerify(email: string, name: string) {
  const { user: created } = await auth.api.createUser({
    body: { email, password: "test-password-123!", name },
  });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  const cookie = signIn.headers.get("set-cookie") ?? "";
  return { userId: created.id, cookie: cookie.split(";")[0] };
}

describe("club-members scoping and permissions", () => {
  let clubAId: string;
  let clubBId: string;
  let userAId: string;
  let userBId: string;
  let memberAId: string;
  let cookieA: string;
  let cookieB: string;

  beforeAll(async () => {
    const a = await signUpAndVerify(`club-members-a-${suffix}@example.com`, "Club A Founder");
    const b = await signUpAndVerify(`club-members-b-${suffix}@example.com`, "Club B Founder");
    userAId = a.userId;
    userBId = b.userId;
    cookieA = a.cookie;
    cookieB = b.cookie;

    const clubA = await auth.api.createOrganization({
      body: { name: `Club A ${suffix}`, slug: `club-a-${suffix}`, userId: userAId },
    });
    const clubB = await auth.api.createOrganization({
      body: { name: `Club B ${suffix}`, slug: `club-b-${suffix}`, userId: userBId },
    });
    clubAId = clubA!.id;
    clubBId = clubB!.id;

    // createOrganization already makes its `userId` the org's first member
    // (owner) -- no separate addMember call needed/possible here.
    const memberA = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, userAId)),
    });
    memberAId = memberA!.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubAId));
    await db.delete(organization).where(eq(organization.id, clubBId));
    await db.delete(user).where(eq(user.id, userAId));
    await db.delete(user).where(eq(user.id, userBId));
    await closeDatabase();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.request(`/club-members?clubId=${clubAId}`);
    expect(res.status).toBe(401);
  });

  it("rejects a request with no clubId with 400", async () => {
    const res = await app.request("/club-members", { headers: { cookie: cookieA } });
    expect(res.status).toBe(400);
  });

  it("returns 404 (not membership data) for a club the caller doesn't belong to, in both directions", async () => {
    const resA = await app.request(`/club-members?clubId=${clubBId}`, { headers: { cookie: cookieA } });
    expect(resA.status).toBe(404);

    const resB = await app.request(`/club-members?clubId=${clubAId}`, { headers: { cookie: cookieB } });
    expect(resB.status).toBe(404);
  });

  it("returns 200 with the member's own club", async () => {
    const res = await app.request(`/club-members?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(1);
  });

  it("lets a plain member self-join via /apply and immediately see their own /me", async () => {
    const applicant = await signUpAndVerify(`club-members-applicant-${suffix}@example.com`, "Applicant");

    const applyRes = await app.request("/club-members/apply", {
      method: "POST",
      headers: { cookie: applicant.cookie, "content-type": "application/json" },
      body: JSON.stringify({ clubId: clubAId, category: "aktiv" }),
    });
    expect(applyRes.status).toBe(201);

    const meRes = await app.request(`/club-members/me?clubId=${clubAId}`, { headers: { cookie: applicant.cookie } });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { data: { category: string; birthDate: null | string } };
    expect(meBody.data.category).toBe("aktiv");
    // The caller sees their OWN sensitive fields even with no club_roles.
    expect(meBody.data.birthDate).toBeNull();

    await db.delete(user).where(eq(user.id, applicant.userId));
  });

  it("lets a member self-join via /apply using clubSlug instead of clubId", async () => {
    const applicant = await signUpAndVerify(`club-members-slug-applicant-${suffix}@example.com`, "Slug Applicant");

    const applyRes = await app.request("/club-members/apply", {
      method: "POST",
      headers: { cookie: applicant.cookie, "content-type": "application/json" },
      body: JSON.stringify({ clubSlug: `club-a-${suffix}` }),
    });
    expect(applyRes.status).toBe(201);

    const meRes = await app.request(`/club-members/me?clubId=${clubAId}`, { headers: { cookie: applicant.cookie } });
    expect(meRes.status).toBe(200);

    await db.delete(user).where(eq(user.id, applicant.userId));
  });

  it("returns 404 for an unknown clubSlug", async () => {
    const applicant = await signUpAndVerify(`club-members-badslug-applicant-${suffix}@example.com`, "Bad Slug Applicant");

    const res = await app.request("/club-members/apply", {
      method: "POST",
      headers: { cookie: applicant.cookie, "content-type": "application/json" },
      body: JSON.stringify({ clubSlug: "does-not-exist" }),
    });
    expect(res.status).toBe(404);

    await db.delete(user).where(eq(user.id, applicant.userId));
  });

  it("rejects /apply with neither clubId nor clubSlug", async () => {
    const applicant = await signUpAndVerify(`club-members-noclub-applicant-${suffix}@example.com`, "No Club Applicant");

    const res = await app.request("/club-members/apply", {
      method: "POST",
      headers: { cookie: applicant.cookie, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);

    await db.delete(user).where(eq(user.id, applicant.userId));
  });

  it("rejects a duplicate /apply with 409", async () => {
    const res = await app.request("/club-members/apply", {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ clubId: clubAId }),
    });
    expect(res.status).toBe(409);
  });

  it("hides sensitive fields from a member without members:read_sensitive, on OTHER members' rows", async () => {
    const second = await signUpAndVerify(`club-members-second-${suffix}@example.com`, "Second Member");
    await auth.api.addMember({ body: { userId: second.userId, organizationId: clubAId, role: "member" } });

    const res = await app.request(`/club-members?clubId=${clubAId}`, { headers: { cookie: second.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    const founderRow = body.data.find((row) => row.userId === userAId)!;
    expect(founderRow.memberNumber).toBeUndefined();
    expect(founderRow.birthDate).toBeUndefined();

    await db.delete(user).where(eq(user.id, second.userId));
  });

  it("rejects a members:write action (department-lead style edit) from a member without the permission", async () => {
    const res = await app.request(`/club-members/${memberAId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ category: "foerdernd" }),
    });
    // cookieA belongs to the club's owner-level user but holds no club_roles
    // row yet in this test -- members:write requires an explicit club_roles
    // assignment (vorsitz/stellv_vorsitz/schriftfuehrer), org-level "owner"
    // alone is deliberately not sufficient. See club-permissions.ts.
    expect(res.status).toBe(403);
  });

  it("rejects assigning the same role twice with 409 and exposes permissions on /me", async () => {
    await db.insert(clubRoles).values({ memberId: memberAId, roleType: "vorsitz" });

    const me = await app.request(`/club-members/me?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    const { data } = (await me.json()) as { data: { permissions: string[] } };
    expect(data.permissions).toContain("roles:write");

    const assign = () =>
      app.request(`/club-members/${memberAId}/roles?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ roleType: "kassenwart" }),
      });
    expect((await assign()).status).toBe(201);
    expect((await assign()).status).toBe(409);

    const rows = await db.query.clubRoles.findMany({ where: eq(clubRoles.memberId, memberAId) });
    expect(rows.filter((r) => r.roleType === "kassenwart")).toHaveLength(1);
  });

  it("upserts the membership sidecar on PATCH /me for a founder without one, and clears birthDate with null", async () => {
    const patch = (body: object) =>
      app.request(`/club-members/me?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const saved = await patch({ birthDate: "1990-05-01", emergencyContactName: "Ada" });
    expect(saved.status).toBe(200);
    const { data } = (await saved.json()) as { data: { birthDate: string | null } };
    expect(data.birthDate).toBe("1990-05-01");

    const cleared = (await (await patch({ birthDate: null })).json()) as { data: { birthDate: string | null; emergencyContactName: string } };
    expect(cleared.data.birthDate).toBeNull();
    expect(cleared.data.emergencyContactName).toBe("Ada");
  });
});
