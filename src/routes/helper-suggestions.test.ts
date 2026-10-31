import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { sweepHelperReminders } from "../lib/helper-reminders.js";
import { wallClock } from "../lib/helper-suggestions.js";
import { createEventFixture, HOUR, type EventFixture } from "./event-test-support.js";

/** Availability hints and reminders of the helper plan (Wave 12 B17). */
describe("helper suggestions and reminders", () => {
  let fx: EventFixture;
  let eventId: string;
  let stationId: string;
  const start = new Date(Date.now() + 5 * 24 * HOUR);
  start.setUTCMinutes(0, 0, 0);
  const hours = (n: number) => new Date(start.getTime() + n * HOUR).toISOString();
  const call = (who: { cookie: string }, path: string, method = "GET", body?: unknown) => fx.req(who, `/events/${eventId}/helpers${path}`, { method, ...(body === undefined ? {} : { body }) });

  beforeAll(async () => {
    fx = await createEventFixture("sug");
    eventId = (await fx.addEvent({ calendarId: fx.calClub, startsAt: start, endsAt: new Date(start.getTime() + 8 * HOUR), title: "Turnier" })).id;
    stationId = (await fx.json(await call(fx.users.board, "/stations", "POST", { name: "Grill" }))).data.id;
  }, 60_000);
  afterAll(async () => fx.cleanup());

  async function shift(fromH: number, toH: number, minStaff = 0, capacity = 3) {
    return (await fx.json(await call(fx.users.board, `/stations/${stationId}/shifts`, "POST", { startsAt: hours(fromH), endsAt: hours(toH), capacity, minStaff }))).data.id as string;
  }

  it("gives availability hints without ranking: available, not available, unknown (no account / no data)", async () => {
    const s = await shift(1, 3);
    const local = wallClock(new Date(hours(1)), "Europe/Berlin");
    const weekday = (local.getDay() + 6) % 7;
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
    // member1: regular slot covering the whole shift; member2: slot but an "away" exception on the day; board: no data at all.
    await db.insert(availabilitySlots).values([
      { memberId: fx.users.member1.memberId, weekday, startTime: "00:00", endTime: "23:59" },
      { memberId: fx.users.member2.memberId, weekday, startTime: "00:00", endTime: "23:59" },
    ]);
    await db.insert(availabilityExceptions).values({ memberId: fx.users.member2.memberId, date: dateStr, isAvailable: false });
    const noAccount = await fx.addAccountless("Anna Ohne Konto");

    const res = await call(fx.users.board, "/suggestions");
    expect(res.status).toBe(200);
    const { data } = await fx.json(res);
    const list = data.shifts.find((x: any) => x.shiftId === s).candidates as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const by = (id: string) => list.find((c) => c.clubMemberId === id);
    expect(by(fx.users.member1.clubMemberId).availability).toBe("verfuegbar");
    expect(by(fx.users.member2.clubMemberId).availability).toBe("nicht_verfuegbar");
    expect(by(fx.users.board.clubMemberId).availability).toBe("unbekannt");
    expect(by(noAccount)).toMatchObject({ availability: "unbekannt", hasAccount: false });
    // Sorted by name, nothing else.
    const names = list.map((c) => c.displayName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "de")));
    expect(Object.keys(by(noAccount)).sort()).toEqual(["alreadyOnShift", "availability", "clubMemberId", "conflicting", "displayName", "hasAccount", "isMinor"]);
  });

  it("flags people who are already on the shift or have an overlapping one; refuses plain members and foreign scopes", async () => {
    const a = await shift(10, 12);
    const b = await shift(11, 13);
    await call(fx.users.member1, `/shifts/${a}/signup`, "POST");
    const { data } = await fx.json(await call(fx.users.board, "/suggestions"));
    const forB = data.shifts.find((x: any) => x.shiftId === b).candidates.find((c: any) => c.clubMemberId === fx.users.member1.clubMemberId); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(forB).toMatchObject({ conflicting: true, alreadyOnShift: false });
    expect(data.shifts.find((x: any) => x.shiftId === a).candidates.find((c: any) => c.clubMemberId === fx.users.member1.clubMemberId).alreadyOnShift).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(fx.users.member1, "/suggestions")).status).toBe(403);
    expect((await call(fx.users.trainerA, "/suggestions")).status).toBe(403);
    expect((await call(fx.users.outsider, "/suggestions")).status).toBe(404);
    const deptEvent = (await fx.addEvent({ calendarId: fx.calB })).id;
    expect((await fx.req(fx.users.leaderA, `/events/${deptEvent}/helpers/suggestions`)).status).toBe(403);
  });

  it("reminds helpers 24 h ahead and the organisers about open shifts 48 h ahead -- once, and not for cancelled events", async () => {
    const soonEvent = (await fx.addEvent({ calendarId: fx.calClub, startsAt: new Date(Date.now() + 20 * HOUR), title: "Morgen" })).id;
    const st = (await fx.json(await fx.req(fx.users.board, `/events/${soonEvent}/helpers/stations`, { method: "POST", body: { name: "Kasse" } }))).data.id;
    const mk = async (fromH: number, minStaff: number) =>
      (await fx.json(await fx.req(fx.users.board, `/events/${soonEvent}/helpers/stations/${st}/shifts`, { method: "POST", body: { startsAt: new Date(Date.now() + fromH * HOUR).toISOString(), endsAt: new Date(Date.now() + (fromH + 2) * HOUR).toISOString(), capacity: 3, minStaff } }))).data.id as string;
    const near = await mk(20, 2);
    const mid = await mk(40, 2);
    const far = await mk(60, 2);
    await fx.req(fx.users.member1, `/events/${soonEvent}/helpers/shifts/${near}/signup`, { method: "POST" });
    await fx.req(fx.users.member2, `/events/${soonEvent}/helpers/shifts/${mid}/signup`, { method: "POST" });
    const cancelledEvent = (await fx.addEvent({ calendarId: fx.calClub, startsAt: new Date(Date.now() + 10 * HOUR), cancelledAt: new Date() })).id;
    const cst = (await fx.json(await fx.req(fx.users.board, `/events/${cancelledEvent}/helpers/stations`, { method: "POST", body: { name: "X" } }))).data.id;
    const cShift = (await fx.json(await fx.req(fx.users.board, `/events/${cancelledEvent}/helpers/stations/${cst}/shifts`, { method: "POST", body: { startsAt: new Date(Date.now() + 10 * HOUR).toISOString(), endsAt: new Date(Date.now() + 12 * HOUR).toISOString(), capacity: 2, minStaff: 2 } }))).data.id as string;

    await sweepHelperReminders();
    const rows = async (key: string, shiftId: string) => db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, key), like(messageDeliveries.refId, `${shiftId}#%`)));
    const reminder = await rows("helper.reminder", near);
    expect(reminder.some((r) => r.clubMemberId === fx.users.member1.clubMemberId && r.channel === "in_app")).toBe(true);
    expect(await rows("helper.reminder", mid)).toHaveLength(0); // more than 24 h away
    expect((await rows("helper.shift_open", near)).length).toBeGreaterThan(0); // 1 of 2: open
    expect((await rows("helper.shift_open", mid)).length).toBeGreaterThan(0);
    expect(await rows("helper.shift_open", far)).toHaveLength(0); // beyond 48 h
    expect(await rows("helper.shift_open", cShift)).toHaveLength(0);
    expect(await rows("helper.reminder", cShift)).toHaveLength(0);

    const before = (await rows("helper.reminder", near)).length + (await rows("helper.shift_open", near)).length;
    await sweepHelperReminders();
    await sweepHelperReminders();
    expect((await rows("helper.reminder", near)).length + (await rows("helper.shift_open", near)).length).toBe(before);
  });
});
