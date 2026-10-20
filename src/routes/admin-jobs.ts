import { and, asc, count, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { JOB_STATUSES, jobs, type JobStatus } from "../db/schema/jobs.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";
import { isUuid } from "../lib/club-members.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Platform-admin view of the job queue (Wave 9 A1): counts per status and job type, the oldest due jobs, the dead jobs and
 * "re-schedule a dead job". Payloads are never returned, `last_error` is shortened and scrubbed of anything that looks like
 * an e-mail address or a push token (handlers must not put personal data into errors; this is the second line of defence).
 */
export const adminJobRoutes = new Hono<SessionEnv>();

adminJobRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
adminJobRoutes.use("*", adminGuard);

const LIST_LIMIT = 20;

/** Error text safe to show: no addresses, no tokens, single line, at most 300 characters. */
export function scrubJobError(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[address]")
    .replace(/(?:Expo|Exponent)PushToken\[[^\]]*\]/g, "[push-token]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

const jobColumns = {
  id: jobs.id,
  type: jobs.type,
  status: jobs.status,
  runAt: jobs.runAt,
  attempts: jobs.attempts,
  maxAttempts: jobs.maxAttempts,
  lastError: jobs.lastError,
  finishedAt: jobs.finishedAt,
  createdAt: jobs.createdAt,
};

type JobListRow = { id: string; type: string; status: string; runAt: Date; attempts: number; maxAttempts: number; lastError: string | null; finishedAt: Date | null; createdAt: Date };

function shapeJob(row: JobListRow, now: Date) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    runAt: row.runAt,
    overdueSeconds: row.runAt.getTime() < now.getTime() ? Math.round((now.getTime() - row.runAt.getTime()) / 1000) : 0,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastError: scrubJobError(row.lastError),
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

adminJobRoutes.get("/stats", async (c) => {
  const now = new Date();
  const grouped = await db.select({ type: jobs.type, status: jobs.status, n: count() }).from(jobs).groupBy(jobs.type, jobs.status);
  const emptyCounts = (): Record<JobStatus, number> => ({ queued: 0, running: 0, done: 0, failed: 0, dead: 0 });
  const byType = new Map<string, Record<JobStatus, number>>();
  const totals = emptyCounts();
  for (const g of grouped) {
    if (!(JOB_STATUSES as readonly string[]).includes(g.status)) continue;
    const status = g.status as JobStatus;
    const entry = byType.get(g.type) ?? emptyCounts();
    entry[status] += g.n;
    totals[status] += g.n;
    byType.set(g.type, entry);
  }
  // Due = waiting for a worker (queued, or failed and waiting for its retry) and the time has come.
  const oldestDue = await db
    .select(jobColumns)
    .from(jobs)
    .where(and(inArray(jobs.status, ["queued", "failed"]), lte(jobs.runAt, sql`now()`)))
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .limit(LIST_LIMIT);
  const dead = await db.select(jobColumns).from(jobs).where(eq(jobs.status, "dead")).orderBy(desc(sql`coalesce(${jobs.finishedAt}, ${jobs.updatedAt})`), desc(jobs.id)).limit(LIST_LIMIT);
  c.header("Cache-Control", "private, no-store");
  return c.json({
    data: {
      generatedAt: now,
      totals,
      types: [...byType.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, counts]) => ({ type, ...counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) })),
      oldestDue: oldestDue.map((r) => shapeJob(r, now)),
      dead: dead.map((r) => shapeJob(r, now)),
    },
  });
});

/** Re-schedules a `dead` job: attempts reset, due immediately, error cleared. Only dead jobs; everything else is a `409`. */
adminJobRoutes.post("/:id/retry", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) throw new NotFoundError("Job not found");
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(jobs)
      .set({ status: "queued", attempts: 0, runAt: sql`now()`, lastError: null, lockedBy: null, lockedUntil: null, finishedAt: null, updatedAt: sql`now()` })
      .where(and(eq(jobs.id, id), eq(jobs.status, "dead")))
      .returning({ id: jobs.id, type: jobs.type });
    if (updated) {
      await tx.insert(auditLog).values({ eventType: "admin.job_retry", subjectId: id, payload: { type: updated.type, actor: c.get("user").id } });
      return updated;
    }
    const [existing] = await tx.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id));
    if (!existing) throw new NotFoundError("Job not found");
    throw new ConflictError("Only a dead job can be re-scheduled", { code: "CONFLICT", details: { status: existing.status } });
  });
  return c.json({ data: { id: result.id, type: result.type, status: "queued" } });
});
