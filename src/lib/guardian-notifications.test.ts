import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMembers } from "../db/schema/club-members.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { meetingInvitees, meetings } from "../db/schema/meetings.js";
import { notifyExitDecision, recipientsForClubMember } from "./decision-notify.js";
import { eventAudience, handleEventChanged } from "./event-notify.js";
import { handleReminder, REMINDER_JOB_TYPE, runReminderSweep } from "./reminders.js";
import { jobs } from "../db/schema/jobs.js";
import { sql } from "drizzle-orm";

/** G5: guardians are told about every event change and about reminders; exit decisions reach them also when the child has an own address. */

const sfx = randomUUID().slice(0, 8);
const clubId = `grd-${sfx}`;
const userIds: string[] = [];
const accountOf: Record<string, string> = {};
const clubMemberOf: Record<string, string> = {};
const userOf: Record<string, string> = {};
let calendarId: string;

async function mk(label: string, extra: { contactEmail?: string; email?: string } = {}) {
  const userId = `grd-${label}-${sfx}`;
  await db.insert(user).values({ id: userId, name: label, email: extra.email ?? `${userId}@example.test`, emailVerified: true });
  userIds.push(userId);
  accountOf[label] = `grd-m-${label}-${sfx}`;
  userOf[label] = userId;
  await db.insert(member).values({ id: accountOf[label], organizationId: clubId, userId, role: "member", createdAt: new Date() });
  const [row] = await db.insert(clubMembers).values({ clubId, memberId: accountOf[label], displayName: label, firstName: label, joinedAt: "2020-01-01" }).returning();
  clubMemberOf[label] = row!.id;
}

const inApp = async (refId: string, eventKey?: string) =>
  (await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${refId}%`), eq(messageDeliveries.channel, "in_app"), ...(eventKey ? [eq(messageDeliveries.eventKey, eventKey)] : [])))).map((d) => d.userId).sort();
const emails = (refId: string) => db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${refId}%`), eq(messageDeliveries.channel, "email")));

beforeAll(async () => {
  await db.insert(organization).values({ id: clubId, name: "TV Eltern", slug: clubId, createdAt: new Date() });
  await mk("owner");
  await mk("child");
  await mk("papa");
  await mk("mama");
  await db.insert(guardianLinks).values([
    { guardianMemberId: accountOf.papa!, wardClubMemberId: clubMemberOf.child! },
    { guardianMemberId: accountOf.mama!, wardClubMemberId: clubMemberOf.child! },
  ]);
  const [calendar] = await db.insert(calendars).values({ clubId, name: "Kalender", createdBy: userOf.owner! }).returning();
  calendarId = calendar!.id;
}, 30_000);

afterAll(async () => {
  await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`);
  await db.delete(organization).where(eq(organization.id, clubId));
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
  await closeDatabase();
});

describe("guardians and event changes", () => {
  it("any change of an event (not only a cancellation) reaches the guardians of the attendee", async () => {
    const [ev] = await db.insert(events).values({ calendarId, title: "Turnier", startsAt: new Date("2030-06-01T16:00:00Z"), createdBy: userOf.owner! }).returning();
    await db.insert(eventAttendees).values({ eventId: ev!.id, memberId: accountOf.child!, status: "angemeldet" });
    const audience = await eventAudience(clubId, ev!.id, null, false);
    expect(audience).toEqual({ memberIds: [clubMemberOf.child], includeGuardians: true });
    await handleEventChanged({ id: randomUUID(), type: "notify_event_changed", attempt: 1, maxAttempts: 3, payload: { clubId, kind: "event", refId: ev!.id, version: 1, cancelled: false, title: "Terminänderung: Turnier", body: "Neu: später", audience: audience! } });
    expect(await inApp(ev!.id, "event.changed")).toEqual([userOf.child, userOf.mama, userOf.papa].sort());
  });
});

describe("guardians and reminders", () => {
  it("event, loan and RSVP reminders also go to the guardians of the person", async () => {
    const [ev] = await db.insert(events).values({ calendarId, title: "Training", startsAt: new Date("2026-10-19T08:00:00Z"), createdBy: userOf.owner! }).returning();
    await db.insert(eventAttendees).values({ eventId: ev!.id, memberId: accountOf.child!, status: "angemeldet" });
    const [item] = await db.insert(inventoryItems).values({ clubId, name: "Ball", condition: "gut" }).returning();
    const [loan] = await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: accountOf.child!, dueAt: new Date("2026-10-22T16:00:00Z") }).returning();
    const [meeting] = await db.insert(meetings).values({ clubId, type: "sonstige", title: "Elternabend", status: "geplant", scheduledAt: new Date("2026-10-22T17:00:00Z"), createdBy: userOf.owner! }).returning();
    await db.insert(meetingInvitees).values({ meetingId: meeting!.id, clubMemberId: clubMemberOf.child!, response: "ausstehend" });

    await runReminderSweep(new Date("2026-10-18T08:15:00Z"), { clubId });
    await runReminderSweep(new Date("2026-10-21T06:00:00Z"), { clubId });
    const all = (await db.select().from(jobs).where(and(eq(jobs.type, REMINDER_JOB_TYPE), sql`${jobs.payload}->>'clubId' = ${clubId}`)));
    for (const job of all) await handleReminder({ id: job.id, type: job.type, payload: job.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 });
    const everyone = [userOf.child, userOf.mama, userOf.papa].sort();
    expect(await inApp(ev!.id, "reminder.event")).toEqual(everyone);
    expect(await inApp(loan!.id, "reminder.loan_due")).toEqual(everyone);
    expect(await inApp(meeting!.id, "reminder.rsvp")).toEqual(everyone);
    const [text] = all.filter((j) => j.payload.kind === "event");
    expect(String(text!.payload.body)).not.toMatch(/\bdu\b|\bdein/i);
  });
});

describe("exit decisions and guardians", () => {
  it("reach the guardians also when the child has an own address, each person once", async () => {
    const recipients = await recipientsForClubMember(clubMemberOf.child!);
    expect(recipients.map((r) => r.userId).sort()).toEqual([userOf.child, userOf.mama, userOf.papa].sort());
    expect(new Set(recipients.map((r) => r.userId)).size).toBe(3);

    const requestId = randomUUID();
    await notifyExitDecision({ clubId, requestId, clubMemberId: clubMemberOf.child!, kind: "accepted", effectiveOn: "2030-01-31", today: "2026-10-20" });
    expect(await inApp(requestId, "exit.accepted")).toEqual([userOf.child, userOf.mama, userOf.papa].sort());
    expect((await emails(requestId)).filter((r) => r.status === "queued")).toHaveLength(3);
    // a repeated call is the same delivery
    await notifyExitDecision({ clubId, requestId, clubMemberId: clubMemberOf.child!, kind: "accepted", effectiveOn: "2030-01-31", today: "2026-10-20" });
    expect(await emails(requestId)).toHaveLength(3);
  });

  it("a family address is mailed once: the second person is covered by the first one's mail", async () => {
    await mk("kid2", { email: `family-${sfx}@example.test` });
    await mk("papa2", { email: `family-${sfx}@example.test`.toUpperCase() });
    await db.insert(guardianLinks).values({ guardianMemberId: accountOf.papa2!, wardClubMemberId: clubMemberOf.kid2! });
    const requestId = randomUUID();
    await notifyExitDecision({ clubId, requestId, clubMemberId: clubMemberOf.kid2!, kind: "rejected", today: "2026-10-20" });
    expect(await inApp(requestId, "exit.rejected")).toEqual([userOf.kid2, userOf.papa2].sort());
    expect(await emails(requestId)).toHaveLength(1);
  });

  it("a child without account and without address falls back to the guardians only", async () => {
    const [row] = await db.insert(clubMembers).values({ clubId, displayName: "Kleines Kind", firstName: "Kleines", joinedAt: "2020-01-01" }).returning();
    await db.insert(guardianLinks).values({ guardianMemberId: accountOf.papa!, wardClubMemberId: row!.id });
    const recipients = await recipientsForClubMember(row!.id);
    expect(recipients).toHaveLength(1);
    expect(recipients[0]).toMatchObject({ userId: userOf.papa, clubMemberId: clubMemberOf.papa });
  });
});
