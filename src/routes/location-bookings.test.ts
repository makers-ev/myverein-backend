import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import { locations } from "../db/schema/locations.js";
import { createEventFixture, HOUR, type EventFixture } from "./event-test-support.js";
import { locationRoutes } from "./locations.js";

/** Occupancy plan and bookings (Wave 12 B19, P2): bookable flag, collisions with bookings and events, parallel bookings, visibility. */
describe("location bookings", () => {
  let fx: EventFixture;
  let hall: string;
  let shed: string;
  const base = Date.now() + 10 * 24 * HOUR;
  const at = (h: number) => new Date(base + h * HOUR).toISOString();
  const book = (who: { cookie: string }, id: string, startH: number, endH: number, extra: object = {}) => fx.req(who, `/locations/${id}/bookings`, { method: "POST", body: { title: "Training Halle", startsAt: at(startH), endsAt: at(endH), ...extra } });

  beforeAll(async () => {
    fx = await createEventFixture("loc", [["/locations", locationRoutes]]);
    [{ id: hall }] = (await db.insert(locations).values({ clubId: fx.clubId, name: "Halle", bookable: true }).returning()) as [{ id: string }];
    [{ id: shed }] = (await db.insert(locations).values({ clubId: fx.clubId, name: "Schuppen" }).returning()) as [{ id: string }];
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("makes a location bookable through PATCH (locations:write) and exposes the flag", async () => {
    expect((await fx.req(fx.users.member1, `/locations/${shed}`, { method: "PATCH", body: { bookable: true } })).status).toBe(403);
    const res = await fx.req(fx.users.board, `/locations/${shed}`, { method: "PATCH", body: { bookable: true } });
    expect((await fx.json(res)).data.bookable).toBe(true);
    await fx.req(fx.users.board, `/locations/${shed}`, { method: "PATCH", body: { bookable: false } });
    const notBookable = await book(fx.users.board, shed, 1, 2);
    expect(notBookable.status).toBe(409);
    expect((await fx.json(notBookable)).error.details.code).toBe("not_bookable");
  });

  it("books only with locations:write, validates times and refuses collisions (adjacent slots are fine)", async () => {
    expect((await book(fx.users.member1, hall, 0, 1)).status).toBe(403);
    expect((await book(fx.users.trainerA, hall, 0, 1)).status).toBe(403);
    expect((await book(fx.users.outsider, hall, 0, 1)).status).toBe(404);
    expect((await book(fx.users.board, hall, 3, 2)).status).toBe(422);
    const first = await book(fx.users.board, hall, 10, 12);
    expect(first.status).toBe(201);
    const clash = await book(fx.users.board, hall, 11, 13);
    expect(clash.status).toBe(409);
    const details = (await fx.json(clash)).error.details;
    expect(details.code).toBe("location_busy");
    expect(details.conflicts[0]).toMatchObject({ type: "booking", title: "Training Halle" });
    expect((await book(fx.users.board, hall, 12, 14)).status).toBe(201);
    expect((await book(fx.users.board, hall, 8, 10)).status).toBe(201);
  });

  it("treats events at the location as occupation and warns when an event is saved onto an occupied slot", async () => {
    const e = await fx.addEvent({ calendarId: fx.calClub, locationId: hall, startsAt: new Date(base + 30 * HOUR), endsAt: new Date(base + 32 * HOUR), title: "Spieltag" });
    expect((await book(fx.users.board, hall, 31, 33)).status).toBe(409);
    expect((await book(fx.users.board, hall, 32, 34)).status).toBe(201);
    // Creating another event at the same time answers with a warning, not an error.
    const created = await fx.req(fx.users.board, "/events", { method: "POST", body: { calendarId: fx.calClub, title: "Doppelt", startsAt: at(31), endsAt: at(33), locationId: hall } });
    expect(created.status).toBe(201);
    const { data } = await fx.json(created);
    expect(data.locationConflicts.map((c: any) => c.id)).toContain(e.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    const clean = await fx.req(fx.users.board, "/events", { method: "POST", body: { calendarId: fx.calClub, title: "Frei", startsAt: at(50), endsAt: at(51), locationId: hall } });
    expect((await fx.json(clean)).data.locationConflicts).toEqual([]);
    const conflicts = await fx.req(fx.users.member1, `/locations/${hall}/conflicts?startsAt=${encodeURIComponent(at(30))}&endsAt=${encodeURIComponent(at(31))}&excludeEventId=${e.id}`);
    expect((await fx.json(conflicts)).data.free).toBe(true);
    // A linked booking is the same occupation as its event.
    expect((await book(fx.users.board, hall, 70, 72, { eventId: (await fx.addEvent({ calendarId: fx.calClub, locationId: hall, startsAt: new Date(base + 70 * HOUR), endsAt: new Date(base + 72 * HOUR) })).id })).status).toBe(201);
  });

  it("lets exactly one of several parallel bookings for the same slot win", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => book(fx.users.board, hall, 100, 102)));
    expect(results.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect(results.map((r) => r.status).filter((s) => s === 409)).toHaveLength(5);
  });

  it("shows the plan to members; titles of events in calendars the caller cannot see are hidden; outsiders get 404", async () => {
    const secret = await fx.addEvent({ calendarId: fx.calB, locationId: hall, startsAt: new Date(base + 200 * HOUR), endsAt: new Date(base + 201 * HOUR), title: "Vorstandsklausur" });
    await db.insert(calendarVisibility).values({ calendarId: fx.calB, roleType: "vorsitz" });
    const plan = async (who: { cookie: string }) => (await fx.json(await fx.req(who, `/locations/${hall}/bookings?from=${encodeURIComponent(at(190))}&to=${encodeURIComponent(at(210))}`))).data;
    const asMember = await plan(fx.users.member1);
    expect(asMember.bookable).toBe(true);
    expect(asMember.items.find((i: any) => i.id === secret.id)).toMatchObject({ type: "event", title: null }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await plan(fx.users.board)).items.find((i: any) => i.id === secret.id).title).toBe("Vorstandsklausur"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await fx.req(fx.users.outsider, `/locations/${hall}/bookings`)).status).toBe(404);
    expect((await fx.req(fx.users.member1, `/locations/${hall}/bookings?from=${encodeURIComponent(at(0))}&to=${encodeURIComponent(at(24 * 200))}`)).status).toBe(422);
  });

  it("changes and deletes bookings with the same collision check", async () => {
    const a = (await fx.json(await book(fx.users.board, hall, 300, 302))).data.id;
    await book(fx.users.board, hall, 302, 304);
    expect((await fx.req(fx.users.board, `/locations/${hall}/bookings/${a}`, { method: "PATCH", body: { endsAt: at(303) } })).status).toBe(409);
    expect((await fx.req(fx.users.board, `/locations/${hall}/bookings/${a}`, { method: "PATCH", body: { title: "Neu", endsAt: at(301) } })).status).toBe(200);
    expect((await fx.req(fx.users.member1, `/locations/${hall}/bookings/${a}`, { method: "DELETE" })).status).toBe(403);
    expect((await fx.req(fx.users.board, `/locations/${hall}/bookings/${a}`, { method: "DELETE" })).status).toBe(204);
    expect((await fx.req(fx.users.board, `/locations/${hall}/bookings/${a}`, { method: "DELETE" })).status).toBe(404);
    expect((await fx.req(fx.users.board, `/locations/${shed}/bookings/${a}`, { method: "DELETE" })).status).toBe(404);
  });
});
