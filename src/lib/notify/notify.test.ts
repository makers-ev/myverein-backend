import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { member, organization, user } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { clubMemberDepartments, clubMembers } from "../../db/schema/club-members.js";
import { clubSettings } from "../../db/schema/club-settings.js";
import { clubAnnouncements, messageDeliveries, notificationPreferences } from "../../db/schema/communication.js";
import { departments } from "../../db/schema/departments.js";
import { jobs } from "../../db/schema/jobs.js";
import { AudienceLimitError } from "../audience.js";
import { JobRegistry, defaultRegistry } from "../jobs/registry.js";
import { JobWorker } from "../jobs/worker.js";
import { registerAllJobs } from "../jobs/handlers.js";
import { EMAIL_JOB_TYPE, handleEmailDelivery, notify, notifySafely, registerNotifyJobs, renderNotifyEmail, resetMailThrottle, setMailSender, setUnsubscribeUrlProvider, textToHtml, waitForMailSlot, type MailSender } from "./index.js";

const sfx = randomUUID().slice(0, 8);
const clubId = `ntf-${sfx}`;
const platformUsers: string[] = [];
type Sent = Parameters<MailSender>[0];
let sent: Sent[] = [];
let failures: Array<unknown> = [];

const double: MailSender = async (mail) => {
  const failure = failures.shift();
  if (failure) throw failure;
  sent.push(mail);
};

const ctx = (deliveryId: string, attempt = 1, maxAttempts = 3) => ({ id: randomUUID(), type: EMAIL_JOB_TYPE, payload: { deliveryId }, attempt, maxAttempts });
const deliveries = (where: { announcementId?: string; eventKey?: string }) =>
  db.select().from(messageDeliveries).where(where.announcementId ? eq(messageDeliveries.announcementId, where.announcementId) : eq(messageDeliveries.eventKey, where.eventKey!));
const emailRows = async (eventKey: string) => (await deliveries({ eventKey })).filter((d) => d.channel === "email");

const ids: Record<string, string> = {};
const userOf: Record<string, string> = {};

async function mkAccountMember(label: string, extra: { contactEmail?: string } = {}) {
  const userId = `ntf-${label}-${sfx}`;
  await db.insert(user).values({ id: userId, name: label, email: `${userId}@example.test`, emailVerified: true });
  platformUsers.push(userId);
  await db.insert(member).values({ id: `ntf-m-${label}-${sfx}`, organizationId: clubId, userId, role: "member", createdAt: new Date() });
  const [row] = await db
    .insert(clubMembers)
    .values({ clubId, memberId: `ntf-m-${label}-${sfx}`, displayName: label, firstName: label, joinedAt: "2020-01-01", ...extra })
    .returning();
  ids[label] = row!.id;
  userOf[label] = userId;
}

beforeAll(async () => {
  process.env.MAIL_SEND_RATE = "0";
  await db.insert(organization).values({ id: clubId, name: "TV Beispiel", slug: clubId, createdAt: new Date() });
  await db.insert(clubSettings).values({ clubId, senderName: "Vorstand TV Beispiel", signature: "Viele Grüße\nDer Vorstand", replyTo: "Vorstand@Example.test" });
  const [dept] = await db.insert(departments).values({ clubId, name: "Jugend" }).returning();
  ids.dept = dept!.id;
  await mkAccountMember("anna");
  await mkAccountMember("ben");
  await mkAccountMember("cora");
  const [kid, noMail, shared] = await db
    .insert(clubMembers)
    .values([
      { clubId, displayName: "Kind", joinedAt: "2020-01-01", contactEmail: "kind@example.test" },
      { clubId, displayName: "Ohne Mail", joinedAt: "2020-01-01" },
      { clubId, displayName: "Geschwister", joinedAt: "2020-01-01", contactEmail: `${userOf.anna}@example.test` },
    ])
    .returning();
  ids.kid = kid!.id;
  ids.noMail = noMail!.id;
  ids.shared = shared!.id;
  await db.insert(clubMemberDepartments).values([ids.anna, ids.ben, ids.kid, ids.noMail, ids.shared].map((clubMemberId) => ({ clubMemberId: clubMemberId!, departmentId: ids.dept! })));
});

beforeEach(() => {
  sent = [];
  failures = [];
  resetMailThrottle();
  setMailSender(double);
  setUnsubscribeUrlProvider(null);
});

afterEach(() => {
  setMailSender(null);
  setUnsubscribeUrlProvider(null);
});

afterAll(async () => {
  const rows = await db.select({ id: messageDeliveries.id }).from(messageDeliveries).where(eq(messageDeliveries.clubId, clubId));
  if (rows.length) {
    for (const r of rows) await db.delete(jobs).where(eq(jobs.dedupeKey, `${EMAIL_JOB_TYPE}:${r.id}`));
  }
  await db.delete(organization).where(eq(organization.id, clubId));
  await db.delete(user).where(inArray(user.id, platformUsers));
});

const base = { clubId, class: "optional" as const, channels: ["in_app", "email"] as Array<"in_app" | "email">, content: { title: "Training fällt aus", body: "Heute kein Training.\nMehr: https://example.test/x." } };

describe("notify: deliveries", () => {
  it("creates one row per recipient and channel and one email job per queued mail", async () => {
    const eventKey = `t-rows-${sfx}`;
    const res = await notify({ ...base, eventKey, audience: { departmentIds: [ids.dept!], includeGuardians: false } });
    expect(res).toMatchObject({ recipients: 5, inApp: 2, queuedEmail: 3, skippedNoAddress: 1 });
    const rows = await deliveries({ eventKey });
    expect(rows.filter((r) => r.channel === "in_app" && r.status === "sent").map((r) => r.userId).sort()).toEqual([userOf.anna, userOf.ben].sort());
    expect(rows.every((r) => r.clubId === clubId)).toBe(true);
    const queued = rows.filter((r) => r.channel === "email" && r.status === "queued");
    expect(queued.map((r) => r.address).sort()).toEqual([`${userOf.anna}@example.test`, `${userOf.ben}@example.test`, "kind@example.test"].sort());
    // account-less member without address: recorded, account-less in-app: no row; shared address: covered, no row
    expect(rows.find((r) => r.clubMemberId === ids.noMail)).toMatchObject({ channel: "email", status: "skipped_no_address", address: null });
    expect(rows.some((r) => r.clubMemberId === ids.shared)).toBe(false);
    expect(rows.some((r) => r.clubMemberId === ids.kid && r.channel === "in_app")).toBe(false);
    const queuedJobs = await db.select().from(jobs).where(inArray(jobs.dedupeKey, queued.map((r) => `${EMAIL_JOB_TYPE}:${r.id}`)));
    expect(queuedJobs).toHaveLength(3);
    expect(JSON.stringify(queuedJobs.map((j) => j.payload))).not.toContain("example.test");
  });

  it("is idempotent for an announcement (no duplicate rows or jobs)", async () => {
    const [ann] = await db
      .insert(clubAnnouncements)
      .values({ clubId, title: "A", body: "B", audience: { memberIds: [ids.anna!, ids.kid!] }, channels: ["in_app", "email"] })
      .returning();
    const input = { ...base, eventKey: `t-ann-${sfx}`, announcementId: ann!.id, audience: { memberIds: [ids.anna!, ids.kid!], includeGuardians: false } };
    const first = await notify(input);
    const second = await notify(input);
    expect(first).toMatchObject({ inApp: 1, queuedEmail: 2, alreadyDelivered: 0 });
    expect(second).toMatchObject({ inApp: 0, queuedEmail: 0, alreadyDelivered: 3 });
    expect(await deliveries({ announcementId: ann!.id })).toHaveLength(3);
  });

  it("supports explicit recipients without a club_members row and collapses repeated addresses", async () => {
    const eventKey = `t-explicit-${sfx}`;
    const res = await notify({
      clubId: null,
      class: "mandatory",
      eventKey,
      refId: "reg-1",
      recipients: [{ name: "Antragsteller", email: "Antrag@Example.test" }, { name: "Doppelt", email: "antrag@example.test" }, { userId: userOf.cora, name: "Cora", email: `${userOf.cora}@example.test` }],
      content: { title: "Dein Antrag", body: "Angenommen." },
      channels: ["in_app", "email"],
    });
    expect(res).toMatchObject({ recipients: 3, inApp: 1, queuedEmail: 2 });
    const rows = await deliveries({ eventKey });
    expect(rows.every((r) => r.clubId === null && r.refId === "reg-1")).toBe(true);
    expect(rows.filter((r) => r.channel === "email").map((r) => r.address).sort()).toEqual(["antrag@example.test", `${userOf.cora}@example.test`]);
    await db.delete(messageDeliveries).where(eq(messageDeliveries.eventKey, eventKey));
  });

  it("rejects ambiguous input", async () => {
    await expect(notify({ ...base, eventKey: "x" })).rejects.toThrow(/exactly one/);
    await expect(notify({ ...base, eventKey: "x", audience: { all: true }, recipients: [] })).rejects.toThrow(/exactly one/);
    await expect(notify({ ...base, clubId: null, eventKey: "x", audience: { all: true } })).rejects.toThrow(/clubId/);
  });

  it("notifySafely swallows failures (status changes are never blocked) and logs no addresses", async () => {
    const res = await notifySafely({ ...base, eventKey: `t-limit-${sfx}`, audience: { all: true }, limit: 1 });
    expect(res).toBeNull();
    await expect(notify({ ...base, eventKey: `t-limit2-${sfx}`, audience: { all: true }, limit: 1 })).rejects.toBeInstanceOf(AudienceLimitError);
    expect(await emailRows(`t-limit-${sfx}`)).toHaveLength(0);
  });
});

describe("notify: preferences", () => {
  afterEach(async () => {
    await db.delete(notificationPreferences).where(inArray(notificationPreferences.userId, [userOf.anna!, userOf.ben!]));
    await db.delete(notificationPreferences).where(eq(notificationPreferences.clubMemberId, ids.kid!));
  });

  it("skips opted-out recipients per channel for optional messages (account and account-less)", async () => {
    await db.insert(notificationPreferences).values([
      { userId: userOf.anna!, category: "announcements", channel: "email", enabled: false },
      { clubMemberId: ids.kid!, category: "announcements", channel: "email", enabled: false },
      { userId: userOf.ben!, category: "reminders", channel: "email", enabled: false }, // other category: irrelevant
    ]);
    const eventKey = `t-optout-${sfx}`;
    const res = await notify({ ...base, eventKey, audience: { memberIds: [ids.anna!, ids.ben!, ids.kid!], includeGuardians: false } });
    expect(res).toMatchObject({ skippedOptout: 2, queuedEmail: 1, inApp: 2 });
    const rows = await emailRows(eventKey);
    expect(rows.filter((r) => r.status === "skipped_optout").map((r) => [r.clubMemberId, r.address])).toEqual(expect.arrayContaining([[ids.anna, null], [ids.kid, null]]));
    expect(rows.filter((r) => r.status === "queued").map((r) => r.userId)).toEqual([userOf.ben]);
  });

  it("never suppresses mandatory messages", async () => {
    await db.insert(notificationPreferences).values([
      { userId: userOf.anna!, category: "announcements", channel: "email", enabled: false },
      { userId: userOf.anna!, category: "decisions", channel: "email", enabled: false },
    ]);
    const eventKey = `t-mandatory-${sfx}`;
    const res = await notify({ ...base, class: "mandatory", eventKey, audience: { memberIds: [ids.anna!], includeGuardians: false } });
    expect(res).toMatchObject({ queuedEmail: 1, skippedOptout: 0 });
  });

  it("uses the reminders category for the reminder template", async () => {
    await db.insert(notificationPreferences).values({ userId: userOf.ben!, category: "reminders", channel: "email", enabled: false });
    const res = await notify({ ...base, eventKey: `t-rem-${sfx}`, content: { ...base.content, template: "reminder" }, audience: { memberIds: [ids.ben!], includeGuardians: false } });
    expect(res).toMatchObject({ skippedOptout: 1, queuedEmail: 0 });
  });
});

describe("email delivery job", () => {
  async function queuedFor(eventKey: string, extra: Partial<Parameters<typeof notify>[0]> = {}) {
    await notify({ ...base, eventKey, audience: { memberIds: [ids.anna!], includeGuardians: false }, ...extra });
    return (await emailRows(eventKey))[0]!;
  }

  it("sends exactly one mail with a single recipient, club sender name, reply-to and signature", async () => {
    const row = await queuedFor(`t-send-${sfx}`);
    await handleEmailDelivery(ctx(row.id));
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe(`${userOf.anna}@example.test`);
    expect(mail.to).not.toMatch(/[,;]/);
    expect(mail).not.toHaveProperty("cc");
    expect(mail).not.toHaveProperty("bcc");
    expect(mail.subject).toBe("Training fällt aus");
    expect(mail.fromName).toBe("Vorstand TV Beispiel");
    expect(mail.replyTo).toBe("vorstand@example.test");
    expect(mail.html).toContain("Hallo anna,");
    expect(mail.html).toContain("Viele Grüße<br />Der Vorstand");
    expect(mail.html).toContain('<a href="https://example.test/x"');
    expect(mail.headers).toBeUndefined(); // stub provider: no List-Unsubscribe yet
    const [after] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, row.id));
    expect(after).toMatchObject({ status: "sent", attempts: 1, errorCode: null });
    expect(after?.sentAt).toBeInstanceOf(Date);
    // a second run of the same job (double execution) must not send again
    await handleEmailDelivery(ctx(row.id, 2));
    expect(sent).toHaveLength(1);
  });

  it("adds List-Unsubscribe (one-click) and a visible link for optional mail only", async () => {
    const seen: unknown[] = [];
    setUnsubscribeUrlProvider((s) => {
      seen.push(s);
      return `https://app.example.test/abmelden/tok-${s.category}`;
    });
    const optional = await queuedFor(`t-unsub-${sfx}`);
    await handleEmailDelivery(ctx(optional.id));
    expect(sent[0]?.headers).toEqual({ "List-Unsubscribe": "<https://app.example.test/abmelden/tok-announcements>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(sent[0]?.html).toContain("Benachrichtigungen abbestellen");
    expect(seen[0]).toMatchObject({ clubId, userId: userOf.anna, clubMemberId: ids.anna, category: "announcements" });

    const mandatory = await queuedFor(`t-unsub-m-${sfx}`, { class: "mandatory" });
    await handleEmailDelivery(ctx(mandatory.id));
    expect(sent[1]?.headers).toBeUndefined();
    expect(sent[1]?.html).not.toContain("abbestellen");

    setUnsubscribeUrlProvider(() => {
      throw new Error("boom");
    });
    const broken = await queuedFor(`t-unsub-b-${sfx}`);
    await handleEmailDelivery(ctx(broken.id));
    expect(sent).toHaveLength(3); // a failing provider never blocks the mail
  });

  it("retries a failing send, then marks it failed without leaking the address", async () => {
    const row = await queuedFor(`t-retry-${sfx}`);
    const smtpError = Object.assign(new Error(`550 mailbox ${row.address} unavailable`), { code: "EENVELOPE" });
    failures = [smtpError, smtpError, smtpError];

    await expect(handleEmailDelivery(ctx(row.id, 1))).rejects.toThrow("mail delivery failed (EENVELOPE)");
    let [d] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, row.id));
    expect(d).toMatchObject({ status: "queued", attempts: 1, errorCode: "EENVELOPE" });
    await expect(handleEmailDelivery(ctx(row.id, 2))).rejects.toThrow(/EENVELOPE/);
    await expect(handleEmailDelivery(ctx(row.id, 3))).resolves.toBeUndefined(); // last attempt: failed, job ends normally
    [d] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, row.id));
    expect(d).toMatchObject({ status: "failed", attempts: 3, errorCode: "EENVELOPE" });
    expect(sent).toHaveLength(0);
    // a failed row is not sent again by a stray job
    await handleEmailDelivery(ctx(row.id, 4));
    expect(sent).toHaveLength(0);
  });

  it("succeeds on a later attempt", async () => {
    const row = await queuedFor(`t-retry-ok-${sfx}`);
    failures = [new Error("temporary")];
    await expect(handleEmailDelivery(ctx(row.id, 1))).rejects.toThrow();
    await handleEmailDelivery(ctx(row.id, 2));
    const [d] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, row.id));
    expect(d).toMatchObject({ status: "sent", attempts: 2, errorCode: null });
    expect(sent).toHaveLength(1);
  });

  it("runs through the real worker: one mail per recipient, mail failure does not touch other deliveries", async () => {
    const eventKey = `t-worker-${sfx}`;
    // earlier tests of this file leave queued rows/jobs behind; only this event's mails may go out through the worker
    await db.update(messageDeliveries).set({ status: "failed" }).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.status, "queued")));
    await notify({ ...base, eventKey, audience: { memberIds: [ids.anna!, ids.ben!, ids.kid!], includeGuardians: false } });
    const rows = await emailRows(eventKey);
    const registry = new JobRegistry();
    registerNotifyJobs(registry);
    const worker = new JobWorker({ registry, pollIntervalMs: 50, concurrency: 3, leaseMs: 60_000, backoffBaseMs: 50, drainMs: 2000 });
    worker.start();
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const current = await emailRows(eventKey);
        if (current.every((r) => r.status === "sent")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await worker.stop();
    }
    expect((await emailRows(eventKey)).map((r) => r.status)).toEqual(rows.map(() => "sent"));
    expect(sent.map((m) => m.to).sort()).toEqual(rows.map((r) => r.address!).sort());
    expect(new Set(sent.map((m) => m.to)).size).toBe(3);
  });

  it("registerAllJobs installs the handler on the default registry", () => {
    registerAllJobs();
    expect(defaultRegistry.types()).toContain(EMAIL_JOB_TYPE);
  });
});

describe("mail throttle", () => {
  afterEach(() => {
    process.env.MAIL_SEND_RATE = "0";
    resetMailThrottle();
  });

  it("spaces sends by 1/MAIL_SEND_RATE seconds, also for concurrent callers", async () => {
    process.env.MAIL_SEND_RATE = "20"; // 50 ms
    resetMailThrottle();
    const start = Date.now();
    const stamps: number[] = [];
    await Promise.all(Array.from({ length: 5 }, () => waitForMailSlot().then(() => stamps.push(Date.now() - start))));
    expect(Math.max(...stamps)).toBeGreaterThanOrEqual(180);
    expect(Math.max(...stamps)).toBeLessThan(1000);
  });

  it("does not wait when unthrottled", async () => {
    process.env.MAIL_SEND_RATE = "0";
    const start = Date.now();
    for (let i = 0; i < 20; i++) await waitForMailSlot();
    expect(Date.now() - start).toBeLessThan(100);
  });
});

describe("templates", () => {
  const input = { template: "announcement" as const, title: "Titel", body: "Text", recipientName: "Anna", clubName: "TV Beispiel", ctaLabel: null, ctaUrl: null, signature: null, unsubscribeUrl: null };

  it("renders the four variants", () => {
    const urgent = renderNotifyEmail({ ...input, template: "urgent" });
    expect(urgent.subject).toBe("[Dringend] Titel");
    expect(urgent.html).toContain("DRINGEND");
    expect(renderNotifyEmail({ ...input, template: "reminder" }).html).toContain("Eine Erinnerung von <strong>TV Beispiel</strong>");
    expect(renderNotifyEmail({ ...input, template: "decision" }).html).toContain("Eine Entscheidung von");
    const announcement = renderNotifyEmail(input);
    expect(announcement.subject).toBe("Titel");
    expect(announcement.html).toContain("Hallo Anna,");
    expect(announcement.html).toContain("cid:app-logo");
    expect(announcement.html).not.toContain("DRINGEND");
  });

  it("escapes user content, strips line breaks from the subject and only links http(s)", () => {
    const { subject, html } = renderNotifyEmail({ ...input, title: "A\r\nBcc: x@y.de <b>", body: '<script>alert(1)</script> javascript:alert(1) https://a.test/?q=1&r="2"', recipientName: "<i>Eve</i>", signature: "<u>sig</u>", ctaUrl: "javascript:alert(1)" });
    expect(subject).toBe("A Bcc: x@y.de <b>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<u>sig");
    expect(html).toContain("&lt;i&gt;Eve&lt;/i&gt;");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://a.test/?q=1&amp;r=&quot;2&quot;"');
  });

  it("linkifies without swallowing trailing punctuation", () => {
    expect(textToHtml("Siehe https://a.test/x.")).toContain('href="https://a.test/x"');
    expect(textToHtml("Siehe https://a.test/x.")).toMatch(/<\/a>\.$/);
  });
});
