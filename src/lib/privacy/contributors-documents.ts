import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { documentAcknowledgements, documentPermissions, documents, documentVersions, memberCards, renderJobs } from "../../db/schema/documents.js";
import { markMediaDeleted } from "../media.js";
import type { PrivacyContributor } from "./registry.js";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Documents of the person (Wave 13): the personal storage (uploads, receipts, generated confirmations), acknowledgements,
 * the membership card, folder rights granted to the person and the render jobs made for them. Everything is keyed on
 * `club_members.id`, so members without an account are covered.
 *
 * Export: metadata and the list of versions (the files themselves are handed over on request, they can be large).
 * Erasure: personal documents are deleted with their files (registry tombstones inside the transaction, files via `purge` after
 * the commit) UNLESS a legal hold or a retention date in the future blocks them -- those stay locked and are reported with the
 * reason (an erasure claim does not override a statutory retention duty). Acknowledgements stay as proof (Art. 7(1)); the
 * person as the one who acted for somebody else is removed. Card, folder rights and jobs are deleted.
 */
export const documentData: PrivacyContributor = {
  key: "documents",
  tables: ["documents", "document_versions", "document_permissions", "document_acknowledgements", "member_cards", "render_jobs"],
  async exportSubject(ex, s) {
    const id = s.clubMemberId;
    const docs = await ex
      .select({ id: documents.id, title: documents.title, docType: documents.docType, kind: documents.kind, status: documents.status, createdAt: documents.createdAt, retentionUntil: documents.retentionUntil })
      .from(documents)
      .where(and(eq(documents.clubId, s.clubId), eq(documents.scope, "person"), eq(documents.ownerClubMemberId, id)))
      .orderBy(asc(documents.createdAt));
    const versions = docs.length
      ? await ex
          .select({ documentId: documentVersions.documentId, versionNo: documentVersions.versionNo, originalFilename: documentVersions.originalFilename, sizeBytes: documentVersions.sizeBytes, mimeType: documentVersions.mimeType, createdAt: documentVersions.createdAt })
          .from(documentVersions)
          .where(inArray(documentVersions.documentId, docs.map((d) => d.id)))
          .orderBy(asc(documentVersions.versionNo))
      : [];
    const acks = await ex
      .select({ title: documents.title, status: documentAcknowledgements.status, wording: documentAcknowledgements.wording, requestedAt: documentAcknowledgements.requestedAt, respondedAt: documentAcknowledgements.respondedAt })
      .from(documentAcknowledgements)
      .innerJoin(documents, eq(documents.id, documentAcknowledgements.documentId))
      .where(eq(documentAcknowledgements.clubMemberId, id))
      .orderBy(asc(documentAcknowledgements.requestedAt));
    const [card] = await ex.select().from(memberCards).where(eq(memberCards.clubMemberId, id));
    const jobs = await ex.select({ templateId: renderJobs.templateId, status: renderJobs.status, createdAt: renderJobs.createdAt }).from(renderJobs).where(eq(renderJobs.subjectClubMemberId, id)).orderBy(asc(renderJobs.createdAt));
    return {
      personalDocuments: docs.map((d) => ({
        title: d.title,
        type: d.docType,
        kind: d.kind,
        status: d.status,
        createdAt: iso(d.createdAt),
        retentionUntil: d.retentionUntil,
        versions: versions.filter((v) => v.documentId === d.id).map((v) => ({ versionNo: v.versionNo, filename: v.originalFilename, sizeBytes: v.sizeBytes, mimeType: v.mimeType, createdAt: iso(v.createdAt) })),
      })),
      acknowledgements: acks.map((a) => ({ document: a.title, status: a.status, wording: a.wording, requestedAt: iso(a.requestedAt), respondedAt: iso(a.respondedAt) })),
      membershipCard: card ? { status: card.status, issuedAt: iso(card.issuedAt), validUntil: card.validUntil, revokedAt: iso(card.revokedAt) } : null,
      generatedDocumentRequests: jobs.map((j) => ({ template: j.templateId, status: j.status, createdAt: iso(j.createdAt) })),
    };
  },
  async eraseSubject(tx, s) {
    const id = s.clubMemberId;
    const today = new Date().toISOString().slice(0, 10);
    // Counted before the documents go: an acknowledgement of a personal document leaves with its document.
    const [{ n: acks }] = await tx.select({ n: sql<number>`count(*)::int` }).from(documentAcknowledgements).where(eq(documentAcknowledgements.clubMemberId, id));
    const owned = await tx
      .select({ id: documents.id, legalHold: documents.legalHold, retentionUntil: documents.retentionUntil })
      .from(documents)
      .where(and(eq(documents.clubId, s.clubId), eq(documents.scope, "person"), eq(documents.ownerClubMemberId, id)));
    const removable = owned.filter((d) => !d.legalHold && (d.retentionUntil === null || d.retentionUntil < today)).map((d) => d.id);
    const kept = owned.length - removable.length;
    const purge: string[] = [];
    if (removable.length > 0) {
      const files = await tx.select({ key: documentVersions.storageKey, clubId: documentVersions.clubId }).from(documentVersions).where(inArray(documentVersions.documentId, removable));
      for (const f of files) if (await markMediaDeleted(f.key, tx, f.clubId)) purge.push(f.key);
      await tx.delete(documents).where(inArray(documents.id, removable));
    }
    const permissions = (await tx.delete(documentPermissions).where(eq(documentPermissions.clubMemberId, id)).returning({ id: documentPermissions.id })).length;
    const cards = (await tx.delete(memberCards).where(eq(memberCards.clubMemberId, id)).returning({ id: memberCards.id })).length;
    const jobs = (await tx.delete(renderJobs).where(eq(renderJobs.subjectClubMemberId, id)).returning({ id: renderJobs.id })).length;
    await tx.update(documentAcknowledgements).set({ actedByClubMemberId: null }).where(eq(documentAcknowledgements.actedByClubMemberId, id));
    return {
      deleted: removable.length + permissions + cards + jobs,
      anonymized: 0,
      kept: kept + acks,
      keptReason: kept + acks > 0 ? "Acknowledgements stay as proof (Art. 7(1)); documents under legal hold or inside a statutory retention period stay locked until it ends" : undefined,
      purge,
    };
  },
};
