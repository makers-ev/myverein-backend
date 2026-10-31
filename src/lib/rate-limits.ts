import { createHmac } from "node:crypto";

import { lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";

import { db } from "../db/client.js";
import { rateLimitEvents } from "../db/schema/rate-limits.js";
import { TooManyRequestsError } from "./errors.js";
import { writeAudit } from "./audit.js";

/**
 * DB-backed rate limits (Wave 9 B14, O4). The counter lives in `rate_limit_events`, so it is shared by all instances and
 * survives restarts (the in-memory limiter of `middleware/rate-limit.ts` stays for the old routes). A hit is only recorded
 * when it is allowed; a per-key transaction lock makes check-and-record atomic. Violations answer 429 with a clear
 * message and leave an audit entry (once per key and window, so a flood cannot fill the audit log).
 */

export interface LimitSpec {
  /** Rule name, e.g. `unsubscribe.ip` (also the audit `rule`). */
  bucket: string;
  /** User id, club id or `ipSubject(...)`. */
  subject: string;
  windowMs: number;
  max: number;
}

/** Reads a positive integer from the environment, clamped; falls back to `fallback` for unset/invalid values. */
export function envInt(name: string, fallback: number, min = 1, max = 1_000_000): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Client IP from `x-forwarded-for`. The first entry is client-controlled (a proxy only APPENDS), so it is never used:
 * `TRUSTED_PROXY_HOPS` (default 1) names how many entries our own proxies appended; the client address is the entry that
 * many positions from the right (1 = the last entry). Fewer entries than hops: the first one. No header: `unknown`.
 */
export function clientIp(c: Context): string {
  const entries = (c.req.header("x-forwarded-for") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (entries.length === 0) return "unknown";
  const hops = envInt("TRUSTED_PROXY_HOPS", 1, 1, 10);
  return entries[Math.max(0, entries.length - hops)]!;
}

/** Salted hash of the client IP (`clientIp`): the table never stores a raw address. */
export function ipSubject(c: Context): string {
  const forwarded = clientIp(c);
  const secret = process.env.UNSUBSCRIBE_SECRET || process.env.BETTER_AUTH_SECRET || "rate-limit";
  return createHmac("sha256", secret).update(`rate-limit-ip:${forwarded}`).digest("hex").slice(0, 32);
}

/** Atomically counts the allowed hits of `spec` in its window and records a new one. */
export async function tryConsume(spec: LimitSpec): Promise<{ allowed: boolean; count: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${spec.bucket}:${spec.subject}`}, 0))`);
    const since = new Date(Date.now() - spec.windowMs);
    const result = await tx.execute(sql`SELECT count(*)::int AS n FROM rate_limit_events WHERE bucket = ${spec.bucket} AND subject = ${spec.subject} AND created_at > ${since}`);
    const count = Number((result.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (count >= spec.max) return { allowed: false, count };
    await tx.insert(rateLimitEvents).values({ bucket: spec.bucket, subject: spec.subject });
    return { allowed: true, count: count + 1 };
  });
}

const windowLabel = (ms: number): string => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)} h` : `${Math.max(1, Math.round(ms / 60_000))} min`);

/** Writes the violation audit entry, once per bucket, subject and window. Ids/rule names only, no personal data. */
export async function auditViolation(spec: LimitSpec, payload: Record<string, unknown> = {}): Promise<void> {
  const first = await tryConsume({ bucket: `${spec.bucket}:violation`, subject: spec.subject, windowMs: spec.windowMs, max: 1 });
  if (!first.allowed) return;
  await writeAudit(db, { eventType: "rate_limit.exceeded", subjectId: spec.subject.length <= 64 ? spec.subject : null, payload: { rule: spec.bucket, limit: spec.max, windowSeconds: Math.round(spec.windowMs / 1000), ...payload } });
}

/** Consumes one hit or throws `429` with `message` (default derived from the rule) and an audit entry. */
export async function enforceLimit(spec: LimitSpec, message?: string, audit: Record<string, unknown> = {}): Promise<void> {
  const { allowed } = await tryConsume(spec);
  if (allowed) return;
  await auditViolation(spec, audit);
  throw new TooManyRequestsError(message ?? `Too many requests (limit ${spec.max} per ${windowLabel(spec.windowMs)}), try again later`, {
    details: { rule: spec.bucket, limit: spec.max, windowSeconds: Math.round(spec.windowMs / 1000) },
  });
}

/**
 * Hono middleware: DB-backed limit per `subject` (default: hashed client IP). `max` is a function so the environment is read
 * per request. A subject function must run after `sessionGuard` when it uses the user.
 */
export function dbRateLimit(options: { bucket: string; windowMs: number; max: () => number; subject?: (c: Context) => string; message?: string }) {
  return createMiddleware(async (c, next) => {
    await enforceLimit({ bucket: options.bucket, subject: options.subject ? options.subject(c) : ipSubject(c), windowMs: options.windowMs, max: options.max() }, options.message);
    await next();
  });
}

/** Retention: removes hits older than two days (the longest window is one day). */
export async function purgeRateLimitEvents(now: Date = new Date()): Promise<number> {
  const rows = await db.delete(rateLimitEvents).where(lt(rateLimitEvents.createdAt, new Date(now.getTime() - 2 * 24 * 3_600_000))).returning({ id: rateLimitEvents.id });
  return rows.length;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
