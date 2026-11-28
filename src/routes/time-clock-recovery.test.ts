import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { clubMemberDepartments } from "../db/schema/club-members.js";
import { timeEntries } from "../db/schema/event-extras.js";
import { createEventFixture, HOUR, type EventFixture, type TestUser } from "./event-test-support.js";
import { timeEntryRoutes } from "./time-tracking.js";

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
    fx = await createEventFixture("timerec", [["/time-entries", timeEntryRoutes]]);
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
});
