import { and, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { jobs } from "../db/schema/jobs.js";
import { meetingInvitees, meetings } from "../db/schema/meetings.js";
import { addDays, daysBetween, isDigestTime, localDate, localHour, safeTimezone } from "./club-time.js";
import { handleReminder, REMINDER_JOB_TYPE, reminderDedupeKey, runReminderSweep, type ReminderPayload } from "./reminders.js";

/** Wave 9 B12: reminder-sweep -- what is due, exactly once, in the club time zone. */

describe("club time helpers (DST)", () => {
  it("counts the calendar day in the club zone around the spring switch (2026-03-29, 23 h day)", () => {
    expect(localDate(new Date("2026-03-28T22:59:00Z"), "Europe/Berlin")).toBe("2026-03-28"); // 23:59 CET
    expect(localDate(new Date("2026-03-28T23:00:00Z"), "Europe/Berlin")).toBe("2026-03-29"); // 00:00 CET
    expect(localDate(new Date("2026-03-29T21:59:00Z"), "Europe/Berlin")).toBe("2026-03-29"); // 23:59 CEST
    expect(localDate(new Date("2026-03-29T22:00:00Z"), "Europe/Berlin")).toBe("2026-03-30");
    expect(localHour(new Date("2026-03-29T00:30:00Z"), "Europe/Berlin")).toBe(1);
    expect(localHour(new Date("2026-03-29T01:00:00Z"), "Europe/Berlin")).toBe(3); // 02:00-03:00 does not exist
  });

  it("counts the calendar day around the autumn switch (2026-10-25, 25 h day)", () => {
    expect(localDate(new Date("2026-10-24T21:59:00Z"), "Europe/Berlin")).toBe("2026-10-24");
    expect(localDate(new Date("2026-10-24T22:00:00Z"), "Europe/Berlin")).toBe("2026-10-25");
    expect(localDate(new Date("2026-10-25T22:59:00Z"), "Europe/Berlin")).toBe("2026-10-25"); // 25 h later still the same day
    expect(localDate(new Date("2026-10-25T23:00:00Z"), "Europe/Berlin")).toBe("2026-10-26");
    expect(localHour(new Date("2026-10-25T00:30:00Z"), "Europe/Berlin")).toBe(2); // CEST
    expect(localHour(new Date("2026-10-25T01:30:00Z"), "Europe/Berlin")).toBe(2); // CET, the repeated hour
  });

  it("adds days on the calendar, across month, year and switch days", () => {
    expect(addDays("2026-03-27", 3)).toBe("2026-03-30");
    expect(addDays("2026-10-23", 3)).toBe("2026-10-26");
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2);
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
  });

  it("opens the digest window at the configured club hour, also on switch days", () => {
    expect(isDigestTime(new Date("2026-03-29T05:59:00Z"), "Europe/Berlin", 8)).toBe(false); // 07:59 CEST
    expect(isDigestTime(new Date("2026-03-29T06:00:00Z"), "Europe/Berlin", 8)).toBe(true); // 08:00 CEST
    expect(isDigestTime(new Date("2026-10-25T06:59:00Z"), "Europe/Berlin", 8)).toBe(false); // 07:59 CET
    expect(isDigestTime(new Date("2026-10-25T07:00:00Z"), "Europe/Berlin", 8)).toBe(true);
    expect(isDigestTime(new Date("2026-10-25T07:00:00Z"), "America/New_York", 8)).toBe(false); // 03:00 EST
  });

  it("falls back to the default zone for garbage", () => {
    expect(safeTimezone("Mars/Olympus")).toBe("Europe/Berlin");
    expect(safeTimezone(null)).toBe("Europe/Berlin");
    expect(safeTimezone("Europe/Lisbon")).toBe("Europe/Lisbon");
  });
});

const suffix = Date.now();

describe("reminder-sweep", () => {
  let clubId: string;
  let calendarId: string;
  const userIds: string[] = [];
  const account: Record<string, string> = {};
  const clubMemberOf: Record<string, string> = {};
  let ownerUserId: string;

  const sweep = (now: string) => runReminderSweep(new Date(now), { clubId });
  const reminderJobs = async (kind?: string, ref?: string) =>
    (await db.select().from(jobs).where(and(eq(jobs.type, REMINDER_JOB_TYPE), sql`${jobs.payload}->>'clubId' = ${clubId}`)))
      .filter((j) => (!kind || j.payload.kind === kind) && (!ref || j.payload.refId === ref));
  const setSettings = async (values: Partial<typeof clubSettings.$inferInsert>) => {
    await db.insert(clubSettings).values({ clubId, ...values }).onConflictDoUpdate({ target: clubSettings.clubId, set: values });
  };
  const deliver = async (job: { id: string; payload: unknown }) => handleReminder({ id: job.id, type: REMINDER_JOB_TYPE, payload: job.payload as Record<string, unknown>, attempt: 1, maxAttempts: 3 });
  const inAppTo = async (refId: string) =>
    (await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${refId}%`), eq(messageDeliveries.channel, "in_app")))).map((d) => d.clubMemberId).sort();

  beforeAll(async () => {
    const make = async (label: string) => {
      const email = `rem-${label}-${suffix}@example.com`;
      const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: label } });
      userIds.push(created.id);
      return created.id;
    };
    ownerUserId = await make("owner");
    const club = await auth.api.createOrganization({ body: { name: `Rem Club ${suffix}`, slug: `rem-club-${suffix}`, userId: ownerUserId } });
    clubId = club!.id;
    for (const label of ["a", "b", "c", "keeper"]) {
      const id = await make(label);
      await auth.api.addMember({ body: { userId: id, organizationId: clubId, role: "member" } });
    }
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    for (const label of ["a", "b", "c", "keeper"]) {
      const email = `rem-${label}-${suffix}@example.com`;
      const [u] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
      const acc = accounts.find((x) => x.userId === u!.id)!;
      account[label] = acc.id;
      const [row] = await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, acc.id));
      clubMemberOf[label] = row!.id;
    }
    const ownerAccount = accounts.find((x) => x.userId === ownerUserId)!;
    account.owner = ownerAccount.id;
    const [ownerRow] = await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, ownerAccount.id));
    if (ownerRow) clubMemberOf.owner = ownerRow.id;
    await db.insert(clubRoles).values({ memberId: account.keeper!, roleType: "schriftfuehrer" });
    const [calendar] = await db.insert(calendars).values({ clubId, name: "Kalender", createdBy: ownerUserId }).returning();
    calendarId = calendar!.id;
  }, 60_000);

  afterAll(async () => {
    await db.delete(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`);
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("reminds the confirmed attendees of an event inside the lead time -- exactly once, however often it sweeps", async () => {
    const [ev] = await db.insert(events).values({ calendarId, title: "Training", startsAt: new Date("2026-10-19T08:00:00Z"), createdBy: ownerUserId }).returning();
    await db.insert(eventAttendees).values([
      { eventId: ev!.id, memberId: account.a!, status: "angemeldet" },
      { eventId: ev!.id, memberId: account.b!, status: "warteliste" },
      { eventId: ev!.id, memberId: account.c!, status: "abgesagt" },
    ]);
    expect((await sweep("2026-10-18T07:00:00Z")).scheduled).toBe(0); // 25 h before, outside the 24 h lead
    expect((await sweep("2026-10-18T08:15:00Z")).scheduled).toBe(1);
    expect((await sweep("2026-10-18T08:30:00Z"))).toEqual({ scheduled: 0, alreadyScheduled: 1 });
    expect((await sweep("2026-10-18T20:00:00Z")).scheduled).toBe(0);
    const [job] = await reminderJobs("event", ev!.id);
    expect(job!.dedupeKey).toBe(reminderDedupeKey("event", ev!.id, "2026-10-19"));
    expect(await reminderJobs("event", ev!.id)).toHaveLength(1);
    expect((job!.payload as ReminderPayload).body).toContain("Mo., 19.10.2026, 10:00 Uhr");

    await deliver(job!);
    expect(await inAppTo(ev!.id)).toEqual([clubMemberOf.a]);
    const [row] = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${ev!.id}%`), eq(messageDeliveries.clubMemberId, clubMemberOf.a!), eq(messageDeliveries.channel, "email")));
    expect(row!.content).toMatchObject({ class: "optional", category: "reminders", template: "reminder" });
  });

  it("skips cancelled events, events without attendees and clubs with the switch off; honours the lead hours", async () => {
    const start = new Date("2026-11-20T18:00:00Z");
    const [cancelled] = await db.insert(events).values({ calendarId, title: "Abgesagt", startsAt: start, cancelledAt: new Date(), createdBy: ownerUserId }).returning();
    const [lonely] = await db.insert(events).values({ calendarId, title: "Leer", startsAt: start, createdBy: ownerUserId }).returning();
    const [normal] = await db.insert(events).values({ calendarId, title: "Normal", startsAt: start, createdBy: ownerUserId }).returning();
    await db.insert(eventAttendees).values([{ eventId: cancelled!.id, memberId: account.a!, status: "angemeldet" }, { eventId: normal!.id, memberId: account.a!, status: "angemeldet" }]);
    await setSettings({ reminderEventLeadHours: 48 });
    expect((await sweep("2026-11-18T17:00:00Z")).scheduled).toBe(0); // 49 h
    await setSettings({ reminderEventEnabled: false });
    expect((await sweep("2026-11-19T10:00:00Z")).scheduled).toBe(0);
    await setSettings({ reminderEventEnabled: true });
    expect((await sweep("2026-11-18T19:00:00Z")).scheduled).toBe(1); // 47 h
    expect(await reminderJobs("event", normal!.id)).toHaveLength(1);
    expect(await reminderJobs("event", cancelled!.id)).toHaveLength(0);
    expect(await reminderJobs("event", lonely!.id)).toHaveLength(0);
    await setSettings({ reminderEventLeadHours: 24 });
  });

  it("reminds a borrower before the due day, on it and three times when overdue -- then stays quiet", async () => {
    const [item] = await db.insert(inventoryItems).values({ clubId, name: "Beamer", condition: "gut" }).returning();
    // Due 2026-10-22 18:00 Berlin (CEST).
    const [loan] = await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: account.a!, dueAt: new Date("2026-10-22T16:00:00Z") }).returning();
    const count = async (kind: string) => (await reminderJobs(kind, loan!.id)).length;

    expect((await sweep("2026-10-20T10:00:00Z")).scheduled).toBe(0); // 2 days before, lead is 1
    expect((await sweep("2026-10-21T05:59:00Z")).scheduled).toBe(0); // 07:59 local: before the digest hour
    expect((await sweep("2026-10-21T06:00:00Z")).scheduled).toBe(1);
    expect((await sweep("2026-10-21T12:00:00Z")).scheduled).toBe(0);
    expect((await sweep("2026-10-22T07:00:00Z")).scheduled).toBe(0); // due day: same key (due date), still one reminder
    expect(await count("loan_due")).toBe(1);

    // 18:30 local on the due day is overdue by instant but still day 0.
    expect((await sweep("2026-10-22T16:30:00Z")).scheduled).toBe(0);
    expect((await sweep("2026-10-23T06:00:00Z")).scheduled).toBe(1); // day 1
    expect((await sweep("2026-10-24T06:00:00Z")).scheduled).toBe(0); // day 2
    expect((await sweep("2026-10-25T08:00:00Z")).scheduled).toBe(0); // day 3 (switch day, 09:00 CET)
    expect((await sweep("2026-10-26T08:00:00Z")).scheduled).toBe(1); // day 4
    expect((await sweep("2026-10-29T08:00:00Z")).scheduled).toBe(1); // day 7
    expect((await sweep("2026-11-10T08:00:00Z")).scheduled).toBe(0); // limited
    expect(await count("loan_overdue")).toBe(3);

    const [overdue] = (await reminderJobs("loan_overdue", loan!.id)).sort((x, y) => String(x.dedupeKey).localeCompare(String(y.dedupeKey)));
    expect((overdue!.payload as ReminderPayload).audience).toEqual({ memberIds: [clubMemberOf.a], includeGuardians: true });
    await deliver(overdue!);
    expect(await inAppTo(loan!.id)).toEqual([clubMemberOf.a]);
  });

  it("catches up with the latest repeat step after downtime and ignores returned or undated loans", async () => {
    const [item] = await db.insert(inventoryItems).values({ clubId, name: "Zelt", condition: "gut" }).returning();
    const [late] = await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: account.b!, dueAt: new Date("2026-09-01T10:00:00Z") }).returning();
    const [returned] = await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: account.b!, dueAt: new Date("2026-09-01T10:00:00Z"), returnedAt: new Date("2026-09-02T10:00:00Z"), status: "zurueckgegeben" }).returning();
    await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: account.b!, dueAt: null });
    await sweep("2026-10-18T10:00:00Z");
    expect(await reminderJobs("loan_overdue", late!.id)).toHaveLength(1);
    expect(await reminderJobs(undefined, returned!.id)).toHaveLength(0);
    await sweep("2026-10-19T10:00:00Z");
    expect(await reminderJobs("loan_overdue", late!.id)).toHaveLength(1);
  });

  it("sends one maintenance digest per club and day to the inventory managers only", async () => {
    await db.insert(inventoryItems).values([
      { clubId, name: "Rasenmäher", condition: "gut", maintenanceIntervalDays: 30, acquiredAt: "2026-09-10" }, // due 2026-10-10: overdue
      { clubId, name: "Leiter", condition: "gut", maintenanceIntervalDays: 365, lastMaintenanceAt: "2025-10-23" }, // due 2026-10-23: inside 7 days
      { clubId, name: "Zaun", condition: "gut", maintenanceIntervalDays: 365, lastMaintenanceAt: "2026-01-01" }, // far away
      { clubId, name: "Tisch", condition: "gut" }, // no schedule
    ]);
    expect((await sweep("2026-10-18T05:00:00Z")).scheduled).toBe(0); // 07:00 local
    const first = await sweep("2026-10-18T06:00:00Z");
    expect(first.scheduled).toBeGreaterThanOrEqual(1);
    expect((await sweep("2026-10-18T14:00:00Z")).scheduled).toBe(0);
    const digests = await reminderJobs("maintenance", clubId);
    expect(digests).toHaveLength(1);
    const payload = digests[0]!.payload as ReminderPayload;
    expect(payload.title).toBe("Wartung fällig: 2 Gegenstände");
    expect(payload.body).toContain("Rasenmäher: überfällig seit 10.10.2026");
    expect(payload.body).toContain("Leiter: fällig am 23.10.2026");
    expect(payload.body).not.toContain("Zaun");
    expect(payload.audience.roleTypes).toEqual(expect.arrayContaining(["vorsitz", "schriftfuehrer", "abteilungsleitung"]));
    expect(payload.audience.roleTypes).not.toContain("kassenwart");

    await deliver(digests[0]!);
    expect(await inAppTo(clubId)).toEqual([clubMemberOf.keeper]);

    await sweep("2026-10-19T06:00:00Z");
    expect(await reminderJobs("maintenance", clubId)).toHaveLength(2); // a new day, a new digest
    await setSettings({ reminderMaintenanceEnabled: false });
    await sweep("2026-10-20T06:00:00Z");
    expect(await reminderJobs("maintenance", clubId)).toHaveLength(2);
    await setSettings({ reminderMaintenanceEnabled: true });
  });

  it("asks only the invitees without an answer, from the lead days before the meeting, across the spring DST switch", async () => {
    // Meeting Mon 2026-03-30 18:00 Berlin (CEST) = 16:00Z; lead 3 days -> from Fri 2026-03-27.
    const [meeting] = await db.insert(meetings).values({ clubId, type: "sonstige", title: "Planung", scheduledAt: new Date("2026-03-30T16:00:00Z"), status: "geplant", createdBy: ownerUserId }).returning();
    await db.insert(meetingInvitees).values([
      { meetingId: meeting!.id, clubMemberId: clubMemberOf.a!, response: "ausstehend" },
      { meetingId: meeting!.id, clubMemberId: clubMemberOf.b!, response: "zugesagt" },
      { meetingId: meeting!.id, clubMemberId: clubMemberOf.c!, response: "abgesagt" },
    ]);
    expect((await sweep("2026-03-26T07:00:00Z")).scheduled).toBe(0); // Thursday 08:00 CET
    expect((await sweep("2026-03-27T06:59:00Z")).scheduled).toBe(0); // Friday 07:59 CET
    expect((await sweep("2026-03-27T07:00:00Z")).scheduled).toBe(1); // Friday 08:00 CET
    expect((await sweep("2026-03-29T06:00:00Z")).scheduled).toBe(0); // switch day, same key
    const [job] = await reminderJobs("rsvp", meeting!.id);
    expect(job!.dedupeKey).toBe(reminderDedupeKey("rsvp", meeting!.id, "2026-03-30"));
    expect((job!.payload as ReminderPayload).audience).toEqual({ memberIds: [clubMemberOf.a], includeGuardians: true });
    await deliver(job!);
    expect(await inAppTo(meeting!.id)).toEqual([clubMemberOf.a]);
  });

  it("asks across the autumn DST switch and skips meetings that are over, undated or cancelled", async () => {
    // Meeting Mon 2026-10-26 18:00 Berlin (CET) = 17:00Z; lead 3 -> from Fri 2026-10-23 (still CEST: 08:00 = 06:00Z).
    const [meeting] = await db.insert(meetings).values({ clubId, type: "sonstige", title: "Herbst", scheduledAt: new Date("2026-10-26T17:00:00Z"), status: "geplant", createdBy: ownerUserId }).returning();
    const [cancelled] = await db.insert(meetings).values({ clubId, type: "sonstige", title: "Abgesagt", scheduledAt: new Date("2026-10-26T17:00:00Z"), status: "abgesagt", createdBy: ownerUserId }).returning();
    const [undated] = await db.insert(meetings).values({ clubId, type: "sonstige", title: "Offen", scheduledAt: null, status: "terminfindung", createdBy: ownerUserId }).returning();
    for (const m of [meeting!, cancelled!, undated!]) await db.insert(meetingInvitees).values({ meetingId: m.id, clubMemberId: clubMemberOf.c!, response: "ausstehend" });
    expect((await sweep("2026-10-23T05:59:00Z")).scheduled).toBe(0);
    await sweep("2026-10-23T06:00:00Z");
    expect(await reminderJobs("rsvp", meeting!.id)).toHaveLength(1);
    expect(await reminderJobs("rsvp", cancelled!.id)).toHaveLength(0);
    expect(await reminderJobs("rsvp", undated!.id)).toHaveLength(0);
    await sweep("2026-10-27T10:00:00Z"); // meeting is over: no further rsvp reminder
    expect(await reminderJobs("rsvp")).toHaveLength(2);
  });

  it("uses the club time zone for the digest hour", async () => {
    await setSettings({ timezone: "America/New_York" });
    const [item] = await db.insert(inventoryItems).values({ clubId, name: "Kamera", condition: "gut" }).returning();
    const [loan] = await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: account.c!, dueAt: new Date("2026-12-10T20:00:00Z") }).returning();
    expect((await sweep("2026-12-09T12:59:00Z")).scheduled).toBe(0); // 07:59 EST
    await sweep("2026-12-09T13:00:00Z"); // 08:00 EST
    expect(await reminderJobs("loan_due", loan!.id)).toHaveLength(1);
    await setSettings({ timezone: "Europe/Berlin" });
  });

  it("two parallel sweeps schedule a reminder once", async () => {
    const [ev] = await db.insert(events).values({ calendarId, title: "Parallel", startsAt: new Date("2027-02-01T10:00:00Z"), createdBy: ownerUserId }).returning();
    await db.insert(eventAttendees).values({ eventId: ev!.id, memberId: account.a!, status: "angemeldet" });
    await Promise.all(Array.from({ length: 5 }, () => sweep("2027-01-31T12:00:00Z")));
    expect(await reminderJobs("event", ev!.id)).toHaveLength(1);
  });
});
