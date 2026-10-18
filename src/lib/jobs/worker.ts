import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { jobs, type JobRow } from "../../db/schema/jobs.js";
import { logger } from "../logger.js";
import { enqueueRecurring } from "./queue.js";
import { defaultRegistry, type JobRegistry } from "./registry.js";

export interface WorkerOptions {
  registry?: JobRegistry;
  /** Idle poll interval. A full batch is followed by an immediate next poll. */
  pollIntervalMs?: number;
  /** Maximum jobs processed in parallel by this worker. */
  concurrency?: number;
  /** Lease: a claimed job is re-claimable after this long without renewal (crashed worker). Renewed while a handler runs. */
  leaseMs?: number;
  /** Retry delay = min(backoffMaxMs, backoffBaseMs * 2^(attempt-1)). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** How long `stop()` waits for running handlers. */
  drainMs?: number;
  workerId?: string;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Bounded, single-line error text for `jobs.last_error` (error class + message; handlers must not put personal data in errors). */
function describeError(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.replace(/\s+/g, " ").slice(0, 500);
}

export interface WorkerHeartbeat {
  running: boolean;
  workerId: string;
  lastPollAt: string | null;
  inFlight: number;
}

// Process-wide heartbeat for GET /ready (one worker per process in the app).
let activeHeartbeat: { owner: object; read: () => WorkerHeartbeat; pollIntervalMs: number } | null = null;

export function getWorkerHeartbeat(): (WorkerHeartbeat & { stale: boolean }) | null {
  if (!activeHeartbeat) return null;
  const hb = activeHeartbeat.read();
  const staleAfter = Math.max(30_000, activeHeartbeat.pollIntervalMs * 5);
  const stale = !hb.running || !hb.lastPollAt || Date.now() - Date.parse(hb.lastPollAt) > staleAfter;
  return { ...hb, stale };
}

export class JobWorker {
  readonly workerId: string;
  readonly pollIntervalMs: number;
  private readonly registry: JobRegistry;
  private readonly concurrency: number;
  private readonly leaseMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly drainMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private polling = false;
  private lastPollAt: Date | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly lastRecurringBucket = new Map<string, number>();

  constructor(options: WorkerOptions = {}) {
    this.registry = options.registry ?? defaultRegistry;
    this.pollIntervalMs = options.pollIntervalMs ?? envInt("WORKER_POLL_INTERVAL_MS", 2000, 50, 600_000);
    this.concurrency = options.concurrency ?? envInt("WORKER_CONCURRENCY", 4, 1, 64);
    this.leaseMs = options.leaseMs ?? envInt("WORKER_LEASE_SECONDS", 300, 5, 86_400) * 1000;
    this.backoffBaseMs = options.backoffBaseMs ?? envInt("JOB_BACKOFF_BASE_SECONDS", 30, 1, 3600) * 1000;
    this.backoffMaxMs = options.backoffMaxMs ?? 60 * 60 * 1000;
    this.drainMs = options.drainMs ?? 10_000;
    this.workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  }

  heartbeat(): WorkerHeartbeat {
    return { running: this.running, workerId: this.workerId, lastPollAt: this.lastPollAt?.toISOString() ?? null, inFlight: this.inFlight.size };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    activeHeartbeat = { owner: this, read: () => this.heartbeat(), pollIntervalMs: this.pollIntervalMs };
    logger.info({ workerId: this.workerId, types: this.registry.types().length }, "[jobs] worker started");
    this.schedule(0);
  }

  /** Stops polling and waits (up to `drainMs`) for running handlers. Unfinished leases simply expire for another worker. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const drained = Promise.allSettled([...this.inFlight]);
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([drained, new Promise<void>((resolve) => (timeout = setTimeout(resolve, this.drainMs)))]);
    if (timeout) clearTimeout(timeout);
    this.running = false;
    if (activeHeartbeat?.owner === this) activeHeartbeat = null;
    logger.info({ workerId: this.workerId, abandoned: this.inFlight.size }, "[jobs] worker stopped");
  }

  private schedule(delayMs: number): void {
    if (this.stopping || !this.running) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    let again = false;
    try {
      again = await this.pollOnce();
    } catch (err) {
      logger.error({ workerId: this.workerId, errName: err instanceof Error ? err.name : "unknown" }, "[jobs] poll failed");
    }
    this.schedule(again ? 0 : this.pollIntervalMs);
  }

  /** One poll: schedule due recurring jobs, then claim and start up to the free concurrency. Returns true if a full batch was claimed. */
  async pollOnce(): Promise<boolean> {
    if (this.polling || this.stopping) return false;
    this.polling = true;
    try {
      this.lastPollAt = new Date();
      await this.scheduleRecurring();
      const free = this.concurrency - this.inFlight.size;
      if (free <= 0) return false;
      const claimed = await this.claim(free);
      for (const job of claimed) this.run(job);
      return claimed.length === free;
    } finally {
      this.polling = false;
    }
  }

  /** Test helper: poll until nothing is claimable and all handlers finished. */
  async drain(): Promise<void> {
    for (;;) {
      const more = await this.pollOnce();
      await Promise.allSettled([...this.inFlight]);
      if (!more && this.inFlight.size === 0) return;
    }
  }

  private async scheduleRecurring(): Promise<void> {
    const now = new Date();
    for (const spec of this.registry.recurringSpecs()) {
      const bucket = Math.floor(now.getTime() / spec.intervalMs);
      if (this.lastRecurringBucket.get(spec.type) === bucket) continue;
      await enqueueRecurring(spec.type, spec.intervalMs, spec.payload, now);
      this.lastRecurringBucket.set(spec.type, bucket);
    }
  }

  private async claim(limit: number): Promise<JobRow[]> {
    const types = this.registry.types();
    if (types.length === 0) return [];
    // Jobs whose lease expired after their last allowed attempt are dead, not retried a further time.
    await db
      .update(jobs)
      .set({ status: "dead", lastError: "lease expired after last attempt", finishedAt: sql`now()`, lockedBy: null, lockedUntil: null, updatedAt: sql`now()` })
      .where(and(inArray(jobs.type, types), eq(jobs.status, "running"), lte(jobs.lockedUntil, sql`now()`), sql`${jobs.attempts} >= ${jobs.maxAttempts}`));

    const due = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          inArray(jobs.type, types),
          or(and(inArray(jobs.status, ["queued", "failed"]), lte(jobs.runAt, sql`now()`)), and(eq(jobs.status, "running"), lte(jobs.lockedUntil, sql`now()`))),
        ),
      )
      .orderBy(asc(jobs.runAt))
      .limit(limit)
      .for("update", { skipLocked: true });

    return db
      .update(jobs)
      .set({
        status: "running",
        lockedBy: this.workerId,
        lockedUntil: sql`now() + ${this.leaseMs / 1000} * interval '1 second'`,
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(inArray(jobs.id, due))
      .returning();
  }

  private run(job: JobRow): void {
    const p = this.execute(job).finally(() => this.inFlight.delete(p));
    this.inFlight.add(p);
  }

  private async execute(job: JobRow): Promise<void> {
    const handler = this.registry.getHandler(job.type);
    const renew = setInterval(() => void this.renewLease(job.id).catch(() => undefined), Math.max(1000, Math.floor(this.leaseMs / 3)));
    renew.unref?.();
    try {
      if (!handler) throw new Error("no handler registered");
      await handler({ id: job.id, type: job.type, payload: job.payload, attempt: job.attempts, maxAttempts: job.maxAttempts });
      await this.complete(job);
    } catch (err) {
      await this.fail(job, err);
    } finally {
      clearInterval(renew);
    }
  }

  private ownedBy(id: string) {
    return and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.lockedBy, this.workerId));
  }

  private async renewLease(id: string): Promise<void> {
    await db
      .update(jobs)
      .set({ lockedUntil: sql`now() + ${this.leaseMs / 1000} * interval '1 second'` })
      .where(this.ownedBy(id));
  }

  private async complete(job: JobRow): Promise<void> {
    const rows = await db
      .update(jobs)
      .set({ status: "done", lockedBy: null, lockedUntil: null, lastError: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(this.ownedBy(job.id))
      .returning({ id: jobs.id });
    if (rows.length === 0) logger.warn({ jobId: job.id, type: job.type }, "[jobs] lease lost before completion");
    else logger.debug({ jobId: job.id, type: job.type, attempt: job.attempts }, "[jobs] done");
  }

  private async fail(job: JobRow, err: unknown): Promise<void> {
    const dead = job.attempts >= job.maxAttempts;
    const delay = backoffDelayMs(job.attempts, this.backoffBaseMs, this.backoffMaxMs);
    const rows = await db
      .update(jobs)
      .set(
        dead
          ? { status: "dead", lastError: describeError(err), lockedBy: null, lockedUntil: null, finishedAt: sql`now()`, updatedAt: sql`now()` }
          : { status: "failed", lastError: describeError(err), runAt: sql`now() + ${delay / 1000} * interval '1 second'`, lockedBy: null, lockedUntil: null, updatedAt: sql`now()` },
      )
      .where(this.ownedBy(job.id))
      .returning({ id: jobs.id });
    // Log class only: error messages may carry personal data from handlers.
    logger.warn({ jobId: job.id, type: job.type, attempt: job.attempts, dead, lost: rows.length === 0, errName: err instanceof Error ? err.name : "unknown" }, "[jobs] attempt failed");
  }
}

export function startJobWorker(options: WorkerOptions = {}): JobWorker {
  const worker = new JobWorker(options);
  worker.start();
  return worker;
}
