import { randomUUID } from "node:crypto";

import { eq, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db } from "../../db/client.js";
import { jobs } from "../../db/schema/jobs.js";
import { bucketDedupeKey, enqueue, enqueueRecurring } from "./queue.js";
import { JobRegistry } from "./registry.js";
import { backoffDelayMs, getWorkerHeartbeat, JobWorker } from "./worker.js";

/** Unique job-type prefix per test file run: the table is shared with parallel test files and workers filter by type. */
const P = `t${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const row = async (id: string) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
const worker = (registry: JobRegistry, extra: Partial<ConstructorParameters<typeof JobWorker>[0]> = {}) =>
  new JobWorker({ registry, pollIntervalMs: 50, concurrency: 5, leaseMs: 60_000, backoffBaseMs: 100, drainMs: 2000, ...extra });

afterAll(async () => {
  await db.delete(jobs).where(like(jobs.type, `${P}%`));
});

describe("enqueue", () => {
  it("is idempotent per dedupeKey and allows many jobs without a key", async () => {
    const type = `${P}-dedupe`;
    const a = await enqueue({ type, dedupeKey: `${type}:k` });
    const b = await enqueue({ type, dedupeKey: `${type}:k` });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: null, created: false });
    expect((await enqueue({ type })).created).toBe(true);
    expect((await enqueue({ type })).created).toBe(true);
    expect((await db.select().from(jobs).where(eq(jobs.type, type))).length).toBe(3);
  });

  it("creates parallel enqueues with the same key exactly once", async () => {
    const type = `${P}-dedupe-par`;
    const results = await Promise.all(Array.from({ length: 10 }, () => enqueue({ type, dedupeKey: `${type}:k` })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });
});

describe("recurring helper", () => {
  it("builds time-bucketed keys", () => {
    const now = new Date("2026-10-12T08:17:42.000Z");
    expect(bucketDedupeKey("reminder-sweep", 15 * 60_000, now)).toBe("reminder-sweep:2026-10-12T08:15");
    expect(bucketDedupeKey("reminder-sweep", 60 * 60_000, now)).toBe("reminder-sweep:2026-10-12T08:00");
    expect(bucketDedupeKey("reminder-sweep", 1000, now)).toBe("reminder-sweep:2026-10-12T08:17"); // clamped to 1 min
  });

  it("schedules each bucket once and a new bucket again", async () => {
    const type = `${P}-recurring`;
    const t1 = new Date("2026-10-12T08:17:00.000Z");
    expect(await enqueueRecurring(type, 15 * 60_000, {}, t1)).toBe(true);
    expect(await enqueueRecurring(type, 15 * 60_000, {}, new Date("2026-10-12T08:29:59.000Z"))).toBe(false);
    expect(await enqueueRecurring(type, 15 * 60_000, {}, new Date("2026-10-12T08:30:00.000Z"))).toBe(true);
    const rows = await db.select().from(jobs).where(eq(jobs.type, type));
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual([`${type}:2026-10-12T08:15`, `${type}:2026-10-12T08:30`]);
  });

  it("runs a registered recurring job once per bucket even with two workers", async () => {
    const type = `${P}-recurring-run`;
    const registry = new JobRegistry();
    let runs = 0;
    registry.registerRecurringJob({ type, intervalMs: 24 * 3_600_000 }, async () => {
      runs += 1;
    });
    const w1 = worker(registry);
    const w2 = worker(registry);
    await Promise.all([w1.drain(), w2.drain()]);
    await Promise.all([w1.drain(), w2.drain()]);
    const rows = await db.select().from(jobs).where(eq(jobs.type, type));
    expect(rows).toHaveLength(1);
    expect(runs).toBe(1);
    expect(rows[0]!.status).toBe("done");
  });
});

describe("worker", () => {
  it("processes every job exactly once with two parallel workers", async () => {
    const type = `${P}-parallel`;
    const registry = new JobRegistry();
    const seen = new Map<string, number>();
    registry.registerJob(type, async (job) => {
      await sleep(5);
      seen.set(job.id, (seen.get(job.id) ?? 0) + 1);
    });
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push((await enqueue({ type, payload: { i } })).id!);

    const w1 = worker(registry);
    const w2 = worker(registry);
    w1.start();
    w2.start();
    for (let i = 0; i < 200 && seen.size < ids.length; i++) await sleep(50);
    await sleep(300); // give a (wrong) double execution the chance to show up
    await Promise.all([w1.stop(), w2.stop()]);

    expect(seen.size).toBe(60);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    const rows = await db.select().from(jobs).where(eq(jobs.type, type));
    expect(rows.every((r) => r.status === "done" && r.attempts === 1 && r.lockedBy === null && r.finishedAt !== null)).toBe(true);
  }, 30_000);

  it("does not run future jobs before runAt", async () => {
    const type = `${P}-future`;
    const registry = new JobRegistry();
    let ran = 0;
    registry.registerJob(type, async () => void (ran += 1));
    const { id } = await enqueue({ type, runAt: new Date(Date.now() + 3_600_000) });
    await worker(registry).drain();
    expect(ran).toBe(0);
    expect((await row(id!)).status).toBe("queued");
  });

  it("retries with exponential backoff and ends dead after max_attempts", async () => {
    const type = `${P}-retry`;
    const registry = new JobRegistry();
    let calls = 0;
    registry.registerJob(type, async () => {
      calls += 1;
      throw new Error("boom\nsecond line");
    });
    const w = worker(registry, { backoffBaseMs: 2000 });
    const { id } = await enqueue({ type, maxAttempts: 3 });

    await w.drain();
    let r = await row(id!);
    expect(calls).toBe(1);
    expect(r.status).toBe("failed");
    expect(r.attempts).toBe(1);
    expect(r.lastError).toBe("Error: boom second line");
    const delay1 = r.runAt.getTime() - Date.now();
    expect(delay1).toBeGreaterThan(500);
    expect(delay1).toBeLessThanOrEqual(2100);

    await w.drain(); // not due yet
    expect(calls).toBe(1);

    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, id!));
    await w.drain();
    r = await row(id!);
    expect(calls).toBe(2);
    expect(r.status).toBe("failed");
    const delay2 = r.runAt.getTime() - Date.now();
    expect(delay2).toBeGreaterThan(2500); // second retry waits twice as long (4 s)
    expect(delay2).toBeLessThanOrEqual(4100);

    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, id!));
    await w.drain();
    r = await row(id!);
    expect(calls).toBe(3);
    expect(r.status).toBe("dead");
    expect(r.finishedAt).not.toBeNull();
    await w.drain();
    expect(calls).toBe(3);
  }, 20_000);

  it("computes capped exponential delays", () => {
    expect(backoffDelayMs(1, 30_000, 3_600_000)).toBe(30_000);
    expect(backoffDelayMs(3, 30_000, 3_600_000)).toBe(120_000);
    expect(backoffDelayMs(20, 30_000, 3_600_000)).toBe(3_600_000);
  });

  it("recovers a job whose lease expired (crashed worker) and kills one that is out of attempts", async () => {
    const type = `${P}-lease`;
    const registry = new JobRegistry();
    const ran: string[] = [];
    registry.registerJob(type, async (job) => void ran.push(job.id));
    const crashed = (await enqueue({ type, maxAttempts: 3 })).id!;
    const live = (await enqueue({ type, maxAttempts: 3 })).id!;
    const exhausted = (await enqueue({ type, maxAttempts: 2 })).id!;
    await db.update(jobs).set({ status: "running", lockedBy: "ghost", lockedUntil: new Date(Date.now() - 1000), attempts: 1 }).where(eq(jobs.id, crashed));
    await db.update(jobs).set({ status: "running", lockedBy: "other", lockedUntil: new Date(Date.now() + 600_000), attempts: 1 }).where(eq(jobs.id, live));
    await db.update(jobs).set({ status: "running", lockedBy: "ghost", lockedUntil: new Date(Date.now() - 1000), attempts: 2 }).where(eq(jobs.id, exhausted));

    await worker(registry).drain();

    expect(ran).toEqual([crashed]);
    const c = await row(crashed);
    expect(c.status).toBe("done");
    expect(c.attempts).toBe(2);
    expect((await row(live)).status).toBe("running"); // valid lease of another worker is respected
    expect((await row(exhausted)).status).toBe("dead");
  });

  it("does not let a worker that lost its lease overwrite the new owner's result", async () => {
    const type = `${P}-lost`;
    const registry = new JobRegistry();
    registry.registerJob(type, async (job) => {
      // Simulate: lease expired and another worker took over while this handler was still running.
      await db.update(jobs).set({ lockedBy: "other-worker" }).where(eq(jobs.id, job.id));
    });
    const { id } = await enqueue({ type });
    await worker(registry).drain();
    const r = await row(id!);
    expect(r.status).toBe("running");
    expect(r.lockedBy).toBe("other-worker");
  });

  it("only claims job types it has handlers for", async () => {
    const mine = `${P}-mine`;
    const theirs = `${P}-theirs`;
    const registry = new JobRegistry();
    registry.registerJob(mine, async () => undefined);
    const a = (await enqueue({ type: mine })).id!;
    const b = (await enqueue({ type: theirs })).id!;
    await worker(registry).drain();
    expect((await row(a)).status).toBe("done");
    expect((await row(b)).status).toBe("queued");
  });

  it("respects concurrency", async () => {
    const type = `${P}-conc`;
    const registry = new JobRegistry();
    let active = 0;
    let peak = 0;
    registry.registerJob(type, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(40);
      active -= 1;
    });
    for (let i = 0; i < 8; i++) await enqueue({ type });
    await worker(registry, { concurrency: 2 }).drain();
    expect(peak).toBe(2);
  });

  it("shuts down cleanly: waits for running handlers and exposes a heartbeat", async () => {
    const type = `${P}-shutdown`;
    const registry = new JobRegistry();
    let finished = false;
    let started = false;
    registry.registerJob(type, async () => {
      started = true;
      await sleep(300);
      finished = true;
    });
    const { id } = await enqueue({ type });
    const w = worker(registry);
    expect(getWorkerHeartbeat()).toBeNull();
    w.start();
    for (let i = 0; i < 100 && !started; i++) await sleep(20);
    const hb = getWorkerHeartbeat();
    expect(hb).toMatchObject({ running: true, stale: false });
    expect(hb!.lastPollAt).not.toBeNull();
    await w.stop();
    expect(finished).toBe(true);
    expect((await row(id!)).status).toBe("done");
    expect(getWorkerHeartbeat()).toBeNull();
  });
});
