import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { eventAttendance, eventAttendanceSheets } from "../db/schema/event-attendance.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { createEventFixture, type EventFixture } from "./event-test-support.js";
import { attendanceReportRoutes } from "./attendance-report.js";

const DAY = 86_400_000;

/** Attendance report (Wave 12 B12): quota per member / group / event, scoping per role, guardians, CSV. */
describe("attendance report", () => {
  let fx: EventFixture;
  let anna: string;
  let ben: string;
  let kid: string;
  let otherKid: string;
  const report = (who: { cookie: string }, query = "") => fx.req(who, `/attendance/report${query}`);

  async function sheet(calendarId: string, daysAgo: number, entries: Array<[string, "anwesend" | "entschuldigt" | "unentschuldigt"]>, extra: { cancelled?: boolean; guests?: number } = {}) {
    const e = await fx.addEvent({ calendarId, startsAt: new Date(Date.now() - daysAgo * DAY), title: `Training -${daysAgo}`, ...(extra.cancelled ? { cancelledAt: new Date() } : {}) });
    const [s] = await db.insert(eventAttendanceSheets).values({ eventId: e.id }).returning();
    for (const [member, status] of entries) await db.insert(eventAttendance).values({ sheetId: s!.id, clubMemberId: member, status });
    for (let i = 0; i < (extra.guests ?? 0); i += 1) await db.insert(eventAttendance).values({ sheetId: s!.id, guestName: `Gast ${i}`, status: "anwesend" });
    return e;
  }

  beforeAll(async () => {
    fx = await createEventFixture("rep", [["/attendance", attendanceReportRoutes]]);
    anna = fx.users.member1.clubMemberId;
    ben = await fx.addAccountless("Ben Ohne Konto", { departmentId: fx.deptA });
    kid = await fx.addAccountless("Kind Eins", { birthDate: "2016-04-04", departmentId: fx.deptA });
    otherKid = await fx.addAccountless("Kind Zwei", { birthDate: "2016-04-05", departmentId: fx.deptB });
    await db.insert(guardianLinks).values({ guardianMemberId: fx.users.member2.memberId, wardClubMemberId: kid, confirmedAt: new Date(), validFrom: "2020-01-01" });
    await sheet(fx.calA, 5, [[anna, "anwesend"], [ben, "anwesend"], [kid, "anwesend"]], { guests: 2 });
    await sheet(fx.calA, 4, [[anna, "anwesend"], [ben, "unentschuldigt"], [kid, "entschuldigt"]]);
    await sheet(fx.calA, 3, [[anna, "unentschuldigt"], [ben, "anwesend"]]);
    await sheet(fx.calB, 2, [[anna, "anwesend"], [otherKid, "anwesend"]]);
    await sheet(fx.calA, 1, [[anna, "unentschuldigt"]], { cancelled: true });
    await fx.addEvent({ calendarId: fx.calA, startsAt: new Date(Date.now() - 6 * DAY), title: "Ohne Liste" });
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("reports the quota per member, per event and counts only events with a list that took place", async () => {
    const { data } = await fx.json(await report(fx.users.board, `?departmentId=${fx.deptA}`));
    expect(data.scope).toBe("group");
    const byName = new Map<string, any>(data.members.map((m: any) => [m.displayName, m])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(byName.get("Ben Ohne Konto")).toMatchObject({ present: 2, unexcused: 1, recorded: 3, rate: 0.667 });
    expect(byName.get("Mitglied Eins")).toMatchObject({ present: 2, unexcused: 1, recorded: 3 });
    expect(byName.get("Kind Eins")).toMatchObject({ present: 1, excused: 1, rate: 0.5 });
    expect(data.events).toHaveLength(3);
    expect(data.events[0]).toMatchObject({ present: 3, guests: 2, closed: false });
    expect(JSON.stringify(data)).not.toContain("Ohne Liste");
    // Whole club: also the other department.
    const all = (await fx.json(await report(fx.users.board))).data;
    expect(all.events).toHaveLength(4);
    expect(all.members.map((m: any) => m.displayName)).toContain("Kind Zwei"); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("limits a trainer to the own department, refuses groups to plain members", async () => {
    const trainer = (await fx.json(await report(fx.users.trainerA))).data;
    expect(trainer.events).toHaveLength(3);
    expect(trainer.members.map((m: any) => m.displayName)).not.toContain("Kind Zwei"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await report(fx.users.trainerA, `?departmentId=${fx.deptB}`)).status).toBe(403);
    // A trainer asking for a member sees only the events of the own department.
    const member = (await fx.json(await report(fx.users.trainerA, `?memberId=${anna}`))).data;
    expect(member.member).toMatchObject({ present: 2, unexcused: 1 });
    expect((await report(fx.users.member1)).status).toBe(403);
    expect((await report(fx.users.member1, `?departmentId=${fx.deptA}`)).status).toBe(403);
  });

  it("lets a member read the own quota, a guardian the ward's, nobody else's", async () => {
    const own = (await fx.json(await report(fx.users.member1, `?memberId=${anna}`))).data;
    expect(own.scope).toBe("member");
    expect(own.member).toMatchObject({ present: 3, unexcused: 1, recorded: 4 });
    expect(own.entries).toHaveLength(4);
    expect((await report(fx.users.member1, `?memberId=${ben}`)).status).toBe(403);
    expect((await report(fx.users.member2, `?memberId=${kid}`)).status).toBe(200);
    expect((await report(fx.users.member2, `?memberId=${otherKid}`)).status).toBe(403);
    expect((await report(fx.users.member2, `?memberId=${anna}`)).status).toBe(403);
    expect((await report(fx.users.member1, `?memberId=${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("is club-scoped and validates the range", async () => {
    expect((await report(fx.users.outsider, `?memberId=${anna}`)).status).toBe(404);
    expect((await report(fx.users.outsider, `?departmentId=${fx.deptA}`)).status).toBe(404);
    expect((await report(fx.users.board, "?from=2020-01-01&to=2026-12-31")).status).toBe(422);
    expect((await report(fx.users.board, "?from=2026-05-02&to=2026-05-01")).status).toBe(422);
    expect((await report(fx.users.board, "?from=garbage")).status).toBe(422);
  });

  it("exports CSV (escaped, audited) with the same rights", async () => {
    const res = await fx.req(fx.users.board, `/attendance/report.csv?departmentId=${fx.deptA}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Name;Anwesend;Entschuldigt;Unentschuldigt;Erfasst;Quote");
    expect(text).toContain("Ben Ohne Konto;2;0;1;3;67 %");
    expect((await fx.req(fx.users.member1, "/attendance/report.csv")).status).toBe(403);
    const mine = await fx.req(fx.users.member1, `/attendance/report.csv?memberId=${anna}`);
    expect(await mine.text()).toContain("Datum;Termin;Status");
  });
});
