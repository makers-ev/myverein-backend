import { gte } from "drizzle-orm";
import { Hono } from "hono";

import { session, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { computeActivityBuckets, generateDayKeys, generateWeekKeys, periodKeyFn, weekKey, dayKey } from "../lib/activity-stats.js";
import { ValidationError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Backs the admin dashboard's KPI cards + activity chart
 * (_template_better-auth-admin's Dashboard). The only app-owned aggregate
 * endpoint this template's admin plugin doesn't already cover -- see
 * ADR/Concept "Better Auth Admin Dashboard" in the vault for why everything
 * else (user CRUD, ban, sessions) needed no new backend route.
 *
 * "Active" = had a session created in the window -- a login proxy, not a
 * request-level activity signal (none exists in this backend). See
 * src/lib/activity-stats.ts for the full definitions.
 */
export const adminStatsRoutes = new Hono<SessionEnv>();

adminStatsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
adminStatsRoutes.use("*", adminGuard);

const PERIOD_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
const INTERVALS = ["day", "week"] as const;

adminStatsRoutes.get("/activity-stats", async (c) => {
  const intervalParam = c.req.query("interval") ?? "day";
  const periodParam = c.req.query("period") ?? "30d";

  if (!INTERVALS.includes(intervalParam as (typeof INTERVALS)[number])) {
    throw new ValidationError("interval must be 'day' or 'week'");
  }
  const periodDays = PERIOD_DAYS[periodParam];
  if (!periodDays) {
    throw new ValidationError("period must be one of '7d', '30d', '90d'");
  }
  const interval = intervalParam as (typeof INTERVALS)[number];

  const now = new Date();

  // Chart buckets: day/week granularity across the requested period, plus
  // one extra lookback bucket so the first displayed bucket can still be
  // classified against its predecessor (see computeActivityBuckets's doc).
  const bucketCount = interval === "day" ? periodDays : Math.ceil(periodDays / 7);
  const chartBucketKeys = interval === "day" ? generateDayKeys(bucketCount + 1, now) : generateWeekKeys(bucketCount + 1, now);
  const chartKeyFn = interval === "day" ? dayKey : weekKey;
  const chartLookbackStart =
    interval === "day"
      ? new Date(now.getTime() - (bucketCount + 1) * 86_400_000)
      : new Date(now.getTime() - (bucketCount + 1) * 7 * 86_400_000);

  // Summary buckets: three whole-period-long windows (current / prev /
  // prev2) fed through the exact same classifier for the KPI cards' values
  // and their %-delta vs the previous period -- see periodKeyFn's doc for
  // why this reuses computeActivityBuckets instead of separate logic.
  const summaryBucketKeys = ["prev2", "prev", "current"];
  const summaryKeyFn = periodKeyFn(periodDays, now);
  const summaryLookbackStart = new Date(now.getTime() - 3 * periodDays * 86_400_000);

  const overallLookbackStart = chartLookbackStart < summaryLookbackStart ? chartLookbackStart : summaryLookbackStart;

  const [signupRows, sessionRows] = await Promise.all([
    db.select({ userId: user.id, createdAt: user.createdAt }).from(user).where(gte(user.createdAt, overallLookbackStart)),
    db.select({ userId: session.userId, createdAt: session.createdAt }).from(session).where(gte(session.createdAt, overallLookbackStart)),
  ]);

  const chartSignups = signupRows.map((r) => ({ userId: r.userId, day: chartKeyFn(r.createdAt) }));
  const chartSessions = sessionRows.map((r) => ({ userId: r.userId, day: chartKeyFn(r.createdAt) }));
  const chart = computeActivityBuckets(chartSignups, chartSessions, chartBucketKeys);

  const summarySignups = signupRows.map((r) => ({ userId: r.userId, day: summaryKeyFn(r.createdAt) }));
  const summarySessions = sessionRows.map((r) => ({ userId: r.userId, day: summaryKeyFn(r.createdAt) }));
  const [previous, current] = computeActivityBuckets(summarySignups, summarySessions, summaryBucketKeys);

  function delta(currentValue: number, previousValue: number): number | null {
    if (previousValue === 0) return null; // undefined % change from zero, not "0%" or "Infinity%"
    return Math.round(((currentValue - previousValue) / previousValue) * 1000) / 10;
  }

  return c.json({
    interval,
    period: periodParam,
    chart: chart.map(({ key, ...rest }) => ({ date: key, ...rest })),
    summary: {
      newUsers: { value: current.newUsers, changePercent: delta(current.newUsers, previous.newUsers) },
      activeUsers: { value: current.activeUsers, changePercent: delta(current.activeUsers, previous.activeUsers) },
      retained: { value: current.retained, changePercent: delta(current.retained, previous.retained) },
      reactivated: { value: current.reactivated, changePercent: delta(current.reactivated, previous.reactivated) },
    },
  });
});
