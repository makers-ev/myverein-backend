import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { organization, user } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { messageDeliveries, notificationPreferences, pushTokens } from "../../db/schema/communication.js";
import { jobs } from "../../db/schema/jobs.js";
import { handlePushDelivery, handlePushReceipts, notify, setMailSender, setPushFetch, type PushFetch } from "./index.js";
import { PUSH_JOB_TYPE, PUSH_RECEIPTS_JOB_TYPE } from "./types.js";

/** Wave 9 B8: push channel via a fetch test double (no network, no SDK). */

const sfx = randomUUID().slice(0, 8);
const clubId = `psh-${sfx}`;
const USERS = 60;
const userIds = Array.from({ length: USERS }, (_, i) => `psh-u${i}-${sfx}`);
const tokenOf = (i: number, d: number) => `ExponentPushToken[${sfx}u${i}d${d}xxxxxxxx]`;

interface Call { url: string; headers: Record<string, string>; body: any } // eslint-disable-line @typescript-eslint/no-explicit-any
let calls: Call[] = [];
let respond: (call: Call) => unknown = () => ({ data: [] });
const fetchDouble: PushFetch = async (url, init) => {
  const call: Call = { url, headers: init.headers, body: JSON.parse(init.body) };
  calls.push(call);
  const out = respond(call);
  if (out instanceof Error) return { ok: false, status: 429, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => out };
};
const allOk = (call: Call) => ({ data: (call.body as unknown[]).map((_, i) => ({ status: "ok", id: `ticket-${randomUUID()}-${i}` })) });

const ctx = (type: string, payload: Record<string, unknown>, attempt = 1, maxAttempts = 3) => ({ id: randomUUID(), type, payload, attempt, maxAttempts });
const recipients = (n = USERS) => userIds.slice(0, n).map((userId, i) => ({ userId, name: `Person ${i}` }));
const pushRows = (eventKey: string) => db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, eventKey), eq(messageDeliveries.channel, "push")));

beforeAll(async () => {
  await db.insert(organization).values({ id: clubId, name: "TV Push", slug: clubId, createdAt: new Date() });
  await db.insert(user).values(userIds.map((id, i) => ({ id, name: `U${i}`, email: `${id}@example.test`, emailVerified: true })));
  // Every user has two devices.
  await db.insert(pushTokens).values(userIds.flatMap((userId, i) => [0, 1].map((d) => ({ userId, token: tokenOf(i, d), platform: d === 0 ? "ios" : "android" }))));
});

beforeEach(() => {
  calls = [];
  respond = allOk;
  setPushFetch(fetchDouble);
  setMailSender(async () => undefined);
  process.env.PUSH_RECEIPT_DELAY_MINUTES = "0";
  delete process.env.EXPO_ACCESS_TOKEN;
});
afterEach(() => {
  setPushFetch(null);
  setMailSender(null);
});

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, clubId));
  await db.delete(user).where(inArray(user.id, userIds));
  await db.delete(jobs).where(inArray(jobs.type, [PUSH_JOB_TYPE, PUSH_RECEIPTS_JOB_TYPE]));
});


describe("push channel (B8)", () => {
  it("creates push rows only for users with a token, always with in_app, and chunks the Expo requests", async () => {
    const eventKey = `t-chunk-${sfx}`;
    const extra = `psh-nodevice-${sfx}`;
    await db.insert(user).values({ id: extra, name: "N", email: `${extra}@example.test`, emailVerified: true });
    const res = await notify({ clubId, class: "optional", eventKey, refId: "ann-1", recipients: [...recipients(), { userId: extra }], content: { title: "Geheimer Titel Max Mustermann", body: "Text mit Namen" }, channels: ["push"] });
    expect(res).toMatchObject({ recipients: USERS + 1, inApp: USERS + 1, queuedPush: USERS, skippedNoAddress: 1 });

    const rows = await pushRows(eventKey);
    expect(rows).toHaveLength(USERS + 1);
    const queued = rows.filter((r) => r.status === "queued");
    const queuedJobs = await db.select().from(jobs).where(and(eq(jobs.type, PUSH_JOB_TYPE), sql`${jobs.payload}->'deliveryIds' @> ${JSON.stringify([queued[0]!.id])}::jsonb`));
    expect(queuedJobs).toHaveLength(1);
    expect((queuedJobs[0]!.payload as { deliveryIds: string[] }).deliveryIds.sort()).toEqual(queued.map((r) => r.id).sort());

    await handlePushDelivery(ctx(PUSH_JOB_TYPE, queuedJobs[0]!.payload));
    // 60 users x 2 devices = 120 messages -> 100 + 20 (a delivery is never split: 50 deliveries + 10)
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 20]);
    expect(calls.every((c) => c.url.endsWith("/send"))).toBe(true);
    expect((await pushRows(eventKey)).filter((r) => r.status === "sent")).toHaveLength(USERS);
    expect((await pushRows(eventKey)).find((r) => r.userId === extra)).toMatchObject({ status: "skipped_no_address" });

    // Re-running the same job sends nothing again.
    await handlePushDelivery(ctx(PUSH_JOB_TYPE, queuedJobs[0]!.payload));
    expect(calls).toHaveLength(2);

    await db.delete(user).where(eq(user.id, extra));
  });

  it("sends a payload without personal data and with deep-link ids; urgent gets high priority and its own channel", async () => {
    const eventKey = "announcement";
    const refId = `t-pay-${sfx}`;
    await notify({ clubId, class: "optional", eventKey, refId, recipients: recipients(1), content: { title: "Hallo Max Mustermann", body: "Dein Kontostand", urgent: true }, channels: ["in_app", "push"] });
    const rows = (await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.refId, refId), eq(messageDeliveries.channel, "push"))));
    await handlePushDelivery(ctx(PUSH_JOB_TYPE, { deliveryIds: rows.map((r) => r.id) }));
    const messages = calls[0]!.body as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(messages).toHaveLength(2);
    for (const m of messages) {
      expect(m).toMatchObject({ priority: "high", channelId: "urgent", title: "TV Push", body: "Dringende Mitteilung", data: { type: "announcement", urgent: true, clubId } });
    }
    const wire = JSON.stringify(calls[0]!.body);
    for (const secret of ["Max Mustermann", "Kontostand", "Person", "example.test", userIds[0]!]) expect(wire).not.toContain(secret);
  });

  it("uses the event id for event messages and normal priority otherwise", async () => {
    const eventKey = "event.cancelled";
    const refId = randomUUID();
    await notify({ clubId, class: "optional", eventKey, refId, recipients: recipients(1), content: { title: "Abgesagt", body: "x", category: "events" }, channels: ["in_app", "push"] });
    const rows = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.refId, refId), eq(messageDeliveries.channel, "push")));
    await handlePushDelivery(ctx(PUSH_JOB_TYPE, { deliveryIds: rows.map((r) => r.id) }));
    expect((calls[0]!.body as Array<Record<string, unknown>>)[0]).toMatchObject({ priority: "default", channelId: "default", data: { type: "event", eventId: refId, urgent: false } });
  });

  it("never sends urgent messages by push alone: in_app and e-mail are added", async () => {
    const eventKey = `t-urgent-${sfx}`;
    const res = await notify({ clubId, class: "optional", eventKey, recipients: [{ userId: userIds[0]!, email: `${userIds[0]}@example.test` }], content: { title: "Wichtig", body: "x", urgent: true }, channels: ["push"] });
    expect(res).toMatchObject({ inApp: 1, queuedEmail: 1, queuedPush: 1 });
    const rows = await db.select().from(messageDeliveries).where(eq(messageDeliveries.eventKey, eventKey));
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "in_app", "push"]);
  });

  it("respects the push opt-out of the category", async () => {
    const eventKey = `t-optout-${sfx}`;
    await db.insert(notificationPreferences).values({ userId: userIds[1]!, category: "announcements", channel: "push", enabled: false });
    const res = await notify({ clubId, class: "optional", eventKey, recipients: recipients(2), content: { title: "T", body: "B" }, channels: ["in_app", "push"] });
    expect(res).toMatchObject({ queuedPush: 1, skippedOptout: 1 });
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, userIds[1]!));
  });

  it("disables a token on DeviceNotRegistered and schedules the receipts job", async () => {
    const eventKey = `t-dead-${sfx}`;
    await notify({ clubId, class: "optional", eventKey, recipients: recipients(2), content: { title: "T", body: "B" }, channels: ["in_app", "push"] });
    const rows = await pushRows(eventKey);
    // user 0: first device dead, second ok; user 1: both dead -> delivery failed
    respond = (call) => ({
      data: (call.body as Array<{ to: string }>).map((m) =>
        m.to === tokenOf(0, 0) || m.to === tokenOf(1, 0) || m.to === tokenOf(1, 1) ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: `tk-${sfx}-${m.to.length}-ok` },
      ),
    });
    await handlePushDelivery(ctx(PUSH_JOB_TYPE, { deliveryIds: rows.map((r) => r.id) }));
    const after = await pushRows(eventKey);
    expect(after.find((r) => r.userId === userIds[0])).toMatchObject({ status: "sent" });
    expect(after.find((r) => r.userId === userIds[1])).toMatchObject({ status: "failed", errorCode: "DeviceNotRegistered" });
    const disabled = await db.select({ token: pushTokens.token }).from(pushTokens).where(and(inArray(pushTokens.userId, [userIds[0]!, userIds[1]!]), eq(pushTokens.token, tokenOf(0, 0))));
    expect(disabled).toHaveLength(1);
    const [t00] = await db.select().from(pushTokens).where(eq(pushTokens.token, tokenOf(0, 0)));
    const [t01] = await db.select().from(pushTokens).where(eq(pushTokens.token, tokenOf(0, 1)));
    expect(t00!.disabledAt).not.toBeNull();
    expect(t01!.disabledAt).toBeNull();

    // Disabled tokens are not used any more: a new message to user 1 has no device left.
    const again = await notify({ clubId, class: "optional", eventKey: `${eventKey}-2`, recipients: [{ userId: userIds[1]! }], content: { title: "T", body: "B" }, channels: ["in_app", "push"] });
    expect(again).toMatchObject({ queuedPush: 0, skippedNoAddress: 1 });
    await db.update(pushTokens).set({ disabledAt: null }).where(inArray(pushTokens.token, [tokenOf(0, 0), tokenOf(1, 0), tokenOf(1, 1)]));
  });

  it("processes receipts: DeviceNotRegistered disables the token, other errors do not; sends the access token when configured", async () => {
    process.env.EXPO_ACCESS_TOKEN = "test-access";
    const [a] = await db.select().from(pushTokens).where(eq(pushTokens.token, tokenOf(2, 0)));
    const [b] = await db.select().from(pushTokens).where(eq(pushTokens.token, tokenOf(2, 1)));
    respond = () => ({ data: { "t-a": { status: "error", details: { error: "DeviceNotRegistered" } }, "t-b": { status: "error", details: { error: "MessageRateExceeded" } } } });
    await handlePushReceipts(ctx(PUSH_RECEIPTS_JOB_TYPE, { items: [{ t: "t-a", k: a!.id }, { t: "t-b", k: b!.id }] }));
    expect(calls[0]!.url.endsWith("/getReceipts")).toBe(true);
    expect(calls[0]!.body).toEqual({ ids: ["t-a", "t-b"] });
    expect(calls[0]!.headers.authorization).toBe("Bearer test-access");
    expect((await db.select().from(pushTokens).where(eq(pushTokens.id, a!.id)))[0]!.disabledAt).not.toBeNull();
    expect((await db.select().from(pushTokens).where(eq(pushTokens.id, b!.id)))[0]!.disabledAt).toBeNull();
    await db.update(pushTokens).set({ disabledAt: null }).where(eq(pushTokens.id, a!.id));
  });

  it("enqueues a receipts job per sent chunk without personal data", async () => {
    const eventKey = `t-rcpt-${sfx}`;
    await notify({ clubId, class: "optional", eventKey, recipients: recipients(1), content: { title: "T", body: "B" }, channels: ["in_app", "push"] });
    const rows = await pushRows(eventKey);
    respond = (call) => ({ data: (call.body as unknown[]).map((_, i) => ({ status: "ok", id: `rcpt-${sfx}-${i}` })) });
    await handlePushDelivery(ctx(PUSH_JOB_TYPE, { deliveryIds: rows.map((r) => r.id) }));
    const [job] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `${PUSH_RECEIPTS_JOB_TYPE}:rcpt-${sfx}-0`));
    expect(job).toBeTruthy();
    expect(JSON.stringify(job!.payload)).not.toContain("ExponentPushToken");
    expect((job!.payload as { items: unknown[] }).items).toHaveLength(2);
  });

  it("retries on a transport error and fails the deliveries on the last attempt", async () => {
    const eventKey = `t-retry-${sfx}`;
    await notify({ clubId, class: "optional", eventKey, recipients: recipients(1), content: { title: "T", body: "B" }, channels: ["in_app", "push"] });
    const rows = await pushRows(eventKey);
    respond = () => new Error("429");
    await expect(handlePushDelivery(ctx(PUSH_JOB_TYPE, { deliveryIds: rows.map((r) => r.id) }, 1, 3))).rejects.toThrow("push delivery failed");
    expect((await pushRows(eventKey))[0]!.status).toBe("queued");
    await handlePushDelivery(ctx(PUSH_JOB_TYPE, { deliveryIds: rows.map((r) => r.id) }, 3, 3));
    expect((await pushRows(eventKey))[0]).toMatchObject({ status: "failed", errorCode: "push_failed" });
  });
});
