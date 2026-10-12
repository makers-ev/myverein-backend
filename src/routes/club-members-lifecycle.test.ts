import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { checkClubMemberConsistency } from "../lib/club-members.js";
import { toAppError } from "../lib/errors.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubMemberRoutes } from "./club-members.js";

/** Wave 7 review fixes: privacy of write responses, member-number robustness, account removal/re-join, hooks, races. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; email: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const today = () => new Date().toISOString().slice(0, 10);

async function signUp(label: string): Promise<Actor> {
  const email = `cm-life-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Life ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0], email };
}

function call(who: Actor, clubId: string, url: string, init: { method?: string; body?: object } = {}) {
  return app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}
const data = async (res: Response) => ((await res.json()) as { data: Json }).data;
const headersOf = (who: Actor) => new Headers({ cookie: who.cookie });

const SENSITIVE = ["email", "contactEmail", "memberNumber", "birthDate", "street", "postalCode", "city", "phone", "emergencyContactName", "emergencyContactPhone"];

describe("club members: review fixes (Wave 7)", () => {
  let club: string;
  let founder: Actor;
  let secretary: Actor; // schriftfuehrer: members:write but NOT members:read_sensitive
  let plain: Actor; // reines mitglied
  let plainAccount: { id: string };
  let secretaryClubMemberId: string;
  let plainClubMemberId: string;
  let childId: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    founder = await signUp("founder");
    secretary = await signUp("secretary");
    plain = await signUp("plain");
    userIds.push(founder.userId, secretary.userId, plain.userId);
    club = (await auth.api.createOrganization({ body: { name: `Life ${suffix}`, slug: `lcyc-${suffix}`, userId: founder.userId } }))!.id;
    const founderMember = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, founder.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: founderMember.id, roleType: "vorsitz" });
    const secretaryAccount = (await auth.api.addMember({ body: { userId: secretary.userId, organizationId: club, role: "member" } }))!;
    await db.insert(clubRoles).values({ memberId: secretaryAccount.id, roleType: "schriftfuehrer" });
    plainAccount = (await auth.api.addMember({ body: { userId: plain.userId, organizationId: club, role: "member" } }))!;
    secretaryClubMemberId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, secretaryAccount.id) }))!.id;
    plainClubMemberId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, plainAccount.id) }))!.id;
    const child = await call(founder, club, "/club-members", {
      method: "POST",
      body: { displayName: "Kind Eins", categoryKey: "jugend", street: "Geheimweg 1", phone: "0123", contactEmail: "eltern@example.com", birthDate: "2014-01-01" },
    });
    childId = (await data(child)).id;
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, club));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("F1 write responses never leak more than the caller may read", () => {
    it("PATCH {} and POST by a Schriftführer (members:write, no read_sensitive) return no sensitive fields", async () => {
      const patched = await call(secretary, club, `/club-members/${childId}`, { method: "PATCH", body: {} });
      expect(patched.status).toBe(200);
      const body = await data(patched);
      for (const key of SENSITIVE) expect(body).not.toHaveProperty(key);
      expect(body.name).toBe("Kind Eins");

      const created = await call(secretary, club, "/club-members", { method: "POST", body: { displayName: "Kind Zwei", categoryKey: "jugend", street: "Hidden 2" } });
      expect(created.status).toBe(201);
      const createdBody = await data(created);
      for (const key of SENSITIVE) expect(createdBody).not.toHaveProperty(key);
      // ...but the data was stored.
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.displayName, "Kind Zwei") }))?.street).toBe("Hidden 2");
    });

    it("the board with members:read_sensitive gets the full shape back from POST/PATCH, and a member's own PATCH on their row too", async () => {
      expect(await data(await call(founder, club, `/club-members/${childId}`, { method: "PATCH", body: {} }))).toMatchObject({ street: "Geheimweg 1" });
      expect(await data(await call(plain, club, "/club-members/me", { method: "PATCH", body: { city: "Ort" } }))).toHaveProperty("contactEmail");
    });

    it("a plain mitglied gets 403 on every new write route", async () => {
      const dept = randomUUID();
      const writes: Array<[string, string, object | undefined]> = [
        ["POST", "/club-members", { displayName: "X", categoryKey: "aktiv" }],
        ["PATCH", `/club-members/${childId}`, { city: "X" }],
        ["POST", `/club-members/${childId}/departments`, { departmentId: dept }],
        ["DELETE", `/club-members/${childId}/departments/${dept}`, undefined],
        ["POST", `/club-members/${plainClubMemberId}/roles`, { roleType: "trainer" }],
        ["DELETE", `/club-members/${plainClubMemberId}/roles/${randomUUID()}`, undefined],
        ["POST", `/club-members/${childId}/guardians`, { guardianMemberId: plainClubMemberId }],
        ["DELETE", `/club-members/${childId}/guardians/${plainClubMemberId}`, undefined],
      ];
      for (const [method, url, body] of writes) expect((await call(plain, club, url, { method, body })).status, `${method} ${url}`).toBe(403);
    });
  });

  describe("F2 member numbers", () => {
    it("an absurd legacy/manual suffix cannot break automatic numbering or the list", async () => {
      const huge = await call(founder, club, "/club-members", { method: "POST", body: { displayName: "Riesennummer", categoryKey: "aktiv", memberNumber: "LCYC-99999999999" } });
      expect(huge.status).toBe(201);
      const next = await call(founder, club, "/club-members", { method: "POST", body: { displayName: "Danach", categoryKey: "aktiv" } });
      expect(next.status).toBe(201);
      expect((await data(next)).memberNumber).toMatch(/^LCYC-\d{4,9}$/);
      expect((await call(founder, club, "/club-members")).status).toBe(200);
    });

    it("validates manual numbers (length, control characters)", async () => {
      for (const memberNumber of ["x".repeat(51), "AB\u0007C", "A\nB"]) {
        expect((await call(founder, club, "/club-members", { method: "POST", body: { displayName: "V", categoryKey: "aktiv", memberNumber } })).status).toBe(422);
        expect((await call(founder, club, `/club-members/${childId}`, { method: "PATCH", body: { memberNumber } })).status).toBe(422);
      }
    });

    it("parallel creations get distinct automatic numbers", async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => call(founder, club, "/club-members", { method: "POST", body: { displayName: `Parallel ${i}`, categoryKey: "aktiv" } })),
      );
      expect(results.map((r) => r.status)).toEqual(Array(6).fill(201));
      const numbers = await Promise.all(results.map(async (r) => (await data(r)).memberNumber as string));
      expect(new Set(numbers).size).toBe(6);
    });
  });

  describe("F6 legacy duplicates can be cleaned up", () => {
    it("PATCH keeping an already duplicated number is allowed; changing to a taken one is not", async () => {
      const [a, b] = await db
        .insert(clubMembers)
        .values([
          { clubId: club, displayName: "Alt A", memberNumber: "ALT-1", joinedAt: today() },
          { clubId: club, displayName: "Alt B", memberNumber: "ALT-1", joinedAt: today() },
        ])
        .returning();
      expect((await call(founder, club, `/club-members/${a!.id}`, { method: "PATCH", body: { memberNumber: "ALT-1", city: "Bereinigt" } })).status).toBe(200);
      expect((await call(founder, club, `/club-members/${b!.id}`, { method: "PATCH", body: { memberNumber: "LCYC-99999999999" } })).status).toBe(409);
      expect((await call(founder, club, `/club-members/${b!.id}`, { method: "PATCH", body: { memberNumber: "ALT-2" } })).status).toBe(200);
    });
  });

  describe("F3 account removal and re-join", () => {
    it("removeMember closes the club member (no ghost), keeps the number, and a re-add reuses the same row", async () => {
      const guest = await signUp("removed");
      userIds.push(guest.userId);
      const added = (await auth.api.addMember({ body: { userId: guest.userId, organizationId: club, role: "member" } }))!;
      const before = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, added.id) }))!;
      expect(before.lastUserId).toBe(guest.userId);

      await auth.api.removeMember({ body: { memberIdOrEmail: added.id, organizationId: club }, headers: headersOf(founder) });
      const removed = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, before.id) }))!;
      expect(removed).toMatchObject({ memberId: null, status: "ausgetreten", leftAt: today(), exitReason: "Konto-Mitgliedschaft entfernt", memberNumber: before.memberNumber });
      const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, before.id));
      expect(history.map((h) => [h.fromStatus, h.toStatus, h.reason])).toEqual([["aktiv", "ausgetreten", "Konto-Mitgliedschaft entfernt"]]);
      // Listed as ausgetreten, not as active member.
      const list = (await data(await call(founder, club, "/club-members"))) as unknown as Json[];
      expect(list.find((m) => m.id === before.id)).toMatchObject({ status: "ausgetreten", hasAccount: false });

      const readded = (await auth.api.addMember({ body: { userId: guest.userId, organizationId: club, role: "member" } }))!;
      const after = await db.select().from(clubMembers).where(eq(clubMembers.lastUserId, guest.userId));
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ id: before.id, memberId: readded.id, status: "aktiv", leftAt: null, exitReason: null, memberNumber: before.memberNumber });
      const history2 = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, before.id));
      expect(history2.map((h) => h.toStatus).sort()).toEqual(["aktiv", "ausgetreten"]);
    });

    it("leaving the club or deleting the user (no hook) is closed lazily by the list / the detail lookup", async () => {
      const leaver = await signUp("leaver");
      const gone = await signUp("gone");
      userIds.push(leaver.userId);
      const a = (await auth.api.addMember({ body: { userId: leaver.userId, organizationId: club, role: "member" } }))!;
      const b = (await auth.api.addMember({ body: { userId: gone.userId, organizationId: club, role: "member" } }))!;
      const rowA = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, a.id) }))!;
      const rowB = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, b.id) }))!;

      await auth.api.leaveOrganization({ body: { organizationId: club }, headers: headersOf(leaver) });
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, rowA.id) }))).toMatchObject({ memberId: null, status: "aktiv" });
      expect(await data(await call(founder, club, `/club-members/${rowA.id}`))).toMatchObject({ status: "ausgetreten", hasAccount: false });

      await db.delete(user).where(eq(user.id, gone.userId));
      await call(founder, club, "/club-members");
      expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, rowB.id) })).toMatchObject({ memberId: null, status: "ausgetreten", displayName: "Life gone" });
    });

    it("members that never had an account (created by the board) are never closed by this mechanism", async () => {
      await call(founder, club, "/club-members");
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, childId) }))?.status).toBe("aktiv");
    });
  });

  describe("F4 hooks, repair and consistency", () => {
    it("acceptInvitation creates a club_members row", async () => {
      const invitee = await signUp("invitee");
      userIds.push(invitee.userId);
      const invitation = await auth.api.createInvitation({ body: { email: invitee.email, role: "member", organizationId: club }, headers: headersOf(founder) });
      await auth.api.acceptInvitation({ body: { invitationId: invitation.id }, headers: headersOf(invitee) });
      const account = await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, invitee.userId)) });
      expect(account).toBeDefined();
      expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account!.id) })).toMatchObject({ clubId: club, displayName: "Life invitee", status: "aktiv" });
    });

    it("resolving a member.id repairs a missing club_members row; the consistency check reports the gap before", async () => {
      expect((await checkClubMemberConsistency(db, club))[0]).toMatchObject({ missing: 0 });
      await db.delete(clubMembers).where(eq(clubMembers.id, plainClubMemberId));
      expect((await checkClubMemberConsistency(db, club))[0]).toMatchObject({ missing: 1 });

      const res = await call(founder, club, `/club-members/${plainAccount.id}`);
      expect(res.status).toBe(200);
      const repaired = await data(res);
      expect(repaired).toMatchObject({ memberId: plainAccount.id, hasAccount: true });
      plainClubMemberId = repaired.id;
      expect((await checkClubMemberConsistency(db, club))[0]).toMatchObject({ missing: 0 });
    });

    it("concurrent approvals of one application create exactly one member and one club_members row", async () => {
      const applicant = await signUp("racer");
      userIds.push(applicant.userId);
      const apply = await app.request("/club-members/apply", {
        method: "POST",
        headers: { cookie: applicant.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
        body: JSON.stringify({ clubId: club }),
      });
      const applicationId = ((await apply.json()) as { data: { application: { id: string } } }).data.application.id;

      const results = await Promise.all([
        call(founder, club, `/club-applications/${applicationId}/approve`, { method: "POST" }),
        call(founder, club, `/club-applications/${applicationId}/approve`, { method: "POST" }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const accounts = await db.select().from(member).where(and(eq(member.organizationId, club), eq(member.userId, applicant.userId)));
      expect(accounts).toHaveLength(1);
      expect(await db.select().from(clubMembers).where(eq(clubMembers.lastUserId, applicant.userId))).toHaveLength(1);
      expect(await db.select().from(clubMembers).where(eq(clubMembers.memberId, accounts[0]!.id))).toHaveLength(1);
    });
  });

  describe("F7 guardians are personal data", () => {
    it("lists a child's guardians only for read_sensitive or the guardian themself", async () => {
      expect((await call(founder, club, `/club-members/${childId}/guardians`, { method: "POST", body: { guardianMemberId: plainClubMemberId } })).status).toBe(201);
      const other = await signUp("otherparent");
      userIds.push(other.userId);
      await auth.api.addMember({ body: { userId: other.userId, organizationId: club, role: "member" } });

      expect((await call(other, club, `/club-members/${childId}/guardians`)).status).toBe(403);
      expect((await call(secretary, club, `/club-members/${childId}/guardians`)).status).toBe(403);
      const asGuardian = await call(plain, club, `/club-members/${childId}/guardians`);
      expect(asGuardian.status).toBe(200);
      expect((await data(asGuardian))[0]).toMatchObject({ guardianName: "Life plain" });
      expect((await call(founder, club, `/club-members/${childId}/guardians`)).status).toBe(200);
      expect(await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, childId))).toHaveLength(1);
      expect(secretaryClubMemberId).toBeTruthy();
    });
  });
});
