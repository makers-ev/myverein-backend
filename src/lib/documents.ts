import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { documents, documentVersions, type DocumentRow, type DocumentVersionRow } from "../db/schema/documents.js";
import type { DbExecutor } from "./club-members.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { logger } from "./logger.js";
import { checkStorageThresholds } from "./media-quota.js";
import { discardStoredFile, DOCUMENT_OWNER_TYPES, DOCUMENT_TYPES, findMediaByKey, MAX_DOCUMENT_BYTES, markMediaDeleted, purgeMediaFile, storeUpload } from "./media.js";

/** Days a document stays in the trash before the daily job removes it for good. */
export const TRASH_RETENTION_DAYS = 30;
/** Versions of one document (older ones stay readable; this only stops a runaway client). */
export const MAX_VERSIONS_PER_DOCUMENT = 100;

export interface NewDocumentInput {
  clubId: string;
  scope: "verein" | "person";
  folderId: string | null;
  ownerClubMemberId: string | null;
  docType: string;
  title: string;
  file: File;
  uploadedBy: string;
  note?: string | null;
}

const storageFor = (scope: "verein" | "person") =>
  scope === "person"
    ? { directory: "personal", ownerType: DOCUMENT_OWNER_TYPES.personal, sensitive: true }
    : { directory: "documents", ownerType: DOCUMENT_OWNER_TYPES.archive, sensitive: false };

function versionValues(documentId: string, clubId: string, versionNo: number, media: { storageKey: string; mimeType: string; sizeBytes: number; sha256: string; originalFilename: string }, userId: string | null, note: string | null) {
  return { documentId, clubId, versionNo, storageKey: media.storageKey, mimeType: media.mimeType, sizeBytes: media.sizeBytes, sha256: media.sha256, originalFilename: media.originalFilename, note, createdBy: userId };
}

/**
 * Uploaded file -> document + version 1, through the media layer (magic bytes, size, EXIF strip, quota under the club lock).
 * File, registry row, document and version share one transaction; a failure removes the stored file again.
 */
export async function createUploadedDocument(input: NewDocumentInput): Promise<{ document: DocumentRow; version: DocumentVersionRow }> {
  const storage = storageFor(input.scope);
  const documentId = randomUUID();
  let storedKey: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
      const media = await storeUpload({
        file: input.file,
        clubId: input.clubId,
        storagePrefix: `${input.clubId}/${storage.directory}`,
        kind: "document",
        allowedTypes: DOCUMENT_TYPES,
        maxBytes: MAX_DOCUMENT_BYTES,
        sensitive: storage.sensitive,
        owner: { type: storage.ownerType, id: documentId },
        uploadedBy: input.uploadedBy,
        executor: tx,
      });
      storedKey = media.storageKey;
      const [doc] = await tx
        .insert(documents)
        .values({ id: documentId, clubId: input.clubId, scope: input.scope, folderId: input.folderId, ownerClubMemberId: input.ownerClubMemberId, kind: "hochgeladen", docType: input.docType, title: input.title, createdBy: input.uploadedBy })
        .returning();
      const [version] = await tx.insert(documentVersions).values(versionValues(documentId, input.clubId, 1, media, input.uploadedBy, input.note ?? null)).returning();
      const [updated] = await tx.update(documents).set({ currentVersionId: version!.id }).where(eq(documents.id, doc!.id)).returning();
      return { document: updated!, version: version! };
    });
    await checkStorageThresholds(input.clubId);
    return result;
  } catch (err) {
    if (storedKey) await discardStoredFile(storedKey);
    throw err;
  }
}

/** New version of an existing document (locks the document row, so parallel uploads get distinct numbers). */
export async function addUploadedVersion(doc: DocumentRow, file: File, userId: string, note: string | null): Promise<{ document: DocumentRow; version: DocumentVersionRow }> {
  const storage = storageFor(doc.scope as "verein" | "person");
  let storedKey: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(documents).where(eq(documents.id, doc.id)).for("update");
      if (!locked) throw new NotFoundError("Document not found");
      if (locked.status !== "aktiv") throw new ConflictError("A document in the trash cannot get a new version");
      const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${documentVersions.versionNo}), 0)::int` }).from(documentVersions).where(eq(documentVersions.documentId, doc.id));
      if (n >= MAX_VERSIONS_PER_DOCUMENT) throw new ConflictError("This document has reached the maximum number of versions");
      const media = await storeUpload({
        file,
        clubId: doc.clubId,
        storagePrefix: `${doc.clubId}/${storage.directory}`,
        kind: "document",
        allowedTypes: DOCUMENT_TYPES,
        maxBytes: MAX_DOCUMENT_BYTES,
        sensitive: storage.sensitive,
        owner: { type: storage.ownerType, id: doc.id },
        uploadedBy: userId,
        executor: tx,
      });
      storedKey = media.storageKey;
      const [version] = await tx.insert(documentVersions).values(versionValues(doc.id, doc.clubId, n + 1, media, userId, note)).returning();
      const [updated] = await tx.update(documents).set({ currentVersionId: version!.id, updatedAt: new Date() }).where(eq(documents.id, doc.id)).returning();
      return { document: updated!, version: version! };
    });
    await checkStorageThresholds(doc.clubId);
    return result;
  } catch (err) {
    if (storedKey) await discardStoredFile(storedKey);
    throw err;
  }
}

/**
 * Deletes documents for good: registry tombstones inside the transaction, the files after the commit (a failure there leaves
 * an orphan the daily sweep removes). Returns the number of documents removed. Documents under legal hold or retention are skipped.
 */
export async function purgeDocuments(executor: DbExecutor, docs: Array<Pick<DocumentRow, "id" | "clubId">>, afterCommit: Array<() => Promise<void>>): Promise<number> {
  if (docs.length === 0) return 0;
  const ids = docs.map((d) => d.id);
  const versions = await executor.select({ storageKey: documentVersions.storageKey, clubId: documentVersions.clubId }).from(documentVersions).where(inArray(documentVersions.documentId, ids));
  for (const v of versions) {
    if (await markMediaDeleted(v.storageKey, executor, v.clubId)) afterCommit.push(() => purgeMediaFile(v.storageKey));
  }
  await executor.delete(documents).where(inArray(documents.id, ids));
  return ids.length;
}

/** Documents in the trash that may be deleted now: past the trash period, no legal hold, retention over. */
export function purgeableCondition(now: Date, olderThanDays: number | null, anyStatus = false) {
  const today = now.toISOString().slice(0, 10);
  return and(
    anyStatus ? undefined : eq(documents.status, "im_papierkorb"),
    eq(documents.legalHold, false),
    or(isNull(documents.retentionUntil), lt(documents.retentionUntil, today)),
    olderThanDays === null ? undefined : lt(documents.trashedAt, new Date(now.getTime() - olderThanDays * 86_400_000)),
  );
}

/** Daily job body: removes archive/personal documents that have been in the trash longer than `TRASH_RETENTION_DAYS`. */
export async function purgeExpiredTrash(now = new Date()): Promise<number> {
  const due = await db.select({ id: documents.id, clubId: documents.clubId }).from(documents).where(purgeableCondition(now, TRASH_RETENTION_DAYS)).limit(500);
  if (due.length === 0) return 0;
  const afterCommit: Array<() => Promise<void>> = [];
  const removed = await db.transaction((tx) => purgeDocuments(tx, due, afterCommit));
  for (const run of afterCommit) await run();
  logger.info({ removed }, "[documents] purged expired trash");
  return removed;
}

export async function listVersions(documentId: string): Promise<DocumentVersionRow[]> {
  return db.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)).orderBy(desc(documentVersions.versionNo));
}

/** The registry row of a version's file (the single source for the download headers); `null` if it is gone. */
export async function mediaOfVersion(version: Pick<DocumentVersionRow, "storageKey" | "clubId">) {
  const media = await findMediaByKey(version.storageKey);
  return media && media.clubId === version.clubId ? media : null;
}
