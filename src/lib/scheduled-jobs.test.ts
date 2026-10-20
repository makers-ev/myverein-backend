import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers, clubMemberStatusHistory, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { forms, formSubmissions, formVersions } from "../db/schema/forms.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { jobs } from "../db/schema/jobs.js";
import { locationKeyHolders, locations } from "../db/schema/locations.js";
import { runAgeTransitionSweep, AGE_TRANSITION_REASON } from "./age-transition.js";
import { EXIT_EFFECTIVE_NOTIFY_JOB_TYPE, exitEffectiveDedupeKey, handleExitEffectiveNotify, runExitEffectiveSweep } from "./exit-effective.js";
import { ensureClubFormDefaults } from "./form-defaults.js";
import { runFormCleanup } from "./form-sweeper.js";
import { defaultRegistry } from "./jobs/registry.js";
import { registerAllJobs } from "./jobs/handlers.js";
import { deleteFinishedJobs } from "./jobs/queue.js";
import { clearRetentionTasks, deliveryRetentionDays, jobsRetentionDays, scrubOldInboxDeliveries, registerRetentionTask, retentionTasks, runRetention, scrubOldEmailDeliveries, registerRetentionTasks } from "./retention.js";
import { handleReminder, REMINDER_JOB_TYPE, type ReminderPayload } from "./reminders.js";

/** Wave 9 B13: timed jobs on the queue (age transition, exit effective, form cleanup, delivery retention, retention hook). */

const suffix = Date.now();

describe("registration", () => {
  it("registers every B13 job type, the recurring ones with their interval", () => {
    registerAllJobs();
    const types = defaultRegistry.types();
    for (const t of ["age_transition_sweep", "exit_effective_sweep", "exit_effective_notify", "age_transition_member_notify", "form_cleanup_sweep", "retention_sweep", "reminder-sweep", "notify_reminder"]) expect(types).toContain(t);
    const recurring = Object.fromEntries(defaultRegistry.recurringSpecs().map((s) => [s.type, s.intervalMs]));
    expect(recurring).toMatchObject({ age_transition_sweep: 3_600_000, exit_effective_sweep: 3_600_000, form_cleanup_sweep: 3_600_000, retention_sweep: 86_400_000, "reminder-sweep": 900_000 });
  });
});

describe("retention hook point", () => {
  it("runs registered tasks in isolation: a failing task does not stop the others and is reported without details", async () => {
    clearRetentionTasks();
    const ran: string[] = [];
    registerRetentionTask({ key: "a", description: "first", run: async () => (ran.push("a"), { affected: 2 }) });
    registerRetentionTask({ key: "boom", description: "fails", run: async () => { throw new Error("secret@example.com"); } });
    registerRetentionTask({ key: "c", description: "last", run: async () => (ran.push("c"), { affected: 0 }) });
    expect(() => registerRetentionTask({ key: "a", description: "dup", run: async () => ({ affected: 0 }) })).toThrow(/already registered/);
    const { results } = await runRetention(new Date());
    expect(ran).toEqual(["a", "c"]);
    expect(results).toEqual([{ key: "a", affected: 2 }, { key: "boom", affected: 0, error: "Error" }, { key: "c", affected: 0 }]);
    expect(JSON.stringify(results)).not.toContain("secret");
    clearRetentionTasks();
    registerRetentionTasks();
    expect(retentionTasks().map((t) => t.key)).toEqual(["inbox-retention", "jobs-retention", "delivery-retention", "rate-limit-events"]);
  });

  it("reads DELIVERY_RETENTION_DAYS with a default of 90", () => {
    const prev = process.env.DELIVERY_RETENTION_DAYS;
    try {
      delete process.env.DELIVERY_RETENTION_DAYS;
      expect(deliveryRetentionDays()).toBe(90);
      process.env.DELIVERY_RETENTION_DAYS = "7";
      expect(deliveryRetentionDays()).toBe(7);
      process.env.DELIVERY_RETENTION_DAYS = "0";
      expect(deliveryRetentionDays()).toBe(90);
      process.env.DELIVERY_RETENTION_DAYS = "abc";
      expect(deliveryRetentionDays()).toBe(90);
    } finally {
      if (prev === undefined) delete process.env.DELIVERY_RETENTION_DAYS;
      else process.env.DELIVERY_RETENTION_DAYS = prev;
    }
  });
});

describe("timed jobs", () => {
  let clubId: string;
  let ownerUserId: string;
  const userIds: string[] = [];
  const account: Record<string, string> = {};
  const clubMemberOf: Record<string, string> = {};
  const DAY = 86_400_000;

  const setSettings = async (values: Partial<typeof clubSettings.$inferInsert>) => {
    await db.insert(clubSettings).values({ clubId, ...values }).onConflictDoUpdate({ target: clubSettings.clubId, set: values });
  };
  const jobsOf = async (type: string) => (await db.select().from(jobs).where(and(eq(jobs.type, type), sql`${jobs.payload}->>'clubId' = ${clubId}`))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const run = async (job: { id: string; type: string; payload: unknown }, fn: (j: never) => Promise<void>) => fn({ id: job.id, type: job.type, payload: job.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 } as never);
  const inAppTo = async (refId: string, eventKey?: string) =>
    (await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${refId}%`), eq(messageDeliveries.channel, "in_app"), eventKey ? eq(messageDeliveries.eventKey, eventKey) : undefined))).map((d) => d.clubMemberId).sort();

  beforeAll(async () => {
    const make = async (label: string) => {
      const email = `sch-${label}-${suffix}@example.com`;
      const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: label } });
      userIds.push(created.id);
      return created.id;
    };
    ownerUserId = await make("owner");
    const club = await auth.api.createOrganization({ body: { name: `Sch Club ${suffix}`, slug: `sch-club-${suffix}`, userId: ownerUserId } });
    clubId = club!.id;
    const ids: Record<string, string> = {};
    for (const label of ["keeper", "a"]) {
      ids[label] = await make(label);
      await auth.api.addMember({ body: { userId: ids[label]!, organizationId: clubId, role: "member" } });
    }
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    for (const label of ["keeper", "a"]) {
      const acc = accounts.find((x) => x.userId === ids[label])!;
      account[label] = acc.id;
      const [row] = await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, acc.id));
      clubMemberOf[label] = row!.id;
    }
    await db.insert(clubRoles).values({ memberId: account.keeper!, roleType: "schriftfuehrer" });
  }, 60_000);

  afterAll(async () => {
    await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`);
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("age_transition_sweep", () => {
    let jugend: string;
    let aktiv: string;
    const kids: Record<string, string> = {};

    const addKid = async (name: string, birthDate: string, extra: Partial<typeof clubMembers.$inferInsert> = {}) => {
      const [row] = await db.insert(clubMembers).values({ clubId, displayName: name, birthDate, joinedAt: "2020-01-01", categoryId: jugend, ...extra }).returning();
      kids[name] = row!.id;
      return row!.id;
    };
    const categoryOf = async (id: string) => (await db.select({ c: clubMembers.categoryId }).from(clubMembers).where(eq(clubMembers.id, id)))[0]!.c;

    beforeAll(async () => {
      const [j] = await db.insert(memberCategories).values({ clubId, key: "nachwuchs", name: "Nachwuchs", maxAge: 17, autoTransitionToKey: "vollmitglied" }).returning();
      const [a] = await db.insert(memberCategories).values({ clubId, key: "vollmitglied", name: "Vollmitglied" }).returning();
      jugend = j!.id;
      aktiv = a!.id;
      await addKid("Anna", "2005-01-01"); // 21: over
      await addKid("Ben", "2005-06-01"); // over
      await addKid("Cleo", "2015-01-01"); // 11: not yet
      await addKid("Dora", "2004-01-01", { status: "ausgetreten", leftAt: "2025-01-01" }); // left: never
      await addKid("Emil", "2008-03-30"); // turns 18 on 2026-03-30
    });

    it("does nothing while the switch is off (suggestions only)", async () => {
      await setSettings({ ageTransitionAuto: false });
      expect(await runAgeTransitionSweep(new Date("2026-10-18T10:00:00Z"), { clubId })).toEqual({ clubs: 0, moved: 0 });
      expect(await categoryOf(kids.Anna!)).toBe(jugend);
    });

    it("on the club's calendar day (midnight in the club zone, not UTC) -- Emil turns 18 on the DST switch weekend", async () => {
      await setSettings({ ageTransitionAuto: true });
      // 2026-03-29T21:30Z = 23:30 CEST on 29 March: Emil is still 17 -- only the older kids move.
      const day1 = await runAgeTransitionSweep(new Date("2026-03-29T21:30:00Z"), { clubId });
      expect(day1.moved).toBe(2);
      expect(await categoryOf(kids.Emil!)).toBe(jugend);
      // 2026-03-29T22:30Z = 00:30 CEST on 30 March: birthday in the club zone, though UTC still says 29 March.
      const day2 = await runAgeTransitionSweep(new Date("2026-03-29T22:30:00Z"), { clubId });
      expect(day2.moved).toBe(1);
      expect(await categoryOf(kids.Emil!)).toBe(aktiv);
      expect(await categoryOf(kids.Cleo!)).toBe(jugend);
      expect(await categoryOf(kids.Dora!)).toBe(jugend);
    });

    it("writes history with the actor system, an audit entry and one name-free summary to the leadership", async () => {
      const [h] = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, kids.Anna!));
      expect(h).toMatchObject({ fromCategoryId: jugend, toCategoryId: aktiv, changedBy: null, reason: AGE_TRANSITION_REASON, effectiveOn: "2026-03-29", fromStatus: "aktiv", toStatus: "aktiv" });
      const audit = (await db.select().from(auditLog).where(and(eq(auditLog.subjectId, clubId), eq(auditLog.eventType, "club_member.age_transition")))).map((a) => a.payload as Record<string, unknown>);
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({ changedBy: "system", automatic: true, count: 2 });

      const summaries = await jobsOf(REMINDER_JOB_TYPE);
      const age = summaries.filter((j) => j.payload.kind === "age_transition");
      expect(age).toHaveLength(2);
      const first = age[0]!.payload as ReminderPayload;
      expect(first.title).toBe("Altersübergang: 2 Mitglieder verschoben");
      expect(first.body).toContain("2 Mitglieder: Nachwuchs → Vollmitglied");
      expect(JSON.stringify(age.map((j) => j.payload))).not.toMatch(/Anna|Ben|Emil/);
      await run(age[0]!, handleReminder as never);
      expect(await inAppTo(clubId, "reminder.age_transition")).toEqual([clubMemberOf.keeper]);
    });

    it("is idempotent: running again (also in parallel) changes and announces nothing more", async () => {
      const before = (await jobsOf(REMINDER_JOB_TYPE)).length;
      const runs = await Promise.all([1, 2, 3].map(() => runAgeTransitionSweep(new Date("2026-03-30T08:00:00Z"), { clubId })));
      expect(runs.reduce((n, r) => n + r.moved, 0)).toBe(0);
      expect((await jobsOf(REMINDER_JOB_TYPE)).length).toBe(before);
      expect(await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, kids.Anna!))).toHaveLength(1);
    });

    it("does not move into an archived target category", async () => {
      await db.update(memberCategories).set({ archivedAt: new Date() }).where(eq(memberCategories.id, aktiv));
      const late = await addKid("Fritz", "2000-01-01");
      expect((await runAgeTransitionSweep(new Date("2026-04-01T08:00:00Z"), { clubId })).moved).toBe(0);
      expect(await categoryOf(late)).toBe(jugend);
    });
  });

  describe("exit_effective_sweep", () => {
    const sweep = (now: string) => runExitEffectiveSweep(new Date(now), { clubId });

    it("announces a pending exit once on the effective day, from the digest hour, with the open returns", async () => {
      const [item] = await db.insert(inventoryItems).values({ clubId, name: "Pavillon", condition: "gut" }).returning();
      await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: account.a! });
      const [returned] = await db.insert(inventoryItems).values({ clubId, name: "Bank", condition: "gut" }).returning();
      await db.insert(inventoryLoans).values({ itemId: returned!.id, memberId: account.a!, returnedAt: new Date(), status: "zurueckgegeben" });
      const [hall] = await db.insert(locations).values({ clubId, name: "Halle Nord" }).returning();
      await db.insert(locationKeyHolders).values({ locationId: hall!.id, memberId: account.a!, keyLabel: "Schlüssel 3" });
      await db.update(clubMembers).set({ leftAt: "2026-10-31" }).where(eq(clubMembers.id, clubMemberOf.a!)); // stored status stays aktiv

      expect((await sweep("2026-10-30T10:00:00Z")).scheduled).toBe(0); // day before
      expect((await sweep("2026-10-31T06:59:00Z")).scheduled).toBe(0); // 07:59 CET: before the digest hour
      expect((await sweep("2026-10-31T07:00:00Z")).scheduled).toBe(1);
      expect(await sweep("2026-10-31T12:00:00Z")).toEqual({ scheduled: 0, alreadyScheduled: 1 });
      expect((await sweep("2026-11-01T12:00:00Z")).scheduled).toBe(0); // catch-up window: same key
      const [job] = await jobsOf(EXIT_EFFECTIVE_NOTIFY_JOB_TYPE);
      expect(job!.dedupeKey).toBe(exitEffectiveDedupeKey(clubMemberOf.a!, "2026-10-31"));
      expect(JSON.stringify(job!.payload)).not.toContain("sch-a");

      await run(job!, handleExitEffectiveNotify as never);
      expect(await inAppTo(clubMemberOf.a!, "member.exit_effective")).toEqual([clubMemberOf.keeper]);
      const [delivery] = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${clubMemberOf.a!}%`), eq(messageDeliveries.channel, "in_app")));
      const content = delivery!.content as { title: string; body: string; category: string };
      expect(content.category).toBe("board"); // leadership digest: its own switchable category (G10)
      expect(content.title).toContain("Rückgabe offen");
      expect(content.body).toContain("• Ausleihe: Pavillon");
      expect(content.body).toContain("• Schlüssel: Halle Nord (Schlüssel 3)");
      expect(content.body).not.toContain("Bank");
    });

    it("catches up missed days after downtime but not older exits, and ignores exits that were booked directly", async () => {
      const [late] = await db.insert(clubMembers).values({ clubId, displayName: "Spät", joinedAt: "2020-01-01", leftAt: "2026-11-10" }).returning();
      const [old] = await db.insert(clubMembers).values({ clubId, displayName: "Alt", joinedAt: "2020-01-01", leftAt: "2026-10-01" }).returning();
      const [direct] = await db.insert(clubMembers).values({ clubId, displayName: "Direkt", joinedAt: "2020-01-01", status: "ausgetreten", leftAt: "2026-11-12" }).returning();
      const result = await sweep("2026-11-12T10:00:00Z"); // two days after the effective day
      expect(result.scheduled).toBe(1);
      const keys = (await jobsOf(EXIT_EFFECTIVE_NOTIFY_JOB_TYPE)).map((j) => j.dedupeKey);
      expect(keys).toContain(exitEffectiveDedupeKey(late!.id, "2026-11-10"));
      expect(keys).not.toContain(exitEffectiveDedupeKey(old!.id, "2026-10-01"));
      expect(keys).not.toContain(exitEffectiveDedupeKey(direct!.id, "2026-11-12"));
    });

    it("uses the club's calendar day around the DST switch (exit on 2026-03-29)", async () => {
      const [m] = await db.insert(clubMembers).values({ clubId, displayName: "Frühling", joinedAt: "2020-01-01", leftAt: "2026-03-29" }).returning();
      expect((await sweep("2026-03-29T05:59:00Z")).scheduled).toBe(0); // 07:59 CEST... digest hour not yet reached
      expect((await sweep("2026-03-29T06:00:00Z")).scheduled).toBe(1);
      expect((await jobsOf(EXIT_EFFECTIVE_NOTIFY_JOB_TYPE)).map((j) => j.dedupeKey)).toContain(exitEffectiveDedupeKey(m!.id, "2026-03-29"));
    });

    it("sends nothing when the exit was revoked or moved before the job ran", async () => {
      const [m] = await db.insert(clubMembers).values({ clubId, displayName: "Zurückgenommen", joinedAt: "2020-01-01", leftAt: "2026-12-01" }).returning();
      await sweep("2026-12-01T10:00:00Z");
      const job = (await jobsOf(EXIT_EFFECTIVE_NOTIFY_JOB_TYPE)).find((j) => j.dedupeKey === exitEffectiveDedupeKey(m!.id, "2026-12-01"))!;
      await db.update(clubMembers).set({ leftAt: null }).where(eq(clubMembers.id, m!.id));
      await run(job, handleExitEffectiveNotify as never);
      expect(await inAppTo(m!.id)).toEqual([]);
    });
  });

  describe("form_cleanup_sweep", () => {
    it("removes drafts idle beyond the TTL and keeps fresh and submitted ones", async () => {
      await ensureClubFormDefaults(clubId);
      const [form] = await db.select().from(forms).where(eq(forms.clubId, clubId));
      const [version] = await db.select().from(formVersions).where(eq(formVersions.formId, form!.id));
      const insert = (status: string, updatedAt: Date) => db.insert(formSubmissions).values({ formId: form!.id, formVersionId: version!.id, clubId, submittedByUserId: ownerUserId, status, updatedAt }).returning();
      const [stale] = await insert("draft", new Date(Date.now() - 31 * DAY));
      const [fresh] = await insert("draft", new Date(Date.now() - 1 * DAY));
      const [submitted] = await insert("submitted", new Date(Date.now() - 60 * DAY));
      const result = await runFormCleanup();
      expect(result.drafts).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(formSubmissions).where(eq(formSubmissions.id, stale!.id))).toEqual([]);
      expect(await db.select().from(formSubmissions).where(eq(formSubmissions.id, fresh!.id))).toHaveLength(1);
      expect(await db.select().from(formSubmissions).where(eq(formSubmissions.id, submitted!.id))).toHaveLength(1);
      expect((await runFormCleanup()).drafts).toBe(0);
    });
  });

  describe("delivery retention", () => {
    it("wipes addresses and content snapshots of old finished mails, keeps the proof, the inbox and queued mails", async () => {
      const old = new Date(Date.now() - 100 * DAY);
      const young = new Date(Date.now() - 10 * DAY);
      const content = { title: "Hallo", body: "Geheimer Text", template: "announcement", category: "announcements", class: "optional", urgent: false, recipientName: "Anna", ctaLabel: null, ctaUrl: "https://x.example/secret", rendered: { subject: "s", html: "<p>Geheim</p>" } };
      const base = { clubId, eventKey: "t.retention", refId: "retention-test", content };
      const [oldSent, oldFailed, oldQueued, oldInApp, youngSent] = await db
        .insert(messageDeliveries)
        .values([
          { ...base, channel: "email", status: "sent", address: "anna@example.com", createdAt: old },
          { ...base, channel: "email", status: "failed", address: "ben@example.com", createdAt: old },
          { ...base, channel: "email", status: "queued", address: "cleo@example.com", createdAt: old },
          { ...base, channel: "in_app", status: "sent", createdAt: old },
          { ...base, channel: "email", status: "sent", address: "dora@example.com", createdAt: young },
        ])
        .returning();
      const get = async (id: string) => (await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, id)))[0]!;

      expect(await scrubOldEmailDeliveries(new Date(), 90)).toBeGreaterThanOrEqual(2);
      const sent = await get(oldSent!.id);
      expect(sent.address).toBeNull();
      expect(sent.status).toBe("sent");
      expect(sent.content).toEqual({ title: "Hallo", template: "announcement", category: "announcements", class: "optional", scrubbed: true });
      expect((await get(oldFailed!.id)).address).toBeNull();
      expect((await get(oldQueued!.id)).address).toBe("cleo@example.com");
      expect((await get(oldInApp!.id)).content).toEqual(content);
      expect((await get(youngSent!.id)).address).toBe("dora@example.com");

      // Idempotent, and a shorter retention catches the younger row too.
      expect(await scrubOldEmailDeliveries(new Date(), 90)).toBe(0);
      expect(await scrubOldEmailDeliveries(new Date(), 5)).toBeGreaterThanOrEqual(1);
      expect((await get(youngSent!.id)).address).toBeNull();
      await db.delete(messageDeliveries).where(eq(messageDeliveries.refId, "retention-test"));
    });

    it("scrubs read in-app and settled push rows, keeps unread inbox rows and queued pushes", async () => {
      const old = new Date(Date.now() - 100 * DAY);
      const content = { title: "Hallo", body: "Geheimer Text", template: "announcement", category: "announcements", class: "optional", urgent: false, recipientName: null, ctaLabel: null, ctaUrl: null };
      const base = { clubId, eventKey: "t.inbox-retention", refId: "inbox-retention-test", content, createdAt: old };
      const [read, unread, push, queuedPush] = await db
        .insert(messageDeliveries)
        .values([
          { ...base, channel: "in_app", status: "sent", readAt: new Date() },
          { ...base, channel: "in_app", status: "sent" },
          { ...base, channel: "push", status: "sent" },
          { ...base, channel: "push", status: "queued" },
        ])
        .returning();
      const get = async (id: string) => (await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, id)))[0]!;
      expect(await scrubOldInboxDeliveries(new Date(), 90)).toBeGreaterThanOrEqual(2);
      expect((await get(read!.id)).content).toEqual({ title: "Hallo", template: "announcement", category: "announcements", class: "optional", scrubbed: true });
      expect((await get(push!.id)).content).toMatchObject({ scrubbed: true });
      expect((await get(unread!.id)).content).toEqual(content);
      expect((await get(queuedPush!.id)).content).toEqual(content);
      await db.delete(messageDeliveries).where(eq(messageDeliveries.refId, "inbox-retention-test"));
    });
  });

  describe("jobs retention", () => {
    it("deletes done jobs older than the retention (default 14 days) and keeps young, dead and queued ones", async () => {
      delete process.env.JOBS_RETENTION_DAYS;
      expect(jobsRetentionDays()).toBe(14);
      process.env.JOBS_RETENTION_DAYS = "30";
      expect(jobsRetentionDays()).toBe(30);
      process.env.JOBS_RETENTION_DAYS = "0";
      expect(jobsRetentionDays()).toBe(14);
      delete process.env.JOBS_RETENTION_DAYS;

      const tag = `jobs-retention-${Date.now()}`;
      const longAgo = new Date(Date.now() - 20 * DAY);
      const rows = await db
        .insert(jobs)
        .values([
          { type: tag, status: "done", finishedAt: longAgo, dedupeKey: `${tag}:old` },
          { type: tag, status: "done", finishedAt: new Date(Date.now() - 2 * DAY), dedupeKey: `${tag}:young` },
          { type: tag, status: "dead", finishedAt: longAgo, dedupeKey: `${tag}:dead` },
          { type: tag, status: "queued", dedupeKey: `${tag}:queued` },
        ])
        .returning();
      expect(await deleteFinishedJobs(14 * DAY)).toBeGreaterThanOrEqual(1);
      const left = (await db.select().from(jobs).where(eq(jobs.type, tag))).map((j) => j.dedupeKey).sort();
      expect(left).toEqual([`${tag}:dead`, `${tag}:queued`, `${tag}:young`]);
      expect(rows).toHaveLength(4);
      await db.delete(jobs).where(eq(jobs.type, tag));
    });
  });
});
