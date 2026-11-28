import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubPlatformStatus } from "../db/schema/club-platform.js";
import { timeEntries } from "../db/schema/event-extras.js";
import { writeAudit } from "./audit.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { envInt } from "./rate-limits.js";
import { notifyTimeEntry } from "./time-notify.js";
import { MAX_ENTRY_HOURS } from "./time-tracking.js";

/**
 * Sweep of running time entries (Wave 16), recurring job every 15 minutes.
 * T4: an entry still running `TIME_AUTO_CLOSE_HOURS` (default 24, 17-720) after its start is ended at `startedAt + 16 h`, stays `offen`,
 * is flagged `autoClosed`, audited (`time_entry.auto_close`, no actor) and the person is told to check it (`time.auto_closed`); it is never
 * confirmed automatically. Idempotent: the update only touches rows that are still running (and takes the same per-person advisory lock as
 * clock-out), and the notification is deduplicated by its delivery reference. Clubs suspended by the platform are skipped (Wave 15 B7).
 */

export const TIME_SWEEP_JOB_TYPE = "time_entry_sweep";
export const TIME_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const HOUR_MS = 3_600_000;
const BATCH = 500;

/** Hours after the start at which a running entry is ended automatically (must exceed the 16 h cap, so the end lies in the past). */
export const autoCloseHours = (): number => envInt("TIME_AUTO_CLOSE_HOURS", 24, MAX_ENTRY_HOURS + 1, 720);

/** SQL: the entry's club is not suspended by the platform. */
const clubActive = sql`NOT EXISTS (SELECT 1 FROM ${clubPlatformStatus} WHERE ${clubPlatformStatus.clubId} = ${timeEntries.clubId} AND ${clubPlatformStatus.suspendedAt} IS NOT NULL)`;

/** `onlyClubId` limits the sweep to one club (tests share one database). */
export async function autoCloseRunningEntries(now: Date = new Date(), onlyClubId?: string): Promise<number> {
  const hours = autoCloseHours();
  const threshold = new Date(now.getTime() - hours * HOUR_MS);
  const candidates = await db
    .select({ id: timeEntries.id, clubMemberId: timeEntries.clubMemberId })
    .from(timeEntries)
    .where(and(isNull(timeEntries.endedAt), lte(timeEntries.startedAt, threshold), clubActive, onlyClubId ? eq(timeEntries.clubId, onlyClubId) : undefined))
    .orderBy(asc(timeEntries.startedAt))
    .limit(BATCH);
  let closed = 0;
  for (const candidate of candidates) {
    try {
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`time:${candidate.clubMemberId}`}, 0))`);
        const [done] = await tx
          .update(timeEntries)
          .set({ endedAt: sql`${timeEntries.startedAt} + make_interval(hours => ${MAX_ENTRY_HOURS})`, autoClosed: true })
          .where(and(eq(timeEntries.id, candidate.id), isNull(timeEntries.endedAt), lte(timeEntries.startedAt, threshold)))
          .returning();
        if (!done) return null;
        await writeAudit(tx, { eventType: "time_entry.auto_close", subjectId: done.clubMemberId, actorUserId: null, payload: { clubId: done.clubId, entryId: done.id, clubMemberId: done.clubMemberId, afterHours: hours } });
        return done;
      });
      if (!row) continue;
      closed += 1;
      await notifyTimeEntry("auto_closed", row);
    } catch (err) {
      logger.error({ entryId: candidate.id, errName: (err as Error)?.name }, "[time] auto-close failed for an entry");
    }
  }
  return closed;
}

export async function sweepTimeEntries(now: Date = new Date(), onlyClubId?: string): Promise<{ autoClosed: number }> {
  const autoClosed = await autoCloseRunningEntries(now, onlyClubId);
  return { autoClosed };
}

export async function handleTimeSweep(_job: JobContext): Promise<void> {
  await sweepTimeEntries();
}
