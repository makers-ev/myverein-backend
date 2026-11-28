import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMemberDepartments } from "../db/schema/club-members.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { createEventFixture, type EventFixture, type TestUser } from "./event-test-support.js";

/** Wave 16 T6: "Wer hat Zeit?" while planning a calendar event -- counters for the planners, names of the unavailable only for calendar managers. */
describe("GET /events/availability-hints", () => {
  let fx: EventFixture;
  let accountless: string;
  // Monday 30 March 2026, 18:00-19:30 in Berlin = summer time (UTC+2), the day after the switch.
  const SUMMER = { startsAt: "2026-03-30T16:00:00Z", endsAt: "2026-03-30T17:30:00Z" };
  // Monday 7 December 2026, 18:00-19:30 in Berlin = winter time (UTC+1).
  const WINTER = { startsAt: "2026-12-07T17:00:00Z", endsAt: "2026-12-07T18:30:00Z" };
  const hints = (who: TestUser, params: Record<string, string>) => fx.req(who, `/events/availability-hints?${new URLSearchParams(params).toString()}`);
  const slot = (who: TestUser, startTime: string, endTime: string) => db.insert(availabilitySlots).values({ memberId: who.memberId, weekday: 0, startTime, endTime, note: "GEHEIM-Notiz" });

  beforeAll(async () => {
    fx = await createEventFixture("availhints");
    const { trainerA, leaderA, member1, member2 } = fx.users;
    for (const u of [trainerA, leaderA, member1, member2]) await db.insert(clubMemberDepartments).values({ clubMemberId: u.clubMemberId, departmentId: fx.deptA, since: "2020-01-01" });
    accountless = await fx.addAccountless("Kind ohne Konto", { departmentId: fx.deptA });
    await slot(member1, "17:00", "21:00"); // free on Monday evenings
    await slot(member2, "08:00", "12:00"); // only Monday mornings
    await slot(leaderA, "17:00", "21:00");
    await db.insert(availabilityExceptions).values({ memberId: leaderA.memberId, date: "2026-03-30", isAvailable: false, note: "GEHEIM-Urlaub" }); // holiday that day
    // trainerA entered nothing -> unbekannt; the account-less child -> unbekannt.
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("counts available / not available / unknown in Europe/Berlin (summer time) and names only the unavailable, without notes", async () => {
    const res = await hints(fx.users.board, { ...SUMMER, calendarId: fx.calA });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await fx.json(res);
    expect(body.data).toMatchObject({ calendarId: fx.calA, eventId: null, timezone: "Europe/Berlin", pool: "department", includesNames: true, truncated: false, counts: { total: 5, verfuegbar: 1, nicht_verfuegbar: 2, unbekannt: 2 } });
    expect(body.data.unavailablePeople).toEqual([
      { clubMemberId: fx.users.leaderA.clubMemberId, displayName: "Leiter A" },
      { clubMemberId: fx.users.member2.clubMemberId, displayName: "Mitglied Zwei" },
    ]);
    const text = JSON.stringify(body);
    expect(text).not.toContain("GEHEIM");
    expect(text).not.toContain(accountless); // unknown people are only counted
    expect(text).not.toContain(fx.users.member1.clubMemberId);
    // The read with names is audited (ids and counts only).
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.clubId, fx.clubId), eq(auditLog.eventType, "availability.sensitive_read")));
    expect(audit).toMatchObject({ actorUserId: fx.users.board.userId });
    expect(audit!.payload).toEqual({ clubId: fx.clubId, calendarId: fx.calA, eventId: null, count: 2 });
  });

  it("uses winter time correctly and treats a window without end as its start", async () => {
    const winter = (await fx.json(await hints(fx.users.board, { ...WINTER, calendarId: fx.calA }))).data;
    // No holiday in December: Leiter A is free again.
    expect(winter.counts).toEqual({ total: 5, verfuegbar: 2, nicht_verfuegbar: 1, unbekannt: 2 });
    const noEnd = (await fx.json(await hints(fx.users.board, { startsAt: WINTER.startsAt, calendarId: fx.calA }))).data;
    expect(noEnd.counts).toEqual(winter.counts);
    expect(noEnd.endsAt).toBeNull();
    // 21:00-22:00 local is outside every Monday slot.
    const late = (await fx.json(await hints(fx.users.board, { startsAt: "2026-12-07T20:00:00Z", endsAt: "2026-12-07T21:00:00Z", calendarId: fx.calA }))).data;
    expect(late.counts).toMatchObject({ verfuegbar: 0, nicht_verfuegbar: 3, unbekannt: 2 });
  });

  it("marks a holiday inside a multi-day window, and counts only (no names) for a trainer of the department", async () => {
    await db.insert(availabilityExceptions).values({ memberId: fx.users.member1.memberId, date: "2026-12-09", isAvailable: false });
    const camp = (await fx.json(await hints(fx.users.leaderA, { startsAt: "2026-12-07T17:00:00Z", endsAt: "2026-12-10T17:00:00Z", calendarId: fx.calA }))).data;
    expect(camp.unavailablePeople.map((p: { displayName: string }) => p.displayName)).toContain("Mitglied Eins");
    const trainer = await hints(fx.users.trainerA, { ...SUMMER, calendarId: fx.calA });
    expect(trainer.status).toBe(200);
    const data = (await fx.json(trainer)).data;
    expect(data).toMatchObject({ includesNames: false, unavailablePeople: null, counts: { total: 5, nicht_verfuegbar: 2 } });
    expect(JSON.stringify(data)).not.toMatch(/Leiter A|Mitglied Zwei/);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, fx.clubId), eq(auditLog.eventType, "availability.sensitive_read"), eq(auditLog.actorUserId, fx.users.trainerA.userId)));
    expect(audits).toHaveLength(0);
  });

  it("denies by default: plain members, trainers outside their department, foreign clubs and calendars", async () => {
    expect((await hints(fx.users.member1, { ...SUMMER, calendarId: fx.calA })).status).toBe(403);
    expect((await hints(fx.users.trainerA, { ...SUMMER, calendarId: fx.calB })).status).toBe(403);
    expect((await hints(fx.users.trainerA, { ...SUMMER, calendarId: fx.calClub })).status).toBe(403);
    expect((await hints(fx.users.board, { ...SUMMER, calendarId: fx.otherCalendar })).status).toBe(404);
    expect((await hints(fx.users.board, { ...SUMMER, calendarId: crypto.randomUUID() })).status).toBe(404);
    expect((await fx.req(fx.users.outsider, `/events/availability-hints?${new URLSearchParams({ ...SUMMER, calendarId: fx.calA })}`, { club: fx.clubId })).status).toBe(404);
    // A trainer cannot pull RSVP counts of an event of another calendar through their own calendar.
    const foreignEvent = await fx.addEvent({ calendarId: fx.calB });
    expect((await hints(fx.users.trainerA, { ...SUMMER, calendarId: fx.calA, eventId: foreignEvent.id })).status).toBe(404);
  });

  it("names the unavailable only for calendars the caller manages: department lead = own department, else counters only", async () => {
    const rights: Array<[TestUser, string, number, boolean | null]> = [
      [fx.users.board, fx.calA, 200, true],
      [fx.users.board, fx.calB, 200, true],
      [fx.users.board, fx.calClub, 200, true],
      [fx.users.leaderA, fx.calA, 200, true],
      [fx.users.leaderA, fx.calB, 200, false],
      [fx.users.leaderA, fx.calClub, 200, false],
      [fx.users.trainerA, fx.calA, 200, false],
      [fx.users.trainerA, fx.calB, 403, null],
      [fx.users.trainerA, fx.calClub, 403, null],
      [fx.users.member1, fx.calA, 403, null],
      [fx.users.member1, fx.calClub, 403, null],
    ];
    for (const [who, calendarId, status, names] of rights) {
      const res = await hints(who, { ...WINTER, calendarId });
      expect(res.status, `${who.clubMemberId} ${calendarId}`).toBe(status);
      if (names === null) continue;
      const data = (await fx.json(res)).data;
      expect(data.includesNames).toBe(names);
      if (!names) expect(data.unavailablePeople).toBeNull();
    }
    // Moving an event into the own department's calendar is planning there (names); counters only for the other calendar.
    const eventB = await fx.addEvent({ calendarId: fx.calB });
    expect((await hints(fx.users.leaderA, { ...WINTER, calendarId: fx.calA, eventId: eventB.id })).status).toBe(200);
    expect((await hints(fx.users.leaderA, { ...WINTER, calendarId: fx.calB, eventId: eventB.id })).status).toBe(200);
    // Counters-only callers stay inside the event's calendar.
    expect((await hints(fx.users.leaderA, { ...WINTER, calendarId: fx.calClub, eventId: eventB.id })).status).toBe(404);
  });

  it("validates the window", async () => {
    const codeOf = async (res: Response) => (await fx.json(res)).error.details?.code;
    expect((await hints(fx.users.board, { calendarId: fx.calA })).status).toBe(422);
    expect((await hints(fx.users.board, { startsAt: "morgen", calendarId: fx.calA })).status).toBe(422);
    let res = await hints(fx.users.board, { startsAt: SUMMER.endsAt, endsAt: SUMMER.startsAt, calendarId: fx.calA });
    expect([res.status, await codeOf(res)]).toEqual([422, "invalid_time"]);
    res = await hints(fx.users.board, { startsAt: "2026-03-01T10:00:00Z", endsAt: "2026-03-16T10:00:00Z", calendarId: fx.calA });
    expect([res.status, await codeOf(res)]).toEqual([422, "range_too_long"]);
  });

  it("adds the RSVPs of an edited event to the pool and follows visibility grants of a restricted calendar", async () => {
    const event = await fx.addEvent({ calendarId: fx.calB, startsAt: new Date(SUMMER.startsAt) });
    const before = (await fx.json(await hints(fx.users.board, { ...SUMMER, calendarId: fx.calB }))).data;
    expect(before.counts.total).toBe(0);
    await db.insert(eventAttendees).values({ eventId: event.id, memberId: fx.users.member2.memberId, status: "angemeldet" });
    const after = (await fx.json(await hints(fx.users.board, { ...SUMMER, calendarId: fx.calB, eventId: event.id }))).data;
    expect(after).toMatchObject({ eventId: event.id, counts: { total: 1, nicht_verfuegbar: 1 } });
    const [restricted] = await db.insert(calendars).values({ clubId: fx.clubId, name: "Vorstand" }).returning();
    await db.insert(calendarVisibility).values({ calendarId: restricted!.id, roleType: "vorsitz" });
    const board = (await fx.json(await hints(fx.users.board, { ...SUMMER, calendarId: restricted!.id }))).data;
    expect(board).toMatchObject({ pool: "calendar_grants", counts: { total: 1, unbekannt: 1 } });
    const club = (await fx.json(await hints(fx.users.board, { ...SUMMER, calendarId: fx.calClub }))).data;
    expect(club.pool).toBe("club");
    expect(club.counts.total).toBeGreaterThanOrEqual(6);
  });

  it("limits each person to 30 requests a minute", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) statuses.push((await hints(fx.users.leaderA, { ...WINTER, calendarId: fx.calA })).status);
    expect(statuses.at(-1)).toBe(429);
  });
});
