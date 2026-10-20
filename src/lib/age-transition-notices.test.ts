import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries, notificationPreferences } from "../db/schema/communication.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { jobs } from "../db/schema/jobs.js";
import { AGE_TRANSITION_MEMBER_JOB_TYPE, ageTransitionMemberDedupeKey, enqueueMemberCategoryNotices, handleAgeTransitionMemberNotify, runAgeTransitionSweep } from "./age-transition.js";
import { handleReminder, REMINDER_JOB_TYPE, type ReminderPayload } from "./reminders.js";
import { setMailSender } from "./notify/index.js";

/** G10: members (and guardians) are told about their automatic category change; the board digests have their own category. */

const suffix = Date.now();
const NOW = new Date("2026-10-18T10:00:00Z");
const DAY = "2026-10-18";
let clubId: string;
const userIds: string[] = [];
let youth: string;
let adult: string;
let anna: string; // account-less child with a contact address, one guardian
let board: string; // club_members id of the board member (schriftfuehrer)
let guardianUser: string;
let guardianAccount: string;
let boardUser: string;
let boardAccount: string;

const ctx = (job: { id: string; type: string; payload: unknown }) => ({ id: job.id, type: job.type, payload: job.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 });
const noticeJobs = async () => (await db.select().from(jobs).where(and(eq(jobs.type, AGE_TRANSITION_MEMBER_JOB_TYPE), sql`${jobs.payload}->>'clubId' = ${clubId}`))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
const deliveriesOf = (eventKey: string) => db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, eventKey)));

async function mkUser(label: string) {
  const { user: created } = await auth.api.createUser({ body: { email: `agn-${label}-${suffix}@example.test`, password: "test-password-123!", name: label } });
  userIds.push(created.id);
  return created.id;
}

beforeAll(async () => {
  setMailSender(async () => undefined);
  const owner = await mkUser("owner");
  clubId = (await auth.api.createOrganization({ body: { name: `Agn Club ${suffix}`, slug: `agn-${suffix}`, userId: owner } }))!.id;
  guardianUser = await mkUser("guardian");
  boardUser = await mkUser("board");
  await auth.api.addMember({ body: { userId: guardianUser, organizationId: clubId, role: "member" } });
  await auth.api.addMember({ body: { userId: boardUser, organizationId: clubId, role: "member" } });
  const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
  guardianAccount = accounts.find((a) => a.userId === guardianUser)!.id;
  boardAccount = accounts.find((a) => a.userId === boardUser)!.id;
  board = (await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, boardAccount)))[0]!.id;
  await db.insert(clubRoles).values({ memberId: boardAccount, roleType: "schriftfuehrer" });
  await db.insert(clubSettings).values({ clubId, ageTransitionAuto: true }).onConflictDoUpdate({ target: clubSettings.clubId, set: { ageTransitionAuto: true } });
  // New clubs start with default categories; make "jugend" move to "erwachsene" at 18.
  const cats = await db.select().from(memberCategories).where(eq(memberCategories.clubId, clubId));
  youth = cats.find((c) => c.key === "jugend")!.id;
  adult = cats.find((c) => c.key === "aktiv")!.id;
  await db.update(memberCategories).set({ name: "Jugend", maxAge: 17, autoTransitionToKey: "aktiv" }).where(eq(memberCategories.id, youth));
  await db.update(memberCategories).set({ name: "Erwachsene", archivedAt: null }).where(eq(memberCategories.id, adult));
  const [row] = await db.insert(clubMembers).values({ clubId, displayName: "Anna Jung", birthDate: "2005-01-01", joinedAt: "2020-01-01", categoryId: youth, contactEmail: "anna@example.test" }).returning();
  anna = row!.id;
  await db.insert(guardianLinks).values({ guardianMemberId: guardianAccount, wardClubMemberId: anna });
}, 60_000);

afterAll(async () => {
  setMailSender(null);
  await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`);
  await db.delete(organization).where(eq(organization.id, clubId));
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await closeDatabase();
});

describe("member notices of the age transition", () => {
  it("the sweep enqueues one id-only notice job per move, keyed by member, day and target", async () => {
    expect((await runAgeTransitionSweep(NOW, { clubId })).moved).toBe(1);
    const found = await noticeJobs();
    expect(found).toHaveLength(1);
    expect(found[0]!.dedupeKey).toBe(ageTransitionMemberDedupeKey(anna, DAY, adult));
    expect(found[0]!.payload).toEqual({ clubId, clubMemberId: anna, fromCategoryId: youth, toCategoryId: adult, date: DAY });
    expect(JSON.stringify(found[0]!.payload)).not.toContain("Anna");
    // a second sweep moves nobody and queues nothing more
    expect((await runAgeTransitionSweep(NOW, { clubId })).moved).toBe(0);
    expect(await noticeJobs()).toHaveLength(1);
  });

  it("tells the member (contact address) and the guardian (in-app + mail), optional, once", async () => {
    const [job] = await noticeJobs();
    await handleAgeTransitionMemberNotify(ctx(job!));
    await handleAgeTransitionMemberNotify(ctx(job!)); // a re-run is the same delivery
    const rows = await deliveriesOf("member.category_changed");
    expect(rows.every((r) => r.refId === `${anna}#${DAY}:${adult}`)).toBe(true);
    const inApp = rows.filter((r) => r.channel === "in_app");
    expect(inApp.map((r) => r.userId)).toEqual([guardianUser]);
    expect(rows.filter((r) => r.channel === "email").map((r) => r.address).sort()).toEqual(["anna@example.test", `${"agn-guardian"}-${suffix}@example.test`].sort());
    const content = inApp[0]!.content as { title: string; body: string; class: string; category: string };
    expect(content).toMatchObject({ class: "optional", category: "announcements", title: "Neue Mitgliedskategorie: Erwachsene" });
    expect(content.body).toContain("Anna Jung");
    expect(content.body).toContain("„Jugend“ zu „Erwachsene“");
  });

  it("respects the mail opt-out of the guardian (announcements) and keeps the in-app copy", async () => {
    await db.delete(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, "member.category_changed")));
    await db.insert(notificationPreferences).values({ userId: guardianUser, category: "announcements", channel: "email", enabled: false });
    const [job] = await noticeJobs();
    await handleAgeTransitionMemberNotify(ctx(job!));
    const rows = await deliveriesOf("member.category_changed");
    expect(rows.find((r) => r.channel === "email" && r.userId === guardianUser)?.status).toBe("skipped_optout");
    expect(rows.filter((r) => r.channel === "in_app")).toHaveLength(1);
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, guardianUser));
  });

  it("sends nothing when the club switched the notice off or the member was moved again", async () => {
    await db.delete(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, "member.category_changed")));
    const [job] = await noticeJobs();
    await db.update(clubSettings).set({ notifyAgeTransition: false }).where(eq(clubSettings.clubId, clubId));
    await handleAgeTransitionMemberNotify(ctx(job!));
    expect(await deliveriesOf("member.category_changed")).toHaveLength(0);
    // nothing is even queued while it is off
    expect(await db.transaction((tx) => enqueueMemberCategoryNotices(tx, clubId, [{ id: anna, fromId: youth, toId: adult }], "2026-10-19"))).toBe(0);
    await db.update(clubSettings).set({ notifyAgeTransition: true }).where(eq(clubSettings.clubId, clubId));

    await db.update(clubMembers).set({ categoryId: youth }).where(eq(clubMembers.id, anna));
    await handleAgeTransitionMemberNotify(ctx(job!));
    expect(await deliveriesOf("member.category_changed")).toHaveLength(0);
    await db.update(clubMembers).set({ categoryId: adult }).where(eq(clubMembers.id, anna));
  });

  it("never notifies a member who has left", async () => {
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2026-01-01" }).where(eq(clubMembers.id, anna));
    const [job] = await noticeJobs();
    await handleAgeTransitionMemberNotify(ctx(job!));
    expect(await deliveriesOf("member.category_changed")).toHaveLength(0);
    await db.update(clubMembers).set({ status: "aktiv", leftAt: null }).where(eq(clubMembers.id, anna));
  });
});

describe("board digests have their own category", () => {
  it("the age-transition summary is category board, so switching off reminders does not silence it", async () => {
    const [summary] = (await db.select().from(jobs).where(and(eq(jobs.type, REMINDER_JOB_TYPE), sql`${jobs.payload}->>'clubId' = ${clubId}`))).filter((j) => j.payload.kind === "age_transition");
    await db.insert(notificationPreferences).values([
      { userId: boardUser, category: "reminders", channel: "email", enabled: false },
      { userId: boardUser, category: "reminders", channel: "push", enabled: false },
    ]);
    await handleReminder(ctx(summary!) as never);
    const mail = (await deliveriesOf("reminder.age_transition")).find((r) => r.channel === "email" && r.userId === boardUser)!;
    expect(mail.status).toBe("queued");
    expect(mail.content).toMatchObject({ category: "board", class: "optional" });
    expect(board).toBeTruthy();

    // ... and the board member can switch exactly this category off
    await db.delete(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, "reminder.age_transition")));
    await db.insert(notificationPreferences).values({ userId: boardUser, category: "board", channel: "email", enabled: false });
    await handleReminder(ctx(summary!) as never);
    expect((await deliveriesOf("reminder.age_transition")).find((r) => r.channel === "email" && r.userId === boardUser)?.status).toBe("skipped_optout");
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, boardUser));
    void (summary as { payload: ReminderPayload });
  });
});

describe("cleanup helpers", () => {
  it("keeps deliveries of other clubs out of the way", async () => {
    expect(await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), like(messageDeliveries.eventKey, "nonexistent%")))).toHaveLength(0);
  });
});
