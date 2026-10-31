import { db } from "../db/client.js";
import { organization } from "../auth/auth-schema.js";
import { logger } from "./logger.js";
import { purgeExpiredTrash } from "./documents.js";
import { sweepOrphanFiles } from "./media.js";

export const MEDIA_ORPHAN_SWEEP_JOB_TYPE = "media_orphan_sweep";
export const MEDIA_ORPHAN_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Daily: removes files of the document namespaces that have no registry row (see `sweepOrphanFiles`). */
export async function handleMediaOrphanSweep(): Promise<void> {
  const clubs = await db.select({ id: organization.id }).from(organization);
  const removed = await sweepOrphanFiles(clubs.map((c) => c.id));
  if (removed > 0) logger.info({ removed }, "[media] removed orphan files");
}

export const DOCUMENT_TRASH_JOB_TYPE = "document_trash_purge";
export const DOCUMENT_TRASH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Daily: documents that have been in the trash for 30 days are deleted for good (legal hold and retention stay). */
export async function handleDocumentTrashPurge(): Promise<void> {
  await purgeExpiredTrash();
}
