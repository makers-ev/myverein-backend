import { and, eq, exists, isNull, lt, notExists, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
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
export async function sweepStaleFormDrafts(now = Date.now()): Promise<{ drafts: number; orphans: number }> {
  const cutoff = new Date(now - draftTtlDays() * 24 * 60 * 60 * 1000);
  const stale = await db
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.status, "draft"), lt(formSubmissions.updatedAt, cutoff)))
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
export async function sweepRejectedFormFiles(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - rejectedFileTtlDays() * 24 * 60 * 60 * 1000);
  const due = await db
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(
      and(
        eq(formSubmissions.status, "rejected"),
        lt(formSubmissions.decidedAt, cutoff),
        exists(db.select({ one: sql`1` }).from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, formSubmissions.id))),
      ),
    )
    .limit(BATCH);

  let files = 0;
  for (const { id } of due) {
    const purge: string[] = [];
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
  }
  return files;
}

/** Starts the sweep now and then hourly (like `startMediaSweeper`); the timer does not keep the process alive. */
export function startFormDraftSweeper(intervalMs = 60 * 60 * 1000): () => void {
  const run = () =>
    Promise.all([sweepStaleFormDrafts(), sweepRejectedFormFiles()])
      .then(([r, expired]) => (r.drafts + r.orphans + expired > 0 ? logger.info({ ...r, expiredRejectedFiles: expired }, "[forms] swept stale drafts and expired files") : undefined))
      .catch((err) => logger.error({ err }, "[forms] draft sweep failed"));
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
