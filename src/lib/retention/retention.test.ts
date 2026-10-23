import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../../auth/auth.js";
import { organization, user } from "../../auth/auth-schema.js";
import { closeDatabase, db } from "../../db/client.js";
import { absenceReports } from "../../db/schema/absences.js";
import { auditLog } from "../../db/schema/audit-log.js";
import { clubApplications } from "../../db/schema/club-applications.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { clubRegistrationDocuments, clubRegistrations } from "../../db/schema/club-registrations.js";
import { clubRoles } from "../../db/schema/club-roles.js";
import { messageDeliveries } from "../../db/schema/communication.js";
import { consentPurposes, consentRecords, consentTexts, retentionPolicies, retentionRuns } from "../../db/schema/privacy.js";
import { retentionPolicyRoutes } from "../../routes/retention-policies.js";
import { adminRetentionRoutes } from "../../routes/admin-retention.js";
import { toAppError } from "../errors.js";
import { RETENTION_RULES, ruleOf } from "./rules.js";
import { runRetentionRules } from "./sweep.js";

/** Wave 10 B9: retention rules, dry run by default, announcement before the first real deletion, club overrides, platform categories. */

const app = new Hono();
app.route("/retention-policies", retentionPolicyRoutes);
app.route("/admin/retention-runs", adminRetentionRoutes);
app.onError((err, c) => {
  const e = toAppError(err);
  return c.json(e.toJSON(), e.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const dateAgo = (n: number) => daysAgo(n).toISOString().slice(0, 10);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `retention-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Retention ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

describe("retention (B9)", () => {
  let clubId: string;
  let otherClubId: string;
  let board: { userId: string; cookie: string; memberId: string };
  let plain: { userId: string; cookie: string };
  const userIds: string[] = [];
  const ids: Record<string, string> = {};

  const sweep = (opts: { dryRun?: boolean; clubId?: string } = {}) => runRetentionRules(new Date(), { clubId, ...opts });
  const runsOf = (club: string, category: string) => db.select().from(retentionRuns).where(and(eq(retentionRuns.clubId, club), eq(retentionRuns.category, category)));
  const call = (who: { cookie: string }, url: string, init: { method?: string; json?: object } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), ...(init.json ? { "content-type": "application/json" } : {}) },
      body: init.json ? JSON.stringify(init.json) : undefined,
    });

  async function seedDueData(club: string, tag: string) {
    const [absence] = await db.insert(absenceReports).values({ clubId: club, clubMemberId: ids[`member-${tag}`]!, kind: "krank", startsOn: dateAgo(210), endsOn: dateAgo(200) }).returning();
    const [recent] = await db.insert(absenceReports).values({ clubId: club, clubMemberId: ids[`member-${tag}`]!, kind: "krank", startsOn: dateAgo(5), endsOn: dateAgo(3) }).returning();
    return { absence: absence!.id, recent: recent!.id };
  }

  async function makeMember(club: string, data: Partial<typeof clubMembers.$inferInsert>) {
    const [row] = await db.insert(clubMembers).values({ clubId: club, displayName: "Person", joinedAt: dateAgo(2000), ...data }).returning();
    return row!.id;
  }

  beforeAll(async () => {
    const founder = await signUp("board");
    userIds.push(founder.userId);
    clubId = (await auth.api.createOrganization({ body: { name: `Retention Club ${suffix}`, slug: `retention-club-${suffix}`, userId: founder.userId } }))!.id;
    const other = await signUp("other");
    userIds.push(other.userId);
    otherClubId = (await auth.api.createOrganization({ body: { name: `Retention Other ${suffix}`, slug: `retention-other-${suffix}`, userId: other.userId } }))!.id;
    const m = await db.query.member.findFirst({ where: (t, { and: a, eq: e }) => a(e(t.organizationId, clubId), e(t.userId, founder.userId)) });
    await db.insert(clubRoles).values({ memberId: m!.id, roleType: "vorsitz" });
    board = { ...founder, memberId: m!.id };
    plain = await signUp("plain");
    userIds.push(plain.userId);
    await auth.api.addMember({ body: { userId: plain.userId, organizationId: clubId, role: "member" } });

    for (const [club, tag] of [[clubId, "a"], [otherClubId, "b"]] as const) {
      ids[`member-${tag}`] = await makeMember(club, { displayName: `Aktiv ${tag}`, status: "aktiv" });
      // Left 800 days ago: anonymised after 730; left 60 days ago: only the emergency contact goes (30 days).
      ids[`former-${tag}`] = await makeMember(club, { displayName: `Ehemalig ${tag}`, firstName: "Erna", phone: "0151", status: "ausgetreten", leftAt: dateAgo(800), emergencyContactName: "Mama", emergencyContactPhone: "01" });
      ids[`recentleft-${tag}`] = await makeMember(club, { displayName: `Kürzlich ${tag}`, firstName: "Kai", status: "ausgetreten", leftAt: dateAgo(60), emergencyContactName: "Papa", emergencyContactPhone: "02" });
      ids[`interested-${tag}`] = await makeMember(club, { displayName: `Interessent ${tag}`, status: "interessent", phone: "0170" });
      await db.update(clubMembers).set({ updatedAt: daysAgo(400) }).where(eq(clubMembers.id, ids[`interested-${tag}`]!));
    }
  }, 90_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    await db.delete(organization).where(eq(organization.id, otherClubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("lists rules with defaults, bounds and the plan's proposals", () => {
    expect(RETENTION_RULES.map((r) => r.category)).toEqual(expect.arrayContaining(["registration_proofs_approved", "registration_proofs_rejected", "registration_proofs_stale", "applications_rejected", "interested_without_join", "former_members", "emergency_contacts_left", "absence_reports", "consent_proofs", "audit_log", "audit_log_auth"]));
    expect(ruleOf("absence_reports")).toMatchObject({ defaultDays: 90, scope: "club" });
    expect(ruleOf("audit_log_auth")).toMatchObject({ defaultDays: 180, scope: "platform" });
    for (const r of RETENTION_RULES) {
      expect(r.minDays).toBeLessThanOrEqual(r.defaultDays);
      expect(r.defaultDays).toBeLessThanOrEqual(r.maxDays);
    }
  });

  it("only counts by default (RETENTION_DRY_RUN unset): nothing is deleted, the runs say so", async () => {
    Object.assign(ids, await seedDueData(clubId, "a"));
    expect(process.env.RETENTION_DRY_RUN).toBeUndefined();
    const summary = await sweep();
    expect(summary.failed).toEqual([]);
    expect(summary.affected).toBe(0);
    expect(await db.select().from(absenceReports).where(eq(absenceReports.id, ids.absence!))).toHaveLength(1);
    const [former] = await db.select().from(clubMembers).where(eq(clubMembers.id, ids["former-a"]!));
    expect(former!.firstName).toBe("Erna");
    const rows = await runsOf(clubId, "absence_reports");
    expect(rows).toEqual([expect.objectContaining({ dryRun: true, notice: false, scanned: 1, affected: 0, errors: 0 })]);
    expect((await runsOf(clubId, "former_members"))[0]).toMatchObject({ dryRun: true, scanned: 1 });
    expect((await runsOf(clubId, "interested_without_join"))[0]).toMatchObject({ scanned: 1 });
  });

  it("announces before the first real deletion, then deletes only what is due, only in the swept club", async () => {
    await db.insert(consentPurposes).values({ clubId, key: "x_test", name: "X", active: true }).onConflictDoNothing();
    const [purpose] = await db.select().from(consentPurposes).where(and(eq(consentPurposes.clubId, clubId), eq(consentPurposes.key, "x_test")));
    const [text] = await db.insert(consentTexts).values({ purposeId: purpose!.id, version: 1, body: "Text", sha256: "0".repeat(64), publishedAt: new Date() }).returning();
    await db.insert(consentRecords).values([
      { clubId, clubMemberId: ids["member-a"]!, purposeId: purpose!.id, textVersionId: text!.id, action: "granted", givenBy: "self", createdAt: daysAgo(1500) },
      { clubId, clubMemberId: ids["member-a"]!, purposeId: purpose!.id, textVersionId: text!.id, action: "revoked", givenBy: "self", createdAt: daysAgo(1200) },
    ]);
    const [legacyUser] = [{ id: userIds[0]! }];
    const [legacyApp] = await db.insert(clubApplications).values({ userId: legacyUser.id, clubId, status: "rejected", birthDate: "1990-01-01", decidedAt: daysAgo(300) }).returning();
    ids.legacyApp = legacyApp!.id;

    // First real run: counts, writes the notice and tells the board; nothing is deleted.
    const first = await sweep({ dryRun: false });
    expect(first.affected).toBe(0);
    expect(await db.select().from(absenceReports).where(eq(absenceReports.id, ids.absence!))).toHaveLength(1);
    const notices = await db.select().from(retentionRuns).where(and(eq(retentionRuns.clubId, clubId), eq(retentionRuns.notice, true)));
    expect(notices.map((n) => n.category).sort()).toEqual(["absence_reports", "applications_rejected", "consent_proofs", "former_members", "interested_without_join", "emergency_contacts_left"].sort());
    expect(notices.every((n) => n.dryRun && n.affected > 0)).toBe(true);
    const sent = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, "retention.notice")));
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.stringify(sent.map((s) => s.content))).not.toContain("Erna");

    // Within the waiting time nothing happens either.
    expect((await sweep({ dryRun: false })).affected).toBe(0);
    expect(await db.select().from(absenceReports).where(eq(absenceReports.id, ids.absence!))).toHaveLength(1);

    // After the waiting time the due data goes.
    await db.update(retentionRuns).set({ startedAt: daysAgo(8) }).where(and(eq(retentionRuns.clubId, clubId), eq(retentionRuns.notice, true)));
    const third = await sweep({ dryRun: false });
    expect(third.failed).toEqual([]);
    expect(third.affected).toBeGreaterThanOrEqual(6);

    expect(await db.select().from(absenceReports).where(eq(absenceReports.id, ids.absence!))).toHaveLength(0);
    expect(await db.select().from(absenceReports).where(eq(absenceReports.id, ids.recent!))).toHaveLength(1);
    const [former] = await db.select().from(clubMembers).where(eq(clubMembers.id, ids["former-a"]!));
    expect(former).toMatchObject({ displayName: "Gelöschtes Mitglied", firstName: null, phone: null, emergencyContactName: null });
    const [recentLeft] = await db.select().from(clubMembers).where(eq(clubMembers.id, ids["recentleft-a"]!));
    expect(recentLeft).toMatchObject({ displayName: "Kürzlich a", firstName: "Kai", emergencyContactName: null, emergencyContactPhone: null });
    const [interested] = await db.select().from(clubMembers).where(eq(clubMembers.id, ids["interested-a"]!));
    expect(interested).toMatchObject({ displayName: "Gelöschtes Mitglied", phone: null });
    const [active] = await db.select().from(clubMembers).where(eq(clubMembers.id, ids["member-a"]!));
    expect(active!.displayName).toBe("Aktiv a");
    expect(await db.select().from(consentRecords).where(eq(consentRecords.clubMemberId, ids["member-a"]!))).toHaveLength(0);
    const [app1] = await db.select().from(clubApplications).where(eq(clubApplications.id, ids.legacyApp!));
    expect(app1).toMatchObject({ birthDate: null, status: "rejected" });

    // The other club was not swept: its due data is untouched.
    const [otherFormer] = await db.select().from(clubMembers).where(eq(clubMembers.id, ids["former-b"]!));
    expect(otherFormer!.firstName).toBe("Erna");
    expect(await runsOf(otherClubId, "former_members")).toHaveLength(0);

    // Runs carry counters only.
    const real = (await runsOf(clubId, "absence_reports")).find((r) => !r.dryRun)!;
    expect(real).toMatchObject({ dryRun: false, notice: false, affected: 1, errors: 0 });
    // Idempotent: nothing left to do.
    expect((await sweep({ dryRun: false })).affected).toBe(0);
  });

  it("keeps blocked members (legal hold) and tries them again", async () => {
    const held = await makeMember(clubId, { displayName: "Gesperrt", firstName: "Hans", status: "ausgetreten", leftAt: dateAgo(900) });
    await db.update(clubMembers).set({ legalHoldAt: new Date(), legalHoldReason: "Streit" }).where(eq(clubMembers.id, held));
    const result = await sweep({ dryRun: false });
    expect(result.failed).toEqual([]);
    const [row] = await db.select().from(clubMembers).where(eq(clubMembers.id, held));
    expect(row!.firstName).toBe("Hans");
    await db.update(clubMembers).set({ legalHoldAt: null, legalHoldReason: null }).where(eq(clubMembers.id, held));
    await sweep({ dryRun: false });
    const [after] = await db.select().from(clubMembers).where(eq(clubMembers.id, held));
    expect(after!.firstName).toBeNull();
  });

  it("isolates a failing category and reports it by name", async () => {
    const fake = { category: "boom_test", scope: "club" as const, defaultDays: 1, minDays: 0, maxDays: 10, label: "Boom", description: "Boom", run: async () => { throw new TypeError("secret detail Erna"); } };
    (RETENTION_RULES as unknown as unknown[]).push(fake);
    try {
      const result = await sweep({ dryRun: true });
      expect(result.failed).toEqual(["boom_test"]);
      const rows = await runsOf(clubId, "boom_test");
      expect(rows).toEqual([expect.objectContaining({ errors: 1, errorCode: "TypeError" })]);
      expect(JSON.stringify(rows)).not.toContain("secret");
      // The other categories still ran.
      expect((await runsOf(clubId, "interested_without_join")).length).toBeGreaterThan(0);
    } finally {
      (RETENTION_RULES as unknown as unknown[]).pop();
    }
  });

  describe("platform categories", () => {
    it("deletes proof documents by outcome and age, keeps the application", async () => {
      const owner = userIds[0]!;
      const make = async (status: string, when: Date, key: string) => {
        const [reg] = await db.insert(clubRegistrations).values({ userId: owner, clubName: `Reg ${key}`, legalForm: "e_v", street: "S", postalCode: "1", city: "C", status, reviewedAt: status === "approved" || status === "rejected" ? when : null, updatedAt: when }).returning();
        const [doc] = await db.insert(clubRegistrationDocuments).values({ registrationId: reg!.id, kind: "satzung", storageKey: `registrations/${reg!.id}/${key}.pdf`, filename: "s.pdf", mimeType: "application/pdf", sizeBytes: 3 }).returning();
        return { reg: reg!.id, doc: doc!.id };
      };
      // Statuses draft/pending/needs_info are limited to one per user: use separate rows of different outcomes.
      const approvedOld = await make("approved", daysAgo(400), "a1");
      const approvedNew = await make("approved", daysAgo(10), "a2");
      const rejectedOld = await make("rejected", daysAgo(120), "r1");
      const rejectedNew = await make("rejected", daysAgo(10), "r2");
      const staleOld = await make("draft", daysAgo(60), "d1");
      const gone = async (docId: string) => (await db.select().from(clubRegistrationDocuments).where(eq(clubRegistrationDocuments.id, docId))).length === 0;
      try {
        // Counting first: nothing changes.
        await ruleOf("registration_proofs_approved")!.run({ clubId: null, days: 180, now: new Date(), dryRun: true });
        expect(await gone(approvedOld.doc)).toBe(false);
        for (const cat of ["registration_proofs_approved", "registration_proofs_rejected", "registration_proofs_stale"]) {
          const r = ruleOf(cat)!;
          await r.run({ clubId: null, days: r.defaultDays, now: new Date(), dryRun: false });
        }
        expect(await gone(approvedOld.doc)).toBe(true);
        expect(await gone(rejectedOld.doc)).toBe(true);
        expect(await gone(staleOld.doc)).toBe(true);
        expect(await gone(approvedNew.doc)).toBe(false);
        expect(await gone(rejectedNew.doc)).toBe(false);
        expect(await db.select().from(clubRegistrations).where(eq(clubRegistrations.id, approvedOld.reg))).toHaveLength(1);
      } finally {
        await db.delete(clubRegistrations).where(inArray(clubRegistrations.id, [approvedOld.reg, approvedNew.reg, rejectedOld.reg, rejectedNew.reg, staleOld.reg]));
      }
    });

    it("deletes old audit entries, auth events sooner, and keeps recent ones", async () => {
      const mark = `retention-test-${suffix}`;
      await db.insert(auditLog).values([
        { eventType: "session.create", subjectId: mark, createdAt: daysAgo(200) },
        { eventType: "session.create", subjectId: `${mark}-new`, createdAt: daysAgo(10) },
        { eventType: "rate_limit.exceeded", subjectId: mark, createdAt: daysAgo(900) },
        { eventType: "rate_limit.exceeded", subjectId: `${mark}-mid`, createdAt: daysAgo(200) },
      ]);
      await ruleOf("audit_log_auth")!.run({ clubId: null, days: 180, now: new Date(), dryRun: false });
      await ruleOf("audit_log")!.run({ clubId: null, days: 730, now: new Date(), dryRun: false });
      const left = await db.select().from(auditLog).where(inArray(auditLog.subjectId, [mark, `${mark}-new`, `${mark}-mid`]));
      expect(left.map((r) => r.subjectId).sort()).toEqual([`${mark}-mid`, `${mark}-new`]);
      await db.delete(auditLog).where(inArray(auditLog.subjectId, [`${mark}-mid`, `${mark}-new`]));
    });
  });

  describe("club overrides (API)", () => {
    it("shows rules, default and effective periods, and the dry-run switch", async () => {
      const res = await call(board, "/retention-policies");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Json;
      expect(body.data.dryRun).toBe(true);
      const absence = body.data.rules.find((r: Json) => r.category === "absence_reports");
      expect(absence).toMatchObject({ defaultDays: 90, minDays: 30, maxDays: 365, effectiveDays: 90, overridden: false, editable: true });
      expect(body.data.rules.find((r: Json) => r.category === "audit_log")).toMatchObject({ editable: false, scope: "platform" });
      expect((await call(plain, "/retention-policies")).status).toBe(403);
    });

    it("previews what the next sweep would concern", async () => {
      await db.insert(absenceReports).values({ clubId, clubMemberId: ids["member-a"]!, kind: "abwesend", startsOn: dateAgo(150), endsOn: dateAgo(140) });
      const preview = (await (await call(board, "/retention-policies/preview")).json()) as Json;
      expect(preview.data.find((r: Json) => r.category === "absence_reports")).toMatchObject({ due: 1 });
      expect(preview.data.some((r: Json) => r.category === "audit_log")).toBe(false);
    });

    it("sets, bounds, resets and audits an override, which the sweep uses", async () => {
      expect((await call(board, "/retention-policies/absence_reports", { method: "PUT", json: { retainDays: 10 } })).status).toBe(422);
      expect((await call(board, "/retention-policies/absence_reports", { method: "PUT", json: { retainDays: 4000 } })).status).toBe(422);
      expect((await call(board, "/retention-policies/audit_log", { method: "PUT", json: { retainDays: 400 } })).status).toBe(422);
      expect((await call(board, "/retention-policies/nope", { method: "PUT", json: { retainDays: 400 } })).status).toBe(404);
      expect((await call(plain, "/retention-policies/absence_reports", { method: "PUT", json: { retainDays: 100 } })).status).toBe(403);

      const set = await call(board, "/retention-policies/absence_reports", { method: "PUT", json: { retainDays: 365 } });
      expect(set.status).toBe(200);
      expect((await set.json() as Json).data).toMatchObject({ effectiveDays: 365, overridden: true });
      await call(board, "/retention-policies/absence_reports", { method: "PUT", json: { retainDays: 300 } }); // upsert
      expect(await db.select().from(retentionPolicies).where(and(eq(retentionPolicies.clubId, clubId), eq(retentionPolicies.category, "absence_reports")))).toHaveLength(1);
      const preview = (await (await call(board, "/retention-policies/preview")).json()) as Json;
      expect(preview.data.find((r: Json) => r.category === "absence_reports")).toMatchObject({ due: 0 });

      expect((await call(board, "/retention-policies/absence_reports", { method: "DELETE" })).status).toBe(204);
      expect((await call(board, "/retention-policies/absence_reports", { method: "DELETE" })).status).toBe(404);
      const after = (await (await call(board, "/retention-policies/preview")).json()) as Json;
      expect(after.data.find((r: Json) => r.category === "absence_reports")).toMatchObject({ due: 1 });
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubId), eq(auditLog.eventType, "retention_policy.update")));
      expect(audits.length).toBeGreaterThanOrEqual(2);
    });

    it("lists the club's own runs, not those of other clubs", async () => {
      const res = (await (await call(board, "/retention-policies/runs")).json()) as Json;
      expect(res.total).toBeGreaterThan(0);
      expect(res.data[0]).toEqual(expect.objectContaining({ category: expect.any(String), scanned: expect.any(Number), affected: expect.any(Number), dryRun: expect.any(Boolean) }));
      expect((await call(plain, "/retention-policies/runs")).status).toBe(403);
    });

    it("keeps the admin run log behind the platform admin guard", async () => {
      const res = await app.request("/admin/retention-runs", { headers: { cookie: board.cookie, "x-forwarded-for": randomUUID() } });
      expect([401, 403]).toContain(res.status);
    });
  });
});
