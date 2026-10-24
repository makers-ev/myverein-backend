import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { member, organization, user } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { messageDeliveries, notificationPreferences, pushTokens } from "../../db/schema/communication.js";
import { jobs } from "../../db/schema/jobs.js";
import { notifyApplicationApproved, notifyExitDecision } from "../decision-notify.js";
import { handleEventChanged, notifyWaitlistPromoted } from "../event-notify.js";
import { handleReminder, PUSH_REMINDER_KINDS } from "../reminders.js";
import { genericPushText, handlePushDelivery, notify, pushDataFor, setMailSender, setPushFetch, type PushFetch } from "./index.js";
import { PUSH_JOB_TYPE } from "./types.js";

/** Wave 9 G4: push for event changes, reminders and decisions (never alone, preferences respected, ids only). */

const sfx = randomUUID().slice(0, 8);
const clubId = `pch-${sfx}`;
const userA = `pch-a-${sfx}`;
const userB = `pch-b-${sfx}`;
let cmA = "";
let cmB = "";
let calls: Array<{ body: Array<Record<string, any>> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
const fetchDouble: PushFetch = async (_url, init) => {
  const body = JSON.parse(init.body) as Array<Record<string, unknown>>;
  calls.push({ body });
  return { ok: true, status: 200, json: async () => ({ data: body.map((_, i) => ({ status: "ok", id: `tk-${randomUUID()}-${i}` })) }) };
};
const ctx = (type: string, payload: Record<string, unknown>) => ({ id: randomUUID(), type, payload, attempt: 1, maxAttempts: 3 });
const rowsOf = (eventKey: string) => db.select().from(messageDeliveries).where(eq(messageDeliveries.eventKey, eventKey));
const channelsOf = async (eventKey: string, userId = userA) => (await rowsOf(eventKey)).filter((r) => r.userId === userId).map((r) => r.channel).sort();
/** Runs the push job the dispatcher queued for these delivery rows. */
async function runPush(eventKey: string) {
  const ids = (await rowsOf(eventKey)).filter((r) => r.channel === "push" && r.status === "queued").map((r) => r.id);
  if (ids.length) await handlePushDelivery(ctx(PUSH_JOB_TYPE, { deliveryIds: ids }));
  return ids.length;
}

beforeAll(async () => {
  await db.insert(organization).values({ id: clubId, name: "TV Kanal", slug: clubId, createdAt: new Date() });
  for (const [id, label] of [[userA, "a"], [userB, "b"]] as const) {
    await db.insert(user).values({ id, name: label, email: `${id}@example.test`, emailVerified: true });
    await db.insert(member).values({ id: `m-${id}`, organizationId: clubId, userId: id, role: "member", createdAt: new Date() });
    await db.insert(pushTokens).values({ userId: id, token: `ExponentPushToken[${sfx}${label}xxxxxxxxxx]`, platform: "ios" });
  }
  const rows = await db
    .insert(clubMembers)
    .values([userA, userB].map((id) => ({ clubId, memberId: `m-${id}`, displayName: id, firstName: id, joinedAt: "2020-01-01" })))
    .returning();
  cmA = rows.find((r) => r.memberId === `m-${userA}`)!.id;
  cmB = rows.find((r) => r.memberId === `m-${userB}`)!.id;
});
beforeEach(() => {
  calls = [];
  setPushFetch(fetchDouble);
  setMailSender(async () => undefined);
});
afterEach(() => {
  setPushFetch(null);
  setMailSender(null);
});
afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, clubId));
  await db.delete(user).where(inArray(user.id, [userA, userB]));
  await db.delete(jobs).where(eq(jobs.type, PUSH_JOB_TYPE));
});

describe("push for event changes", () => {
  it("event change goes out as in_app + email + push and the payload carries the event id only", async () => {
    const eventId = randomUUID();
    await handleEventChanged(ctx("notify_event_changed", { clubId, kind: "event", refId: eventId, version: 1, cancelled: true, title: "Abgesagt: Training Max", body: "Geheim", audience: { memberIds: [cmA], includeGuardians: false } }));
    expect(await channelsOf("event.cancelled")).toEqual(["email", "in_app", "push"]);
    expect(await runPush("event.cancelled")).toBe(1);
    expect(calls[0]!.body[0]).toMatchObject({ body: "Termin abgesagt", data: { type: "event", eventId, clubId } });
    const wire = JSON.stringify(calls[0]!.body);
    expect(wire).not.toContain("Max");
    expect(wire).not.toContain("Geheim");
  });

  it("a re-run of the same change creates nothing twice (idempotent)", async () => {
    const payload = { clubId, kind: "event", refId: randomUUID(), version: 7, cancelled: false, title: "Geändert", body: "x", audience: { memberIds: [cmA], includeGuardians: false } };
    await handleEventChanged(ctx("notify_event_changed", payload));
    const before = (await rowsOf("event.changed")).length;
    await handleEventChanged(ctx("notify_event_changed", payload));
    expect((await rowsOf("event.changed")).length).toBe(before);
  });

  it("respects the per-category push preference (events) and keeps in_app + email", async () => {
    await db.insert(notificationPreferences).values({ userId: userB, category: "events", channel: "push", enabled: false });
    await handleEventChanged(ctx("notify_event_changed", { clubId, kind: "meeting", refId: randomUUID(), version: 2, cancelled: true, title: "Treffen", body: "x", audience: { memberIds: [cmA, cmB], includeGuardians: false } }));
    const rows = (await rowsOf("meeting.cancelled")).filter((r) => r.channel === "push");
    expect(rows.find((r) => r.userId === userA)?.status).toBe("queued");
    expect(rows.find((r) => r.userId === userB)?.status).toBe("skipped_optout");
    expect(await channelsOf("meeting.cancelled", userB)).toEqual(["email", "in_app", "push"]);
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, userB));
  });

  it("waitlist promotion is pushed with the event id", async () => {
    const event = { id: randomUUID(), title: "Turnier", startsAt: new Date(Date.now() + 86_400_000), endsAt: null, locationId: null, cancelledAt: null };
    await notifyWaitlistPromoted({ clubId, event, accountMemberId: `m-${userA}`, respondedAt: new Date() });
    expect(await channelsOf("event.promoted")).toEqual(["email", "in_app", "push"]);
  });
});

describe("push for reminders", () => {
  const payload = (kind: string, extra: Record<string, unknown> = {}) => ({ clubId, kind, refId: randomUUID(), date: "2030-01-01", title: "Erinnerung: X", body: "y", audience: { memberIds: [cmA], includeGuardians: false }, ...extra });

  it("event, rsvp and loan reminders get push; board digests do not", async () => {
    expect([...PUSH_REMINDER_KINDS].sort()).toEqual(["event", "loan_due", "loan_overdue", "rsvp"]);
    await handleReminder(ctx("notify_reminder", payload("event")));
    await handleReminder(ctx("notify_reminder", payload("maintenance")));
    expect((await channelsOf("reminder.event"))).toContain("push");
    expect((await channelsOf("reminder.maintenance"))).not.toContain("push");
  });

  it("re-running the same reminder does not duplicate the push delivery", async () => {
    const p = payload("loan_due");
    await handleReminder(ctx("notify_reminder", p));
    await handleReminder(ctx("notify_reminder", p));
    expect((await rowsOf("reminder.loan_due")).filter((r) => r.channel === "push")).toHaveLength(1);
  });

  it("rsvp reminders deep-link to the meeting, not to an event", () => {
    expect(pushDataFor("reminder.rsvp", "m-1#2030-01-01", null, clubId, false)).toMatchObject({ type: "meeting", meetingId: "m-1" });
    expect(pushDataFor("reminder.event", "e-1#2030-01-01", null, clubId, false)).toMatchObject({ type: "event", eventId: "e-1" });
    expect(genericPushText("reminder.loan_overdue", "reminder")).toBe("Rückgabe überfällig");
  });
});

describe("push deep links of the general assembly", () => {
  it("opens the ballot for ballot.* and the assembly (real meeting id) for an invitation, with ids only", () => {
    expect(pushDataFor("ballot.opened", "b-1", null, clubId, false)).toEqual({ type: "ballot", urgent: false, clubId, ballotId: "b-1" });
    expect(pushDataFor("ballot.reminder", "b-1#2030-01-01", null, clubId, false)).toMatchObject({ type: "ballot", ballotId: "b-1" });
    // The ref of an invitation is the invitation id, never a meeting id.
    const invitation = pushDataFor("meeting.invitation", "inv-1", null, clubId, false, "m-9");
    expect(invitation).toEqual({ type: "assembly", urgent: false, clubId, meetingId: "m-9" });
    expect(pushDataFor("meeting.invitation", "inv-1", null, clubId, false)).toEqual({ type: "assembly", urgent: false, clubId });
    // Other meeting events keep their behaviour.
    expect(pushDataFor("meeting.changed", "m-1", null, clubId, false)).toMatchObject({ type: "meeting", meetingId: "m-1" });
    expect(JSON.stringify([invitation, pushDataFor("ballot.opened", "b-1", null, clubId, false)])).not.toMatch(/title|choice|label/i);
    expect(genericPushText("ballot.opened", "announcement")).toBe("Neue Abstimmung");
    expect(genericPushText("meeting.invitation", "announcement")).toBe("Einladung zur Versammlung");
  });
});

describe("push for decisions (mandatory)", () => {
  it("approval carries in_app + email + push and an id-free inbox payload", async () => {
    const applicationId = randomUUID();
    await notifyApplicationApproved({ clubId, applicationId, userId: userA, clubMemberId: cmA });
    expect(await channelsOf("application.approved")).toEqual(["email", "in_app", "push"]);
    await runPush("application.approved");
    expect(calls[0]!.body[0]!.data).toEqual({ type: "message", urgent: false });
  });

  it("exit decisions push, the receipt does not", async () => {
    await notifyExitDecision({ clubId, requestId: randomUUID(), clubMemberId: cmA, kind: "rejected", today: "2030-01-01" });
    await notifyExitDecision({ clubId, requestId: randomUUID(), clubMemberId: cmA, kind: "received", today: "2030-01-01" });
    expect(await channelsOf("exit.rejected")).toContain("push");
    expect(await channelsOf("exit.received")).not.toContain("push");
  });

  it("mandatory + push alone is widened to in_app + email, and ignores single category switches", async () => {
    await db.insert(notificationPreferences).values({ userId: userA, category: "events", channel: "push", enabled: false });
    const res = await notify({ clubId, class: "mandatory", eventKey: `t-mand-${sfx}`, recipients: [{ userId: userA, email: `${userA}@example.test` }], content: { title: "T", body: "B" }, channels: ["push"] });
    expect(res).toMatchObject({ inApp: 1, queuedEmail: 1, queuedPush: 1 });
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, userA));
  });

  it("push switched off in every category is honoured; in_app and e-mail stay", async () => {
    await db.insert(notificationPreferences).values(["announcements", "events", "reminders"].map((category) => ({ userId: userA, category, channel: "push", enabled: false })));
    const eventKey = `t-mand-off-${sfx}`;
    const res = await notify({ clubId, class: "mandatory", eventKey, recipients: [{ userId: userA, email: `${userA}@example.test` }], content: { title: "T", body: "B" }, channels: ["in_app", "email", "push"] });
    expect(res).toMatchObject({ inApp: 1, queuedEmail: 1, queuedPush: 0, skippedOptout: 1 });
    expect((await rowsOf(eventKey)).filter((r) => r.channel === "push")[0]?.status).toBe("skipped_optout");
    await db.delete(notificationPreferences).where(and(eq(notificationPreferences.userId, userA)));
  });

  it("an account without a device token gets no push and the mandatory mail anyway", async () => {
    await db.delete(pushTokens).where(eq(pushTokens.userId, userB));
    const eventKey = `t-mand-notoken-${sfx}`;
    const res = await notify({ clubId, class: "mandatory", eventKey, recipients: [{ userId: userB, email: `${userB}@example.test` }], content: { title: "T", body: "B" }, channels: ["in_app", "email", "push"] });
    expect(res).toMatchObject({ queuedEmail: 1, queuedPush: 0, skippedNoAddress: 1 });
  });
});
