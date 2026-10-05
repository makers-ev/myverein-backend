import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubMemberRoutes } from "./club-members.js";

/**
 * Integration test against a real Postgres (DATABASE_URL): pending-queue
 * listing, members:write gating, club-scoping (IDOR -> 404), approve creating
 * member + membership with sequential member numbers, reject creating
 * nothing, double decisions (409) and re-applying after a rejection.
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
const json = { "content-type": "application/json" };

async function signUpAndVerify(email: string, name: string) {
  const { user: created } = await auth.api.createUser({
    body: { email, password: "test-password-123!", name },
  });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  const cookie = signIn.headers.get("set-cookie") ?? "";
  return { userId: created.id, cookie: cookie.split(";")[0] };
}

type Applicant = Awaited<ReturnType<typeof signUpAndVerify>>;

describe("club-applications decision queue", () => {
  let clubAId: string;
  let clubBId: string;
  let boardA: Applicant; // vorsitz in club A (members:write)
  let plainA: Applicant; // plain member of club A, no club_roles
  let boardB: Applicant; // vorsitz in club B
  let boardAMemberId: string;
  const createdUserIds: string[] = [];

  async function newApplicant(label: string): Promise<Applicant> {
    const a = await signUpAndVerify(`club-applications-${label}-${suffix}@example.com`, `Applicant ${label}`);
    createdUserIds.push(a.userId);
    return a;
  }

  async function apply(applicant: Applicant, clubId: string, body: object = {}) {
    return app.request("/club-members/apply", {
      method: "POST",
      headers: { cookie: applicant.cookie, ...json },
      body: JSON.stringify({ clubId, ...body }),
    });
  }

  async function applyOk(applicant: Applicant, clubId: string, body: object = {}) {
    const res = await apply(applicant, clubId, body);
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { application: { id: string } } }).data.application.id;
  }

  const decide = (who: Applicant, clubId: string, id: string, action: "approve" | "reject") =>
    app.request(`/club-applications/${id}/${action}?clubId=${clubId}`, { method: "POST", headers: { cookie: who.cookie } });

  beforeAll(async () => {
    boardA = await signUpAndVerify(`club-applications-boarda-${suffix}@example.com`, "Board A");
    plainA = await signUpAndVerify(`club-applications-plaina-${suffix}@example.com`, "Plain A");
    boardB = await signUpAndVerify(`club-applications-boardb-${suffix}@example.com`, "Board B");
    createdUserIds.push(boardA.userId, plainA.userId, boardB.userId);

    const clubA = await auth.api.createOrganization({
      body: { name: `Demo Verein ${suffix}`, slug: `demo-verein-${suffix}`, userId: boardA.userId },
    });
    const clubB = await auth.api.createOrganization({
      body: { name: `Other Verein ${suffix}`, slug: `other-verein-${suffix}`, userId: boardB.userId },
    });
    clubAId = clubA!.id;
    clubBId = clubB!.id;
    await auth.api.addMember({ body: { userId: plainA.userId, organizationId: clubAId, role: "member" } });

    const boardAMember = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, boardA.userId)),
    });
    boardAMemberId = boardAMember!.id;
    await db.insert(clubRoles).values({ memberId: boardAMemberId, roleType: "vorsitz" });

    const boardBMember = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubBId), eq(m.userId, boardB.userId)),
    });
    await db.insert(clubRoles).values({ memberId: boardBMember!.id, roleType: "vorsitz" });
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubAId));
    await db.delete(organization).where(eq(organization.id, clubBId));
    for (const id of createdUserIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("requires a session and a clubId", async () => {
    expect((await app.request(`/club-applications?clubId=${clubAId}`)).status).toBe(401);
    expect((await app.request("/club-applications", { headers: { cookie: boardA.cookie } })).status).toBe(400);
  });

  it("returns 403 for list/approve/reject to a member without members:write", async () => {
    const applicant = await newApplicant("perm");
    const id = await applyOk(applicant, clubAId);

    const list = await app.request(`/club-applications?clubId=${clubAId}`, { headers: { cookie: plainA.cookie } });
    expect(list.status).toBe(403);
    expect((await decide(plainA, clubAId, id, "approve")).status).toBe(403);
    expect((await decide(plainA, clubAId, id, "reject")).status).toBe(403);

    const row = await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, id) });
    expect(row?.status).toBe("pending");
  });

  it("lists only the club's pending applications, oldest first, with name/email/birthDate", async () => {
    const first = await newApplicant("list1");
    const second = await newApplicant("list2");
    const other = await newApplicant("listother");
    const firstId = await applyOk(first, clubAId, { category: "jugend", birthDate: "2010-04-05" });
    const secondId = await applyOk(second, clubAId);
    await applyOk(other, clubBId);

    const res = await app.request(`/club-applications?clubId=${clubAId}`, { headers: { cookie: boardA.cookie } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: Array<{ id: string; userId: string; name: string; email: string; category: string; birthDate: string | null; status: string; createdAt: string }>;
    };
    const ids = data.map((a) => a.id);
    expect(ids.indexOf(firstId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(firstId)).toBeLessThan(ids.indexOf(secondId));
    expect(data.every((a) => a.status === "pending")).toBe(true);
    expect(data.some((a) => a.userId === other.userId)).toBe(false);

    const entry = data.find((a) => a.id === firstId)!;
    expect(entry.userId).toBe(first.userId);
    expect(entry.name).toBe("Applicant list1");
    expect(entry.email).toBe(`club-applications-list1-${suffix}@example.com`);
    expect(entry.category).toBe("jugend");
    expect(entry.birthDate).toBe("2010-04-05");
    expect(typeof entry.createdAt).toBe("string");
  });

  it("returns 404 (not 403) when deciding another club's application, and for unknown or malformed ids", async () => {
    const applicant = await newApplicant("idor");
    const id = await applyOk(applicant, clubBId);

    // boardA holds members:write in club A, but the application belongs to club B.
    expect((await decide(boardA, clubAId, id, "approve")).status).toBe(404);
    expect((await decide(boardA, clubAId, id, "reject")).status).toBe(404);
    // boardA is not a member of club B at all.
    expect((await decide(boardA, clubBId, id, "approve")).status).toBe(404);
    expect((await decide(boardA, clubAId, crypto.randomUUID(), "approve")).status).toBe(404);
    expect((await decide(boardA, clubAId, "not-a-uuid", "reject")).status).toBe(404);

    const row = await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, id) });
    expect(row?.status).toBe("pending");
  });

  it("approve creates member + membership with sequential member numbers and marks the application approved", async () => {
    const one = await newApplicant("approve1");
    const two = await newApplicant("approve2");
    const idOne = await applyOk(one, clubAId, { category: "passiv", birthDate: "1995-06-07" });
    const idTwo = await applyOk(two, clubAId);

    const resOne = await decide(boardA, clubAId, idOne, "approve");
    expect(resOne.status).toBe(200);
    const bodyOne = (await resOne.json()) as {
      data: {
        application: { id: string; status: string; decidedBy: string; decidedAt: string };
        member: { id: string; userId: string; role: string };
        membership: { memberNumber: string; category: string; birthDate: string; joinedAt: string };
      };
    };
    expect(bodyOne.data.application.status).toBe("approved");
    expect(bodyOne.data.application.decidedBy).toBe(boardAMemberId);
    expect(bodyOne.data.application.decidedAt).toBeTruthy();
    expect(bodyOne.data.member.userId).toBe(one.userId);
    expect(bodyOne.data.member.role).toBe("member");
    expect(bodyOne.data.membership.category).toBe("passiv");
    expect(bodyOne.data.membership.birthDate).toBe("1995-06-07");
    expect(bodyOne.data.membership.joinedAt).toBe(new Date().toISOString().slice(0, 10));
    expect(bodyOne.data.membership.memberNumber).toMatch(/^DEMO-\d{4}$/);

    const resTwo = await decide(boardA, clubAId, idTwo, "approve");
    expect(resTwo.status).toBe(200);
    const bodyTwo = (await resTwo.json()) as { data: { membership: { memberNumber: string } } };
    const num = (s: string) => Number(s.split("-")[1]);
    expect(num(bodyTwo.data.membership.memberNumber)).toBe(num(bodyOne.data.membership.memberNumber) + 1);

    // The applicant is now a real member and can read their own /me.
    const me = await app.request(`/club-members/me?clubId=${clubAId}`, { headers: { cookie: one.cookie } });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { category: string; memberNumber: string } };
    expect(meBody.data.category).toBe("passiv");
    expect(meBody.data.memberNumber).toBe(bodyOne.data.membership.memberNumber);

    // Approved applications disappear from the pending list.
    const list = await app.request(`/club-applications?clubId=${clubAId}`, { headers: { cookie: boardA.cookie } });
    const ids = ((await list.json()) as { data: Array<{ id: string }> }).data.map((a) => a.id);
    expect(ids).not.toContain(idOne);
    expect(ids).not.toContain(idTwo);
  });

  it("reject marks the application rejected and creates no member, then allows re-applying", async () => {
    const applicant = await newApplicant("reject");
    const id = await applyOk(applicant, clubAId);

    const res = await decide(boardA, clubAId, id, "reject");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { application: { status: string; decidedBy: string; decidedAt: string } } };
    expect(data.application.status).toBe("rejected");
    expect(data.application.decidedBy).toBe(boardAMemberId);
    expect(data.application.decidedAt).toBeTruthy();

    const memberRow = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, applicant.userId)),
    });
    expect(memberRow).toBeUndefined();
    expect((await app.request(`/club-members/me?clubId=${clubAId}`, { headers: { cookie: applicant.cookie } })).status).toBe(404);

    // Re-apply after a rejection is allowed and yields a fresh pending application.
    const newId = await applyOk(applicant, clubAId);
    expect(newId).not.toBe(id);
    const approve = await decide(boardA, clubAId, newId, "approve");
    expect(approve.status).toBe(200);
  });

  it("returns 409 on a second decision of an already decided application", async () => {
    const applicant = await newApplicant("double");
    const id = await applyOk(applicant, clubAId);

    expect((await decide(boardA, clubAId, id, "approve")).status).toBe(200);
    expect((await decide(boardA, clubAId, id, "approve")).status).toBe(409);
    expect((await decide(boardA, clubAId, id, "reject")).status).toBe(409);

    const rejected = await newApplicant("double-reject");
    const rejectedId = await applyOk(rejected, clubAId);
    expect((await decide(boardA, clubAId, rejectedId, "reject")).status).toBe(200);
    expect((await decide(boardA, clubAId, rejectedId, "reject")).status).toBe(409);
    expect((await decide(boardA, clubAId, rejectedId, "approve")).status).toBe(409);
  });

  it("lets exactly one of two concurrent approvals win", async () => {
    const applicant = await newApplicant("race");
    const id = await applyOk(applicant, clubAId);

    const results = await Promise.all([decide(boardA, clubAId, id, "approve"), decide(boardA, clubAId, id, "approve")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    const members = await db.query.member.findMany({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, applicant.userId)) });
    expect(members.length).toBe(1);
  });

  it("returns 409 on approve when the applicant became a member through another route meanwhile", async () => {
    const applicant = await newApplicant("already");
    const id = await applyOk(applicant, clubAId);
    await auth.api.addMember({ body: { userId: applicant.userId, organizationId: clubAId, role: "member" } });

    expect((await decide(boardA, clubAId, id, "approve")).status).toBe(409);
    const row = await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, id) });
    expect(row?.status).toBe("pending");
    const members = await db.query.member.findMany({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, applicant.userId)),
    });
    expect(members).toHaveLength(1);
  });
});
