import { randomUUID } from "node:crypto";
import { withConsent } from "./forms-test-support.js";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMemberDepartments, clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { ensureClubMember } from "../lib/club-members.js";
import { toAppError } from "../lib/errors.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubMemberRoutes } from "./club-members.js";

/**
 * Wave 7 B2/B3: club_members as the member identity (ADR-003). Real Postgres, real Better Auth sessions and two
 * clubs, so the club-scoping/IDOR checks with club_members ids and with foreign ids are not mocked.
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string): Promise<Actor> {
  const email = `cm-found-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `User ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

// The in-memory rate limiter keys on x-forwarded-for; every request gets its own bucket.
function call(who: Actor, clubId: string, url: string, init: { method?: string; body?: object } = {}) {
  return app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}

const data = async (res: Response) => ((await res.json()) as { data: Json }).data;

describe("club_members foundation (Wave 7 B2/B3)", () => {
  let clubA: string;
  let clubB: string;
  let founder: Actor;
  let plain: Actor;
  let outsider: Actor;
  let memberOfPlain: { id: string };
  let founderMember: { id: string };
  let founderClubMemberId: string;
  let plainClubMemberId: string;
  let clubBFounderClubMemberId: string;
  let childId: string;
  let departmentA: string;
  let departmentB: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    founder = await signUp("founder");
    plain = await signUp("plain");
    outsider = await signUp("outsider");
    userIds.push(founder.userId, plain.userId, outsider.userId);

    clubA = (await auth.api.createOrganization({ body: { name: `Found A ${suffix}`, slug: `found-a-${suffix}`, userId: founder.userId } }))!.id;
    clubB = (await auth.api.createOrganization({ body: { name: `Found B ${suffix}`, slug: `found-b-${suffix}`, userId: outsider.userId } }))!.id;
    founderMember = (await db.query.member.findFirst({ where: and(eq(member.organizationId, clubA), eq(member.userId, founder.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: founderMember.id, roleType: "vorsitz" });
    memberOfPlain = (await auth.api.addMember({ body: { userId: plain.userId, organizationId: clubA, role: "member" } }))!;

    founderClubMemberId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, founderMember.id) }))!.id;
    plainClubMemberId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, memberOfPlain.id) }))!.id;
    const outsiderMember = (await db.query.member.findFirst({ where: and(eq(member.organizationId, clubB), eq(member.userId, outsider.userId)) }))!;
    clubBFounderClubMemberId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, outsiderMember.id) }))!.id;

    [{ id: departmentA }] = await db.insert(departments).values({ clubId: clubA, name: "Fussball" }).returning();
    [{ id: departmentB }] = await db.insert(departments).values({ clubId: clubB, name: "Tennis" }).returning();
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubA));
    await db.delete(organization).where(eq(organization.id, clubB));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("every join path creates a club_members row", () => {
    it("createOrganization (founder) and addMember create one via the Better Auth hook, with categories and numbers", async () => {
      const founderRow = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, founderMember.id) });
      expect(founderRow).toMatchObject({ clubId: clubA, displayName: "User founder", contactEmail: `cm-found-founder-${suffix}@example.com`, status: "aktiv" });
      const plainRow = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, memberOfPlain.id) });
      expect(plainRow).toMatchObject({ clubId: clubA, displayName: "User plain", status: "aktiv" });
      expect(founderRow!.memberNumber).toMatch(/^FOUN-\d{4}$/);
      expect(plainRow!.memberNumber).not.toBe(founderRow!.memberNumber);

      const cats = await db.select().from(memberCategories).where(eq(memberCategories.clubId, clubA));
      expect(cats.map((c) => c.key).sort()).toEqual(["aktiv", "ehrenmitglied", "foerdernd", "jugend", "passiv"]);
      expect(cats.find((c) => c.id === founderRow!.categoryId)?.key).toBe("aktiv");
    });

    it("ensureClubMember is idempotent (same row, no second number)", async () => {
      const before = await db.select().from(clubMembers).where(eq(clubMembers.clubId, clubA));
      const again = await ensureClubMember(db, founderMember as never as Parameters<typeof ensureClubMember>[1]);
      expect(again.id).toBe(founderClubMemberId);
      expect(await db.select().from(clubMembers).where(eq(clubMembers.clubId, clubA))).toHaveLength(before.length);
    });

    it("approving an Aufnahmeantrag creates the club_members row with the applied category and birth date", async () => {
      const applicant = await signUp("applicant");
      userIds.push(applicant.userId);
      const apply = await app.request("/club-members/apply", {
        method: "POST",
        headers: { cookie: applicant.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
        body: JSON.stringify(withConsent({ clubId: clubA, category: "jugend", birthDate: "2012-04-05" })),
      });
      expect(apply.status).toBe(201);
      const applicationId = ((await apply.json()) as { data: { application: { id: string } } }).data.application.id;

      const approve = await call(founder, clubA, `/club-applications/${applicationId}/approve`, { method: "POST" });
      expect(approve.status).toBe(200);
      const body = await data(approve);
      const row = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, body.member.id) });
      expect(row).toMatchObject({ clubId: clubA, birthDate: "2012-04-05", status: "aktiv", displayName: "User applicant" });
      expect(body.clubMember.id).toBe(row!.id);
      expect(body.membership).toMatchObject({ category: "jugend", birthDate: "2012-04-05", memberNumber: row!.memberNumber });
      const cat = await db.query.memberCategories.findFirst({ where: eq(memberCategories.id, row!.categoryId!) });
      expect(cat?.key).toBe("jugend");
      expect(await db.select().from(clubMembers).where(eq(clubMembers.memberId, body.member.id))).toHaveLength(1);
    });
  });

  describe("POST /club-members (account-less member)", () => {
    it("requires members:write", async () => {
      const res = await call(plain, clubA, "/club-members", { method: "POST", body: { displayName: "Kind", categoryKey: "jugend" } });
      expect(res.status).toBe(403);
    });

    it("creates a member without account, auto number, category object, sensitive fields for the board", async () => {
      const res = await call(founder, clubA, "/club-members", {
        method: "POST",
        body: { displayName: "Emma Kind", firstName: "Emma", lastName: "Kind", categoryKey: "jugend", birthDate: "2015-03-04", street: "Weg 1", postalCode: "12345", city: "Stadt", phone: "0170", contactEmail: "eltern@example.com", emergencyContactName: "Mama", emergencyContactPhone: "0171" },
      });
      expect(res.status).toBe(201);
      const body = await data(res);
      childId = body.id;
      expect(body).toMatchObject({
        memberId: null,
        userId: null,
        hasAccount: false,
        name: "Emma Kind",
        email: null,
        contactEmail: "eltern@example.com",
        status: "aktiv",
        category: "jugend",
        categoryName: "Jugend",
        categoryObject: { key: "jugend", name: "Jugend", votingRight: false },
        orgRole: null,
        roles: [],
        departments: [],
        birthDate: "2015-03-04",
        street: "Weg 1",
        postalCode: "12345",
        city: "Stadt",
        phone: "0170",
        emergencyContactName: "Mama",
        emergencyContactPhone: "0171",
      });
      expect(body.memberNumber).toMatch(/^FOUN-\d{4}$/);
      expect(body.joinedAt).toBe(new Date().toISOString().slice(0, 10));
    });

    it("validates: category is required, must exist in the club, and a leaving status cannot be assigned", async () => {
      expect((await call(founder, clubA, "/club-members", { method: "POST", body: { displayName: "X" } })).status).toBe(422);
      expect((await call(founder, clubA, "/club-members", { method: "POST", body: { displayName: "X", categoryKey: "gibtsnicht" } })).status).toBe(422);
      expect((await call(founder, clubA, "/club-members", { method: "POST", body: { displayName: "X", categoryKey: "aktiv", status: "ausgetreten" } })).status).toBe(422);
      expect((await call(founder, clubA, "/club-members", { method: "POST", body: { displayName: "", categoryKey: "aktiv" } })).status).toBe(422);
      // A category id of another club is refused.
      const foreignCat = await db.query.memberCategories.findFirst({ where: eq(memberCategories.clubId, clubB) });
      expect((await call(founder, clubA, "/club-members", { method: "POST", body: { displayName: "X", categoryId: foreignCat!.id } })).status).toBe(422);
    });

    it("answers 409 for a manually set duplicate member number (create and update), and allows keeping its own", async () => {
      const first = await call(founder, clubA, "/club-members", { method: "POST", body: { displayName: "Nummer Eins", categoryKey: "aktiv", memberNumber: `MANUAL-${suffix}` } });
      expect(first.status).toBe(201);
      const firstId = (await data(first)).id;
      const dup = await call(founder, clubA, "/club-members", { method: "POST", body: { displayName: "Nummer Zwei", categoryKey: "aktiv", memberNumber: `MANUAL-${suffix}` } });
      expect(dup.status).toBe(409);

      const patchDup = await call(founder, clubA, `/club-members/${childId}`, { method: "PATCH", body: { memberNumber: `MANUAL-${suffix}` } });
      expect(patchDup.status).toBe(409);
      const patchSelf = await call(founder, clubA, `/club-members/${firstId}`, { method: "PATCH", body: { memberNumber: `MANUAL-${suffix}`, city: "Ort" } });
      expect(patchSelf.status).toBe(200);
      // The same number in ANOTHER club is fine.
      const other = await call(outsider, clubB, "/club-members", { method: "POST", body: { displayName: "Anderswo", categoryKey: "aktiv", memberNumber: `MANUAL-${suffix}` } });
      expect(other.status).toBe(403);
      // Once club B's founder holds a board role the same number is accepted there (uniqueness is per club).
      const outsiderMember = await db.query.member.findFirst({ where: and(eq(member.organizationId, clubB), eq(member.userId, outsider.userId)) });
      await db.insert(clubRoles).values({ memberId: outsiderMember!.id, roleType: "vorsitz" });
      expect((await call(outsider, clubB, "/club-members", { method: "POST", body: { displayName: "Anderswo", categoryKey: "aktiv", memberNumber: `MANUAL-${suffix}` } })).status).toBe(201);
    });
  });

  describe("reading and the e-mail leak", () => {
    it("lists account and account-less members; others' contact data is hidden without members:read_sensitive", async () => {
      const res = await call(plain, clubA, "/club-members");
      expect(res.status).toBe(200);
      const list = (await data(res)) as unknown as Json[];
      expect(list.map((m) => m.id)).toEqual(expect.arrayContaining([founderClubMemberId, plainClubMemberId, childId]));
      const child = list.find((m) => m.id === childId)!;
      const founderRow = list.find((m) => m.id === founderClubMemberId)!;
      for (const hidden of ["email", "contactEmail", "memberNumber", "birthDate", "street", "postalCode", "city", "phone", "emergencyContactName", "emergencyContactPhone"]) {
        expect(child).not.toHaveProperty(hidden);
        expect(founderRow).not.toHaveProperty(hidden);
      }
      expect(founderRow).toMatchObject({ name: "User founder", hasAccount: true, memberId: founderMember.id, userId: founder.userId, orgRole: "owner" });
      expect(founderRow.roles.map((r: Json) => r.roleType)).toEqual(["vorsitz"]);
      // Own row: sensitive fields (incl. the account e-mail) are included.
      const own = list.find((m) => m.id === plainClubMemberId)!;
      expect(own.email).toBe(`cm-found-plain-${suffix}@example.com`);
      expect(own).toHaveProperty("memberNumber");
    });

    it("shows everything to a caller with members:read_sensitive", async () => {
      const list = (await data(await call(founder, clubA, "/club-members"))) as unknown as Json[];
      const plainRow = list.find((m) => m.id === plainClubMemberId)!;
      expect(plainRow.email).toBe(`cm-found-plain-${suffix}@example.com`);
      expect(plainRow.contactEmail).toBe(`cm-found-plain-${suffix}@example.com`);
      const child = list.find((m) => m.id === childId)!;
      expect(child.street).toBe("Weg 1");
    });

    it("GET /:id works with club_members.id and (transition) with member.id; foreign and unknown ids are 404", async () => {
      const byCanonical = await call(founder, clubA, `/club-members/${plainClubMemberId}`);
      expect(byCanonical.status).toBe(200);
      expect((await data(byCanonical)).id).toBe(plainClubMemberId);
      const byAccountId = await call(founder, clubA, `/club-members/${memberOfPlain.id}`);
      expect(byAccountId.status).toBe(200);
      expect((await data(byAccountId)).id).toBe(plainClubMemberId);

      // IDOR: club B's club_members.id / member.id used in club A, and club A's ids used in club B.
      const outsiderMember = await db.query.member.findFirst({ where: and(eq(member.organizationId, clubB), eq(member.userId, outsider.userId)) });
      expect((await call(founder, clubA, `/club-members/${clubBFounderClubMemberId}`)).status).toBe(404);
      expect((await call(founder, clubA, `/club-members/${outsiderMember!.id}`)).status).toBe(404);
      expect((await call(outsider, clubB, `/club-members/${plainClubMemberId}`)).status).toBe(404);
      expect((await call(outsider, clubB, `/club-members/${memberOfPlain.id}`)).status).toBe(404);
      expect((await call(founder, clubA, `/club-members/${randomUUID()}`)).status).toBe(404);
      // The same holds for writes and sub-resources.
      expect((await call(founder, clubA, `/club-members/${clubBFounderClubMemberId}`, { method: "PATCH", body: { city: "X" } })).status).toBe(404);
      expect((await call(founder, clubA, `/club-members/${clubBFounderClubMemberId}/roles`)).status).toBe(404);
      expect((await call(founder, clubA, `/club-members/${clubBFounderClubMemberId}/departments`)).status).toBe(404);
      expect((await call(founder, clubA, `/club-members/${clubBFounderClubMemberId}/guardians`)).status).toBe(404);
      const untouched = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, clubBFounderClubMemberId) });
      expect(untouched?.city).toBeNull();
    });

    it("hides a member's sensitive fields in GET /:id from a plain member, but not their own", async () => {
      const other = await data(await call(plain, clubA, `/club-members/${childId}`));
      expect(other).not.toHaveProperty("street");
      expect(other).not.toHaveProperty("email");
      const own = await data(await call(plain, clubA, `/club-members/${plainClubMemberId}`));
      expect(own).toHaveProperty("contactEmail");
    });
  });

  describe("PATCH", () => {
    it("is gated by members:write and rejects a status change", async () => {
      expect((await call(plain, clubA, `/club-members/${childId}`, { method: "PATCH", body: { city: "Hack" } })).status).toBe(403);
      expect((await call(founder, clubA, `/club-members/${childId}`, { method: "PATCH", body: { status: "ausgetreten" } })).status).toBe(422);
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, childId) }))?.status).toBe("aktiv");
    });

    it("updates master data, category (by key as before, or by id) and clears the number only when sent as null", async () => {
      const res = await call(founder, clubA, `/club-members/${childId}`, { method: "PATCH", body: { city: "Neustadt", phone: "", category: "passiv" } });
      expect(res.status).toBe(200);
      const body = await data(res);
      expect(body).toMatchObject({ city: "Neustadt", phone: null, category: "passiv", categoryName: "Passiv", street: "Weg 1" });
      const numberBefore = body.memberNumber as string;
      expect(numberBefore).toBeTruthy();

      const untouched = await data(await call(founder, clubA, `/club-members/${childId}`, { method: "PATCH", body: { city: "Altstadt" } }));
      expect(untouched.memberNumber).toBe(numberBefore);

      const jugend = await db.query.memberCategories.findFirst({ where: and(eq(memberCategories.clubId, clubA), eq(memberCategories.key, "jugend")) });
      const byId = await data(await call(founder, clubA, `/club-members/${childId}`, { method: "PATCH", body: { categoryId: jugend!.id } }));
      expect(byId.category).toBe("jugend");

      const cleared = await data(await call(founder, clubA, `/club-members/${childId}`, { method: "PATCH", body: { memberNumber: null } }));
      expect(cleared.memberNumber).toBeNull();
    });
  });

  describe("/me", () => {
    it("returns clubMemberId and permissions, and self-service covers address, phone and contact e-mail", async () => {
      const me = await data(await call(plain, clubA, "/club-members/me"));
      expect(me).toMatchObject({ id: plainClubMemberId, clubMemberId: plainClubMemberId, memberId: memberOfPlain.id, hasAccount: true, permissions: [] });
      const patched = await call(plain, clubA, "/club-members/me", { method: "PATCH", body: { street: "Selbst 5", postalCode: "99999", city: "Eigenort", phone: "030", contactEmail: "privat@example.com", birthDate: "1990-01-01" } });
      expect(patched.status).toBe(200);
      expect(await data(patched)).toMatchObject({ street: "Selbst 5", postalCode: "99999", city: "Eigenort", phone: "030", contactEmail: "privat@example.com", birthDate: "1990-01-01" });
      expect((await call(plain, clubA, "/club-members/me", { method: "PATCH", body: { contactEmail: "kein-email" } })).status).toBe(422);
      // /me can never touch master data that only the board maintains.
      const memberNumberBefore = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, plainClubMemberId) }))!.memberNumber;
      await call(plain, clubA, "/club-members/me", { method: "PATCH", body: { memberNumber: "HACK-1", status: "aktiv" } });
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, plainClubMemberId) }))!.memberNumber).toBe(memberNumberBefore);
    });
  });

  describe("roles need an account", () => {
    it("answers 409 'Member has no account' for an account-less member (list, assign, revoke)", async () => {
      for (const [method, url, body] of [
        ["GET", `/club-members/${childId}/roles`, undefined],
        ["POST", `/club-members/${childId}/roles`, { roleType: "trainer" }],
        ["DELETE", `/club-members/${childId}/roles/${randomUUID()}`, undefined],
      ] as const) {
        const res = await call(founder, clubA, url, { method, body });
        expect(res.status).toBe(409);
        expect(JSON.stringify(await res.json())).toContain("Member has no account");
      }
      // scoped to this club: the test database is shared with test files running in parallel
      const trainers = await db
        .select({ id: clubRoles.id })
        .from(clubRoles)
        .innerJoin(member, eq(member.id, clubRoles.memberId))
        .where(and(eq(member.organizationId, clubA), eq(clubRoles.roleType, "trainer")));
      expect(trainers).toHaveLength(0);
    });

    it("assigns and revokes roles via club_members.id and via member.id (transition), written on the account", async () => {
      const assigned = await call(founder, clubA, `/club-members/${plainClubMemberId}/roles`, { method: "POST", body: { roleType: "trainer", departmentId: departmentA } });
      expect(assigned.status).toBe(201);
      const role = await data(assigned);
      expect(role.memberId).toBe(memberOfPlain.id);
      const viaAccount = await data(await call(founder, clubA, `/club-members/${memberOfPlain.id}/roles`));
      expect(viaAccount.map((r: Json) => r.id)).toContain(role.id);
      expect((await call(founder, clubA, `/club-members/${memberOfPlain.id}/roles/${role.id}`, { method: "DELETE" })).status).toBe(204);
      expect((await call(plain, clubA, `/club-members/${plainClubMemberId}/roles`, { method: "POST", body: { roleType: "beisitzer" } })).status).toBe(403);
    });
  });

  describe("departments", () => {
    it("assigns, lists, rejects duplicates and foreign departments, ends the assignment and shows it on the member", async () => {
      expect((await call(plain, clubA, `/club-members/${childId}/departments`, { method: "POST", body: { departmentId: departmentA } })).status).toBe(403);
      const assigned = await call(founder, clubA, `/club-members/${childId}/departments`, { method: "POST", body: { departmentId: departmentA, since: "2024-09-01" } });
      expect(assigned.status).toBe(201);
      expect(await data(assigned)).toMatchObject({ id: departmentA, name: "Fussball", since: "2024-09-01", until: null });
      expect((await call(founder, clubA, `/club-members/${childId}/departments`, { method: "POST", body: { departmentId: departmentA } })).status).toBe(409);
      expect((await call(founder, clubA, `/club-members/${childId}/departments`, { method: "POST", body: { departmentId: departmentB } })).status).toBe(404);

      const member1 = await data(await call(plain, clubA, `/club-members/${childId}`));
      expect(member1.departments).toEqual([{ id: departmentA, name: "Fussball", since: "2024-09-01", until: null }]);
      expect(await data(await call(plain, clubA, `/club-members/${childId}/departments`))).toHaveLength(1);

      expect((await call(plain, clubA, `/club-members/${childId}/departments/${departmentA}`, { method: "DELETE" })).status).toBe(403);
      expect((await call(founder, clubA, `/club-members/${childId}/departments/${departmentA}?until=2025-01-31`, { method: "DELETE" })).status).toBe(204);
      expect((await call(founder, clubA, `/club-members/${childId}/departments/${departmentA}`, { method: "DELETE" })).status).toBe(404);
      const rows = await db.select().from(clubMemberDepartments).where(eq(clubMemberDepartments.clubMemberId, childId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.until).toBe("2025-01-31");
      // After it ended the member can be assigned again.
      expect((await call(founder, clubA, `/club-members/${childId}/departments`, { method: "POST", body: { departmentId: departmentA } })).status).toBe(201);
    });
  });

  describe("guardians", () => {
    it("links an account-less child (ward = club_members.id) to an account guardian", async () => {
      expect((await call(plain, clubA, `/club-members/${childId}/guardians`, { method: "POST", body: { guardianMemberId: plainClubMemberId } })).status).toBe(403);

      const created = await call(founder, clubA, `/club-members/${childId}/guardians`, { method: "POST", body: { guardianMemberId: plainClubMemberId } });
      expect(created.status).toBe(201);
      expect(await data(created)).toMatchObject({ guardianMemberId: memberOfPlain.id, guardianClubMemberId: plainClubMemberId, guardianName: "User plain", wardClubMemberId: childId, wardMemberId: null });
      expect(await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, childId))).toHaveLength(1);

      // Duplicate (also when the guardian is named by the legacy member.id).
      expect((await call(founder, clubA, `/club-members/${childId}/guardians`, { method: "POST", body: { guardianMemberId: memberOfPlain.id } })).status).toBe(409);

      const listed = await data(await call(plain, clubA, `/club-members/${childId}/guardians`));
      expect(listed).toHaveLength(1);
      expect(listed[0].guardianMemberId).toBe(memberOfPlain.id);
    });

    it("rejects an account-less guardian (409), a foreign guardian (404), the member as own guardian, and cross-club wards", async () => {
      const second = await data(await call(founder, clubA, "/club-members", { method: "POST", body: { displayName: "Ohne Konto Zwei", categoryKey: "jugend" } }));
      expect((await call(founder, clubA, `/club-members/${childId}/guardians`, { method: "POST", body: { guardianMemberId: second.id } })).status).toBe(409);
      expect((await call(founder, clubA, `/club-members/${childId}/guardians`, { method: "POST", body: { guardianMemberId: clubBFounderClubMemberId } })).status).toBe(404);
      expect((await call(founder, clubA, `/club-members/${plainClubMemberId}/guardians`, { method: "POST", body: { guardianMemberId: plainClubMemberId } })).status).toBe(422);
      expect((await call(founder, clubA, `/club-members/${clubBFounderClubMemberId}/guardians`, { method: "POST", body: { guardianMemberId: plainClubMemberId } })).status).toBe(404);
    });

    it("removes the link by club_members.id (or member.id of the guardian) and 404s afterwards", async () => {
      expect((await call(plain, clubA, `/club-members/${childId}/guardians/${plainClubMemberId}`, { method: "DELETE" })).status).toBe(403);
      expect((await call(founder, clubA, `/club-members/${childId}/guardians/${plainClubMemberId}`, { method: "DELETE" })).status).toBe(204);
      expect((await call(founder, clubA, `/club-members/${childId}/guardians/${memberOfPlain.id}`, { method: "DELETE" })).status).toBe(404);
      expect(await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, childId))).toHaveLength(0);
    });
  });

  it("deleting the account keeps the person as a member without account (club_members.member_id set null)", async () => {
    const leaver = await signUp("leaver");
    const added = await auth.api.addMember({ body: { userId: leaver.userId, organizationId: clubA, role: "member" } });
    const row = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, added!.id) });
    expect(row).toBeDefined();
    await db.delete(user).where(eq(user.id, leaver.userId));
    const after = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, row!.id) });
    expect(after).toMatchObject({ memberId: null, displayName: "User leaver" });
  });
});
