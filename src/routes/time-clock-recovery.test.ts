import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberDepartments } from "../db/schema/club-members.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { timeEntries } from "../db/schema/event-extras.js";
import { pushDataFor } from "../lib/notify/push.js";
import { createEventFixture, HOUR, type EventFixture, type TestUser } from "./event-test-support.js";
import { timeEntryRoutes, timeReportRoutes } from "./time-tracking.js";

/**
 * Wave 16 T0: a clock-in that was forgotten for more than 16 hours (40 h, 328 h as reported) must never be a dead end. Before the fix:
 * clock-out 422 `too_long`, PATCH 409 `running`, clock-in 409 `already_running`, and the board could neither close nor reject it.
 */
describe("a forgotten clock-in is never a dead end", () => {
  let fx: EventFixture;
  const call = (who: { cookie: string }, path: string, method = "GET", body?: unknown) => fx.req(who, path, { method, ...(body === undefined ? {} : { body }) });
  const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
  const stuck = async (who: TestUser, hours: number) =>
    (await db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId: who.clubMemberId, startedAt: hoursAgo(hours), source: "stempeln", status: "offen" }).returning())[0]!;
  const clear = (who: TestUser) => db.delete(timeEntries).where(and(eq(timeEntries.clubId, fx.clubId), eq(timeEntries.clubMemberId, who.clubMemberId)));

  beforeAll(async () => {
    fx = await createEventFixture("timerec", [["/time-entries", timeEntryRoutes], ["/time-report", timeReportRoutes]]);
    for (const u of [fx.users.trainerA, fx.users.leaderA]) await db.insert(clubMemberDepartments).values({ clubMemberId: u.clubMemberId, departmentId: fx.deptA, since: "2020-01-01" });
  }, 60_000);
  afterAll(async () => fx.cleanup());

  for (const hours of [40, 328]) {
    it(`lets the person end a ${hours} h old running entry with an end time`, async () => {
      const me = fx.users.trainerA;
      await clear(me);
      const entry = await stuck(me, hours);
      // Without an end time: no silent capping, the client is asked for one.
      const ask = await call(me, "/time-entries/clock-out", "POST");
      expect(ask.status).toBe(409);
      const details = (await fx.json(ask)).error.details;
      expect(details).toMatchObject({ code: "needs_end_time", entryId: entry.id });
      expect(new Date(details.maxEndedAt).getTime()).toBe(entry.startedAt.getTime() + 16 * HOUR);
      // A new clock-in stays blocked while it runs.
      expect((await call(me, "/time-entries/clock-in", "POST", {})).status).toBe(409);
      const end = new Date(entry.startedAt.getTime() + 3 * HOUR).toISOString();
      const out = await call(me, "/time-entries/clock-out", "POST", { endedAt: end });
      expect(out.status).toBe(200);
      expect((await fx.json(out)).data).toMatchObject({ running: false, status: "offen", minutes: 180, corrected: true });
      // Afterwards the person can stamp again.
      expect((await call(me, "/time-entries/clock-in", "POST", {})).status).toBe(201);
      await clear(me);
    });

    it(`lets the person set the end of a ${hours} h old running entry by editing it`, async () => {
      const me = fx.users.trainerA;
      await clear(me);
      const entry = await stuck(me, hours);
      const res = await call(me, `/time-entries/${entry.id}`, "PATCH", { endedAt: new Date(entry.startedAt.getTime() + 2 * HOUR).toISOString() });
      expect(res.status).toBe(200);
      expect((await fx.json(res)).data).toMatchObject({ running: false, minutes: 120, corrected: true });
      await clear(me);
    });

    it(`lets the board close or reject a ${hours} h old running entry of a member`, async () => {
      const member = fx.users.trainerA;
      await clear(member);
      const entry = await stuck(member, hours);
      const close = await call(fx.users.board, `/time-entries/${entry.id}/close`, "POST", { endedAt: new Date(entry.startedAt.getTime() + 4 * HOUR).toISOString() });
      expect(close.status).toBe(200);
      expect((await fx.json(close)).data).toMatchObject({ running: false, status: "offen", minutes: 240, closedByOther: true });
      const second = await stuck(member, Math.max(17, hours - 20));
      const reject = await call(fx.users.leaderA, `/time-entries/${second.id}/reject`, "POST");
      expect(reject.status).toBe(200);
      expect((await fx.json(reject)).data).toMatchObject({ running: false, status: "abgelehnt" });
      expect((await call(member, "/time-entries/clock-in", "POST", {})).status).toBe(201);
      await clear(member);
    });
  }

  it("keeps the rules for an explicit end: order, future, 16 h cap at 15:59 / 16:01, overlap; no age limit; audit with corrected", async () => {
    const me = fx.users.trainerA;
    await clear(me);
    const entry = await stuck(me, 30);
    const end = (h: number) => new Date(entry.startedAt.getTime() + h * HOUR).toISOString();
    const codeOf = async (res: Response) => (await fx.json(res)).error.details.code;
    let res = await call(me, "/time-entries/clock-out", "POST", { endedAt: end(-1) });
    expect([res.status, await codeOf(res)]).toEqual([422, "invalid_time"]);
    res = await call(me, "/time-entries/clock-out", "POST", { endedAt: end(16 + 1 / 60) });
    expect([res.status, await codeOf(res)]).toEqual([422, "too_long"]);
    res = await call(me, "/time-entries/clock-out", "POST", { endedAt: new Date(Date.now() + HOUR).toISOString() });
    expect([res.status, await codeOf(res)]).toEqual([422, "in_future"]);
    expect((await call(me, "/time-entries/clock-out", "POST", { endedAt: "gestern" })).status).toBe(422);
    // A manual entry inside the window (inserted directly: the API refuses it while the clock runs) blocks an end across it.
    const [other] = await db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId: me.clubMemberId, startedAt: new Date(entry.startedAt.getTime() + 2 * HOUR), endedAt: new Date(entry.startedAt.getTime() + 3 * HOUR), source: "manuell", status: "offen" }).returning();
    res = await call(me, "/time-entries/clock-out", "POST", { endedAt: end(4) });
    expect([res.status, await codeOf(res)]).toEqual([409, "entry_overlap"]);
    await db.delete(timeEntries).where(eq(timeEntries.id, other!.id));
    // Exactly 16 h minus a minute is fine; the entry is flagged and audited as corrected.
    res = await call(me, "/time-entries/clock-out", "POST", { endedAt: end(16 - 1 / 60) });
    expect(res.status).toBe(200);
    expect((await fx.json(res)).data).toMatchObject({ minutes: 16 * 60 - 1, corrected: true, overdue: false, maxEndedAt: null });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.clubId, fx.clubId), eq(auditLog.eventType, "time_entry.clock_out"))).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(audit!.payload).toMatchObject({ entryId: entry.id, corrected: true });
    // A normal clock-out (no body, < 16 h) is not a correction; an end "now" sent by the client is not one either.
    expect((await call(me, "/time-entries/clock-in", "POST", {})).status).toBe(201);
    res = await call(me, "/time-entries/clock-out", "POST", { endedAt: new Date(Date.now() + 60_000).toISOString() });
    expect(res.status).toBe(200);
    expect((await fx.json(res)).data).toMatchObject({ corrected: false });
    // More than a year old and still running: still endable (no too_old for ending a running entry).
    const ancient = await stuck(me, 400 * 24);
    res = await call(me, `/time-entries/${ancient.id}`, "PATCH", { endedAt: new Date(ancient.startedAt.getTime() + HOUR).toISOString() });
    expect(res.status).toBe(200);
    await clear(me);
  });

  it("shows overdue and maxEndedAt on the running entry, and serializes parallel corrections", async () => {
    const me = fx.users.trainerA;
    await clear(me);
    const fresh = await stuck(me, 15 + 59 / 60);
    let current = (await fx.json(await call(me, "/time-entries/current"))).data;
    expect(current).toMatchObject({ id: fresh.id, running: true, overdue: false, corrected: false, autoClosed: false, closedByOther: false });
    expect(Math.abs(new Date(current.maxEndedAt).getTime() - Date.now())).toBeLessThan(60_000);
    await clear(me);
    const entry = await stuck(me, 16 + 1 / 60);
    current = (await fx.json(await call(me, "/time-entries/current"))).data;
    expect(current).toMatchObject({ overdue: true });
    expect(new Date(current.maxEndedAt).getTime()).toBe(entry.startedAt.getTime() + 16 * HOUR);
    const end = new Date(entry.startedAt.getTime() + HOUR).toISOString();
    const results = await Promise.all(Array.from({ length: 4 }, () => call(me, "/time-entries/clock-out", "POST", { endedAt: end })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    await clear(me);
    // Person (clock-out, PATCH) and board (close, reject) at the same time: serialized, no deadlock, no 500, the entry ends.
    const race = await stuck(me, 30);
    const raceEnd = { endedAt: new Date(race.startedAt.getTime() + 2 * HOUR).toISOString() };
    const mixed = await Promise.all([
      call(me, "/time-entries/clock-out", "POST", raceEnd),
      call(me, `/time-entries/${race.id}`, "PATCH", raceEnd),
      call(fx.users.board, `/time-entries/${race.id}/close`, "POST", raceEnd),
      call(fx.users.leaderA, `/time-entries/${race.id}/reject`, "POST"),
      call(me, `/time-entries/${race.id}`, "PATCH", raceEnd),
    ]);
    const statuses = mixed.map((r) => r.status);
    expect(statuses.every((st) => st < 500), statuses.join(",")).toBe(true);
    expect((await db.select().from(timeEntries).where(eq(timeEntries.id, race.id)))[0]!.endedAt).not.toBeNull();
    await clear(me);
  });

  it("lets a person whose rate lapsed end or discard a stuck entry, but not move a finished one", async () => {
    const m = fx.users.member2;
    await clear(m);
    const entry = await stuck(m, 50);
    expect((await call(m, "/time-entries/clock-out", "POST")).status).toBe(409);
    const res = await call(m, `/time-entries/${entry.id}`, "PATCH", { endedAt: new Date(entry.startedAt.getTime() + HOUR).toISOString() });
    expect(res.status).toBe(200);
    expect((await call(m, `/time-entries/${entry.id}`, "PATCH", { endedAt: new Date(entry.startedAt.getTime() + 2 * HOUR).toISOString() })).status).toBe(403);
    const second = await stuck(m, 20);
    expect((await call(m, `/time-entries/${second.id}`, "DELETE")).status).toBe(204);
    // Somebody else's running entry stays invisible.
    const foreign = await stuck(fx.users.trainerA, 20);
    // Without a rate and without an own running entry, PATCH is denied before any lookup (deny by default); DELETE finds nothing.
    expect((await call(m, `/time-entries/${foreign.id}`, "PATCH", { endedAt: new Date().toISOString() })).status).toBe(403);
    expect((await call(m, `/time-entries/${foreign.id}`, "DELETE")).status).toBe(404);
    await clear(m);
    await clear(fx.users.trainerA);
  });

  it("keeps closing someone else's entry to time:write in scope, never one's own, only stuck entries; the closer does not confirm", async () => {
    const member = fx.users.trainerA;
    await clear(member);
    const codeOf = async (res: Response) => (await fx.json(res)).error.details.code;
    const endAt = (e: { startedAt: Date }, h: number) => ({ endedAt: new Date(e.startedAt.getTime() + h * HOUR).toISOString() });
    const entry = await stuck(member, 30);
    // Plain members and trainers: 403 before anything is looked up; an unknown id: 404; a missing end: 422.
    expect((await call(fx.users.member1, `/time-entries/${entry.id}/close`, "POST", endAt(entry, 1))).status).toBe(403);
    expect((await call(fx.users.board, `/time-entries/${crypto.randomUUID()}/close`, "POST", endAt(entry, 1))).status).toBe(404);
    expect((await call(fx.users.board, `/time-entries/${entry.id}/close`, "POST", {})).status).toBe(422);
    // Department lead of A: not for a member of department B (404, existence not leaked).
    const foreign = await fx.addAccountless("Abteilung B", { departmentId: fx.deptB });
    const [foreignEntry] = await db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId: foreign, startedAt: hoursAgo(30), source: "stempeln", status: "offen" }).returning();
    expect((await call(fx.users.leaderA, `/time-entries/${foreignEntry!.id}/close`, "POST", endAt(foreignEntry!, 1))).status).toBe(404);
    // Own entry: use clock-out.
    const ownStuck = (await db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId: fx.users.leaderA.clubMemberId, startedAt: hoursAgo(30), source: "stempeln", status: "offen" }).returning())[0]!;
    let res = await call(fx.users.leaderA, `/time-entries/${ownStuck.id}/close`, "POST", endAt(ownStuck, 1));
    expect([res.status, await codeOf(res)]).toEqual([403, "no_self_decision"]);
    expect((await call(fx.users.leaderA, `/time-entries/${ownStuck.id}/reject`, "POST")).status).toBe(403);
    // Not stuck yet: not_overdue; too long an end: too_long.
    const fresh = await stuck(fx.users.member2, 3);
    res = await call(fx.users.board, `/time-entries/${fresh.id}/close`, "POST", endAt(fresh, 1));
    expect([res.status, await codeOf(res)]).toEqual([409, "not_overdue"]);
    res = await call(fx.users.board, `/time-entries/${fresh.id}/reject`, "POST");
    expect([res.status, await codeOf(res)]).toEqual([409, "running"]);
    res = await call(fx.users.leaderA, `/time-entries/${entry.id}/close`, "POST", endAt(entry, 17));
    expect([res.status, await codeOf(res)]).toEqual([422, "too_long"]);
    // The lead of A closes; a second close: not_running; audited with the actor; the person is notified (in-app, push data type time_entry).
    res = await call(fx.users.leaderA, `/time-entries/${entry.id}/close`, "POST", endAt(entry, 5));
    expect(res.status).toBe(200);
    expect((await fx.json(res)).data).toMatchObject({ minutes: 300, corrected: true, closedByOther: true, status: "offen" });
    res = await call(fx.users.board, `/time-entries/${entry.id}/close`, "POST", endAt(entry, 6));
    expect([res.status, await codeOf(res)]).toEqual([409, "not_running"]);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.clubId, fx.clubId), eq(auditLog.eventType, "time_entry.close"))).orderBy(desc(auditLog.createdAt)).limit(1);
    expect(audit).toMatchObject({ actorUserId: fx.users.leaderA.userId, subjectMemberId: member.clubMemberId });
    expect(audit!.payload).toMatchObject({ entryId: entry.id, minutes: 300 });
    const notes = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.refId, `${entry.id}#closed_by_other`), eq(messageDeliveries.channel, "in_app")));
    expect(notes.map((n) => n.clubMemberId)).toEqual([member.clubMemberId]);
    expect(pushDataFor("time.closed_by_other", `${entry.id}#closed_by_other`, null, fx.clubId, false)).toMatchObject({ type: "time_entry", timeEntryId: entry.id });
    // The closer does not confirm it; the board does; once the owner edits the times, the closer may confirm again.
    res = await call(fx.users.leaderA, `/time-entries/${entry.id}/confirm`, "POST");
    expect([res.status, await codeOf(res)]).toEqual([403, "closed_by_you"]);
    const again = await stuck(member, 25);
    expect((await call(fx.users.leaderA, `/time-entries/${again.id}/close`, "POST", endAt(again, 2))).status).toBe(200);
    expect((await call(member, `/time-entries/${again.id}`, "PATCH", endAt(again, 3))).status).toBe(200);
    expect((await call(fx.users.leaderA, `/time-entries/${again.id}/confirm`, "POST")).status).toBe(200);
    expect((await call(fx.users.board, `/time-entries/${entry.id}/confirm`, "POST")).status).toBe(200);
    for (const id of [foreignEntry!.id, ownStuck.id, fresh.id]) await db.delete(timeEntries).where(eq(timeEntries.id, id));
    await clear(member);
  });

  it("marks corrected and automatically ended entries in the report and its exports (counts only)", async () => {
    const member = fx.users.trainerA;
    await clear(member);
    const confirmedEntry = (h: number, flags: { corrected?: boolean; autoClosed?: boolean }) =>
      db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId: member.clubMemberId, startedAt: hoursAgo(h), endedAt: hoursAgo(h - 1), source: "stempeln", status: "bestaetigt", ...flags });
    await confirmedEntry(50, { corrected: true });
    await confirmedEntry(40, { autoClosed: true });
    await confirmedEntry(30, {});
    const report = (await fx.json(await call(fx.users.board, "/time-report"))).data;
    expect(report.rows.find((r: { clubMemberId: string }) => r.clubMemberId === member.clubMemberId)).toMatchObject({ entries: 3, correctedEntries: 1, autoClosedEntries: 1 });
    expect(report.totals).toMatchObject({ correctedEntries: 1, autoClosedEntries: 1 });
    const csv = await (await call(fx.users.board, "/time-report?format=csv")).text();
    expect(csv.split("\r\n")[0]).toMatch(/;Korrigiert\/automatisch beendet$/);
    expect(csv).toMatch(/Trainer A;[^\r\n]*;2\r\n/);
    const lead = await (await call(fx.users.leaderA, "/time-report?format=csv")).text();
    expect(lead).toMatch(/Trainer A;[^\r\n]*;3;2\r\n/);
    await clear(member);
  });
});
