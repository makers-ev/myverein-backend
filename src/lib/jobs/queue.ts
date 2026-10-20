import { sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { jobs } from "../../db/schema/jobs.js";

export interface EnqueueInput {
  type: string;
  payload?: Record<string, unknown>;
  /** Earliest execution time (default: now). */
  runAt?: Date;
  /** Idempotency key: enqueueing the same key again is a no-op (also across instances). */
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Anything with drizzle's `insert` (the `db` or a transaction), so a job can be enqueued atomically with a business write. */
export type JobExecutor = Pick<typeof db, "insert">;

export function defaultMaxAttempts(): number {
  const n = Number(process.env.JOB_MAX_ATTEMPTS ?? 5);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 5;
}

/**
 * Schedules a job. Returns `{ id, created }`; with a `dedupeKey` that already exists nothing is inserted and
 * `{ id: null, created: false }` is returned (the existing job, whatever its state, stays untouched).
 */
export async function enqueue(input: EnqueueInput, executor: JobExecutor = db): Promise<{ id: string | null; created: boolean }> {
  const rows = await executor
    .insert(jobs)
    .values({
      type: input.type,
      payload: input.payload ?? {},
      runAt: input.runAt ?? new Date(),
      dedupeKey: input.dedupeKey ?? null,
      maxAttempts: input.maxAttempts ?? defaultMaxAttempts(),
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  const row = rows[0];
  return row ? { id: row.id, created: true } : { id: null, created: false };
}

/** `type:YYYY-MM-DDTHH:MM` (UTC) of the interval bucket containing `now`, e.g. `reminder-sweep:2026-10-12T08:15`. */
export function bucketDedupeKey(type: string, intervalMs: number, now: Date = new Date()): string {
  const interval = Math.max(60_000, Math.floor(intervalMs));
  const start = new Date(Math.floor(now.getTime() / interval) * interval);
  return `${type}:${start.toISOString().slice(0, 16)}`;
}

/** Idempotently schedules the run of a recurring job for the current time bucket. Safe to call from every instance. */
export async function enqueueRecurring(type: string, intervalMs: number, payload: Record<string, unknown> = {}, now: Date = new Date()): Promise<boolean> {
  const interval = Math.max(60_000, Math.floor(intervalMs));
  const runAt = new Date(Math.floor(now.getTime() / interval) * interval);
  const { created } = await enqueue({ type, payload, runAt, dedupeKey: bucketDedupeKey(type, interval, now) });
  return created;
}

/** Deletes finished jobs older than `olderThanMs` (housekeeping; `dead` jobs are kept for inspection). */
export async function deleteFinishedJobs(olderThanMs: number, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);
  const result = await db.execute(sql`DELETE FROM jobs WHERE status = 'done' AND finished_at < ${cutoff}`);
  return result.rowCount ?? 0;
}
