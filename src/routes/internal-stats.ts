import { timingSafeEqual } from "node:crypto";

import { count, gt, gte } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";

import { session, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { ServiceUnavailableError, UnauthorizedError } from "../lib/errors.js";

/**
 * Admin-only, token-authenticated aggregate stats -- deliberately NOT
 * gated by `adminGuard`/a Better Auth session. A caller of this endpoint
 * (e.g. project-portal's Fleet Dashboard, see that repo's PRD §5) is a
 * different backend entirely, with no user account of its own on THIS
 * instance. Requiring a real admin login here would mean a central portal
 * holding live admin credentials for every project it manages -- a far
 * bigger blast radius than one static, single-purpose token per project
 * that can only ever read this one aggregate endpoint, never touch
 * anything else `adminGuard` protects. Mirrors this template's existing
 * /health, /ready pattern (no plugin, no new table) rather than inventing
 * a second auth mechanism for a one-route need.
 *
 * Only ever returns aggregates -- counts, never rows. See the same PRD
 * section on why: a portal is meant to stay a client of this data, not a
 * second system with raw access to it.
 */
function checkToken(c: Context): void {
  const configured = process.env.INTERNAL_STATS_TOKEN;
  if (!configured) {
    throw new ServiceUnavailableError("INTERNAL_STATS_TOKEN is not configured on this backend.");
  }

  const header = c.req.header("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  // Constant-time comparison -- a naive `===` here would leak how many
  // leading characters of the token guessed right via response timing,
  // the same class of bug the base template's session lookups are
  // careful to avoid by never hand-rolling token comparisons elsewhere.
  const providedBuf = Buffer.from(provided);
  const configuredBuf = Buffer.from(configured);
  const matches = providedBuf.length === configuredBuf.length && timingSafeEqual(providedBuf, configuredBuf);

  if (!matches) {
    throw new UnauthorizedError("Invalid or missing internal stats token.");
  }
}

export const internalStatsRoutes = new Hono();

internalStatsRoutes.get("/stats", async (c) => {
  checkToken(c);

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [totalUsersRow, newUsersRow, activeSessionsRow, eventRows] = await Promise.all([
    db.select({ value: count() }).from(user),
    db.select({ value: count() }).from(user).where(gte(user.createdAt, sevenDaysAgo)),
    db.select({ value: count() }).from(session).where(gt(session.expiresAt, new Date())),
    db.select({ eventType: auditLog.eventType, value: count() }).from(auditLog).groupBy(auditLog.eventType),
  ]);

  return c.json({
    totalUsers: totalUsersRow[0].value,
    newUsersLast7Days: newUsersRow[0].value,
    activeSessions: activeSessionsRow[0].value,
    // "Usage per feature" (PRD §5) proxied by audit_log's own event_type
    // breakdown -- the same events already written by databaseHooks and
    // domain routes, not a new instrumentation layer.
    eventCounts: Object.fromEntries(eventRows.map((row) => [row.eventType, row.value])),
    generatedAt: new Date().toISOString(),
  });
});
