import { and, eq } from "drizzle-orm";

import { clubInfoPages, clubInfoPageVersions, type ClubInfoPageRow } from "../db/schema/club-info-pages.js";
import { documents, documentVersions } from "../db/schema/documents.js";
import type { DbExecutor } from "./club-members.js";
import { ValidationError } from "./errors.js";

/** Markdown of an info page is stored raw (sanitising happens when it is rendered); this caps the size. */
export const MAX_INFO_MARKDOWN_CHARS = 100_000;

export interface InfoPageContent {
  title: string;
  contentMarkdown: string | null;
  externalUrl: string | null;
  validFrom: string | null;
  documentId: string | null;
}

export interface WriteInfoPageInput extends InfoPageContent {
  clubId: string;
  slug: string;
  note: string | null;
  userId: string | null;
}

export interface WriteInfoPageResult {
  page: ClubInfoPageRow;
  /** `created`: first version, `updated`: new version, `unchanged`: nothing differed, no version was written. */
  outcome: "created" | "updated" | "unchanged";
  previousVersion: number | null;
}

/** An attached PDF has to be a live archive document of the same club with a PDF as its current version. */
export async function assertAttachableDocument(executor: DbExecutor, clubId: string, documentId: string): Promise<void> {
  const [row] = await executor
    .select({ scope: documents.scope, status: documents.status, mimeType: documentVersions.mimeType })
    .from(documents)
    .leftJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .where(and(eq(documents.id, documentId), eq(documents.clubId, clubId)))
    .limit(1);
  if (!row || row.scope !== "verein" || row.status !== "aktiv") throw new ValidationError("Unknown attachment document", { details: { field: "documentId" } });
  if (row.mimeType !== "application/pdf") throw new ValidationError("The attachment has to be a PDF", { details: { field: "documentId" } });
}

const same = (a: InfoPageContent, b: InfoPageContent) =>
  a.title === b.title && (a.contentMarkdown ?? null) === (b.contentMarkdown ?? null) && (a.externalUrl ?? null) === (b.externalUrl ?? null) && (a.validFrom ?? null) === (b.validFrom ?? null) && (a.documentId ?? null) === (b.documentId ?? null);

/**
 * Create-or-update of an info page by slug; every real change is a new version (history in `club_info_page_versions`).
 * Runs in one transaction under a row lock on the page, so parallel writers get distinct, gapless version numbers.
 * An identical write changes nothing.
 */
export async function writeInfoPage(executor: DbExecutor, input: WriteInfoPageInput): Promise<WriteInfoPageResult> {
  if (input.documentId) await assertAttachableDocument(executor, input.clubId, input.documentId);
  const content: InfoPageContent = { title: input.title, contentMarkdown: input.contentMarkdown, externalUrl: input.externalUrl, validFrom: input.validFrom, documentId: input.documentId };

  const insertVersion = (pageId: string, versionNo: number) =>
    executor.insert(clubInfoPageVersions).values({ pageId, clubId: input.clubId, versionNo, ...content, note: input.note, createdBy: input.userId });

  // A concurrent first write of the same slug loses the insert and continues as an update below.
  const [created] = await executor
    .insert(clubInfoPages)
    .values({ clubId: input.clubId, slug: input.slug, ...content, currentVersion: 1, updatedBy: input.userId })
    .onConflictDoNothing({ target: [clubInfoPages.clubId, clubInfoPages.slug] })
    .returning();
  if (created) {
    await insertVersion(created.id, 1);
    return { page: created, outcome: "created", previousVersion: null };
  }

  const [existing] = await executor
    .select()
    .from(clubInfoPages)
    .where(and(eq(clubInfoPages.clubId, input.clubId), eq(clubInfoPages.slug, input.slug)))
    .for("update");
  if (!existing) throw new ValidationError("Page vanished while writing");
  if (same(content, existing)) return { page: existing, outcome: "unchanged", previousVersion: existing.currentVersion };

  const versionNo = existing.currentVersion + 1;
  await insertVersion(existing.id, versionNo);
  const [page] = await executor
    .update(clubInfoPages)
    .set({ ...content, currentVersion: versionNo, updatedBy: input.userId, updatedAt: new Date() })
    .where(eq(clubInfoPages.id, existing.id))
    .returning();
  return { page: page!, outcome: "updated", previousVersion: existing.currentVersion };
}
