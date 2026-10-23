import { sql } from "drizzle-orm";

import { db } from "../db/client.js";
import type { JobContext } from "./jobs/registry.js";
import { deleteFinishedJobs } from "./jobs/queue.js";
import { logger } from "./logger.js";
import { purgeRateLimitEvents } from "./rate-limits.js";
import { runRetentionRules } from "./retention/sweep.js";

/**
 * Retention jobs (Wave 9 B13). One recurring job `retention_sweep` (daily) runs every registered retention task, each in
 * isolation (a failing task does not stop the others; the job fails afterwards so the queue retries, tasks are idempotent).
 *
 * HOOK POINT: retention / deletion jobs register a `RetentionTask` via `registerRetentionTask` from `registerRetentionTasks()` --
 * no new job type or scheduler plumbing needed. The data protection rules of Wave 10 (proof documents, applications, former
 * members, absences, consent proofs, audit log; `lib/retention/`) run as ONE task, `data-retention`, which isolates and logs
 * its categories itself (`retention_runs`) and only counts unless `RETENTION_DRY_RUN=false`.
 */

export const RETENTION_SWEEP_JOB_TYPE = "retention_sweep";
export const RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RetentionTask {
  /** Stable identifier (logs, tests). */
  key: string;
  description: string;
  run(ctx: { now: Date }): Promise<{ affected: number }>;
}

const tasks = new Map<string, RetentionTask>();

export function registerRetentionTask(task: RetentionTask): void {
  if (tasks.has(task.key)) throw new Error(`retention task already registered: ${task.key}`);
  tasks.set(task.key, task);
}

export function retentionTasks(): RetentionTask[] {
  return [...tasks.values()];
}

/** Test helper. */
export function clearRetentionTasks(): void {
  tasks.clear();
}

export interface RetentionRunResult {
  results: Array<{ key: string; affected: number; error?: string }>;
}

export async function runRetention(now: Date = new Date()): Promise<RetentionRunResult> {
  const results: RetentionRunResult["results"] = [];
  for (const task of tasks.values()) {
    try {
      const { affected } = await task.run({ now });
      results.push({ key: task.key, affected });
      if (affected > 0) logger.info({ task: task.key, affected }, "[retention] task finished");
    } catch (err) {
      results.push({ key: task.key, affected: 0, error: (err as Error)?.name ?? "Error" });
      logger.error({ task: task.key, errName: (err as Error)?.name, errCode: (err as { code?: unknown })?.code }, "[retention] task failed");
    }
  }
  return { results };
}

export async function handleRetentionSweep(_job: JobContext): Promise<void> {
  const { results } = await runRetention();
  const failed = results.filter((r) => r.error).map((r) => r.key);
  // No personal data in the error text (it ends up in jobs.last_error).
  if (failed.length > 0) throw new Error(`retention tasks failed: ${failed.join(", ")}`);
}

// --- delivery retention ------------------------------------------------------------------------

/** Days after which delivery addresses and mail content snapshots are wiped (default 90, clamped 1-3650). */
export function deliveryRetentionDays(): number {
  const n = Number(process.env.DELIVERY_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 3650 ? Math.floor(n) : 90;
}

const BATCH = 1000;

/**
 * `message_deliveries` keeps the proof of delivery (who, which event, channel, status, time) but not what was needed
 * only for sending: for finished e-mail rows older than `DELIVERY_RETENTION_DAYS` the address is set to NULL and the content
 * snapshot is reduced to title/template/category/class (`scrubbed: true`: no body, rendered mail, recipient name or link).
 * Rows that are still `queued` are never touched. The in-app copies (the member's inbox) are not part of this task.
 * Idempotent: scrubbed rows no longer match.
 */
export async function scrubOldEmailDeliveries(now: Date = new Date(), days: number = deliveryRetentionDays()): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  let total = 0;
  for (;;) {
    const result = await db.execute(sql`
      UPDATE message_deliveries d
      SET address = NULL,
          content = CASE WHEN d.content IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
            'title', d.content->'title', 'template', d.content->'template', 'category', d.content->'category', 'class', d.content->'class', 'scrubbed', true
          )) END
      WHERE d.id IN (
        SELECT id FROM message_deliveries
        WHERE channel = 'email' AND status <> 'queued' AND created_at < ${cutoff}
          AND (address IS NOT NULL OR (content IS NOT NULL AND content->>'scrubbed' IS NULL))
        LIMIT ${BATCH}
      )`);
    const n = result.rowCount ?? 0;
    total += n;
    if (n < BATCH) return total;
  }
}

/**
 * In-app and push rows carry the message text (the inbox copy / send snapshot). Once a push row is settled or an in-app
 * row was read and is older than `DELIVERY_RETENTION_DAYS`, the content is reduced to title/template/category/class
 * (`scrubbed: true`, no body, name or link); the row itself stays as proof of delivery. Unread inbox rows are kept intact.
 */
export async function scrubOldInboxDeliveries(now: Date = new Date(), days: number = deliveryRetentionDays()): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  let total = 0;
  for (;;) {
    const result = await db.execute(sql`
      UPDATE message_deliveries d
      SET content = jsonb_strip_nulls(jsonb_build_object(
            'title', d.content->'title', 'template', d.content->'template', 'category', d.content->'category', 'class', d.content->'class', 'scrubbed', true
          ))
      WHERE d.id IN (
        SELECT id FROM message_deliveries
        WHERE created_at < ${cutoff} AND content IS NOT NULL AND content->>'scrubbed' IS NULL
          AND ((channel = 'in_app' AND read_at IS NOT NULL) OR (channel = 'push' AND status <> 'queued'))
        LIMIT ${BATCH}
      )`);
    const n = result.rowCount ?? 0;
    total += n;
    if (n < BATCH) return total;
  }
}

/** Days after which finished (`done`) jobs are deleted (default 14, clamped 2-3650: must outlive the reminder horizon / dedupe keys). */
export function jobsRetentionDays(): number {
  const n = Number(process.env.JOBS_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 2 && n <= 3650 ? Math.floor(n) : 14;
}

export function registerRetentionTasks(): void {
  registerRetentionTask({
    key: "inbox-retention",
    description: "Scrub message text of read in-app and settled push deliveries after DELIVERY_RETENTION_DAYS",
    run: async ({ now }) => ({ affected: await scrubOldInboxDeliveries(now) }),
  });
  registerRetentionTask({
    key: "jobs-retention",
    description: "Delete done jobs older than JOBS_RETENTION_DAYS (dead jobs are kept for inspection)",
    run: async ({ now }) => ({ affected: await deleteFinishedJobs(jobsRetentionDays() * 86_400_000, now) }),
  });
  registerRetentionTask({
    key: "delivery-retention",
    description: "Wipe e-mail delivery addresses and content snapshots after DELIVERY_RETENTION_DAYS",
    run: async ({ now }) => ({ affected: await scrubOldEmailDeliveries(now) }),
  });
  registerRetentionTask({
    key: "data-retention",
    description: "Wave 10 retention rules (RETENTION_DRY_RUN=true counts only)",
    run: async ({ now }) => {
      const summary = await runRetentionRules(now);
      // Category names only (no data) so the queue retries; every category already logged its own error.
      if (summary.failed.length > 0) throw new Error(`retention categories failed: ${[...new Set(summary.failed)].join(", ")}`);
      return { affected: summary.affected };
    },
  });
  registerRetentionTask({
    key: "rate-limit-events",
    description: "Delete DB rate limit hits older than two days",
    run: async ({ now }) => ({ affected: await purgeRateLimitEvents(now) }),
  });
}
