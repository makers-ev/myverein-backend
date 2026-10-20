import { randomUUID } from "node:crypto";

import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMemberInvites } from "../db/schema/club-member-invites.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { jobs } from "../db/schema/jobs.js";
import { addDays } from "./club-time.js";
import { handleReminder, REMINDER_JOB_TYPE, reminderDedupeKey, runReminderSweep, type ReminderPayload } from "./reminders.js";

/** G6: reminders for member invitations that are about to expire / expired, and for expiring credentials (qualifications). */

const sfx = randomUUID().slice(0, 8);
const clubId = `ddl-${sfx}`;
const userIds: string[] = [];
const accountOf: Record<string, string> = {};
const clubMemberOf: Record<string, string> = {};
const userOf: Record<string, string> = {};
// 10:00 in Berlin (CEST): after the digest hour, so date based reminders are due.
const NOW = new Date("2026-10-20T08:00:00Z");
const TODAY = "2026-10-20";
let n = 0;

async function mk(label: string, role?: string) {
  const userId = `ddl-${label}-${sfx}`;
  await db.insert(user).values({ id: userId, name: label, email: `${userId}@example.test`, emailVerified: true });
  userIds.push(userId);
  accountOf[label] = `ddl-m-${label}-${sfx}`;
  userOf[label] = userId;
  await db.insert(member).values({ id: accountOf[label], organizationId: clubId, userId, role: "member", createdAt: new Date() });
  const [row] = await db.insert(clubMembers).values({ clubId, memberId: accountOf[label], displayName: label, firstName: label, joinedAt: "2020-01-01" }).returning();
  clubMemberOf[label] = row!.id;
  if (role) await db.insert(clubRoles).values({ memberId: accountOf[label], roleType: role });
}
const sweep = (now = NOW) => runReminderSweep(now, { clubId });
const jobsOf = async (kind: string, ref?: string) =>
  (await db.select().from(jobs).where(and(eq(jobs.type, REMINDER_JOB_TYPE), sql`${jobs.payload}->>'clubId' = ${clubId}`))).filter((j) => j.payload.kind === kind && (!ref || j.payload.refId === ref));
const deliver = (job: { id: string; payload: unknown }) => handleReminder({ id: job.id, type: REMINDER_JOB_TYPE, payload: job.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 });
const inApp = async (refId: string) => (await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${refId}%`), eq(messageDeliveries.channel, "in_app")))).map((d) => d.userId).sort();
const setSettings = (values: Partial<typeof clubSettings.$inferInsert>) => db.insert(clubSettings).values({ clubId, ...values }).onConflictDoUpdate({ target: clubSettings.clubId, set: values });
const at = (date: string, time = "12:00:00Z") => new Date(`${date}T${time}`);

async function accountlessMember(extra: Partial<typeof clubMembers.$inferInsert> = {}) {
  const [row] = await db.insert(clubMembers).values({ clubId, displayName: `Gast ${++n}`, joinedAt: "2020-01-01", ...extra }).returning();
  return row!;
}
async function invite(memberRow: { id: string }, expiresAt: Date, extra: Partial<typeof clubMemberInvites.$inferInsert> = {}) {
  const [row] = await db.insert(clubMemberInvites).values({ clubMemberId: memberRow.id, email: `gast${++n}-${sfx}@example.test`, tokenHash: randomUUID(), expiresAt, ...extra }).returning();
  return row!;
}
async function credential(holder: string, value: unknown, def: Partial<typeof memberFieldDefinitions.$inferInsert> = {}) {
  const [d] = await db.insert(memberFieldDefinitions).values({ clubId, key: `cred_${++n}`, label: `Übungsleiter ${n}`, fieldType: "credential", visibleTo: "mitglied", editableBy: "self", ...def }).returning();
  const [v] = await db.insert(memberFieldValues).values({ clubMemberId: clubMemberOf[holder]!, fieldId: d!.id, value }).returning();
  return { def: d!, value: v! };
}

beforeAll(async () => {
  await db.insert(organization).values({ id: clubId, name: "TV Fristen", slug: clubId, createdAt: new Date() });
  await mk("vorstand", "vorsitz");
  await mk("holder");
  await mk("parent");
  await mk("plain");
  await db.insert(guardianLinks).values({ guardianMemberId: accountOf.parent!, wardClubMemberId: clubMemberOf.holder! });
}, 30_000);

afterAll(async () => {
  await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`);
  await db.delete(organization).where(eq(organization.id, clubId));
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await closeDatabase();
});

describe("expiring member invitations", () => {
  it("reminds the reviewers once when an open invitation is about to expire, exactly once however often it sweeps", async () => {
    const guest = await accountlessMember();
    const inv = await invite(guest, at(addDays(TODAY, 2)));
    expect((await sweep(new Date("2026-10-20T05:00:00Z"))).scheduled).toBe(0); // 07:00 local, before the digest hour
    expect((await sweep()).scheduled).toBeGreaterThanOrEqual(1);
    expect((await sweep())).toMatchObject({ scheduled: 0 });
    const [job] = await jobsOf("invite_expiring", inv.id);
    expect(job!.dedupeKey).toBe(reminderDedupeKey("invite_expiring", inv.id, addDays(TODAY, 2)));
    const payload = job!.payload as ReminderPayload;
    expect(payload.title).toBe(`Einladung läuft ab: ${guest.displayName}`);
    expect(payload.body).not.toContain("@");
    expect(payload.audience.includeGuardians).toBe(false);

    await deliver(job!);
    await deliver(job!); // a re-run is the same delivery
    expect(await inApp(inv.id)).toEqual([userOf.vorstand]);
    const mail = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${inv.id}%`), eq(messageDeliveries.channel, "email")));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.content).toMatchObject({ class: "optional", category: "reminders", template: "reminder" });
  });

  it("stays quiet outside the lead time, for accepted invitations, left members and when switched off; notices an expired one once", async () => {
    const far = await invite(await accountlessMember(), at(addDays(TODAY, 10)));
    const accepted = await invite(await accountlessMember(), at(addDays(TODAY, 1)), { acceptedAt: new Date() });
    const left = await invite(await accountlessMember({ status: "ausgetreten", leftAt: "2026-01-01" }), at(addDays(TODAY, 1)));
    // The member got an account by other means (application, merge) while the invitation is still open.
    const linked = await invite({ id: clubMemberOf.plain! }, at(addDays(TODAY, 1)));
    const justExpired = await invite(await accountlessMember(), at(addDays(TODAY, -2)));
    const longGone = await invite(await accountlessMember(), at(addDays(TODAY, -30)));
    await sweep();
    for (const inv of [far, accepted, left, linked, longGone]) expect(await jobsOf("invite_expiring", inv.id)).toHaveLength(0);
    for (const inv of [far, accepted, left, linked, longGone]) expect(await jobsOf("invite_expired", inv.id)).toHaveLength(0);
    expect(await jobsOf("invite_expired", justExpired.id)).toHaveLength(1);
    expect(((await jobsOf("invite_expired", justExpired.id))[0]!.payload as ReminderPayload).title).toContain("Einladung abgelaufen");

    await setSettings({ reminderInvitationEnabled: false });
    const off = await invite(await accountlessMember(), at(addDays(TODAY, 1)));
    await sweep();
    expect(await jobsOf("invite_expiring", off.id)).toHaveLength(0);
    await setSettings({ reminderInvitationEnabled: true, reminderInvitationLeadDays: 12 });
    await sweep();
    expect(await jobsOf("invite_expiring", far.id)).toHaveLength(1); // 10 days out, lead 12
    await setSettings({ reminderInvitationLeadDays: 3 });
  });

  it("a re-sent invitation (new row, new expiry) is reminded on its own", async () => {
    const guest = await accountlessMember();
    const first = await invite(guest, at(addDays(TODAY, 1)));
    await sweep();
    await db.delete(clubMemberInvites).where(eq(clubMemberInvites.id, first.id));
    const second = await invite(guest, at(addDays(TODAY, 3)));
    await sweep();
    expect(await jobsOf("invite_expiring", second.id)).toHaveLength(1);
  });
});

describe("expiring credentials", () => {
  it("reminds the holder once inside the lead time, and the guardians where they may read the field", async () => {
    const soon = await credential("holder", { valid: true, level: "B", validUntil: addDays(TODAY, 12) });
    await sweep();
    await sweep();
    const [job] = await jobsOf("credential_expiring", soon.value.id);
    expect(await jobsOf("credential_expiring", soon.value.id)).toHaveLength(1);
    expect(job!.dedupeKey).toBe(reminderDedupeKey("credential_expiring", soon.value.id, addDays(TODAY, 12)));
    const payload = job!.payload as ReminderPayload;
    expect(payload.title).toBe(`Qualifikation läuft ab: ${soon.def.label}`);
    expect(payload.audience).toEqual({ memberIds: [clubMemberOf.holder], includeGuardians: true });
    await deliver(job!);
    expect(await inApp(soon.value.id)).toEqual([userOf.holder, userOf.parent].sort());

    // board-internal field: the holder is told, the guardians are not
    const internal = await credential("holder", { valid: true, validUntil: addDays(TODAY, 5) }, { visibleTo: "vorstand", editableBy: "vorstand" });
    await sweep();
    const [internalJob] = await jobsOf("credential_expiring", internal.value.id);
    expect((internalJob!.payload as ReminderPayload).audience.includeGuardians).toBe(false);
    await deliver(internalJob!);
    expect(await inApp(internal.value.id)).toEqual([userOf.holder]);
  });

  it("notices an expired credential once; renewing it starts a new cycle", async () => {
    const lapsed = await credential("plain", { valid: true, validUntil: addDays(TODAY, -3) });
    await sweep();
    expect(await jobsOf("credential_expired", lapsed.value.id)).toHaveLength(1);
    expect(await jobsOf("credential_expiring", lapsed.value.id)).toHaveLength(0);
    const renewed = addDays(TODAY, 20);
    await db.update(memberFieldValues).set({ value: { valid: true, validUntil: renewed } }).where(eq(memberFieldValues.id, lapsed.value.id));
    await sweep();
    expect((await jobsOf("credential_expiring", lapsed.value.id)).map((j) => j.dedupeKey)).toEqual([reminderDedupeKey("credential_expiring", lapsed.value.id, renewed)]);
  });

  it("ignores far-away and long-expired dates, credentials without a date, sensitive and archived fields, left members and a disabled switch", async () => {
    const far = await credential("plain", { valid: true, validUntil: addDays(TODAY, 200) });
    const longGone = await credential("plain", { valid: true, validUntil: addDays(TODAY, -40) });
    const noDate = await credential("plain", { valid: true });
    const sensitive = await credential("plain", { valid: true, validUntil: addDays(TODAY, 4) }, { sensitive: true });
    const archived = await credential("plain", { valid: true, validUntil: addDays(TODAY, 4) }, { archivedAt: new Date() });
    await mk("leaver");
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2026-01-01" }).where(eq(clubMembers.id, clubMemberOf.leaver!));
    const gone = await credential("leaver", { valid: true, validUntil: addDays(TODAY, 4) });
    await setSettings({ reminderCredentialEnabled: false });
    const off = await credential("plain", { valid: true, validUntil: addDays(TODAY, 4) });
    await sweep();
    for (const c of [far, longGone, noDate, sensitive, archived, gone, off]) {
      expect(await jobsOf("credential_expiring", c.value.id)).toHaveLength(0);
      expect(await jobsOf("credential_expired", c.value.id)).toHaveLength(0);
    }
    await setSettings({ reminderCredentialEnabled: true, reminderCredentialLeadDays: 240 });
    await sweep();
    expect(await jobsOf("credential_expiring", far.value.id)).toHaveLength(1);
    expect(await jobsOf("credential_expiring", off.value.id)).toHaveLength(1);
    await setSettings({ reminderCredentialLeadDays: 30 });
  });
});
