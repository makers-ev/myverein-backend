import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const JOB_STATUSES = ["queued", "running", "done", "failed", "dead"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * DB-backed job queue (ADR-005, Wave 9). Workers claim rows with `SELECT ... FOR UPDATE SKIP LOCKED`; `locked_until` is
 * the lease, `dedupe_key` makes scheduling idempotent (NULL = no deduplication). `failed` = last attempt failed and a
 * retry is scheduled (status goes back to `queued` when it is claimed again), `dead` = `max_attempts` exhausted.
 * `payload` and `last_error` must not contain personal data (ids only).
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    // One of JOB_STATUSES (free text in the DB, like the other status columns).
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    // Unique when set (Postgres allows several NULLs).
    dedupeKey: text("dedupe_key").unique("jobs_dedupe_key_uidx"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("jobs_status_run_at_idx").on(table.status, table.runAt), index("jobs_type_status_idx").on(table.type, table.status)],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
