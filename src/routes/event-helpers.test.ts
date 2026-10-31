import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { helperSignups, helperSwapRequests } from "../db/schema/event-helpers.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { createEventFixture, HOUR, type EventFixture } from "./event-test-support.js";

/** Helper plan (Wave 12 B16): management rights, sign-up rules, parallel capacity / overlap / swaps, guardians and minors. */
describe("helper plan", () => {
  let fx: EventFixture;
  let eventId: string;
  let stationId: string;
  const base = Date.now() + 3 * 24 * HOUR;
  const iso = (offsetHours: number) => new Date(base + offsetHours * HOUR).toISOString();
  const call = (who: { cookie: string }, path: string, method = "GET", body?: unknown) => fx.req(who, `/events/${eventId}/helpers${path}`, { method, ...(body === undefined ? {} : { body }) });

  async function shift(capacity: number, from: number, to: number, minStaff = 0, station = stationId) {
    const res = await call(fx.users.board, `/stations/${station}/shifts`, "POST", { startsAt: iso(from), endsAt: iso(to), capacity, minStaff });
    expect(res.status).toBe(201);
    return (await fx.json(res)).data.id as string;
  }

  beforeAll(async () => {
    fx = await createEventFixture("help");
    eventId = (await fx.addEvent({ calendarId: fx.calA, startsAt: new Date(base), endsAt: new Date(base + 10 * HOUR), title: "Sommerfest" })).id;
    const res = await call(fx.users.board, "/stations", "POST", { name: "Kuchenstand" });
    stationId = (await fx.json(res)).data.id;
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("lets only helpers:write inside the scope manage the plan (plain member 403, foreign department 403, other club 404)", async () => {
    expect((await call(fx.users.member1, "/stations", "POST", { name: "X" })).status).toBe(403);
    expect((await call(fx.users.trainerA, "/stations", "POST", { name: "X" })).status).toBe(403);
    expect((await call(fx.users.outsider, "/stations", "POST", { name: "X" })).status).toBe(404);
    expect((await call(fx.users.leaderA, "/stations", "POST", { name: "Getraenke" })).status).toBe(201);
    const foreign = (await fx.addEvent({ calendarId: fx.calB })).id;
    expect((await fx.req(fx.users.leaderA, `/events/${foreign}/helpers/stations`, { method: "POST", body: { name: "X" } })).status).toBe(403);
    // Validation: capacity, time order, minimum staffing.
    for (const bad of [{ startsAt: iso(2), endsAt: iso(1), capacity: 2 }, { startsAt: iso(1), endsAt: iso(2), capacity: 0 }, { startsAt: iso(1), endsAt: iso(2), capacity: 2, minStaff: 3 }]) {
      expect((await call(fx.users.board, `/stations/${stationId}/shifts`, "POST", bad)).status).toBe(422);
    }
    expect((await call(fx.users.board, `/stations/${crypto.randomUUID()}/shifts`, "POST", { startsAt: iso(1), endsAt: iso(2), capacity: 2 })).status).toBe(404);
  });

  it("shows the plan with occupation, understaffing and own shifts to every reader of the event", async () => {
    const s = await shift(2, 0, 2, 2);
    expect((await call(fx.users.member1, `/shifts/${s}/signup`, "POST")).status).toBe(201);
    const view = (await fx.json(await call(fx.users.member1, ""))).data;
    expect(view.canManage).toBe(false);
    const found = view.stations.flatMap((st: any) => st.shifts).find((x: any) => x.id === s); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(found).toMatchObject({ capacity: 2, filled: 1, free: 1, understaffed: true, full: false, mine: true });
    expect(found.signups[0]).toMatchObject({ displayName: "Mitglied Eins", mine: true });
    expect(view.mine.map((m: any) => m.shiftId)).toContain(s); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await fx.json(await call(fx.users.board, ""))).data.canManage).toBe(true);
    expect((await call(fx.users.outsider, "")).status).toBe(404);
    await call(fx.users.member1, `/shifts/${s}/signup`, "DELETE");
  });

  it("is idempotent for a repeated sign-up and refuses overlapping shifts of one person (409) -- also in parallel", async () => {
    const a = await shift(5, 20, 22);
    const b = await shift(5, 21, 23);
    const c = await shift(5, 22, 24);
    expect((await call(fx.users.member1, `/shifts/${a}/signup`, "POST")).status).toBe(201);
    expect((await call(fx.users.member1, `/shifts/${a}/signup`, "POST")).status).toBe(200);
    const overlap = await call(fx.users.member1, `/shifts/${b}/signup`, "POST");
    expect(overlap.status).toBe(409);
    expect((await fx.json(overlap)).error.details).toMatchObject({ code: "shift_overlap", shiftId: a });
    expect((await call(fx.users.member1, `/shifts/${c}/signup`, "POST")).status).toBe(201); // touches, does not overlap
    await call(fx.users.member1, `/shifts/${a}/signup`, "DELETE");
    await call(fx.users.member1, `/shifts/${c}/signup`, "DELETE");

    // Parallel: the same person for two overlapping shifts -> exactly one wins.
    const results = await Promise.all([call(fx.users.member2, `/shifts/${a}/signup`, "POST"), call(fx.users.member2, `/shifts/${b}/signup`, "POST")]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("never overbooks a shift under parallel sign-ups", async () => {
    const accounts = await Promise.all(Array.from({ length: 8 }, (_, i) => fx.addAccount(`Helfer ${i}`)));
    const s = await shift(3, 40, 42);
    const results = await Promise.all(accounts.map((a) => call(a, `/shifts/${s}/signup`, "POST")));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((x) => x === 201)).toHaveLength(3);
    expect(statuses.filter((x) => x === 409)).toHaveLength(5);
    expect(await db.select().from(helperSignups).where(eq(helperSignups.shiftId, s))).toHaveLength(3);
    const full = await call(fx.users.member1, `/shifts/${s}/signup`, "POST");
    expect((await fx.json(full)).error.details.code).toBe("shift_full");
  });

  it("lets the organiser enter members without account, refuses minors for themselves and lets a guardian enter the ward", async () => {
    const s = await shift(4, 50, 52);
    const noAccount = await fx.addAccountless("Oma Helferin", { birthDate: "1950-01-01" });
    expect((await call(fx.users.member1, `/shifts/${s}/signup`, "POST", { clubMemberId: noAccount })).status).toBe(403);
    const added = await call(fx.users.leaderA, `/shifts/${s}/signup`, "POST", { clubMemberId: noAccount });
    expect(added.status).toBe(201);
    const told = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, "%#added"), eq(messageDeliveries.eventKey, "helper.signed_up_by_organiser"), eq(messageDeliveries.clubMemberId, noAccount)));
    expect(told.length).toBeGreaterThan(0);

    const teen = await fx.addAccount("Jugendlicher");
    await db.update(clubMembers).set({ birthDate: "2012-01-01" }).where(eq(clubMembers.id, teen.clubMemberId));
    const refused = await call(teen, `/shifts/${s}/signup`, "POST");
    expect(refused.status).toBe(403);
    expect((await fx.json(refused)).error.details.code).toBe("minor_needs_guardian");

    const kid = await fx.addAccountless("Kind Helfer", { birthDate: "2014-06-01", departmentId: fx.deptA });
    await db.insert(guardianLinks).values({ guardianMemberId: fx.users.member2.memberId, wardClubMemberId: kid, confirmedAt: new Date(), validFrom: "2020-01-01" });
    expect((await call(fx.users.member1, `/shifts/${s}/signup`, "POST", { clubMemberId: kid })).status).toBe(403);
    expect((await call(fx.users.member2, `/shifts/${s}/signup`, "POST", { clubMemberId: kid })).status).toBe(201);
    // The guardian sees the ward's sign-up as theirs; a stranger sees the name only.
    const asGuardian = (await fx.json(await call(fx.users.member2, ""))).data;
    expect(asGuardian.stations.flatMap((st: any) => st.shifts).find((x: any) => x.id === s).signups.find((x: any) => x.clubMemberId === kid).mine).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(fx.users.member2, `/shifts/${s}/signup?clubMemberId=${kid}`, "DELETE")).status).toBe(204);
  });

  it("warns the organisers about a withdrawal shortly before the start, not about an early one", async () => {
    const soonEvent = (await fx.addEvent({ calendarId: fx.calClub, startsAt: new Date(Date.now() + 6 * HOUR) })).id;
    const station = (await fx.json(await fx.req(fx.users.board, `/events/${soonEvent}/helpers/stations`, { method: "POST", body: { name: "Aufbau" } }))).data.id;
    const soon = (await fx.json(await fx.req(fx.users.board, `/events/${soonEvent}/helpers/stations/${station}/shifts`, { method: "POST", body: { startsAt: new Date(Date.now() + 5 * HOUR).toISOString(), endsAt: new Date(Date.now() + 8 * HOUR).toISOString(), capacity: 2 } }))).data.id;
    const early = (await fx.json(await fx.req(fx.users.board, `/events/${soonEvent}/helpers/stations/${station}/shifts`, { method: "POST", body: { startsAt: new Date(Date.now() + 100 * HOUR).toISOString(), endsAt: new Date(Date.now() + 102 * HOUR).toISOString(), capacity: 2 } }))).data.id;
    for (const id of [soon, early]) expect((await fx.req(fx.users.member1, `/events/${soonEvent}/helpers/shifts/${id}/signup`, { method: "POST" })).status).toBe(201);
    for (const id of [soon, early]) expect((await fx.req(fx.users.member1, `/events/${soonEvent}/helpers/shifts/${id}/signup`, { method: "DELETE" })).status).toBe(204);
    const warned = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, "helper.late_cancel"), like(messageDeliveries.refId, `${soon}#%`)));
    expect(warned.length).toBeGreaterThan(0);
    expect(await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, "helper.late_cancel"), like(messageDeliveries.refId, `${early}#%`)))).toHaveLength(0);
  });

  it("changes shifts safely: capacity below the filled count is refused, deleting tells the people, foreign shifts are 404", async () => {
    const s = await shift(2, 60, 62);
    await call(fx.users.member1, `/shifts/${s}/signup`, "POST");
    await call(fx.users.member2, `/shifts/${s}/signup`, "POST");
    const low = await call(fx.users.board, `/shifts/${s}`, "PATCH", { capacity: 1 });
    expect(low.status).toBe(409);
    expect((await fx.json(low)).error.details.code).toBe("capacity_below_filled");
    expect((await call(fx.users.member1, `/shifts/${s}`, "PATCH", { capacity: 5 })).status).toBe(403);
    expect((await call(fx.users.board, `/shifts/${s}`, "PATCH", { capacity: 4, minStaff: 3 })).status).toBe(200);
    const otherEvent = (await fx.addEvent({ calendarId: fx.calA })).id;
    expect((await fx.req(fx.users.board, `/events/${otherEvent}/helpers/shifts/${s}`, { method: "PATCH", body: { capacity: 3 } })).status).toBe(404);
    expect((await call(fx.users.board, `/shifts/${s}`, "DELETE")).status).toBe(204);
    expect(await db.select().from(helperSignups).where(eq(helperSignups.shiftId, s))).toHaveLength(0);
    const removed = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, "helper.shift_removed"), eq(messageDeliveries.refId, `${s}#removed`)));
    expect(removed.length).toBeGreaterThan(0);
  });

  describe("swaps", () => {
    it("hands a shift to a named person: only the addressee accepts, the signup moves and the capacity stays", async () => {
      const s = await shift(1, 70, 72);
      await call(fx.users.member1, `/shifts/${s}/signup`, "POST");
      expect((await call(fx.users.member2, `/shifts/${s}/swaps`, "POST", {})).status).toBe(404); // not signed up
      const swap = await call(fx.users.member1, `/shifts/${s}/swaps`, "POST", { toClubMemberId: fx.users.member2.clubMemberId });
      expect(swap.status).toBe(201);
      const id = (await fx.json(swap)).data.id;
      expect((await call(fx.users.member1, `/shifts/${s}/swaps`, "POST", {})).status).toBe(409); // one open request per signup
      const third = await fx.addAccount("Dritter Helfer");
      const wrong = await call(third, `/swaps/${id}/accept`, "POST");
      expect(wrong.status).toBe(409);
      expect((await fx.json(wrong)).error.details.code).toBe("swap_not_for_you");
      expect((await call(fx.users.member2, `/swaps/${id}/accept`, "POST")).status).toBe(200);
      const rows = await db.select().from(helperSignups).where(eq(helperSignups.shiftId, s));
      expect(rows.map((r) => r.clubMemberId)).toEqual([fx.users.member2.clubMemberId]);
      expect((await call(fx.users.member2, `/swaps/${id}/accept`, "POST")).status).toBe(409); // closed
      const [swapRow] = await db.select().from(helperSwapRequests).where(eq(helperSwapRequests.id, id));
      expect(swapRow).toMatchObject({ status: "angenommen", resolvedByClubMemberId: fx.users.member2.clubMemberId });
      await call(fx.users.member2, `/shifts/${s}/signup`, "DELETE");
    });

    it("lets exactly one of many parallel takers win an open swap", async () => {
      const s = await shift(1, 80, 82);
      await call(fx.users.member1, `/shifts/${s}/signup`, "POST");
      const id = (await fx.json(await call(fx.users.member1, `/shifts/${s}/swaps`, "POST", {}))).data.id;
      const takers = await Promise.all(Array.from({ length: 6 }, (_, i) => fx.addAccount(`Uebernehmer ${i}`)));
      const results = await Promise.all(takers.map((t) => call(t, `/swaps/${id}/accept`, "POST")));
      expect(results.map((r) => r.status).filter((x) => x === 200)).toHaveLength(1);
      expect(results.map((r) => r.status).filter((x) => x === 409)).toHaveLength(5);
      const rows = await db.select().from(helperSignups).where(eq(helperSignups.shiftId, s));
      expect(rows).toHaveLength(1);
      expect(takers.map((t) => t.clubMemberId)).toContain(rows[0]!.clubMemberId);
    });

    it("declines, withdraws, and refuses a taker with an overlapping shift", async () => {
      const s = await shift(1, 90, 92);
      const other = await shift(1, 91, 93);
      await call(fx.users.member1, `/shifts/${s}/signup`, "POST");
      await call(fx.users.member2, `/shifts/${other}/signup`, "POST");
      const toTwo = (await fx.json(await call(fx.users.member1, `/shifts/${s}/swaps`, "POST", { toClubMemberId: fx.users.member2.clubMemberId }))).data.id;
      const clash = await call(fx.users.member2, `/swaps/${toTwo}/accept`, "POST");
      expect(clash.status).toBe(409);
      expect((await fx.json(clash)).error.details.code).toBe("shift_overlap");
      expect((await call(fx.users.member1, `/swaps/${toTwo}/decline`, "POST")).status).toBe(409); // not the addressee
      expect((await call(fx.users.member2, `/swaps/${toTwo}/decline`, "POST")).status).toBe(200);
      const open = (await fx.json(await call(fx.users.member1, `/shifts/${s}/swaps`, "POST", {}))).data.id;
      expect((await call(fx.users.member2, `/swaps/${open}`, "DELETE")).status).toBe(403);
      expect((await call(fx.users.member1, `/swaps/${open}`, "DELETE")).status).toBe(204);
      expect((await call(fx.users.member1, `/swaps/${open}`, "DELETE")).status).toBe(409);
      const foreignEvent = (await fx.addEvent({ calendarId: fx.calClub })).id;
      expect((await fx.req(fx.users.member1, `/events/${foreignEvent}/helpers/swaps/${open}/accept`, { method: "POST" })).status).toBe(404);
    });
  });
});
