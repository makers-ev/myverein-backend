import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Hit log of the DB-backed rate limits (Wave 9 B14): one row per allowed request, counted within a sliding window. Unlike
 * the in-memory limiter this survives restarts and is shared by all instances. `subject` is a user id, a club id or a
 * salted hash of the client IP (never a raw address). Old rows are removed by the retention task `rate-limit-events`.
 */
export const rateLimitEvents = pgTable(
  "rate_limit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bucket: text("bucket").notNull(),
    subject: text("subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("rate_limit_events_lookup_idx").on(table.bucket, table.subject, table.createdAt)],
);

export type RateLimitEventRow = typeof rateLimitEvents.$inferSelect;
