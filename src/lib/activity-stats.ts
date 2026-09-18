/**
 * Cohort activity classification for the admin dashboard's KPI/chart data
 * (`GET /admin/activity-stats`). "Active" is a proxy for "created a session
 * in the bucket" (a login), not "did anything" -- there is no request-level
 * activity tracking anywhere in this backend, and this is the closest
 * honest signal that already exists.
 *
 * UTC-only throughout (same convention as this suite's other calendar
 * arithmetic, e.g. mycouple-backend's `daysUntilNext`) -- avoids the
 * classic "which server timezone is 'today' in" bug.
 */

export interface DayRow {
  userId: string;
  day: string;
}

export interface ActivityBucketResult {
  key: string;
  newUsers: number;
  activeUsers: number;
  retained: number;
  reactivated: number;
}

/** UTC calendar day, e.g. "2026-08-18". */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC ISO week start (Monday), as a day key. */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return dayKey(d);
}

/** `count` consecutive day keys ending at `endDate` (inclusive), oldest first. */
export function generateDayKeys(count: number, endDate: Date): string[] {
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(endDate);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(dayKey(d));
  }
  return keys;
}

/** `count` consecutive week-start keys ending at `endDate`'s week (inclusive), oldest first. */
export function generateWeekKeys(count: number, endDate: Date): string[] {
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(endDate);
    d.setUTCDate(d.getUTCDate() - i * 7);
    keys.push(weekKey(d));
  }
  return keys;
}

/**
 * Classifies (userId, day) rows into per-bucket New/Active/Retained/
 * Reactivated counts. `bucketKeys` must be ordered oldest-first and include
 * ONE extra bucket before the first one you want a result for -- retention
 * for bucket N is defined relative to bucket N-1, so the first returned
 * bucket needs that lookback bucket to compare against. The result array is
 * therefore always `bucketKeys.length - 1` entries long.
 *
 * Definitions:
 * - New: signed up within the bucket.
 * - Active: had >=1 session created within the bucket.
 * - Retained: active in this bucket AND the previous bucket.
 * - Reactivated: active in this bucket, not active in the previous bucket,
 *   and not new in this bucket (i.e. came back after a gap, as opposed to
 *   showing up for the first time).
 */
export function computeActivityBuckets(signups: DayRow[], sessions: DayRow[], bucketKeys: string[]): ActivityBucketResult[] {
  const newUsersByBucket = new Map<string, Set<string>>();
  const activeByBucket = new Map<string, Set<string>>();
  for (const key of bucketKeys) {
    newUsersByBucket.set(key, new Set());
    activeByBucket.set(key, new Set());
  }
  for (const { userId, day } of signups) {
    newUsersByBucket.get(day)?.add(userId);
  }
  for (const { userId, day } of sessions) {
    activeByBucket.get(day)?.add(userId);
  }

  const results: ActivityBucketResult[] = [];
  for (let i = 1; i < bucketKeys.length; i++) {
    const key = bucketKeys[i];
    const prevActive = activeByBucket.get(bucketKeys[i - 1]) ?? new Set();
    const active = activeByBucket.get(key) ?? new Set();
    const newUsers = newUsersByBucket.get(key) ?? new Set();

    let retained = 0;
    let reactivated = 0;
    for (const userId of active) {
      if (prevActive.has(userId)) {
        retained++;
      } else if (!newUsers.has(userId)) {
        reactivated++;
      }
    }

    results.push({ key, newUsers: newUsers.size, activeUsers: active.size, retained, reactivated });
  }
  return results;
}

/**
 * Maps a date to one of three consecutive `periodDays`-long windows ending
 * now ("current", "prev", "prev2"), or "out-of-range" for anything older.
 * Feeding these labels through `computeActivityBuckets` as bucket keys
 * reuses the exact same classification logic for period-over-period KPI
 * deltas as for the day/week chart -- no separate "summary" logic to keep
 * in sync.
 */
export function periodKeyFn(periodDays: number, now: Date): (date: Date) => string {
  const msPerDay = 86_400_000;
  const currentStart = now.getTime() - periodDays * msPerDay;
  const prevStart = currentStart - periodDays * msPerDay;
  const prev2Start = prevStart - periodDays * msPerDay;

  return (date: Date): string => {
    const t = date.getTime();
    if (t >= currentStart) return "current";
    if (t >= prevStart) return "prev";
    if (t >= prev2Start) return "prev2";
    return "out-of-range";
  };
}
