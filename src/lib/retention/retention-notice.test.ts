import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../../auth/auth.js";
import { organization, user } from "../../auth/auth-schema.js";
import { closeDatabase, db } from "../../db/client.js";
import { absenceReports } from "../../db/schema/absences.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { clubRoles } from "../../db/schema/club-roles.js";
import { consentPurposes, consentRecords, consentTexts, retentionRuns } from "../../db/schema/privacy.js";
import { runRetentionRules } from "./sweep.js";

/** Review M4/M7: legal hold protects against every category; a notice is written after it was sent and covers only its own cohort. */

const suffix = Date.now();
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const dateAgo = (n: number) => daysAgo(n).toISOString().slice(0, 10);

describe("retention notices and legal hold", () => {
  const userIds: string[] = [];
  const clubs: string[] = [];

  async function makeClub(label: string, board: boolean) {
    const email = `retnotice-${label}-${suffix}@example.com`;
    const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `RN ${label}` } });
    userIds.push(created.id);
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
    const clubId = (await auth.api.createOrganization({ body: { name: `RN Club ${label} ${suffix}`, slug: `rn-${label}-${suffix}`, userId: created.id } }))!.id;
    clubs.push(clubId);
    if (board) {
      const m = await db.query.member.findFirst({ where: (t, { and: a, eq: e }) => a(e(t.organizationId, clubId), e(t.userId, created.id)) });
      await db.insert(clubRoles).values({ memberId: m!.id, roleType: "vorsitz" });
    }
    return clubId;
  }
  const person = async (clubId: string, data: Partial<typeof clubMembers.$inferInsert>) => (await db.insert(clubMembers).values({ clubId, displayName: "Person", joinedAt: dateAgo(2000), ...data }).returning())[0]!.id;
  const noticeRows = (clubId: string, category: string) => db.select().from(retentionRuns).where(and(eq(retentionRuns.clubId, clubId), eq(retentionRuns.category, category), eq(retentionRuns.notice, true)));
  const ageNotices = (clubId: string, category: string) => db.update(retentionRuns).set({ startedAt: daysAgo(8) }).where(and(eq(retentionRuns.clubId, clubId), eq(retentionRuns.category, category), eq(retentionRuns.notice, true)));
  const seedNotice = (clubId: string, category: string, days = 8) => db.insert(retentionRuns).values({ clubId, category, dryRun: true, notice: true, scanned: 1, affected: 1, startedAt: daysAgo(days), finishedAt: daysAgo(days) });

  afterAll(async () => {
    for (const id of clubs) await db.delete(organization).where(eq(organization.id, id));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("legal hold (M4)", () => {
    let clubId: string;
    beforeAll(async () => {
      clubId = await makeClub("hold", true);
    }, 30_000);

    it("keeps the absences, emergency contact and consent proofs of a held member, while others are cleaned", async () => {
      const left = { status: "ausgetreten", leftAt: dateAgo(1200), emergencyContactName: "Mama", emergencyContactPhone: "01" };
      const held = await person(clubId, left);
      const free = await person(clubId, left);
      await db.update(clubMembers).set({ legalHoldAt: new Date(), legalHoldReason: "Streit" }).where(eq(clubMembers.id, held));
      const absence = (id: string) => db.insert(absenceReports).values({ clubId, clubMemberId: id, kind: "krank", startsOn: dateAgo(210), endsOn: dateAgo(200) }).returning();
      const [heldAbsence] = await absence(held);
      const [freeAbsence] = await absence(free);
      await db.insert(consentPurposes).values({ clubId, key: "hold_test", name: "H", active: true });
      const [purpose] = await db.select().from(consentPurposes).where(and(eq(consentPurposes.clubId, clubId), eq(consentPurposes.key, "hold_test")));
      const [text] = await db.insert(consentTexts).values({ purposeId: purpose!.id, version: 1, body: "T", sha256: "0".repeat(64), publishedAt: new Date() }).returning();
      for (const id of [held, free]) await db.insert(consentRecords).values({ clubId, clubMemberId: id, purposeId: purpose!.id, textVersionId: text!.id, action: "granted", givenBy: "self", createdAt: daysAgo(1500) });
      // The cohort is announced (8 days ago) and the former-member category is announced too, so the erasure of the free person runs.
      for (const category of ["absence_reports", "emergency_contacts_left", "consent_proofs"]) await seedNotice(clubId, category);

      const result = await runRetentionRules(new Date(), { clubId, dryRun: false });
      expect(result.failed).toEqual([]);
      expect(await db.select().from(absenceReports).where(eq(absenceReports.id, heldAbsence!.id))).toHaveLength(1);
      expect(await db.select().from(absenceReports).where(eq(absenceReports.id, freeAbsence!.id))).toHaveLength(0);
      const [heldRow] = await db.select().from(clubMembers).where(eq(clubMembers.id, held));
      const [freeRow] = await db.select().from(clubMembers).where(eq(clubMembers.id, free));
      expect(heldRow).toMatchObject({ emergencyContactName: "Mama" });
      expect(freeRow).toMatchObject({ emergencyContactName: null });
      expect(await db.select().from(consentRecords).where(eq(consentRecords.clubMemberId, held))).toHaveLength(1);
      expect(await db.select().from(consentRecords).where(eq(consentRecords.clubMemberId, free))).toHaveLength(0);
    });
  });

  describe("notices (M7)", () => {
    it("writes no notice when nobody could be told, and deletes nothing", async () => {
      const clubId = await makeClub("silent", false);
      const m = await person(clubId, { status: "aktiv" });
      const [absence] = await db.insert(absenceReports).values({ clubId, clubMemberId: m, kind: "krank", startsOn: dateAgo(210), endsOn: dateAgo(200) }).returning();
      await runRetentionRules(new Date(), { clubId, dryRun: false });
      expect(await noticeRows(clubId, "absence_reports")).toHaveLength(0);
      expect(await db.select().from(absenceReports).where(eq(absenceReports.id, absence!.id))).toHaveLength(1);
      // Once somebody can be told, the notice is written.
      const owner = await db.query.member.findFirst({ where: (t, { eq: e }) => e(t.organizationId, clubId) });
      await db.insert(clubRoles).values({ memberId: owner!.id, roleType: "vorsitz" });
      await runRetentionRules(new Date(), { clubId, dryRun: false });
      expect(await noticeRows(clubId, "absence_reports")).toHaveLength(1);
    }, 30_000);

    it("covers only the cohort of its notice: data that became due later needs a fresh notice", async () => {
      const clubId = await makeClub("cohort", true);
      const m = await person(clubId, { status: "aktiv" });
      const absence = async (endsDaysAgo: number) => (await db.insert(absenceReports).values({ clubId, clubMemberId: m, kind: "krank", startsOn: dateAgo(endsDaysAgo + 5), endsOn: dateAgo(endsDaysAgo) }).returning())[0]!.id;
      const early = await absence(200);
      const late = await absence(105); // due now (90 days) and a week from now, but was not yet due 30 days ago
      await seedNotice(clubId, "absence_reports", 30);
      const exists = async (id: string) => (await db.select().from(absenceReports).where(eq(absenceReports.id, id))).length === 1;

      await runRetentionRules(new Date(), { clubId, dryRun: false });
      expect(await exists(early)).toBe(false);
      expect(await exists(late)).toBe(true);
      expect(await noticeRows(clubId, "absence_reports")).toHaveLength(2); // the old one and a fresh one for the late cohort

      await runRetentionRules(new Date(), { clubId, dryRun: false }); // waiting: nothing new, nothing deleted
      expect(await exists(late)).toBe(true);
      expect(await noticeRows(clubId, "absence_reports")).toHaveLength(2);

      await ageNotices(clubId, "absence_reports");
      await runRetentionRules(new Date(), { clubId, dryRun: false });
      expect(await exists(late)).toBe(false);
    }, 30_000);
  });
});
