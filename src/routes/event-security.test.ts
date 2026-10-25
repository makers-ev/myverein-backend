import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { eventAttendance } from "../db/schema/event-attendance.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { eventRegistrationSettings } from "../db/schema/event-extras.js";
import { timeEntries } from "../db/schema/event-extras.js";
import { sweepUnconfirmedGuests } from "../lib/event-guests.js";
import { attendanceReportRoutes } from "./attendance-report.js";
import { createEventFixture, HOUR, type EventFixture } from "./event-test-support.js";
import { locationRoutes } from "./locations.js";
import { publicEventRoutes } from "./public-events.js";
import { rateCardRoutes, timeEntryRoutes, timeReportRoutes } from "./time-tracking.js";

/**
 * Wave 12 B21: IDOR between clubs and departments, external guests, public-route abuse and parallel runs of the new routes.
 * (The deny-by-default matrix of all writing routes is `rights-matrix.test.ts`.)
 */
describe("events, attendance, helpers: security and parallel runs", () => {
  let fx: EventFixture;
  let eventA: string;
  let eventB: string;
  let shiftA: string;
  let rideA: string;
  let locationId: string;
  let timeEntryA: string;

  const as = (who: { cookie: string }, path: string, init: { method?: string; body?: unknown; club?: string } = {}) => fx.req(who, path, init);
  const pub = (path: string, init: { method?: string; body?: unknown; ip?: string } = {}) =>
    fx.app.request(`/public${path}`, { method: init.method ?? "GET", headers: { "content-type": "application/json", "x-forwarded-for": init.ip ?? randomUUID() }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });

  beforeAll(async () => {
    fx = await createEventFixture("sec", [["/attendance", attendanceReportRoutes], ["/locations", locationRoutes], ["/public", publicEventRoutes], ["/time-entries", timeEntryRoutes], ["/rate-cards", rateCardRoutes], ["/time-report", timeReportRoutes]]);
    eventA = (await fx.addEvent({ calendarId: fx.calA, capacity: 3, startsAt: new Date(Date.now() + 2 * 24 * HOUR), endsAt: new Date(Date.now() + 2 * 24 * HOUR + 2 * HOUR) })).id;
    eventB = (await fx.addEvent({ calendarId: fx.calB, capacity: 3, startsAt: new Date(Date.now() + 2 * 24 * HOUR) })).id;
    for (const id of [eventA, eventB]) await as(fx.users.board, `/events/${id}/registration`, { method: "PUT", body: { enabled: true, allowGuests: true, maxCompanions: 2 } });
    const station = (await fx.json(await as(fx.users.board, `/events/${eventA}/helpers/stations`, { method: "POST", body: { name: "Kasse" } }))).data.id;
    shiftA = (await fx.json(await as(fx.users.board, `/events/${eventA}/helpers/stations/${station}/shifts`, { method: "POST", body: { startsAt: new Date(Date.now() + 49 * HOUR).toISOString(), endsAt: new Date(Date.now() + 51 * HOUR).toISOString(), capacity: 2 } }))).data.id;
    rideA = (await fx.json(await as(fx.users.member1, `/events/${eventA}/rides`, { method: "POST", body: { seats: 2, departurePlace: "Privatadresse 1" } }))).data.id;
    const res = await as(fx.users.board, "/locations", { method: "POST", body: { name: "Halle", bookable: true } });
    locationId = (await fx.json(res)).data.id;
    const [entry] = await db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId: fx.users.trainerA.clubMemberId, startedAt: new Date(Date.now() - 5 * HOUR), endedAt: new Date(Date.now() - 4 * HOUR), source: "manuell", status: "offen" }).returning();
    timeEntryA = entry!.id;
  }, 90_000);
  afterAll(async () => fx.cleanup());

  it("keeps the other club out of every new route (board of club B with club A ids: 404 or 403, never data)", async () => {
    const other = fx.otherClubId;
    const memberA = fx.users.member1.clubMemberId;
    const calls: Array<[string, string, string, unknown?]> = [
      ["GET", `/events/${eventA}/attendance`, "attendance"],
      ["PUT", `/events/${eventA}/attendance`, "attendance", { entries: [{ clubMemberId: memberA, status: "anwesend" }] }],
      ["PUT", `/events/${eventA}/attendance/supervisors`, "supervisors", { clubMemberIds: [memberA] }],
      ["POST", `/events/${eventA}/attendance/close`, "close", {}],
      ["GET", `/events/${eventA}/registrations`, "registrations"],
      ["GET", `/events/${eventA}/registrations.csv`, "csv"],
      ["PUT", `/events/${eventA}/registration`, "settings", { enabled: true }],
      ["POST", `/events/${eventA}/public-link`, "link"],
      ["DELETE", `/events/${eventA}/public-link`, "link-revoke"],
      ["GET", `/events/${eventA}/helpers`, "plan"],
      ["POST", `/events/${eventA}/helpers/stations`, "station", { name: "Fremd" }],
      ["GET", `/events/${eventA}/helpers/suggestions`, "suggestions"],
      ["POST", `/events/${eventA}/helpers/shifts/${shiftA}/signup`, "signup", {}],
      ["GET", `/events/${eventA}/rides`, "rides"],
      ["POST", `/events/${eventA}/rides`, "ride", { seats: 2, departurePlace: "x" }],
      ["POST", `/events/${eventA}/rides/${rideA}/requests`, "request", {}],
      ["POST", `/events/${eventA}/rsvp`, "rsvp", {}],
      ["GET", `/attendance/report?memberId=${memberA}`, "report"],
      ["GET", `/attendance/report?departmentId=${fx.deptA}`, "report-dept"],
      ["GET", `/locations/${locationId}/bookings`, "plan"],
      ["POST", `/locations/${locationId}/bookings`, "booking", { title: "x", startsAt: new Date(Date.now() + 9 * HOUR).toISOString(), endsAt: new Date(Date.now() + 10 * HOUR).toISOString() }],
      ["POST", `/time-entries/${timeEntryA}/confirm`, "confirm"],
    ];
    for (const [method, path, label, body] of calls) {
      const res = await as(fx.users.outsider, path, { method, club: other, ...(body === undefined ? {} : { body }) });
      expect([403, 404], `${label}: ${method} ${path} -> ${res.status}`).toContain(res.status);
    }
    // And nothing changed.
    expect(await db.select().from(eventAttendance)).toEqual(expect.not.arrayContaining([expect.objectContaining({ clubMemberId: memberA })]));
    const [entry] = await db.select().from(timeEntries).where(eq(timeEntries.id, timeEntryA));
    expect(entry!.status).toBe("offen");
  });

  it("keeps a trainer / department lead out of the events of another department", async () => {
    for (const who of [fx.users.trainerA, fx.users.leaderA]) {
      for (const [method, path, body] of [
        ["GET", `/events/${eventB}/attendance`],
        ["PUT", `/events/${eventB}/attendance`, { entries: [{ guestName: "Eindringling", status: "anwesend" }] }],
        ["POST", `/events/${eventB}/attendance/close`, {}],
        ["GET", `/events/${eventB}/registrations`],
        ["GET", `/events/${eventB}/registrations.csv`],
        ["POST", `/events/${eventB}/helpers/stations`, { name: "x" }],
        ["GET", `/events/${eventB}/helpers/suggestions`],
      ] as Array<[string, string, unknown?]>) {
        const res = await as(who, path, { method, ...(body === undefined ? {} : { body }) });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
    }
    expect(await db.select().from(eventAttendance).where(eq(eventAttendance.guestName, "Eindringling"))).toHaveLength(0);
    // ... while their own department works.
    expect((await as(fx.users.trainerA, `/events/${eventA}/attendance`)).status).toBe(200);
    expect((await as(fx.users.leaderA, `/events/${eventA}/registrations`)).status).toBe(200);
  });

  it("refuses plain members and external guests on every management read and on time tracking", async () => {
    const guest = await fx.addGuest("Eltern Gast");
    for (const who of [fx.users.member1, guest]) {
      for (const path of [`/events/${eventA}/attendance`, `/events/${eventA}/registrations`, `/events/${eventA}/registrations.csv`, `/events/${eventA}/helpers/suggestions`, "/rate-cards", "/time-report", "/time-entries", `/attendance/report?departmentId=${fx.deptA}`]) {
        const res = await as(who, path);
        expect([403, 404], `${path} -> ${res.status}`).toContain(res.status);
        expect(res.status).not.toBe(200);
      }
    }
    // An external guest cannot sign up for shifts or stamp time.
    expect([403, 404]).toContain((await as(guest, `/events/${eventA}/helpers/shifts/${shiftA}/signup`, { method: "POST", body: {} })).status);
    expect((await as(guest, "/time-entries/clock-in", { method: "POST", body: {} })).status).toBe(403);
  });

  it("does not let a plain member change other people's helper, ride or time rows", async () => {
    const signup = await as(fx.users.member1, `/events/${eventA}/helpers/shifts/${shiftA}/signup`, { method: "POST", body: {} });
    expect(signup.status).toBe(201);
    // member2 cannot remove or swap member1's sign-up by naming them.
    expect((await as(fx.users.member2, `/events/${eventA}/helpers/shifts/${shiftA}/signup?clubMemberId=${fx.users.member1.clubMemberId}`, { method: "DELETE" })).status).toBe(403);
    expect((await as(fx.users.member2, `/events/${eventA}/helpers/shifts/${shiftA}/swaps`, { method: "POST", body: { clubMemberId: fx.users.member1.clubMemberId } })).status).toBe(403);
    // ... nor the ride of member1 (change, delete, decide about requests) or their time entries.
    expect((await as(fx.users.member2, `/events/${eventA}/rides/${rideA}`, { method: "PATCH", body: { seats: 5 } })).status).toBe(403);
    expect((await as(fx.users.member2, `/events/${eventA}/rides/${rideA}`, { method: "DELETE" })).status).toBe(403);
    expect((await as(fx.users.trainerA, `/time-entries/${timeEntryA}/confirm`, { method: "POST" })).status).toBe(403);
    expect((await as(fx.users.leaderA, `/time-entries/${timeEntryA}`, { method: "PATCH", body: { endedAt: new Date().toISOString() } })).status).toBe(404);
    expect((await as(fx.users.leaderA, `/time-entries/${timeEntryA}`, { method: "DELETE" })).status).toBe(404);
    expect(await db.select().from(timeEntries).where(eq(timeEntries.id, timeEntryA))).toHaveLength(1);
    // The place of the ride stays hidden from uninvolved members and the trainer.
    const ride = (await fx.json(await as(fx.users.member2, `/events/${eventA}/rides`))).data.rides.find((r: any) => r.id === rideA); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ride.departurePlace).toBeNull();
    expect(JSON.stringify(await fx.json(await as(fx.users.member2, `/events/${eventA}/rides`)))).not.toContain("Privatadresse");
  });

  describe("public guest routes", () => {
    let token: string;
    let event: string;
    const mail = (n: string) => `sec-${n}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

    beforeAll(async () => {
      event = (await fx.addEvent({ calendarId: fx.calClub, capacity: 2, title: "Offenes Fest" })).id;
      await as(fx.users.board, `/events/${event}/registration`, { method: "PUT", body: { enabled: true, allowGuests: true, maxCompanions: 1 } });
      token = (await fx.json(await as(fx.users.board, `/events/${event}/public-link`, { method: "POST" }))).data.token;
    });

    const codeOf = async (to: string) => {
      const rows = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${event}%`), eq(messageDeliveries.eventKey, "event.guest_confirm"), eq(messageDeliveries.address, to)));
      return (rows.at(-1)!.content as { ctaUrl: string }).ctaUrl.split("/").at(-1)!;
    };

    it("answers a flood of registrations from one address with 429 and never sets a cookie or echoes the address", async () => {
      const ip = randomUUID();
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < 12; i += 1) {
        last = await pub(`/events/${token}/registrations`, { method: "POST", ip, body: { name: "Flut", email: mail(`flood${i}`), privacyAccepted: true } });
        statuses.push(last.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
      expect(statuses.slice(10)).toContain(429);
      expect(last!.headers.get("set-cookie")).toBeNull();
      const body = await (await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Echo", email: "echo-check@example.com", privacyAccepted: true } })).text();
      expect(body).not.toContain("echo-check");
    });

    it("keeps the three secrets apart (link, confirmation code, management token) and kills the link on revocation", async () => {
      const g = mail("secrets");
      await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Gina", email: g, privacyAccepted: true } });
      const code = await codeOf(g);
      // The code is not an event link and not a management token; the event link is not a code.
      expect((await pub(`/events/${code}`)).status).toBe(404);
      expect((await pub(`/registrations/${code}`)).status).toBe(404);
      expect((await pub("/registrations/confirm", { method: "POST", body: { code: token } })).status).toBe(404);
      const done = (await fx.json(await pub("/registrations/confirm", { method: "POST", body: { code } }))).data;
      expect((await pub(`/registrations/${code}`)).status).toBe(404); // an unconfirmed-stage secret never manages
      expect((await pub("/registrations/confirm", { method: "POST", body: { code: done.manageToken } })).status).toBe(404);
      // Revoked link: no new registrations, the existing guest keeps the management link.
      await as(fx.users.board, `/events/${event}/public-link`, { method: "DELETE" });
      expect((await pub(`/events/${token}`)).status).toBe(404);
      expect((await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Spaet", email: mail("late"), privacyAccepted: true } })).status).toBe(404);
      expect((await pub(`/registrations/${done.manageToken}`)).status).toBe(200);
      // A new link is a new secret.
      const fresh = (await fx.json(await as(fx.users.board, `/events/${event}/public-link`, { method: "POST" }))).data.token;
      expect(fresh).not.toBe(token);
      token = fresh;
    });

    it("confirms a code exactly once even when clicked in parallel, and never overfills with parallel confirmations", async () => {
      const g = mail("twice");
      await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Doppelt", email: g, privacyAccepted: true } });
      const code = await codeOf(g);
      const results = await Promise.all(Array.from({ length: 5 }, () => pub("/registrations/confirm", { method: "POST", body: { code } })));
      const bodies = await Promise.all(results.map(async (r) => (await r.json()) as { data: { alreadyConfirmed: boolean; manageToken: string | null } }));
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(bodies.filter((b) => !b.data.alreadyConfirmed)).toHaveLength(1);
      expect(bodies.filter((b) => b.data.manageToken !== null)).toHaveLength(1);

      // Capacity 2: of 6 guests confirming at once exactly the free seats are taken.
      const roomy = (await fx.addEvent({ calendarId: fx.calClub, capacity: 3, title: "Knapp" })).id;
      await as(fx.users.board, `/events/${roomy}/registration`, { method: "PUT", body: { enabled: true, allowGuests: true } });
      const linkToken = (await fx.json(await as(fx.users.board, `/events/${roomy}/public-link`, { method: "POST" }))).data.token as string;
      const addresses = Array.from({ length: 6 }, (_, i) => mail(`cap${i}`));
      for (const a of addresses) await pub(`/events/${linkToken}/registrations`, { method: "POST", body: { name: "Kap", email: a, privacyAccepted: true } });
      const codes = await Promise.all(addresses.map(async (a) => {
        const rows = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${roomy}%`), eq(messageDeliveries.eventKey, "event.guest_confirm"), eq(messageDeliveries.address, a)));
        return (rows.at(-1)!.content as { ctaUrl: string }).ctaUrl.split("/").at(-1)!;
      }));
      const confirmed = await Promise.all(codes.map((c) => pub("/registrations/confirm", { method: "POST", body: { code: c } })));
      expect(confirmed.every((r) => r.status === 200)).toBe(true);
      const rows = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, roomy));
      expect(rows.filter((r) => r.status === "angemeldet")).toHaveLength(3);
      expect(rows.filter((r) => r.status === "warteliste")).toHaveLength(3);
    });

    it("drops unconfirmed sign-ups after 48 hours by itself (independent of the retention dry run) and keeps confirmed ones", async () => {
      const g = mail("sweep");
      await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Nie bestaetigt", email: g, privacyAccepted: true } });
      const confirmedMail = mail("kept");
      await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Bestaetigt", email: confirmedMail, privacyAccepted: true } });
      await pub("/registrations/confirm", { method: "POST", body: { code: await codeOf(confirmedMail) } });
      await db.update(eventAttendees).set({ guestDeleteAfter: new Date(Date.now() - 1000) }).where(eq(eventAttendees.guestEmail, g));
      await db.update(eventAttendees).set({ guestDeleteAfter: new Date(Date.now() - 1000) }).where(eq(eventAttendees.guestEmail, confirmedMail));
      expect(await sweepUnconfirmedGuests()).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(eventAttendees).where(eq(eventAttendees.guestEmail, g))).toHaveLength(0);
      expect(await db.select().from(eventAttendees).where(eq(eventAttendees.guestEmail, confirmedMail))).toHaveLength(1);
    });
  });

  it("runs parallel attendance writes and a parallel close without duplicates or server errors", async () => {
    const kid = await fx.addAccountless("Paralleles Kind", { departmentId: fx.deptA });
    const writes = await Promise.all(Array.from({ length: 6 }, () => as(fx.users.trainerA, `/events/${eventA}/attendance`, { method: "PUT", body: { entries: [{ clubMemberId: kid, status: "anwesend" }] } })));
    expect(writes.map((r) => r.status).every((s) => s === 200)).toBe(true);
    expect(await db.select().from(eventAttendance).where(eq(eventAttendance.clubMemberId, kid))).toHaveLength(1);
    const closes = await Promise.all(Array.from({ length: 4 }, () => as(fx.users.leaderA, `/events/${eventA}/attendance/close`, { method: "POST", body: {} })));
    expect(closes.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
    expect(closes.map((r) => r.status).filter((s) => s === 409)).toHaveLength(3);
  });

  it("keeps attendance and registration settings consistent: no seats without settings, cancelled events accept nothing", async () => {
    const plain = (await fx.addEvent({ calendarId: fx.calClub })).id;
    await db.delete(eventRegistrationSettings).where(eq(eventRegistrationSettings.eventId, plain));
    expect((await as(fx.users.member1, `/events/${plain}/rsvp`, { method: "POST", body: { partySize: 2 } })).status).toBe(422);
    const cancelled = (await fx.addEvent({ calendarId: fx.calA, cancelledAt: new Date() })).id;
    expect((await as(fx.users.leaderA, `/events/${cancelled}/attendance`, { method: "PUT", body: { entries: [{ guestName: "Geist", status: "anwesend" }] } })).status).toBe(409);
    expect((await as(fx.users.member1, `/events/${cancelled}/rsvp`, { method: "POST", body: {} })).status).toBe(409);
    expect((await as(fx.users.member1, `/events/${cancelled}/helpers`)).status).toBe(200);
  });
});
