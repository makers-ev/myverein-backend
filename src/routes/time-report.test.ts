import { and, eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { rateCards, timeEntries } from "../db/schema/event-extras.js";
import { clubMemberRoutes } from "./club-members.js";
import { createEventFixture, HOUR, type EventFixture, type TestUser } from "./event-test-support.js";
import { rateCardRoutes, timeEntryRoutes, timeReportRoutes } from "./time-tracking.js";

/** Tracking by hourly rate and the extended report (filters, grouping, people, XLSX). Every assertion is scoped to the fixture's own club. */
describe("time tracking by rate and the extended report", () => {
  let fx: EventFixture;
  const call = (who: { cookie: string }, path: string, method = "GET", body?: unknown, club?: string) => fx.req(who, path, { method, club, ...(body === undefined ? {} : { body }) });
  const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
  const confirmed = (clubMemberId: string, startH: number, lenMin: number, eventId: string | null = null) =>
    db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId, eventId, startedAt: hoursAgo(startH), endedAt: new Date(hoursAgo(startH).getTime() + lenMin * 60_000), source: "manuell", status: "bestaetigt" });
  let e1: string;
  let e2: string;
  let nasty: string;
  let foreign: string;

  beforeAll(async () => {
    fx = await createEventFixture("timerep", [["/time-entries", timeEntryRoutes], ["/rate-cards", rateCardRoutes], ["/time-report", timeReportRoutes], ["/club-members", clubMemberRoutes]]);
    for (const u of [fx.users.trainerA, fx.users.leaderA]) await db.insert(clubMemberDepartments).values({ clubMemberId: u.clubMemberId, departmentId: fx.deptA, since: "2020-01-01" });
    e1 = (await fx.addEvent({ calendarId: fx.calA, startsAt: hoursAgo(50), endsAt: hoursAgo(48), title: "Training Montag" })).id;
    e2 = (await fx.addEvent({ calendarId: fx.calA, startsAt: hoursAgo(30), endsAt: hoursAgo(28), title: "Turnier" })).id;
    nasty = await fx.addAccountless("=1+1", { departmentId: fx.deptA });
    foreign = await fx.addAccountless("Fremdabteilung", { departmentId: fx.deptB });
    await db.insert(rateCards).values([
      { clubId: fx.clubId, roleType: "trainer", hourlyRateCents: 1500, validFrom: "2020-01-01" },
      { clubId: fx.clubId, clubMemberId: nasty, hourlyRateCents: 1000, validFrom: "2020-01-01" },
    ]);
    await confirmed(fx.users.trainerA.clubMemberId, 50, 120, e1);
    await confirmed(fx.users.trainerA.clubMemberId, 30, 60, e2);
    await confirmed(fx.users.leaderA.clubMemberId, 20, 30);
    await confirmed(nasty, 49, 60, e1);
    await confirmed(foreign, 10, 90);
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("lets members with an applicable rate track, everybody else gets no_rate, and exposes canTrack/hasRate", async () => {
    const me = async (who: TestUser) => (await fx.json(await call(who, "/club-members/me"))).data;
    expect(await me(fx.users.member1)).toMatchObject({ canTrack: false, hasRate: false });
    expect(await me(fx.users.trainerA)).toMatchObject({ canTrack: true, hasRate: true });
    expect(await me(fx.users.leaderA)).toMatchObject({ canTrack: true, hasRate: false });
    for (const [path, method] of [["/time-entries", "GET"], ["/time-entries/current", "GET"], ["/time-entries/suggestions", "GET"], ["/time-entries/clock-in", "POST"], ["/time-entries/clock-out", "POST"], ["/time-entries", "POST"], ["/time-entries/from-event", "POST"]] as const) {
      const res = await call(fx.users.member1, path, method, method === "POST" ? {} : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await fx.json(res)).error.details.code).toBe("no_rate");
    }
    // A rate for the implicit role mitglied, not yet valid / already expired: still no.
    const future = await db.insert(rateCards).values({ clubId: fx.clubId, roleType: "mitglied", hourlyRateCents: 800, validFrom: "2999-01-01" }).returning();
    const expired = await db.insert(rateCards).values({ clubId: fx.clubId, roleType: "mitglied", hourlyRateCents: 800, validFrom: "2000-01-01", validUntil: "2001-01-01" }).returning();
    expect((await call(fx.users.member1, "/time-entries/clock-in", "POST", {})).status).toBe(403);
    // A rate card of another club does not count.
    const [foreignCard] = await db.insert(rateCards).values({ clubId: fx.otherClubId, roleType: "mitglied", hourlyRateCents: 800, validFrom: "2020-01-01" }).returning();
    expect((await call(fx.users.member1, "/time-entries/clock-in", "POST", {})).status).toBe(403);
    // Valid role rate for all members: member1 may track, member2 does too; the rate gives no confirm right.
    const [valid] = await db.insert(rateCards).values({ clubId: fx.clubId, roleType: "mitglied", hourlyRateCents: 800, validFrom: "2020-01-01" }).returning();
    expect(await me(fx.users.member1)).toMatchObject({ canTrack: true, hasRate: true });
    const inRes = await call(fx.users.member1, "/time-entries/clock-in", "POST", {});
    expect(inRes.status).toBe(201);
    expect((await call(fx.users.member1, "/time-entries/clock-out", "POST")).status).toBe(200);
    const manual = await call(fx.users.member1, "/time-entries", "POST", { startedAt: hoursAgo(9).toISOString(), endedAt: hoursAgo(8).toISOString() });
    expect(manual.status).toBe(201);
    const entry = (await fx.json(manual)).data;
    expect((await call(fx.users.member1, `/time-entries/${entry.id}/confirm`, "POST")).status).toBe(403);
    expect((await call(fx.users.member1, "/time-report")).status).toBe(403);
    expect((await call(fx.users.member1, "/rate-cards")).status).toBe(403);
    expect((await call(fx.users.member1, "/time-entries?scope=team")).status).toBe(403);
    // Rate removed again: back to no_rate.
    await db.delete(rateCards).where(eq(rateCards.id, valid!.id));
    expect(await me(fx.users.member1)).toMatchObject({ canTrack: false, hasRate: false });
    expect((await call(fx.users.member1, "/time-entries/clock-in", "POST", {})).status).toBe(403);
    // Personal card works for one person only.
    const [personal] = await db.insert(rateCards).values({ clubId: fx.clubId, clubMemberId: fx.users.member2.clubMemberId, hourlyRateCents: 900, validFrom: "2020-01-01" }).returning();
    expect((await call(fx.users.member2, "/time-entries/clock-in", "POST", {})).status).toBe(201);
    expect((await call(fx.users.member2, "/time-entries/clock-out", "POST")).status).toBe(200);
    expect((await call(fx.users.member1, "/time-entries/clock-in", "POST", {})).status).toBe(403);
    for (const id of [future![0]!.id, expired![0]!.id, foreignCard!.id, personal!.id]) await db.delete(rateCards).where(eq(rateCards.id, id));
    // Outsiders of the club stay out (404 from the club guard), trainers keep tracking without needing a card.
    expect((await call(fx.users.outsider, "/time-entries/clock-in", "POST", {})).status).toBe(404);
  });

  it("groups by person, event and person+event with totals and amounts", async () => {
    const get = async (qs: string) => (await fx.json(await call(fx.users.board, `/time-report?${qs}`))).data;
    const person = await get("");
    expect(person.groupBy).toBe("person");
    expect(person.rows.map((r: any) => r.displayName)).toEqual(["=1+1", "Fremdabteilung", "Leiter A", "Trainer A"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const trainer = person.rows.find((r: any) => r.displayName === "Trainer A"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(trainer).toMatchObject({ entries: 2, minutes: 180, hours: 3, rateCents: 1500, amountCents: 4500, roleTypes: ["trainer"], eventId: null });
    expect(person.people).toEqual(person.rows);
    expect(person.totals).toEqual({ minutes: 180 + 30 + 60 + 90, hours: 6, amountCents: 4500 + 0 + 1000 });
    const noRate = person.rows.find((r: any) => r.displayName === "Leiter A"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(noRate).toMatchObject({ rateMissing: true, amountCents: 0, rateCents: null });
    const byEvent = await get("groupBy=event");
    expect(byEvent.rows).toHaveLength(3);
    const monday = byEvent.rows.find((r: any) => r.eventId === e1); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(monday).toMatchObject({ eventTitle: "Training Montag", minutes: 180, entries: 2, displayName: null, clubMemberId: null });
    expect(monday.eventDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(byEvent.rows.some((r: any) => r.eventId === null && r.minutes === 120)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(byEvent.people.length).toBe(4);
    const both = await get("groupBy=person_event");
    expect(both.rows).toHaveLength(5);
    expect(both.rows.find((r: any) => r.eventId === e1 && r.displayName === "Trainer A")).toMatchObject({ eventTitle: "Training Montag", minutes: 120, amountCents: 3000 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(both.totals.minutes).toBe(360);
  });

  it("filters by people, role types, event and department; foreign ids yield nothing", async () => {
    const get = async (qs: string, who: TestUser = fx.users.board) => (await fx.json(await call(who, `/time-report?${qs}`))).data;
    expect((await get(`clubMemberIds=${fx.users.trainerA.clubMemberId},${fx.users.leaderA.clubMemberId}`)).rows.map((r: any) => r.displayName)).toEqual(["Leiter A", "Trainer A"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get("roleTypes=trainer")).rows.map((r: any) => r.displayName)).toEqual(["Trainer A"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get("roleTypes=abteilungsleitung,trainer")).rows).toHaveLength(2);
    expect((await get(`eventId=${e2}`)).totals.minutes).toBe(60);
    expect((await get(`eventId=${e1}&groupBy=person`)).rows.map((r: any) => r.displayName)).toEqual(["=1+1", "Trainer A"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get(`departmentId=${fx.deptB}`)).rows.map((r: any) => r.displayName)).toEqual(["Fremdabteilung"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await get(`from=2000-01-01&to=2000-02-01`)).rows).toEqual([]);
    // Ids of somebody else's club or event: no rows, no error, no leak.
    const [strangerRow] = await db.insert(clubMembers).values({ clubId: fx.otherClubId, displayName: "Fremder", status: "aktiv", joinedAt: "2020-01-01" }).returning();
    await db.insert(timeEntries).values({ clubId: fx.otherClubId, clubMemberId: strangerRow!.id, startedAt: hoursAgo(5), endedAt: hoursAgo(4), source: "manuell", status: "bestaetigt" });
    const stranger = strangerRow!.id;
    expect((await get(`clubMemberIds=${stranger}`)).rows).toEqual([]);
    expect((await get("eventId=00000000-0000-4000-8000-000000000001")).rows).toEqual([]);
    expect((await fx.json(await call(fx.users.outsider, "/time-report", "GET", undefined, fx.otherClubId))).data.rows.map((r: any) => r.displayName)).toEqual(["Fremder"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(fx.users.outsider, "/time-report")).status).toBe(404);
    // Validation.
    expect((await call(fx.users.board, "/time-report?clubMemberIds=nope")).status).toBe(422);
    expect((await call(fx.users.board, `/time-report?clubMemberIds=${Array.from({ length: 101 }, () => fx.users.board.clubMemberId).join(",")}`)).status).toBe(422);
    expect((await call(fx.users.board, "/time-report?roleTypes=kaiser")).status).toBe(422);
    expect((await call(fx.users.board, "/time-report?groupBy=week")).status).toBe(422);
    expect((await call(fx.users.board, "/time-report?format=pdf")).status).toBe(422);
  });

  it("limits department leads to hours of their own departments, in every format", async () => {
    const lead = fx.users.leaderA;
    const body = (await fx.json(await call(lead, "/time-report?groupBy=person_event"))).data;
    expect(body.includesRates).toBe(false);
    expect(body.totals.amountCents).toBeNull();
    expect(body.rows.map((r: any) => r.displayName)).not.toContain("Fremdabteilung"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(body)).not.toMatch(/(amountCents|rateCents)":\d/);
    // Asking for a person outside the scope or the other department gives nothing, not a 403 leak and not their hours.
    expect((await fx.json(await call(lead, `/time-report?clubMemberIds=${foreign}`))).data.rows).toEqual([]);
    expect((await fx.json(await call(lead, `/time-report?departmentId=${fx.deptB}`))).data.rows).toEqual([]);
    const people = (await fx.json(await call(lead, "/time-report/people"))).data;
    expect(people.includesRates).toBe(false);
    expect(people.people.map((p: any) => p.displayName)).toEqual(["=1+1", "Leiter A", "Trainer A"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(people.roleTypes).toEqual(["abteilungsleitung", "trainer"]);
    expect(people.events.map((e: any) => e.eventId).sort()).toEqual([e1, e2].sort()); // eslint-disable-line @typescript-eslint/no-explicit-any
    const csv = await (await call(lead, "/time-report?format=csv")).text();
    expect(csv).toContain("Name;Rolle(n);Termin;Datum;Stunden\r\n");
    expect(csv).not.toMatch(/Satz|Betrag|Fremdabteilung/);
    const sheet = sheetOf(new Uint8Array(await (await call(lead, "/time-report?format=xlsx")).arrayBuffer()));
    expect(sheet).not.toMatch(/Satz|Betrag|Fremdabteilung/);
    // Trainers and plain members do not see the report or the selector.
    for (const who of [fx.users.trainerA, fx.users.member1]) {
      expect((await call(who, "/time-report")).status).toBe(403);
      expect((await call(who, "/time-report/people")).status).toBe(403);
      expect((await call(who, "/time-report?format=xlsx")).status).toBe(403);
    }
  });

  it("serves the selector data for time:read_rates: people with hours or a rate, role types, events", async () => {
    const data = (await fx.json(await call(fx.users.board, "/time-report/people"))).data;
    expect(data.includesRates).toBe(true);
    const names = data.people.map((p: any) => p.displayName); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(names).toEqual(expect.arrayContaining(["Trainer A", "Leiter A", "=1+1", "Fremdabteilung"]));
    expect(names).toContain("Trainer A");
    expect(data.roleTypes).toEqual(expect.arrayContaining(["trainer", "abteilungsleitung"]));
    expect(data.events.map((e: any) => e.title)).toEqual(expect.arrayContaining(["Training Montag", "Turnier"])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await call(fx.users.board, "/time-report/people?from=2030-02-01&to=2030-01-01")).status).toBe(422);
  });

  it("exports a real XLSX with the expected cells, escapes formulas in CSV and XLSX, and audits without names", async () => {
    const res = await call(fx.users.board, "/time-report?format=xlsx&groupBy=person_event");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toContain('filename="stundenbericht.xlsx"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x50, 0x4b]); // zip
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"]));
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain('name="Stundenbericht"');
    const sheet = sheetOf(bytes);
    for (const text of ["Berechnungsgrundlage, keine Abrechnung", "Name", "Rolle(n)", "Termin", "Datum", "Stunden", "Satz (EUR/h)", "Betrag (EUR)", "Trainer A", "Training Montag", "Turnier", "Summe"]) expect(sheet).toContain(text);
    expect(sheet).toContain("<v>2</v>"); // Trainer A, Training Montag: 2 h
    expect(sheet).toContain("<v>15</v>"); // 15.00 EUR/h
    expect(sheet).toContain("<v>30</v>"); // 2 h x 15 EUR
    expect(sheet).toContain("<v>6</v>"); // total hours
    // Formula injection: text starting with = is a quoted string, never a formula cell.
    expect(sheet).toContain("&apos;=1+1".replace("&apos;", "'"));
    expect(sheet).not.toMatch(/<f>/);
    const csv = await (await call(fx.users.board, "/time-report?format=csv")).text();
    expect(csv).toContain("'=1+1");
    expect(csv).not.toMatch(/(^|;|\n)=1\+1/);
    expect(csv).toContain("Summe");
    const csvRes = await call(fx.users.board, "/time-report?format=csv");
    expect(csvRes.headers.get("content-disposition")).toContain("stundenbericht.csv");
    expect(csvRes.headers.get("cache-control")).toBe("private, no-store");
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, fx.clubId), eq(auditLog.eventType, "time_report.export")));
    expect(audits.map((a) => (a.payload as any).format).sort()).toEqual(expect.arrayContaining(["csv", "xlsx"])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(JSON.stringify(audits.map((a) => a.payload))).not.toMatch(/Trainer A|=1\+1|Fremdabteilung/);
    // The JSON view writes no export audit.
    const before = (await db.select().from(auditLog).where(and(eq(auditLog.clubId, fx.clubId), eq(auditLog.eventType, "time_report.export")))).length;
    await call(fx.users.board, "/time-report");
    expect((await db.select().from(auditLog).where(and(eq(auditLog.clubId, fx.clubId), eq(auditLog.eventType, "time_report.export")))).length).toBe(before);
  });
});

function sheetOf(bytes: Uint8Array): string {
  return strFromU8(unzipSync(bytes)["xl/worksheets/sheet1.xml"]!);
}
