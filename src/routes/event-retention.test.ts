import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { eventAttendance, eventAttendanceSheets } from "../db/schema/event-attendance.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { clubMembers } from "../db/schema/club-members.js";
import { ruleOf } from "../lib/retention/rules.js";
import { eventAttendanceOld, eventGuestsOld } from "../lib/retention/categories.js";
import { createEventFixture, type EventFixture } from "./event-test-support.js";

const DAY = 86_400_000;

describe("retention of attendance lists and guest registrations (Wave 12)", () => {
  let fx: EventFixture;
  beforeAll(async () => {
    fx = await createEventFixture("evret");
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("registers both categories as club rules", () => {
    expect(ruleOf("event_attendance")).toMatchObject({ scope: "club", defaultDays: 1095 });
    expect(ruleOf("event_guests")).toMatchObject({ scope: "club", defaultDays: 90 });
  });

  it("deletes old attendance lists, keeps recent ones and lists of members under legal hold", async () => {
    const member = await fx.addAccountless("Alt Anwesend");
    const held = await fx.addAccountless("Gesperrt Anwesend");
    await db.update(clubMembers).set({ legalHoldAt: new Date(), legalHoldReason: "test" }).where(eq(clubMembers.id, held));
    const old = await fx.addEvent({ calendarId: fx.calA, startsAt: new Date(Date.now() - 400 * DAY) });
    const oldHeld = await fx.addEvent({ calendarId: fx.calA, startsAt: new Date(Date.now() - 400 * DAY) });
    const recent = await fx.addEvent({ calendarId: fx.calA, startsAt: new Date(Date.now() - 10 * DAY) });
    for (const [event, who] of [[old, member], [oldHeld, held], [recent, member]] as const) {
      const [sheet] = await db.insert(eventAttendanceSheets).values({ eventId: event.id }).returning();
      await db.insert(eventAttendance).values({ sheetId: sheet!.id, clubMemberId: who, status: "anwesend" });
    }
    const ctx = { clubId: fx.clubId, days: 365, now: new Date(), dryRun: false };
    const dry = await eventAttendanceOld({ ...ctx, dryRun: true });
    expect(dry).toEqual({ scanned: 1, affected: 0 });
    expect(await eventAttendanceOld(ctx)).toEqual({ scanned: 1, affected: 1 });
    expect(await db.select().from(eventAttendanceSheets).where(eq(eventAttendanceSheets.eventId, old.id))).toHaveLength(0);
    expect(await db.select().from(eventAttendanceSheets).where(eq(eventAttendanceSheets.eventId, oldHeld.id))).toHaveLength(1);
    expect(await db.select().from(eventAttendanceSheets).where(eq(eventAttendanceSheets.eventId, recent.id))).toHaveLength(1);
  });

  it("deletes guest registrations once their deletion date passed (and unconfirmed ones), keeps member rows", async () => {
    const event = await fx.addEvent({ calendarId: fx.calClub, startsAt: new Date(Date.now() + DAY) });
    const [expired] = await db.insert(eventAttendees).values({ eventId: event.id, guestEmail: "abgelaufen@example.com", guestName: "Gast", status: "angemeldet", guestDeleteAfter: new Date(Date.now() - 1000) }).returning();
    const [fresh] = await db.insert(eventAttendees).values({ eventId: event.id, guestEmail: "frisch@example.com", guestName: "Gast", status: "angemeldet", guestDeleteAfter: new Date(Date.now() + 30 * DAY) }).returning();
    const [memberRow] = await db.insert(eventAttendees).values({ eventId: event.id, memberId: fx.users.member1.memberId, status: "angemeldet" }).returning();
    const ctx = { clubId: fx.clubId, days: 90, now: new Date(), dryRun: false };
    expect(await eventGuestsOld({ ...ctx, dryRun: true })).toMatchObject({ scanned: 1, affected: 0 });
    expect(await eventGuestsOld(ctx)).toEqual({ scanned: 1, affected: 1 });
    expect(await db.select().from(eventAttendees).where(eq(eventAttendees.id, expired!.id))).toHaveLength(0);
    expect(await db.select().from(eventAttendees).where(eq(eventAttendees.id, fresh!.id))).toHaveLength(1);
    expect(await db.select().from(eventAttendees).where(eq(eventAttendees.id, memberRow!.id))).toHaveLength(1);
    // The backstop: a guest row of an event that ended long ago goes even without a date.
    const past = await fx.addEvent({ calendarId: fx.calClub, startsAt: new Date(Date.now() - 200 * DAY) });
    await db.insert(eventAttendees).values({ eventId: past.id, guestEmail: "alt@example.com", guestName: "Alt", status: "angemeldet" });
    expect(await eventGuestsOld(ctx)).toEqual({ scanned: 1, affected: 1 });
  });
});
