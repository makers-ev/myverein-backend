import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { jobs } from "../db/schema/jobs.js";
import { consentPurposes, consentRecords, consentTexts } from "../db/schema/privacy.js";
import { confirmationOf, memberConsentViews, recordConsent } from "./consent.js";
import { activeWardLinks } from "./guardian-scope.js";
import { handleMajorityNotify, majorityDate, MAJORITY_NOTIFY_JOB_TYPE, runMajoritySweep } from "./majority.js";
import { setMailSender } from "./notify/index.js";

/** Wave 10 B6: notice 28 days ahead, link end and audit on the birthday, consent confirmation, idempotence, read-time guard. */

const suffix = Date.now();
const NOW = new Date("2026-10-18T10:00:00Z");
let clubId: string;
const userIds: string[] = [];
const ids: Record<string, string> = {};
let guardianAccount: string;
let boardAccount: string;
let wardUserId: string;

const ctx = (job: { id: string; type: string; payload: unknown }) => ({ id: job.id, type: job.type, payload: job.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 });
const jobsOf = async () => (await db.select().from(jobs).where(and(eq(jobs.type, MAJORITY_NOTIFY_JOB_TYPE), sql`${jobs.payload}->>'clubId' = ${clubId}`))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
const deliveriesOf = (eventKey: string) => db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, eventKey)));

async function mkUser(label: string) {
  const { user: created } = await auth.api.createUser({ body: { email: `maj-${label}-${suffix}@example.test`, password: "test-password-123!", name: label } });
  userIds.push(created.id);
  return created.id;
}
async function child(name: string, birthDate: string, extra: Partial<typeof clubMembers.$inferInsert> = {}) {
  const [row] = await db.insert(clubMembers).values({ clubId, displayName: name, birthDate, joinedAt: "2020-01-01", contactEmail: `${name.toLowerCase().replace(/\W/g, "")}@example.test`, ...extra }).returning();
  return row!.id;
}
const link = (ward: string, extra: Partial<typeof guardianLinks.$inferInsert> = {}) => db.insert(guardianLinks).values({ guardianMemberId: guardianAccount, wardClubMemberId: ward, confirmedAt: new Date(), validFrom: "2020-01-01", ...extra });

beforeAll(async () => {
  setMailSender(async () => undefined);
  const owner = await mkUser("owner");
  clubId = (await auth.api.createOrganization({ body: { name: `Maj Club ${suffix}`, slug: `maj-${suffix}`, userId: owner } }))!.id;
  const guardianUser = await mkUser("guardian");
  const boardUser = await mkUser("board");
  wardUserId = await mkUser("ward");
  await auth.api.addMember({ body: { userId: guardianUser, organizationId: clubId, role: "member" } });
  await auth.api.addMember({ body: { userId: boardUser, organizationId: clubId, role: "member" } });
  await auth.api.addMember({ body: { userId: wardUserId, organizationId: clubId, role: "member" } });
  const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
  guardianAccount = accounts.find((a) => a.userId === guardianUser)!.id;
  boardAccount = accounts.find((a) => a.userId === boardUser)!.id;
  await db.insert(clubRoles).values({ memberId: boardAccount, roleType: "schriftfuehrer" });

  ids.ahead = await child("Ahead Kind", "2008-11-07"); // 18 on 2026-11-07: 20 days from NOW
  ids.far = await child("Far Kind", "2008-12-30"); // 73 days
  ids.yesterday = await child("Yesterday Kind", "2008-10-17");
  ids.today = await child("Today Kind", "2008-10-18");
  ids.old = await child("Old Kind", "2000-03-03");
  ids.noLinks = await child("NoLinks Kind", "2008-10-10");
  const wardRow = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, accounts.find((a) => a.userId === wardUserId)!.id) });
  ids.account = wardRow!.id;
  await db.update(clubMembers).set({ birthDate: "2008-10-16", displayName: "Account Kind" }).where(eq(clubMembers.id, ids.account));
  for (const k of ["ahead", "far", "yesterday", "today", "account"]) await link(ids[k]!);
  await link(ids.old, { validUntil: "2020-01-01" });
}, 90_000);

afterAll(async () => {
  setMailSender(null);
  await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`);
  await db.delete(organization).where(eq(organization.id, clubId));
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await closeDatabase();
});

describe("majorityDate / confirmationOf", () => {
  it("counts 29 February on 1 March in non-leap years", () => {
    expect(majorityDate("2008-02-29")).toBe("2026-03-01");
    expect(majorityDate("2004-02-29")).toBe("2022-03-01");
    expect(majorityDate("2000-02-29", 24)).toBe("2024-02-29");
    expect(majorityDate("2008-10-18")).toBe("2026-10-18");
  });

  it("asks only for consents somebody else gave while the person was a minor", () => {
    const at = (iso: string) => new Date(`${iso}T10:00:00Z`);
    expect(confirmationOf({ action: "granted", givenBy: "guardian", createdAt: at("2024-05-05") }, "2008-10-17", 18, "2026-10-18")).toEqual({ pending: true, due: "2027-01-15", overdue: false });
    expect(confirmationOf({ action: "granted", givenBy: "guardian", createdAt: at("2024-05-05") }, "2008-10-17", 18, "2027-02-01").overdue).toBe(true);
    expect(confirmationOf({ action: "granted", givenBy: "self", createdAt: at("2024-05-05") }, "2008-10-17", 18, "2026-10-18").pending).toBe(false);
    expect(confirmationOf({ action: "revoked", givenBy: "guardian", createdAt: at("2024-05-05") }, "2008-10-17", 18, "2026-10-18").pending).toBe(false);
    expect(confirmationOf({ action: "granted", givenBy: "guardian", createdAt: at("2024-05-05") }, "2010-01-01", 18, "2026-10-18").pending).toBe(false); // still a minor
    expect(confirmationOf({ action: "granted", givenBy: "board_paper", createdAt: at("2027-01-01") }, "2008-10-17", 18, "2027-02-01").pending).toBe(false); // signed as an adult
    expect(confirmationOf(undefined, "2008-10-17", 18, "2026-10-18").pending).toBe(false);
    expect(confirmationOf({ action: "granted", givenBy: "guardian", createdAt: at("2024-05-05") }, null, 18, "2026-10-18").pending).toBe(false);
  });
});

describe("majority sweep", () => {
  it("announces 28 days ahead once, ends the links on the birthday and writes the audit, ignoring everyone else", async () => {
    const first = await runMajoritySweep(NOW, { clubId });
    expect(first).toEqual({ noticed: 1, transitioned: 3 });

    const found = await jobsOf();
    expect(found.map((j) => `${(j.payload as Record<string, string>).kind}:${(j.payload as Record<string, string>).clubMemberId}`).sort()).toEqual(
      [`notice:${ids.ahead}`, `done:${ids.yesterday}`, `done:${ids.today}`, `done:${ids.account}`].sort(),
    );
    expect(JSON.stringify(found.map((j) => j.payload))).not.toMatch(/Kind|@/); // ids and dates only

    const linkOf = async (ward: string) => (await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, ward)))[0]!;
    expect((await linkOf(ids.yesterday!)).validUntil).toBe("2026-10-16");
    expect((await linkOf(ids.today!)).validUntil).toBe("2026-10-17");
    expect((await linkOf(ids.account!)).validUntil).toBe("2026-10-15");
    expect((await linkOf(ids.ahead!)).validUntil).toBeNull();
    expect((await linkOf(ids.far!)).validUntil).toBeNull();
    expect((await linkOf(ids.old!)).validUntil).toBe("2020-01-01");

    const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubId), eq(auditLog.eventType, "club_member.majority")));
    expect(audits.map((a) => a.subjectMemberId).sort()).toEqual([ids.yesterday, ids.today, ids.account].sort());
    expect(audits.every((a) => a.actorUserId === null)).toBe(true);

    // A second run, and one a day later, change nothing and schedule nothing new.
    expect(await runMajoritySweep(NOW, { clubId })).toEqual({ noticed: 0, transitioned: 0 });
    expect((await runMajoritySweep(new Date("2026-10-19T10:00:00Z"), { clubId })).transitioned).toBe(0);
    expect(await jobsOf()).toHaveLength(4);
  });

  it("catches up a missed notice window and a missed birthday after downtime", async () => {
    const late = await child("Late Kind", "2008-11-20");
    await link(late);
    const result = await runMajoritySweep(new Date("2026-10-30T10:00:00Z"), { clubId }); // 21 days ahead
    expect(result.noticed).toBeGreaterThanOrEqual(1);
    expect((await jobsOf()).some((j) => (j.payload as Record<string, string>).clubMemberId === late && (j.payload as Record<string, string>).kind === "notice")).toBe(true);
    const missed = await runMajoritySweep(new Date("2026-11-25T10:00:00Z"), { clubId });
    expect(missed.transitioned).toBeGreaterThanOrEqual(2);
    expect((await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, late)))[0]!.validUntil).toBe("2026-11-19");
  });

  it("keeps the read-time guard as the authority: an ended or 18 year old ward is out of scope without the job", async () => {
    // `ids.far` is 18 on 2026-12-30: with the clock after that day the link is dead although the job never ran for it.
    const links = await activeWardLinks(await userOf(guardianAccount));
    expect(links.map((l) => l.ward.id)).not.toContain(ids.yesterday);
    expect(links.map((l) => l.ward.id)).not.toContain(ids.today);
  });
});

async function userOf(accountId: string): Promise<string> {
  const row = await db.query.member.findFirst({ where: (m, { eq: same }) => same(m.id, accountId) });
  return row!.userId;
}

describe("notices", () => {
  it("tells guardians and the member ahead of time, and the board when the member has no account", async () => {
    const [notice] = (await jobsOf()).filter((j) => (j.payload as Record<string, string>).kind === "notice" && (j.payload as Record<string, string>).clubMemberId === ids.ahead);
    await handleMajorityNotify(ctx(notice!));
    const ahead = await deliveriesOf("member.majority_ahead");
    expect(ahead.length).toBeGreaterThan(0);
    const board = await deliveriesOf("member.majority_ahead_board");
    expect(board.map((d) => d.userId)).toContain(await userOf(boardAccount));
    expect(JSON.stringify(board.map((d) => d.content))).toContain("Einladung");
    // Re-running the same job writes nothing new (delivery dedupe).
    const count = (await deliveriesOf("member.majority_ahead")).length;
    await handleMajorityNotify(ctx(notice!));
    expect((await deliveriesOf("member.majority_ahead")).length).toBe(count);
  });

  it("does not announce a member whose birth date was corrected or who left", async () => {
    const [done] = (await jobsOf()).filter((j) => (j.payload as Record<string, string>).kind === "done" && (j.payload as Record<string, string>).clubMemberId === ids.today);
    await db.update(clubMembers).set({ birthDate: "2012-01-01" }).where(eq(clubMembers.id, ids.today!));
    await handleMajorityNotify(ctx(done!));
    expect((await deliveriesOf("member.majority_reached")).filter((d) => d.clubMemberId === ids.today)).toHaveLength(0);
  });
});

describe("consent confirmation after the majority", () => {
  it("shows guardian-given consents as pending, confirms by granting again, and never blocks", async () => {
    const [purpose] = await db.insert(consentPurposes).values({ clubId, key: "maj_foto", name: "Foto", active: true, requested: true }).returning();
    const [text] = await db.insert(consentTexts).values({ purposeId: purpose!.id, version: 1, body: "Fotos erlaubt.", sha256: "1".repeat(64), publishedAt: new Date() }).returning();
    await db.insert(consentRecords).values({ clubId, clubMemberId: ids.account!, purposeId: purpose!.id, textVersionId: text!.id, action: "granted", givenBy: "guardian", createdAt: new Date("2025-01-01T10:00:00Z") });

    const before = (await memberConsentViews(clubId, ids.account!)).find((v) => v.key === "maj_foto")!;
    expect(before).toMatchObject({ state: "granted", givenBy: "guardian" });
    expect(before.confirmation.pending).toBe(true);
    expect(before.confirmation.due).toBe("2027-01-14");

    // The notice to the now adult person mentions the open confirmation.
    const [done] = (await jobsOf()).filter((j) => (j.payload as Record<string, string>).kind === "done" && (j.payload as Record<string, string>).clubMemberId === ids.account);
    await handleMajorityNotify(ctx(done!));
    const delivered = (await deliveriesOf("member.majority_reached")).filter((d) => d.clubMemberId === ids.account);
    expect(delivered.length).toBeGreaterThan(0);
    expect(JSON.stringify(delivered.map((d) => d.content))).toContain("freiwillig");

    // Confirming = granting again as the person: a new `self` event although the state was already "granted".
    const result = await db.transaction((tx) => recordConsent(tx, { clubId, clubMemberId: ids.account!, purposeId: purpose!.id, action: "granted", givenBy: "self", recordedByUserId: wardUserId, via: "member" }));
    expect(result.changed).toBe(true);
    const after = (await memberConsentViews(clubId, ids.account!)).find((v) => v.key === "maj_foto")!;
    expect(after).toMatchObject({ state: "granted", givenBy: "self" });
    expect(after.confirmation.pending).toBe(false);
    // A second self grant is a plain repeat.
    expect((await db.transaction((tx) => recordConsent(tx, { clubId, clubMemberId: ids.account!, purposeId: purpose!.id, action: "granted", givenBy: "self", recordedByUserId: wardUserId, via: "member" }))).changed).toBe(false);
  });
});
