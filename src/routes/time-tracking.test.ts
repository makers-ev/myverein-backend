import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { clubMemberDepartments } from "../db/schema/club-members.js";
import { eventAttendanceSheets, eventAttendanceSupervisors } from "../db/schema/event-attendance.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { rateCards, timeEntries } from "../db/schema/event-extras.js";
import { rateOn } from "../lib/time-tracking.js";
import { createEventFixture, HOUR, type EventFixture, type TestUser } from "./event-test-support.js";
import { rateCardRoutes, timeEntryRoutes, timeReportRoutes } from "./time-tracking.js";

/** Time tracking (Wave 12 B20, P2): stamping, entries from events, confirmation scope, rates and the report -- report only. */
describe("time tracking", () => {
  let fx: EventFixture;
  const call = (who: { cookie: string }, path: string, method = "GET", body?: unknown) => fx.req(who, path, { method, ...(body === undefined ? {} : { body }) });
  const manual = (who: TestUser, startH: number, endH: number, extra: object = {}) =>
    call(who, "/time-entries", "POST", { startedAt: new Date(Date.now() + startH * HOUR).toISOString(), endedAt: new Date(Date.now() + endH * HOUR).toISOString(), ...extra });

  beforeAll(async () => {
    fx = await createEventFixture("time", [["/time-entries", timeEntryRoutes], ["/rate-cards", rateCardRoutes], ["/time-report", timeReportRoutes]]);
    for (const u of [fx.users.trainerA, fx.users.leaderA]) await db.insert(clubMemberDepartments).values({ clubMemberId: u.clubMemberId, departmentId: fx.deptA, since: "2020-01-01" });
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("is for trainers and department leads only (deny by default)", async () => {
    const denied = await call(fx.users.member1, "/time-entries/clock-in", "POST", {});
    expect(denied.status).toBe(403);
    expect((await fx.json(denied)).error.details.code).toBe("no_rate");
    expect((await call(fx.users.member1, "/time-entries")).status).toBe(403);
    expect((await manual(fx.users.member1, -3, -2)).status).toBe(403);
    expect((await call(fx.users.member1, "/time-report")).status).toBe(403);
    expect((await call(fx.users.member1, "/rate-cards")).status).toBe(403);
    expect((await call(fx.users.outsider, "/time-entries/clock-in", "POST", {})).status).toBe(404);
  });

  it("stamps in and out once at a time, even in parallel", async () => {
    const parallel = await Promise.all(Array.from({ length: 5 }, () => call(fx.users.trainerA, "/time-entries/clock-in", "POST", {})));
    expect(parallel.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect(parallel.map((r) => r.status).filter((s) => s === 409)).toHaveLength(4);
    const current = (await fx.json(await call(fx.users.trainerA, "/time-entries/current"))).data;
    expect(current).toMatchObject({ running: true, source: "stempeln", status: "offen" });
    expect((await call(fx.users.trainerA, `/time-entries/${current.id}`, "PATCH", { endedAt: new Date().toISOString() })).status).toBe(409);
    const out = await call(fx.users.trainerA, "/time-entries/clock-out", "POST");
    expect(out.status).toBe(200);
    expect((await fx.json(out)).data.running).toBe(false);
    expect((await call(fx.users.trainerA, "/time-entries/clock-out", "POST")).status).toBe(409);
    expect((await fx.json(await call(fx.users.trainerA, "/time-entries/current"))).data).toBeNull();
  });

  it("validates manual entries: order, future, length, overlap", async () => {
    expect((await manual(fx.users.leaderA, -2, -3)).status).toBe(422);
    expect((await manual(fx.users.leaderA, 1, 2)).status).toBe(422); // future
    expect((await manual(fx.users.leaderA, -30, -10)).status).toBe(422); // 20 h
    expect((await manual(fx.users.leaderA, -9, -7)).status).toBe(201);
    const overlap = await manual(fx.users.leaderA, -8, -6);
    expect(overlap.status).toBe(409);
    expect((await fx.json(overlap)).error.details.code).toBe("entry_overlap");
    expect((await manual(fx.users.leaderA, -7, -6)).status).toBe(201); // touching
  });

  it("proposes entries from attended events but never creates one on its own", async () => {
    const event = await fx.addEvent({ calendarId: fx.calA, startsAt: new Date(Date.now() - 30 * HOUR), endsAt: new Date(Date.now() - 28 * HOUR), title: "Training gestern" });
    const [sheet] = await db.insert(eventAttendanceSheets).values({ eventId: event.id }).returning();
    await db.insert(eventAttendanceSupervisors).values({ sheetId: sheet!.id, clubMemberId: fx.users.trainerA.clubMemberId });
    expect(await db.select().from(timeEntries).where(eq(timeEntries.eventId, event.id))).toHaveLength(0);
    const list = (await fx.json(await call(fx.users.trainerA, "/time-entries/suggestions"))).data;
    expect(list.map((p: any) => p.eventId)).toContain(event.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await fx.json(await call(fx.users.leaderA, "/time-entries/suggestions"))).data.map((p: any) => p.eventId)).not.toContain(event.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(fx.users.leaderA, "/time-entries/from-event", "POST", { eventId: event.id })).status).toBe(404);
    const taken = await call(fx.users.trainerA, "/time-entries/from-event", "POST", { eventId: event.id });
    expect(taken.status).toBe(201);
    expect((await fx.json(taken)).data).toMatchObject({ source: "aus_termin", status: "offen", minutes: 120 });
    expect((await call(fx.users.trainerA, "/time-entries/from-event", "POST", { eventId: event.id })).status).toBe(409);
  });

  it("confirms only with time:write inside the scope and never one's own entry", async () => {
    const mine = (await fx.json(await manual(fx.users.trainerA, -20, -18))).data;
    expect((await call(fx.users.trainerA, `/time-entries/${mine.id}/confirm`, "POST")).status).toBe(403);
    expect((await call(fx.users.member1, `/time-entries/${mine.id}/confirm`, "POST")).status).toBe(403);
    expect((await call(fx.users.leaderA, `/time-entries/${mine.id}/confirm`, "POST")).status).toBe(200);
    expect((await call(fx.users.leaderA, `/time-entries/${mine.id}/confirm`, "POST")).status).toBe(409);
    expect((await call(fx.users.trainerA, `/time-entries/${mine.id}`, "PATCH", { endedAt: new Date().toISOString() })).status).toBe(409); // decided
    // The leader's own entry: not by themselves, but by the board.
    const leaders = (await fx.json(await manual(fx.users.leaderA, -40, -38))).data;
    const self = await call(fx.users.leaderA, `/time-entries/${leaders.id}/confirm`, "POST");
    expect(self.status).toBe(403);
    expect((await fx.json(self)).error.details.code).toBe("no_self_decision");
    expect((await call(fx.users.board, `/time-entries/${leaders.id}/confirm`, "POST")).status).toBe(200);
    // Scope: a trainer of another department is out of reach for the leader of department A.
    const other = await fx.addAccount("Fremder Trainer");
    await db.insert(clubRoles).values({ memberId: other.memberId, roleType: "trainer", departmentId: fx.deptB });
    await db.insert(clubMemberDepartments).values({ clubMemberId: other.clubMemberId, departmentId: fx.deptB, since: "2020-01-01" });
    const foreign = (await fx.json(await manual(other, -60, -58))).data;
    expect((await call(fx.users.leaderA, `/time-entries/${foreign.id}/confirm`, "POST")).status).toBe(404);
    expect((await call(fx.users.leaderA, `/time-entries?scope=team`)).status).toBe(200);
    expect((await fx.json(await call(fx.users.leaderA, "/time-entries?scope=team"))).data.map((e: any) => e.id)).not.toContain(foreign.id); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(fx.users.trainerA, "/time-entries?scope=team")).status).toBe(403);
    expect((await call(fx.users.board, `/time-entries/${foreign.id}/reject`, "POST")).status).toBe(200);
  });

  it("keeps rates for time:read_rates and resolves person before role, newest first", async () => {
    expect((await call(fx.users.leaderA, "/rate-cards")).status).toBe(403);
    expect((await call(fx.users.trainerA, "/rate-cards", "POST", { roleType: "trainer", hourlyRateCents: 1500, validFrom: "2026-01-01" })).status).toBe(403);
    expect((await call(fx.users.board, "/rate-cards", "POST", { roleType: "trainer", clubMemberId: fx.users.trainerA.clubMemberId, hourlyRateCents: 1500, validFrom: "2026-01-01" })).status).toBe(422);
    expect((await call(fx.users.board, "/rate-cards", "POST", { roleType: "trainer", hourlyRateCents: 1500, validFrom: "2026-01-01", validUntil: "2025-01-01" })).status).toBe(422);
    const role = await call(fx.users.board, "/rate-cards", "POST", { roleType: "trainer", hourlyRateCents: 1500, validFrom: "2020-01-01" });
    expect(role.status).toBe(201);
    const person = await call(fx.users.board, "/rate-cards", "POST", { clubMemberId: fx.users.trainerA.clubMemberId, hourlyRateCents: 2000, validFrom: "2020-01-01" });
    expect(person.status).toBe(201);
    expect((await fx.json(await call(fx.users.board, "/rate-cards"))).data.map((c: any) => c.displayName)).toContain("Trainer A"); // eslint-disable-line @typescript-eslint/no-explicit-any
    const cards = await db.select().from(rateCards).where(eq(rateCards.clubId, fx.clubId));
    expect(rateOn(cards, fx.users.trainerA.clubMemberId, ["trainer"], "2026-06-01")).toBe(2000);
    expect(rateOn(cards, fx.users.leaderA.clubMemberId, ["trainer"], "2026-06-01")).toBe(1500);
    expect(rateOn(cards, fx.users.leaderA.clubMemberId, ["abteilungsleitung"], "2026-06-01")).toBeNull();
    expect(rateOn(cards, fx.users.trainerA.clubMemberId, [], "2019-01-01")).toBeNull();
  });

  it("reports hours x rate of confirmed entries: amounts only with time:read_rates, scope for department leads, CSV escaped, nothing booked", async () => {
    const report = (await fx.json(await call(fx.users.board, "/time-report"))).data;
    expect(report.includesRates).toBe(true);
    const trainer = report.people.find((p: any) => p.displayName === "Trainer A"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(trainer).toMatchObject({ entries: 1, minutes: 120, hours: 2, rateCents: 2000, amountCents: 4000, rateMissing: false });
    expect(report.totals.amountCents).toBeGreaterThanOrEqual(4000);
    // Rejected / open entries are not part of it.
    expect(report.people.some((p: any) => p.displayName === "Fremder Trainer")).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
    const lead = (await fx.json(await call(fx.users.leaderA, "/time-report"))).data;
    expect(lead.includesRates).toBe(false);
    expect(JSON.stringify(lead)).not.toMatch(/amountCents":\d|rateCents":\d/);
    expect(lead.people.map((p: any) => p.displayName)).toContain("Trainer A"); // eslint-disable-line @typescript-eslint/no-explicit-any
    const csv = await call(fx.users.board, "/time-report?format=csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("Name;Rolle(n);Termin;Datum;Stunden;Satz (EUR/h);Betrag (EUR)");
    expect((await call(fx.users.trainerA, "/time-report")).status).toBe(403);
    expect((await call(fx.users.board, "/time-report?from=2020-01-01&to=2026-12-31")).status).toBe(422);
    // The API knows no payout, booking or payment state.
    expect(Object.keys(report.people[0]).join(",")).not.toMatch(/paid|payout|booked|payment/i);
  });
});
