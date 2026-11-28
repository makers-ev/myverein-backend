import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubPlatformStatus } from "../db/schema/club-platform.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { timeEntries } from "../db/schema/event-extras.js";
import { createEventFixture, HOUR, type EventFixture } from "../routes/event-test-support.js";
import { timeEntryRoutes } from "../routes/time-tracking.js";
import { defaultRegistry } from "./jobs/registry.js";
import { registerAllJobs } from "./jobs/handlers.js";
import { autoCloseHours, sweepTimeEntries, TIME_SWEEP_JOB_TYPE } from "./time-sweep.js";

/** Wave 16 T4: running entries are ended after TIME_AUTO_CLOSE_HOURS at start + 16 h, flagged, audited and announced; idempotent; suspended clubs skipped. */
describe("time entry sweep: automatic end", () => {
  let fx: EventFixture;
  const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
  const running = async (clubMemberId: string, hours: number) =>
    (await db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId, startedAt: hoursAgo(hours), source: "stempeln", status: "offen" }).returning())[0]!;
  const load = async (id: string) => (await db.select().from(timeEntries).where(eq(timeEntries.id, id)))[0]!;
  const original = process.env.TIME_AUTO_CLOSE_HOURS;

  beforeAll(async () => {
    fx = await createEventFixture("timesweep", [["/time-entries", timeEntryRoutes]]);
  }, 60_000);
  afterEach(async () => {
    if (original === undefined) delete process.env.TIME_AUTO_CLOSE_HOURS;
    else process.env.TIME_AUTO_CLOSE_HOURS = original;
    await db.delete(timeEntries).where(eq(timeEntries.clubId, fx.clubId));
    await db.delete(clubPlatformStatus).where(eq(clubPlatformStatus.clubId, fx.clubId));
  });
  afterAll(async () => fx.cleanup());

  it("is registered as a recurring job and reads TIME_AUTO_CLOSE_HOURS within 17..720 (default 24)", () => {
    registerAllJobs();
    expect(defaultRegistry.types()).toContain(TIME_SWEEP_JOB_TYPE);
    delete process.env.TIME_AUTO_CLOSE_HOURS;
    expect(autoCloseHours()).toBe(24);
    for (const [raw, expected] of [["48", 48], ["17", 17], ["16", 24], ["10", 24], ["abc", 24], ["721", 24]] as const) {
      process.env.TIME_AUTO_CLOSE_HOURS = raw;
      expect(autoCloseHours(), raw).toBe(expected);
    }
  });

  it("ends entries after the threshold at start + 16 h, keeps them open, flags, audits and notifies once", async () => {
    const old = await running(fx.users.trainerA.clubMemberId, 328);
    const young = await running(fx.users.member1.clubMemberId, 20);
    const [finished] = await db.insert(timeEntries).values({ clubId: fx.clubId, clubMemberId: fx.users.member2.clubMemberId, startedAt: hoursAgo(40), endedAt: hoursAgo(39), source: "manuell", status: "offen" }).returning();
    expect(await sweepTimeEntries(new Date(), fx.clubId)).toMatchObject({ autoClosed: 1 });
    const closed = await load(old.id);
    expect(closed.endedAt!.getTime()).toBe(old.startedAt.getTime() + 16 * HOUR);
    expect(closed).toMatchObject({ status: "offen", autoClosed: true, corrected: false, confirmedAt: null });
    expect((await load(young.id)).endedAt).toBeNull();
    expect(await load(finished!.id)).toMatchObject({ autoClosed: false, endedAt: finished!.endedAt });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, fx.clubId), eq(auditLog.eventType, "time_entry.auto_close")));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorUserId: null, subjectMemberId: fx.users.trainerA.clubMemberId });
    expect(audits[0]!.payload).toMatchObject({ entryId: old.id, afterHours: 24 });
    const inbox = async () => db.select().from(messageDeliveries).where(and(eq(messageDeliveries.refId, `${old.id}#auto_closed`), eq(messageDeliveries.channel, "in_app")));
    const notes = await inbox();
    expect(notes.map((n) => n.clubMemberId)).toEqual([fx.users.trainerA.clubMemberId]);
    expect(notes[0]!.eventKey).toBe("time.auto_closed");
    // Idempotent: a second (and a parallel) run changes and sends nothing more.
    const again = await Promise.all([sweepTimeEntries(new Date(), fx.clubId), sweepTimeEntries(new Date(), fx.clubId)]);
    expect(again.map((r) => r.autoClosed)).toEqual([0, 0]);
    expect(await inbox()).toHaveLength(1);
    // The person can still correct it and the board confirms by hand; the API shows the flag.
    const list = (await fx.json(await fx.req(fx.users.trainerA, "/time-entries?from=2020-01-01"))).data;
    expect(list.find((e: { id: string }) => e.id === old.id)).toMatchObject({ autoClosed: true, running: false, status: "offen" });
    // A lower threshold reaches the 20 h entry.
    process.env.TIME_AUTO_CLOSE_HOURS = "17";
    expect(await sweepTimeEntries(new Date(), fx.clubId)).toMatchObject({ autoClosed: 1 });
    expect((await load(young.id)).autoClosed).toBe(true);
  });

  it("skips clubs suspended by the platform and catches up after the suspension ends", async () => {
    const entry = await running(fx.users.trainerA.clubMemberId, 30);
    await db.insert(clubPlatformStatus).values({ clubId: fx.clubId, suspendedAt: new Date() });
    expect(await sweepTimeEntries(new Date(), fx.clubId)).toMatchObject({ autoClosed: 0 });
    expect((await load(entry.id)).endedAt).toBeNull();
    await db.update(clubPlatformStatus).set({ suspendedAt: null }).where(eq(clubPlatformStatus.clubId, fx.clubId));
    expect(await sweepTimeEntries(new Date(), fx.clubId)).toMatchObject({ autoClosed: 1 });
  });
});
