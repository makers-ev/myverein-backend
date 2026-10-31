import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { eventRideRequests } from "../db/schema/event-extras.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { createEventFixture, HOUR, type EventFixture, type TestUser } from "./event-test-support.js";

/** Ride sharing (Wave 12 B18, P2): offer, request, confirm under a seat lock, minors via guardians, place visible to the involved only. */
describe("event rides", () => {
  let fx: EventFixture;
  let eventId: string;
  const call = (who: { cookie: string }, path: string, method = "GET", body?: unknown) => fx.req(who, `/events/${eventId}/rides${path}`, { method, ...(body === undefined ? {} : { body }) });
  const offer = async (who: TestUser, seats = 2, extra: object = {}) => (await fx.json(await call(who, "", "POST", { seats, departurePlace: "Hauptstr. 12, Parkplatz", departureAt: new Date(Date.now() + 40 * HOUR).toISOString(), note: "Klingeln", ...extra }))).data.id as string;

  beforeAll(async () => {
    fx = await createEventFixture("ride");
    eventId = (await fx.addEvent({ calendarId: fx.calClub, startsAt: new Date(Date.now() + 48 * HOUR), title: "Auswaertsspiel" })).id;
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("shows the place and note only to the involved; others see that a ride exists", async () => {
    const ride = await offer(fx.users.member1, 2);
    const asOther = (await fx.json(await call(fx.users.member2, ""))).data.rides.find((r: any) => r.id === ride); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(asOther).toMatchObject({ seats: 2, seatsFree: 2, placeHidden: true, departurePlace: null, note: null, mine: false });
    expect(asOther.requests).toBeUndefined();
    const asDriver = (await fx.json(await call(fx.users.member1, ""))).data.rides.find((r: any) => r.id === ride); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(asDriver).toMatchObject({ departurePlace: "Hauptstr. 12, Parkplatz", note: "Klingeln", placeHidden: false, mine: true });
    // Asking makes one "involved": the place appears for the requester (not for the others).
    const req = await call(fx.users.member2, `/${ride}/requests`, "POST", {});
    expect(req.status).toBe(201);
    const afterAsk = (await fx.json(await call(fx.users.member2, ""))).data.rides.find((r: any) => r.id === ride); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(afterAsk).toMatchObject({ departurePlace: "Hauptstr. 12, Parkplatz", placeHidden: false });
    expect((await fx.json(await call(fx.users.trainerA, ""))).data.rides[0].departurePlace).toBeNull();
    expect((await call(fx.users.outsider, "")).status).toBe(404);
  });

  it("refuses invalid offers: minors drive nothing, seats are bounded, unknown events are 404", async () => {
    const teen = await fx.addAccount("Fahrschueler");
    await db.update(clubMembers).set({ birthDate: "2010-01-01" }).where(eq(clubMembers.id, teen.clubMemberId));
    const minor = await call(teen, "", "POST", { seats: 2, departurePlace: "Hier" });
    expect(minor.status).toBe(422);
    expect((await fx.json(minor)).error.details.code).toBe("driver_must_be_adult");
    expect((await call(fx.users.member1, "", "POST", { seats: 0, departurePlace: "Hier" })).status).toBe(422);
    expect((await call(fx.users.member1, "", "POST", { seats: 9, departurePlace: "Hier" })).status).toBe(422);
    expect((await fx.req(fx.users.member1, `/events/${crypto.randomUUID()}/rides`, { method: "POST", body: { seats: 2, departurePlace: "Hier" } })).status).toBe(404);
    expect((await call(fx.users.member1, "", "POST", { seats: 2, departurePlace: "Hier", clubMemberId: fx.users.member2.clubMemberId })).status).toBe(403);
  });

  it("lets the driver confirm only as many passengers as there are seats -- also in parallel -- and frees a seat on withdrawal", async () => {
    const ride = await offer(fx.users.leaderA, 2);
    const people = await Promise.all(Array.from({ length: 4 }, (_, i) => fx.addAccount(`Mitfahrer ${i}`)));
    const requests = await Promise.all(people.map(async (p) => (await fx.json(await call(p, `/${ride}/requests`, "POST", {}))).data.requestId as string));
    expect((await call(people[0]!, `/${ride}/requests`, "POST", {})).status).toBe(409); // already asked
    // Only the driver decides.
    expect((await call(people[1]!, `/${ride}/requests/${requests[1]}`, "PATCH", { status: "zugesagt" })).status).toBe(403);
    const results = await Promise.all(requests.map((id) => call(fx.users.leaderA, `/${ride}/requests/${id}`, "PATCH", { status: "zugesagt" })));
    expect(results.map((r) => r.status).filter((s) => s === 200)).toHaveLength(2);
    expect(results.map((r) => r.status).filter((s) => s === 409)).toHaveLength(2);
    const confirmed = await db.select().from(eventRideRequests).where(eq(eventRideRequests.rideId, ride));
    expect(confirmed.filter((r) => r.status === "zugesagt")).toHaveLength(2);
    const winner = confirmed.find((r) => r.status === "zugesagt")!;
    const winnerUser = people.find((p) => p.clubMemberId === winner.passengerClubMemberId)!;
    const loser = confirmed.find((r) => r.status === "angefragt")!;
    expect((await fx.json(await call(fx.users.leaderA, `/${ride}/requests/${loser.id}`, "PATCH", { status: "zugesagt" }))).error.details.code).toBe("ride_full");
    expect((await call(winnerUser, `/${ride}/requests/${winner.id}`, "DELETE")).status).toBe(204);
    expect((await call(fx.users.leaderA, `/${ride}/requests/${loser.id}`, "PATCH", { status: "zugesagt" })).status).toBe(200);
    // Lowering the seats below the confirmed passengers is refused.
    expect((await call(fx.users.leaderA, `/${ride}`, "PATCH", { seats: 1 })).status).toBe(409);
    expect((await call(fx.users.member2, `/${ride}`, "PATCH", { seats: 3 })).status).toBe(403);
    expect((await call(fx.users.leaderA, `/${ride}`, "PATCH", { seats: 3 })).status).toBe(200);
  });

  it("takes minors along only through their guardians, and lets the driver cancel a ride (passengers are told)", async () => {
    // A guardian sees the events of the ward's department calendars.
    eventId = (await fx.addEvent({ calendarId: fx.calA, startsAt: new Date(Date.now() + 48 * HOUR), title: "Jugendspiel" })).id;
    const ride = await offer(fx.users.member1, 3);
    const kid = await fx.addAccountless("Mitfahrkind", { birthDate: "2015-05-05", departmentId: fx.deptA });
    await db.insert(guardianLinks).values({ guardianMemberId: fx.users.member2.memberId, wardClubMemberId: kid, confirmedAt: new Date(), validFrom: "2020-01-01" });
    expect((await call(fx.users.trainerA, `/${ride}/requests`, "POST", { clubMemberId: kid })).status).toBe(403);
    const asked = await call(fx.users.member2, `/${ride}/requests`, "POST", { clubMemberId: kid });
    expect(asked.status).toBe(201);
    const requestId = (await fx.json(asked)).data.requestId;
    const teen = await fx.addAccount("Teen Mitfahrer");
    await db.update(clubMembers).set({ birthDate: "2011-01-01" }).where(eq(clubMembers.id, teen.clubMemberId));
    expect((await fx.json(await call(teen, `/${ride}/requests`, "POST", {}))).error.details.code).toBe("minor_needs_guardian");
    // The guardian withdraws, then asks again; the driver cancels the whole ride.
    expect((await call(fx.users.member2, `/${ride}/requests/${requestId}`, "DELETE")).status).toBe(204);
    expect((await call(fx.users.member1, `/${ride}`, "DELETE")).status).toBe(204);
    expect((await call(fx.users.member1, `/${ride}`, "DELETE")).status).toBe(404);
  });
});
