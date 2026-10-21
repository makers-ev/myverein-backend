import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { absenceReports } from "../db/schema/absences.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { meetingAttendance, meetings } from "../db/schema/meetings.js";
import { forms, formSubmissions, formVersions } from "../db/schema/forms.js";
import { consentRecords, dataSubjectRequests } from "../db/schema/privacy.js";
import { toAppError } from "../lib/errors.js";
import { clubMemberRoutes } from "./club-members.js";
import { consentPurposeRoutes } from "./consent-purposes.js";
import { dataSubjectRequestRoutes } from "./data-subject-requests.js";
import { guardianRoutes } from "./guardian.js";

/** Wave 10 B7/B8: data export (Art. 15), erasure plan and execution (Art. 17), legal hold, account deletion hook, request deadlines. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/consent-purposes", consentPurposeRoutes);
app.route("/data-subject-requests", dataSubjectRequestRoutes);
app.route("/guardian", guardianRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; memberId: string; clubMemberId: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `privacy-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Privacy ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}
const json = async (res: Response) => (await res.json()) as Json;

describe("member data export and erasure (B7/B8)", () => {
  let clubId: string;
  let otherClubId: string;
  let board: Actor; // founder = sole owner + vorsitz
  let alice: Actor; // plain member, gets erased by the board
  let bob: Actor; // plain member, deletes the account himself
  let carol: Actor; // plain member, blocked by an open loan
  let guardian: Actor;
  let outsider: Actor;
  let childId: string;
  let meetingId: string;
  const userIds: string[] = [];

  const call = (who: Actor, url: string, init: { method?: string; json?: object; club?: string } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${init.club ?? clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), ...(init.json ? { "content-type": "application/json" } : {}) },
      body: init.json ? JSON.stringify(init.json) : undefined,
    });

  async function resolve(s: { userId: string; cookie: string }, club: string): Promise<Actor> {
    const m = await db.query.member.findFirst({ where: (t, { and: a, eq: e }) => a(e(t.organizationId, club), e(t.userId, s.userId)) });
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) });
    return { ...s, memberId: m!.id, clubMemberId: cm!.id };
  }
  async function join(label: string, role: "member" | "guest" = "member", data: Partial<typeof clubMembers.$inferInsert> = {}): Promise<Actor> {
    const s = await signUp(label);
    userIds.push(s.userId);
    await auth.api.addMember({ body: { userId: s.userId, organizationId: clubId, role } });
    const actor = await resolve(s, clubId);
    await db.update(clubMembers).set({ firstName: label, lastName: "Tester", birthDate: "1990-02-02", phone: "0151 1234", street: "Hauptstr. 1", contactEmail: `${label}@example.com`, emergencyContactName: "Mama", emergencyContactPhone: "0170 99", ...data }).where(eq(clubMembers.id, actor.clubMemberId));
    return actor;
  }
  const exportOf = (who: Actor, target: string, format = "json") => call(who, `/club-members/${target}/data-export`, { method: "POST", json: { identityChecked: true, format } });
  const plan = async (target: string) => json(await call(board, `/club-members/${target}/erasure/plan`, { method: "POST" }));
  const execute = (target: string, planDigest: string) => call(board, `/club-members/${target}/erasure/execute`, { method: "POST", json: { planDigest, confirm: true } });

  beforeAll(async () => {
    const founder = await signUp("board");
    userIds.push(founder.userId);
    clubId = (await auth.api.createOrganization({ body: { name: `Privacy Club ${suffix}`, slug: `privacy-club-${suffix}`, userId: founder.userId } }))!.id;
    const out = await signUp("outsider");
    userIds.push(out.userId);
    otherClubId = (await auth.api.createOrganization({ body: { name: `Privacy Other ${suffix}`, slug: `privacy-other-${suffix}`, userId: out.userId } }))!.id;
    board = await resolve(founder, clubId);
    await db.insert(clubRoles).values({ memberId: board.memberId, roleType: "vorsitz" });
    outsider = await resolve(out, otherClubId);
    await db.insert(clubRoles).values({ memberId: outsider.memberId, roleType: "vorsitz" });

    alice = await join("alice", "member", { displayName: "Alice <b>Tester</b>" });
    bob = await join("bob");
    carol = await join("carol");
    guardian = await join("guardian", "guest");
    await db.insert(clubRoles).values({ memberId: guardian.memberId, roleType: "erziehungsberechtigt" });
    childId = (await json(await call(board, "/club-members", { method: "POST", json: { displayName: "Kind Ohne Konto", categoryKey: "jugend", birthDate: "2016-05-05", phone: "0152 5555" } }))).data.id;
    expect((await call(board, `/club-members/${childId}/guardians`, { method: "POST", json: { guardianMemberId: guardian.clubMemberId } })).status).toBe(201);

    // Data of alice and bob across the registered contributors.
    const [meeting] = await db.insert(meetings).values({ clubId, type: "mitgliederversammlung", title: "MV", status: "abgehalten", createdBy: board.userId }).returning();
    meetingId = meeting!.id;
    await db.insert(meetingAttendance).values([
      { meetingId, memberId: alice.memberId, present: true, hasVotingRight: true },
      { meetingId, memberId: bob.memberId, present: true, hasVotingRight: false },
    ]);
    await db.insert(absenceReports).values({ clubId, clubMemberId: alice.clubMemberId, kind: "krank", startsOn: "2030-01-01", endsOn: "2030-01-03", note: "Grippe", reportedByUserId: alice.userId });
    const list = await json(await call(board, "/consent-purposes"));
    const purposeId = list.data.find((p: Json) => p.key === "foto_video").id;
    const text = (await json(await call(board, `/consent-purposes/${purposeId}/texts`, { method: "POST", json: { body: "Fotos beim Training dürfen verwendet werden." } }))).data;
    expect((await call(alice, `/club-members/${alice.clubMemberId}/consents/${purposeId}`, { method: "POST", json: { textVersionId: text.id } })).status).toBe(201);

    const [item] = await db.insert(inventoryItems).values({ clubId, name: "Zelt", condition: "gut" }).returning();
    await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: carol.memberId });
  }, 90_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    await db.delete(organization).where(eq(organization.id, otherClubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("export", () => {
    it("gives a member their own data as JSON with one section per contributor, never cached, and audits it", async () => {
      const res = await call(alice, "/club-members/me/data-export");
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      const body = (await json(res)).data;
      expect(Object.keys(body.sections)).toEqual(expect.arrayContaining(["member_core", "consents", "absences", "guardianship", "forms_and_applications", "exit_requests", "communication", "account_data"]));
      expect(body.sections.member_core.masterData).toMatchObject({ firstName: "alice", phone: "0151 1234", street: "Hauptstr. 1", emergencyContactName: "Mama", hasAccount: true });
      expect(body.sections.absences.absences).toEqual([expect.objectContaining({ kind: "krank", note: "Grippe" })]);
      expect(body.sections.consents.events).toEqual([expect.objectContaining({ action: "granted", givenBy: "self" })]);
      expect(body.sections.account_data.account.meetingAttendance).toEqual([expect.objectContaining({ present: true })]);
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_data.export"), eq(auditLog.subjectMemberId, alice.clubMemberId)));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.payload).toMatchObject({ via: "self", format: "json" });
      expect(JSON.stringify(audits[0]!.payload)).not.toContain("Hauptstr");
    });

    it("does not contain the data of other members", async () => {
      const text = JSON.stringify((await json(await call(alice, "/club-members/me/data-export"))).data);
      expect(text).not.toContain("bob");
      expect(text).not.toContain("Kind Ohne Konto");
    });

    it("renders an escaped HTML version", async () => {
      const res = await call(alice, "/club-members/me/data-export?format=html");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("Alice &lt;b&gt;Tester&lt;/b&gt;");
      expect(html).not.toContain("<b>Tester</b>");
    });

    it("lets the board export any member of the club (also without account) after confirming the identity check", async () => {
      expect((await call(board, `/club-members/${childId}/data-export`, { method: "POST", json: {} })).status).toBe(422);
      const res = await exportOf(board, childId);
      expect(res.status).toBe(200);
      expect((await json(res)).data.sections.member_core.masterData).toMatchObject({ displayName: "Kind Ohne Konto", phone: "0152 5555", hasAccount: false });
      expect((await exportOf(board, childId, "html")).headers.get("content-type")).toContain("text/html");
    });

    it("denies members, guests and other clubs", async () => {
      expect((await exportOf(alice, bob.clubMemberId)).status).toBe(403);
      expect((await exportOf(alice, alice.clubMemberId)).status).toBe(403); // the self route is /me/data-export
      expect((await exportOf(guardian, childId)).status).toBe(403);
      expect((await call(outsider, `/club-members/${alice.clubMemberId}/data-export`, { method: "POST", json: { identityChecked: true }, club: otherClubId })).status).toBe(404);
      expect((await call(board, `/club-members/${randomUUID()}/data-export`, { method: "POST", json: { identityChecked: true } })).status).toBe(404);
    });

    it("lets a guardian export the ward's data, and nobody else's", async () => {
      const res = await call(guardian, `/guardian/wards/${childId}/data-export`);
      expect(res.status).toBe(200);
      expect((await json(res)).data.sections.member_core.masterData.displayName).toBe("Kind Ohne Konto");
      expect((await call(guardian, `/guardian/wards/${alice.clubMemberId}/data-export`)).status).toBe(404);
      expect((await call(alice, `/guardian/wards/${childId}/data-export`)).status).toBe(404);
    });

    it("needs custody for the ward's export and erasure request, and names the ward by first name in the guardian's own export", async () => {
      await db.update(guardianLinks).set({ hasCustody: false }).where(eq(guardianLinks.wardClubMemberId, childId));
      for (const [path, method] of [[`/guardian/wards/${childId}/data-export`, "GET"], [`/guardian/wards/${childId}/erasure-request`, "POST"]] as const) {
        const res = await call(guardian, path, { method });
        expect(res.status, path).toBe(403);
        expect((await json(res)).error.details.code).toBe("guardian_requires_custody");
      }
      await db.update(guardianLinks).set({ hasCustody: true }).where(eq(guardianLinks.wardClubMemberId, childId));
      expect((await call(guardian, `/guardian/wards/${childId}/data-export`)).status).toBe(200);
      const own = await call(guardian, "/club-members/me/data-export");
      expect(own.status).toBe(200);
      const ownExport = JSON.stringify((await json(own)).data);
      expect(ownExport).toContain("wardsOfThisMember");
      expect(ownExport).not.toContain("Kind Ohne Konto");
    });

    it("closes an open access request when the export is delivered", async () => {
      const created = await json(await call(board, "/data-subject-requests", { method: "POST", json: { clubMemberId: bob.clubMemberId, kind: "access" } }));
      expect(created.data.status).toBe("open");
      expect((await exportOf(board, bob.clubMemberId)).status).toBe(200);
      const [row] = await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, created.data.id));
      expect(row).toMatchObject({ status: "done", handledByUserId: board.userId });
    });
  });

  describe("data subject requests", () => {
    it("tracks a one month deadline, is idempotent per member and kind, and is scoped to the club", async () => {
      const first = await call(carol, "/club-members/me/erasure-request", { method: "POST" });
      expect(first.status).toBe(201);
      const request = (await json(first)).data;
      const days = (new Date(request.dueAt).getTime() - new Date(request.receivedAt).getTime()) / 86_400_000;
      expect(days).toBeGreaterThanOrEqual(28);
      expect(days).toBeLessThanOrEqual(31);
      const again = await call(carol, "/club-members/me/erasure-request", { method: "POST" });
      expect(again.status).toBe(200);
      expect((await json(again)).data.id).toBe(request.id);

      const mine = await json(await call(carol, "/club-members/me/data-requests"));
      expect(mine.data).toEqual([expect.objectContaining({ id: request.id, kind: "erasure", status: "open" })]);

      const list = await json(await call(board, "/data-subject-requests?status=open&kind=erasure"));
      const entry = list.data.find((r: Json) => r.id === request.id);
      expect(entry).toMatchObject({ memberName: expect.any(String), overdue: false });
      expect(entry.daysLeft).toBeGreaterThan(25);
      expect((await json(await call(outsider, "/data-subject-requests", { club: otherClubId }))).data.map((r: Json) => r.id)).not.toContain(request.id);
    });

    it("marks overdue requests and lets the board close or reject them", async () => {
      const created = (await json(await call(board, "/data-subject-requests", { method: "POST", json: { clubMemberId: bob.clubMemberId, kind: "rectification" } }))).data;
      await db.update(dataSubjectRequests).set({ dueAt: new Date(Date.now() - 2 * 86_400_000) }).where(eq(dataSubjectRequests.id, created.id));
      const overdue = await json(await call(board, "/data-subject-requests?overdue=true"));
      expect(overdue.data.find((r: Json) => r.id === created.id)).toMatchObject({ overdue: true });
      expect((await call(board, `/data-subject-requests/${created.id}`, { method: "PATCH", json: { status: "rejected" } })).status).toBe(422);
      const done = await call(board, `/data-subject-requests/${created.id}`, { method: "PATCH", json: { status: "done", result: "Anschrift korrigiert" } });
      expect(done.status).toBe(200);
      expect((await json(done)).data).toMatchObject({ status: "done", overdue: false });
      expect((await call(board, `/data-subject-requests/${created.id}`, { method: "PATCH", json: { status: "in_progress" } })).status).toBe(422);
      expect((await call(outsider, `/data-subject-requests/${created.id}`, { method: "PATCH", json: { status: "done" }, club: otherClubId })).status).toBe(404);
    });

    it("is only readable with privacy:read and writable with privacy:manage", async () => {
      expect((await call(alice, "/data-subject-requests")).status).toBe(403);
      expect((await call(alice, "/data-subject-requests", { method: "POST", json: { clubMemberId: bob.clubMemberId, kind: "access" } })).status).toBe(403);
    });
  });

  describe("erasure (board)", () => {
    it("blocks the sole owner, a board role, open loans and a legal hold, with a reason each; the plan changes nothing", async () => {
      const own = (await plan(board.clubMemberId)).data;
      expect(own.blockers.map((b: Json) => b.code)).toEqual(expect.arrayContaining(["board_role", "sole_owner"]));
      expect(own.steps).toEqual([]);

      const loan = (await plan(carol.clubMemberId)).data;
      expect(loan.blockers.map((b: Json) => b.code)).toEqual(["open_loans"]);
      const refused = await execute(carol.clubMemberId, loan.planDigest);
      expect(refused.status).toBe(409);
      expect((await json(refused)).error.details.code).toBe("open_loans");

      expect((await call(board, `/club-members/${bob.clubMemberId}/legal-hold`, { method: "PUT", json: { active: true } })).status).toBe(422);
      expect((await call(board, `/club-members/${bob.clubMemberId}/legal-hold`, { method: "PUT", json: { active: true, reason: "Rechtsstreit" } })).status).toBe(200);
      const held = (await plan(bob.clubMemberId)).data;
      expect(held.blockers.map((b: Json) => b.code)).toEqual(["legal_hold"]);
      expect((await execute(bob.clubMemberId, held.planDigest)).status).toBe(409);
      expect((await call(board, `/club-members/${bob.clubMemberId}/legal-hold`, { method: "PUT", json: { active: false } })).status).toBe(200);
      expect((await plan(bob.clubMemberId)).data.blockers).toEqual([]);
    });

    it("plans without changing anything and lists what is deleted, anonymised and kept", async () => {
      const p = (await plan(alice.clubMemberId)).data;
      expect(p.blockers).toEqual([]);
      expect(p.displayName).toBe("Alice <b>Tester</b>");
      const byKey = Object.fromEntries(p.steps.map((s: Json) => [s.key, s]));
      expect(byKey.absences.deleted).toBe(1);
      expect(byKey.consents).toMatchObject({ kept: 1 });
      expect(byKey.consents.keptReason).toBeTruthy();
      expect(byKey.account_data.kept).toBe(1);
      expect(byKey.member_core.anonymized).toBeGreaterThanOrEqual(1);
      const [row] = await db.select().from(clubMembers).where(eq(clubMembers.id, alice.clubMemberId));
      expect(row).toMatchObject({ firstName: "alice", phone: "0151 1234" });
      expect(await db.select().from(absenceReports).where(eq(absenceReports.clubMemberId, alice.clubMemberId))).toHaveLength(1);
      expect(await db.query.member.findFirst({ where: eq(member.id, alice.memberId) })).toBeTruthy();
    });

    it("needs the digest of the plan and refuses a stale or missing one", async () => {
      expect((await call(board, `/club-members/${alice.clubMemberId}/erasure/execute`, { method: "POST", json: { confirm: true } })).status).toBe(422);
      const stale = await execute(alice.clubMemberId, "0".repeat(64));
      expect(stale.status).toBe(409);
      expect((await json(stale)).error.details.code).toBe("plan_outdated");
      const [row] = await db.select().from(clubMembers).where(eq(clubMembers.id, alice.clubMemberId));
      expect(row!.firstName).toBe("alice");
    });

    it("denies members and other clubs, and answers 404 for foreign ids", async () => {
      expect((await call(alice, `/club-members/${bob.clubMemberId}/erasure/plan`, { method: "POST" })).status).toBe(403);
      expect((await call(alice, `/club-members/${bob.clubMemberId}/legal-hold`, { method: "PUT", json: { active: false } })).status).toBe(403);
      expect((await call(outsider, `/club-members/${alice.clubMemberId}/erasure/plan`, { method: "POST", club: otherClubId })).status).toBe(404);
      expect((await call(board, `/club-members/${randomUUID()}/erasure/plan`, { method: "POST" })).status).toBe(404);
    });

    it("anonymises the member, keeps pseudonymised attendance and consent proof, deletes the rest and the account membership", async () => {
      const p = (await plan(alice.clubMemberId)).data;
      const res = await execute(alice.clubMemberId, p.planDigest);
      expect(res.status).toBe(200);
      expect((await json(res)).data.erased).toBe(true);

      const [row] = await db.select().from(clubMembers).where(eq(clubMembers.id, alice.clubMemberId));
      expect(row).toMatchObject({ displayName: "Gelöschtes Mitglied", firstName: null, lastName: null, birthDate: null, phone: null, street: null, contactEmail: null, emergencyContactName: null, emergencyContactPhone: null, memberId: null, lastUserId: null, status: "ausgetreten" });
      expect(row!.joinedAt).toBeTruthy();
      expect(await db.select().from(absenceReports).where(eq(absenceReports.clubMemberId, alice.clubMemberId))).toHaveLength(0);
      expect(await db.select().from(consentRecords).where(eq(consentRecords.clubMemberId, alice.clubMemberId))).toHaveLength(1);
      expect(await db.query.member.findFirst({ where: eq(member.id, alice.memberId) })).toBeUndefined();
      // The attendance stays for the minutes, without the reference to the person.
      const attendance = await db.select().from(meetingAttendance).where(eq(meetingAttendance.meetingId, meetingId));
      expect(attendance).toHaveLength(2);
      expect(attendance.find((a) => a.memberId === null)).toMatchObject({ present: true, hasVotingRight: true });
      // The account itself survives (the user decides separately), but it is no longer a member of the club.
      expect(await db.query.user.findFirst({ where: eq(user.id, alice.userId) })).toBeTruthy();
      expect((await call(alice, "/club-members/me")).status).toBe(404);

      const audit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_erasure.execute"), eq(auditLog.subjectMemberId, alice.clubMemberId)));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]!.payload)).not.toContain("Alice");
      const requests = await db.select().from(dataSubjectRequests).where(and(eq(dataSubjectRequests.clubMemberId, alice.clubMemberId), eq(dataSubjectRequests.kind, "erasure")));
      expect(requests).toEqual([expect.objectContaining({ status: "done" })]);
      // The export of the anonymised record holds no master data any more.
      const exported = JSON.stringify((await json(await exportOf(board, alice.clubMemberId))).data);
      expect(exported).not.toContain("Hauptstr");
      expect(exported).not.toContain("Grippe");
    });

    it("anonymises a child without account and removes the guardian link", async () => {
      const p = (await plan(childId)).data;
      expect((await execute(childId, p.planDigest)).status).toBe(200);
      expect(await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, childId))).toHaveLength(0);
      // The last link of the guest guardian is gone, so is the guardian role.
      expect(await db.select().from(clubRoles).where(and(eq(clubRoles.memberId, guardian.memberId), eq(clubRoles.roleType, "erziehungsberechtigt")))).toHaveLength(0);
      const [row] = await db.select().from(clubMembers).where(eq(clubMembers.id, childId));
      expect(row).toMatchObject({ displayName: "Gelöschtes Mitglied", phone: null, birthDate: null });
    });
  });

  describe("account deletion hook", () => {
    it("refuses the deletion of the only owner and changes nothing", async () => {
      await expect(auth.api.deleteUser({ headers: new Headers({ cookie: board.cookie }), body: {} })).rejects.toMatchObject({ body: { code: "ERASURE_BOARD_ROLE" } });
      expect(await db.query.user.findFirst({ where: eq(user.id, board.userId) })).toBeTruthy();
      expect(await db.query.member.findFirst({ where: eq(member.id, board.memberId) })).toBeTruthy();
    });

    it("refuses the deletion while loans are open", async () => {
      await expect(auth.api.deleteUser({ headers: new Headers({ cookie: carol.cookie }), body: {} })).rejects.toMatchObject({ body: { code: "ERASURE_OPEN_LOANS" } });
      expect(await db.query.user.findFirst({ where: eq(user.id, carol.userId) })).toBeTruthy();
    });

    it("anonymises the club record and keeps the attendance instead of cascading it away", async () => {
      await auth.api.deleteUser({ headers: new Headers({ cookie: bob.cookie }), body: {} });
      expect(await db.query.user.findFirst({ where: eq(user.id, bob.userId) })).toBeUndefined();
      const [row] = await db.select().from(clubMembers).where(eq(clubMembers.id, bob.clubMemberId));
      expect(row).toMatchObject({ displayName: "Gelöschtes Mitglied", phone: null, firstName: null, memberId: null });
      const attendance = await db.select().from(meetingAttendance).where(eq(meetingAttendance.meetingId, meetingId));
      expect(attendance).toHaveLength(2);
      expect(attendance.every((a) => a.memberId === null)).toBe(true);
      expect(attendance.map((a) => a.hasVotingRight).sort()).toEqual([false, true]);
    });
  });

  describe("account deletion keeps club records (H1)", () => {
    it("keeps meetings and decided applications, blocks while an application is under review", async () => {
      const dave = await join("dave");
      const [meeting] = await db.insert(meetings).values({ clubId, type: "sonstige", title: "Kreis", status: "geplant", createdBy: dave.userId }).returning();
      const [form] = await db.insert(forms).values({ clubId, purpose: "sonstige", name: "Antrag" }).returning();
      const [version] = await db.insert(formVersions).values({ formId: form!.id, version: 1, status: "published" }).returning();
      const base = { formId: form!.id, formVersionId: version!.id, clubId, submittedByUserId: dave.userId };
      const [open] = await db.insert(formSubmissions).values({ ...base, status: "submitted" }).returning();
      await expect(auth.api.deleteUser({ headers: new Headers({ cookie: dave.cookie }), body: {} })).rejects.toMatchObject({ body: { code: "ERASURE_APPLICATION_PENDING" } });
      expect(await db.query.user.findFirst({ where: eq(user.id, dave.userId) })).toBeTruthy();

      await db.update(formSubmissions).set({ status: "accepted" }).where(eq(formSubmissions.id, open!.id));
      const [draft] = await db.insert(formSubmissions).values({ ...base, status: "draft" }).returning();
      await auth.api.deleteUser({ headers: new Headers({ cookie: dave.cookie }), body: {} });
      expect(await db.query.user.findFirst({ where: eq(user.id, dave.userId) })).toBeUndefined();
      expect((await db.query.meetings.findFirst({ where: eq(meetings.id, meeting!.id) }))?.createdBy).toBeNull();
      expect((await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, open!.id) }))?.submittedByUserId).toBeNull();
      expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, draft!.id) })).toBeUndefined();
    });
  });
});
