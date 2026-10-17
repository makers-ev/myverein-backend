import { and, eq, exists, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { scrubApplicationCopies } from "./form-retention.js";
import { formSubmissionFiles, formSubmissions } from "../db/schema/forms.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { draftTtlDays, rejectedFileTtlDays, removeFiles } from "./forms.js";
import { logger } from "./logger.js";
import { deleteMedia, purgeMediaFile } from "./media.js";

/** An upload registered for a submission whose file row never got committed is orphaned after this long. */
const ORPHAN_AFTER_MS = 60 * 60 * 1000;
const BATCH = 200;

/**
 * Removes abandoned application drafts (Wave 8 M1): drafts idle for `FORM_DRAFT_TTL_DAYS` (default 30) are deleted
 * together with their files (registry tombstone + bytes). Submitted / decided / withdrawn submissions are never
 * touched. Also removes registry entries owned by a form submission that have no file row (an upload whose follow-up
 * transaction failed hard). Returns the number of drafts and orphaned files removed. Audit entries carry ids only.
 */
export async function sweepStaleFormDrafts(now = Date.now(), scope: { userId?: string } = {}): Promise<{ drafts: number; orphans: number }> {
  const cutoff = new Date(now - draftTtlDays() * 24 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.status, "draft"), lt(formSubmissions.updatedAt, cutoff), scope.userId ? eq(formSubmissions.submittedByUserId, scope.userId) : undefined))
    .limit(BATCH);

  let drafts = 0;
  for (const { id } of stale) {
    const purge: string[] = [];
    const removed = await db.transaction(async (tx) => {
      // Re-check under the row lock: a draft that was touched meanwhile (or submitted) stays.
      const [locked] = await tx
        .select()
        .from(formSubmissions)
        .where(and(eq(formSubmissions.id, id), eq(formSubmissions.status, "draft"), lt(formSubmissions.updatedAt, cutoff)))
        .for("update", { skipLocked: true });
      if (!locked) return false;
      const files = await tx.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, id));
      purge.push(...(await removeFiles(tx, files)));
      await tx.delete(formSubmissions).where(eq(formSubmissions.id, id));
      await tx.insert(auditLog).values({ eventType: "form_submission.draft_swept", subjectId: id, payload: { clubId: locked.clubId, userId: locked.submittedByUserId, fileCount: files.length } });
      return true;
    });
    if (removed) {
      drafts += 1;
      await Promise.all(purge.map((key) => purgeMediaFile(key)));
    }
  }

  // A scoped (lazy) sweep stays with the caller's own drafts; the registry-wide orphan scan is the hourly job's.
  if (scope.userId) return { drafts, orphans: 0 };

  const orphanCutoff = new Date(now - ORPHAN_AFTER_MS);
  const orphaned = await db
    .select({ storageKey: mediaFiles.storageKey })
    .from(mediaFiles)
    .where(
      and(
        eq(mediaFiles.ownerType, "form_submission"),
        isNull(mediaFiles.deletedAt),
        lt(mediaFiles.createdAt, orphanCutoff),
        notExists(db.select({ one: sql`1` }).from(formSubmissionFiles).where(eq(formSubmissionFiles.storageKey, mediaFiles.storageKey))),
      ),
    )
    .limit(BATCH);
  for (const { storageKey } of orphaned) await deleteMedia(storageKey);

  return { drafts, orphans: orphaned.length };
}

/**
 * Retention of the uploads of REJECTED applications (Wave 8 B6): the files (documents, photo) are deleted
 * `FORM_REJECTED_FILE_TTL_DAYS` (default 30) after the rejection -- long enough for a rectification, short enough that a
 * person who was turned down does not leave documents behind. The answers stay as the record of the decision until the
 * data protection concept (Wave 10) decides on erasure. Files of ACCEPTED applications are kept on purpose (documents
 * the club needs for the member file; the photo already belongs to the member). Returns the number of files removed.
 */
export async function sweepRejectedFormFiles(now = Date.now(), scope: { clubId?: string } = {}): Promise<number> {
  const cutoff = new Date(now - rejectedFileTtlDays() * 24 * 60 * 60 * 1000);
  const due = await db
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.status, "rejected"),
        lt(formSubmissions.decidedAt, cutoff),
        scope.clubId ? eq(formSubmissions.clubId, scope.clubId) : undefined,
        exists(db.select({ one: sql`1` }).from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, formSubmissions.id))),
      ),
    )
    .limit(BATCH);

  let files = 0;
  for (const { id } of due) {
    const purge: string[] = [];
    // One broken entry must not stop the others (nor the sweeper's other jobs).
    try {
      await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(formSubmissions).where(and(eq(formSubmissions.id, id), eq(formSubmissions.status, "rejected"))).for("update", { skipLocked: true });
        if (!locked) return;
        const rows = await tx.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, id));
        if (rows.length === 0) return;
        purge.push(...(await removeFiles(tx, rows)));
        files += rows.length;
        await tx.insert(auditLog).values({ eventType: "form_submission.files_expired", subjectId: id, payload: { clubId: locked.clubId, fileCount: rows.length, reason: "rejected_retention" } });
      });
      await Promise.all(purge.map((key) => purgeMediaFile(key)));
    } catch (err) {
      logger.error({ err, submissionId: id }, "[forms] could not expire the files of a rejected application");
    }
  }
  return files;
}

/**
 * Minimal data for children (Wave 8 B8/B10): the answers of a child application that was REJECTED or WITHDRAWN describe a
 * person who never became a member, so they are erased `FORM_REJECTED_FILE_TTL_DAYS` (default 30) after the decision /
 * withdrawal (answers set to `{}`, the decision notes cleared; ids, status and timestamps stay as the record that an application
 * existed). The files of such applications are already deleted (rejected: `sweepRejectedFormFiles`, withdrawn: at once).
 * Applications of adults and accepted child applications are never touched here. Returns the number of submissions erased.
 */
export async function sweepRejectedChildAnswers(now = Date.now(), scope: { clubId?: string } = {}): Promise<number> {
  const cutoff = new Date(now - rejectedFileTtlDays() * 24 * 60 * 60 * 1000);
  const due = await db
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.onBehalfOf, "guardian"),
        or(and(eq(formSubmissions.status, "rejected"), lt(formSubmissions.decidedAt, cutoff)), and(eq(formSubmissions.status, "withdrawn"), lt(formSubmissions.updatedAt, cutoff))),
        sql`${formSubmissions.answers} <> '{}'::jsonb`,
        scope.clubId ? eq(formSubmissions.clubId, scope.clubId) : undefined,
      ),
    )
    .limit(BATCH);

  let erased = 0;
  for (const { id } of due) {
    try {
      await db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(formSubmissions)
          .where(and(eq(formSubmissions.id, id), eq(formSubmissions.onBehalfOf, "guardian"), inArray(formSubmissions.status, ["rejected", "withdrawn"])))
          .for("update", { skipLocked: true });
        if (!locked) return;
        await tx.update(formSubmissions).set({ answers: {}, decisionNote: null, decisionInternalNote: null, updatedAt: new Date() }).where(eq(formSubmissions.id, id));
        // The copies on the application row (birth date, category) go with the answers.
        await scrubApplicationCopies(tx, eq(clubApplications.formSubmissionId, id));
        await tx.insert(auditLog).values({ eventType: "form_submission.answers_erased", subjectId: id, payload: { clubId: locked.clubId, reason: "rejected_child_retention" } });
        erased += 1;
      });
    } catch (err) {
      logger.error({ err, submissionId: id }, "[forms] could not erase the answers of a rejected child application");
    }
  }
  return erased;
}

/** How long a lazy cleanup for the same key is skipped after it ran (one query round per key per window is plenty). */
const LAZY_WINDOW_MS = 10 * 60 * 1000;
const lazyRuns = new Map<string, number>();
const lazyPending = new Set<Promise<void>>();

/** Forgets the throttle (tests). */
export function resetLazyCleanup(): void {
  lazyRuns.clear();
}

/** Resolves when every scheduled lazy cleanup has finished (tests, graceful shutdown). */
export async function settleLazyCleanups(): Promise<void> {
  await Promise.allSettled([...lazyPending]);
}

/**
 * Lazy cleanup hook (Wave 8 B10, no scheduler needed): called when someone touches their data, it removes what is overdue
 * in exactly that scope -- `userId`: the caller's own stale drafts and their files; `clubId`: files of rejected applications
 * and answers of rejected child applications of that club -- at most once per key per 10 minutes. A failure never reaches the
 * request and is logged WITHOUT data; the key stays throttled (backoff: the next try is after the window). The hourly sweeper
 * does the same globally.
 */
export async function lazyCleanup(scope: { userId?: string; clubId?: string }, now = Date.now()): Promise<void> {
  const key = scope.userId ? `user:${scope.userId}` : scope.clubId ? `club:${scope.clubId}` : null;
  if (key === null) return;
  const last = lazyRuns.get(key);
  if (last !== undefined && now - last < LAZY_WINDOW_MS) return;
  lazyRuns.set(key, now);
  if (lazyRuns.size > 5000) for (const [k, at] of lazyRuns) if (now - at >= LAZY_WINDOW_MS) lazyRuns.delete(k);
  try {
    if (scope.userId) await sweepStaleFormDrafts(now, { userId: scope.userId });
    if (scope.clubId) {
      await sweepRejectedFormFiles(now, { clubId: scope.clubId });
      await sweepRejectedChildAnswers(now, { clubId: scope.clubId });
    }
  } catch (err) {
    logger.error({ code: (err as { code?: string })?.code }, "[forms] lazy cleanup failed");
  }
}

/** Fire-and-forget `lazyCleanup`: the request never waits for it, so it can neither slow down nor fail the request (errors are logged without data). */
export function scheduleLazyCleanup(scope: { userId?: string; clubId?: string }): void {
  const run = lazyCleanup(scope).catch(() => undefined);
  lazyPending.add(run);
  void run.finally(() => lazyPending.delete(run));
}

/** Starts the sweep now and then hourly (like `startMediaSweeper`); the timer does not keep the process alive. */
export function startFormDraftSweeper(intervalMs = 60 * 60 * 1000): () => void {
  const run = () =>
    Promise.all([sweepStaleFormDrafts(), sweepRejectedFormFiles(), sweepRejectedChildAnswers()])
      .then(([r, expired, erased]) => (r.drafts + r.orphans + expired + erased > 0 ? logger.info({ ...r, expiredRejectedFiles: expired, erasedChildAnswers: erased }, "[forms] swept stale drafts and expired data") : undefined))
      .catch((err) => logger.error({ err }, "[forms] draft sweep failed"));
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
