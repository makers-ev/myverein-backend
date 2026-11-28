import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubPlatformStatus } from "../db/schema/club-platform.js";
import { timeEntries } from "../db/schema/event-extras.js";
import { writeAudit } from "./audit.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { envInt } from "./rate-limits.js";
import { notifyTimeEntry } from "./time-notify.js";
import { MAX_AGE_DAYS, MAX_ENTRY_HOURS } from "./time-tracking.js";

/**
 * Sweep of running time entries (Wave 16), recurring job every 15 minutes.
 * T4: an entry still running `TIME_AUTO_CLOSE_HOURS` (default 24, 17-720) after its start is ended at `startedAt + 16 h`, stays `offen`,
 * is flagged `autoClosed`, audited (`time_entry.auto_close`, no actor) and the person is told to check it (`time.auto_closed`); it is never
 * confirmed automatically. An entry that started more than `MAX_AGE_DAYS` (366) ago could never be recorded or corrected any more
 * (`too_old`): it is ended the same way but set to `abgelehnt` (discarded, `time.auto_discarded`). At most `TIME_SWEEP_BATCH` (default
 * 200) entries per run and kind, the rest follows in the next run (first run after a deploy with many stuck entries). T5: a reminder after 10 h of running time, see `remindLongRunningEntries`. Idempotent: the update only touches rows that are still running (and takes the same per-person advisory lock as
 * clock-out), and the notification is deduplicated by its delivery reference. Clubs suspended by the platform are skipped (Wave 15 B7).
 */

export const TIME_SWEEP_JOB_TYPE = "time_entry_sweep";
export const TIME_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Hours after the start at which a running entry is ended automatically (must exceed the 16 h cap, so the end lies in the past). */
export const autoCloseHours = (): number => envInt("TIME_AUTO_CLOSE_HOURS", 24, MAX_ENTRY_HOURS + 1, 720);
/** Entries handled per run and kind (throttles the first run after a deploy). */
export const sweepBatch = (): number => envInt("TIME_SWEEP_BATCH", 200, 1, 5000);

/** Startup check (review 9): an invalid value falls back to the default -- say so instead of doing it silently. Returns the warnings. */
export function warnOnInvalidTimeConfig(): string[] {
  const warnings: string[] = [];
  for (const [name, fallback, min, max] of [["TIME_AUTO_CLOSE_HOURS", 24, MAX_ENTRY_HOURS + 1, 720], ["TIME_SWEEP_BATCH", 200, 1, 5000]] as const) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      warnings.push(name);
      logger.warn({ name, allowed: `${min}-${max}`, using: fallback }, `[time] ${name} is invalid, using the default`);
    }
  }
  return warnings;
}

/** SQL: the entry's club is not suspended by the platform. */
const clubActive = sql`NOT EXISTS (SELECT 1 FROM ${clubPlatformStatus} WHERE ${clubPlatformStatus.clubId} = ${timeEntries.clubId} AND ${clubPlatformStatus.suspendedAt} IS NOT NULL)`;

/** `onlyClubId` limits the sweep to one club (tests share one database). */
export async function autoCloseRunningEntries(now: Date = new Date(), onlyClubId?: string): Promise<{ closed: number; discarded: number }> {
  const hours = autoCloseHours();
  const threshold = new Date(now.getTime() - hours * HOUR_MS);
  const candidates = await db
    .select({ id: timeEntries.id, clubMemberId: timeEntries.clubMemberId, startedAt: timeEntries.startedAt })
    .from(timeEntries)
    .where(and(isNull(timeEntries.endedAt), lte(timeEntries.startedAt, threshold), clubActive, onlyClubId ? eq(timeEntries.clubId, onlyClubId) : undefined))
    .orderBy(asc(timeEntries.startedAt))
    .limit(sweepBatch());
  let closed = 0;
  let discarded = 0;
  for (const candidate of candidates) {
    try {
      const tooOld = now.getTime() - candidate.startedAt.getTime() > MAX_AGE_DAYS * DAY_MS;
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`time:${candidate.clubMemberId}`}, 0))`);
        const [done] = await tx
          .update(timeEntries)
          .set({ endedAt: sql`${timeEntries.startedAt} + make_interval(hours => ${MAX_ENTRY_HOURS})`, autoClosed: true, ...(tooOld ? { status: "abgelehnt" } : {}) })
          .where(and(eq(timeEntries.id, candidate.id), isNull(timeEntries.endedAt), lte(timeEntries.startedAt, threshold)))
          .returning();
        if (!done) return null;
        await writeAudit(tx, { eventType: "time_entry.auto_close", subjectId: done.clubMemberId, actorUserId: null, payload: { clubId: done.clubId, entryId: done.id, clubMemberId: done.clubMemberId, afterHours: hours, discarded: tooOld } });
        return done;
      });
      if (!row) continue;
      if (tooOld) discarded += 1;
      else closed += 1;
      await notifyTimeEntry(tooOld ? "auto_discarded" : "auto_closed", row);
    } catch (err) {
      logger.error({ entryId: candidate.id, errName: (err as Error)?.name }, "[time] auto-close failed for an entry");
    }
  }
  return { closed, discarded };
}

/** Hours of running time after which the person is reminded once ("Du bist seit 10 Stunden eingestempelt"). */
export const REMIND_AFTER_HOURS = 10;

/**
 * T5: one reminder per entry once it has been running for 10 h (optional, category `reminders`: switchable in the notification
 * settings). The entry is claimed by setting `long_run_reminder_at` in a conditional update, so parallel sweeps send it once.
 */
export async function remindLongRunningEntries(now: Date = new Date(), onlyClubId?: string): Promise<number> {
  const threshold = new Date(now.getTime() - REMIND_AFTER_HOURS * HOUR_MS);
  // Entries already due for the automatic end are left to it (also those beyond this run's batch): one message, not two.
  const closeThreshold = new Date(now.getTime() - autoCloseHours() * HOUR_MS);
  const candidates = await db
    .select({ id: timeEntries.id })
    .from(timeEntries)
    .where(and(isNull(timeEntries.endedAt), isNull(timeEntries.longRunReminderAt), lte(timeEntries.startedAt, threshold), gt(timeEntries.startedAt, closeThreshold), clubActive, onlyClubId ? eq(timeEntries.clubId, onlyClubId) : undefined))
    .orderBy(asc(timeEntries.startedAt))
    .limit(sweepBatch());
  let reminded = 0;
  for (const candidate of candidates) {
    try {
      const [claimed] = await db
        .update(timeEntries)
        .set({ longRunReminderAt: now })
        .where(and(eq(timeEntries.id, candidate.id), isNull(timeEntries.endedAt), isNull(timeEntries.longRunReminderAt)))
        .returning();
      if (!claimed) continue;
      reminded += 1;
      await notifyTimeEntry("long_running", claimed);
    } catch (err) {
      logger.error({ entryId: candidate.id, errName: (err as Error)?.name }, "[time] long-running reminder failed for an entry");
    }
  }
  return reminded;
}

export async function sweepTimeEntries(now: Date = new Date(), onlyClubId?: string): Promise<{ autoClosed: number; discarded: number; reminded: number }> {
  // Close first: an entry that is ended now needs no "still clocked in?" reminder any more.
  const { closed, discarded } = await autoCloseRunningEntries(now, onlyClubId);
  const reminded = await remindLongRunningEntries(now, onlyClubId);
  return { autoClosed: closed, discarded, reminded };
}

export async function handleTimeSweep(_job: JobContext): Promise<void> {
  await sweepTimeEntries();
}
