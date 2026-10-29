import { stat } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { documentAcknowledgements, documents, documentVersions } from "../db/schema/documents.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { documentRoutes } from "../routes/documents.js";
import { createClub, dropClubs, installErrorHandler, requester } from "../routes/forms-test-support.js";
import { memberDocumentRoutes } from "../routes/member-documents.js";
import { purgeDocuments, purgeExpiredTrash } from "./documents.js";
import { runDocumentRetention } from "./document-retention.js";
import { storageUsage } from "./media-quota.js";
import { PDF_BYTES } from "./media-fixtures.js";
import { storeGeneratedPdf } from "./media.js";
import { transitionMember, todayBerlin } from "./member-lifecycle.js";
import { addYears, retentionUntilFor } from "./retention/document-classes.js";
import { UPLOADS_DIR } from "./storage.js";

/** Wave 13 B14: retention classes, exit-based dates, the sweep (dry run, marking, notice, deletion), legal hold. */
const app = new Hono();
app.route("/documents", documentRoutes);
app.route("/member-documents", memberDocumentRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

describe("document retention", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let plainCm = "";
  const id = () => club.clubId;

  async function addDoc(values: { scope: "verein" | "person"; docType: string; retentionUntil: string | null; ownerId?: string; title?: string }) {
    const media = await storeGeneratedPdf({ buffer: PDF_BYTES, clubId: id(), directory: values.scope === "person" ? "personal" : "documents", filename: "x.pdf", owner: { type: values.scope === "person" ? "member_document" : "generated_pdf", id: null }, sensitive: true, uploadedBy: null });
    const [doc] = await db.insert(documents).values({ clubId: id(), scope: values.scope, ownerClubMemberId: values.ownerId ?? null, kind: "erzeugt", docType: values.docType, title: values.title ?? "Geheimer Titel", retentionUntil: values.retentionUntil }).returning();
    const [v] = await db.insert(documentVersions).values({ documentId: doc!.id, clubId: id(), versionNo: 1, storageKey: media.storageKey, mimeType: "application/pdf", sizeBytes: media.sizeBytes, sha256: media.sha256, originalFilename: "x.pdf" }).returning();
    await db.update(documents).set({ currentVersionId: v!.id }).where(eq(documents.id, doc!.id));
    return { id: doc!.id, key: media.storageKey, size: media.sizeBytes };
  }
  const row = async (docId: string) => (await db.select().from(documents).where(eq(documents.id, docId)))[0];

  beforeAll(async () => {
    club = await createClub("ret", suffix, { plain: null });
    other = await createClub("reto", suffix);
    const account = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, id()), e(m.userId, club.members.plain!.userId)) });
    plainCm = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account!.id) }))!.id;
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("computes the dates: from creation, from the exit, never for uploads, leap day safe", () => {
    expect(retentionUntilFor("versammlung_protokoll", "2026-03-01", null)).toBe("2036-03-01");
    expect(retentionUntilFor("aufnahmebeleg", "2026-03-01", null)).toBeNull();
    expect(retentionUntilFor("aufnahmebeleg", "2026-03-01", "2028-02-29")).toBe("2031-02-28");
    expect(retentionUntilFor("upload", "2026-03-01", "2028-02-29")).toBeNull();
    expect(addYears("2024-02-29", 1)).toBe("2025-02-28");
  });

  it("lists the classes for the board only", async () => {
    const res = await call(club.founder, "/documents/retention-classes", { clubId: id() });
    expect(res.status).toBe(200);
    const data = (await body(res)).data as Array<{ docType: string; years: number; startsOn: string }>;
    expect(data.find((d) => d.docType === "aufnahmebeleg")).toMatchObject({ years: 3, startsOn: "exit" });
    expect((await call(club.members.plain!, "/documents/retention-classes", { clubId: id() })).status).toBe(403);
  });

  it("starts the period of a person's documents with the exit and lifts it when the exit is taken back or the person returns", async () => {
    const receipt = await addDoc({ scope: "person", docType: "aufnahmebeleg", retentionUntil: null, ownerId: plainCm });
    const upload = await addDoc({ scope: "person", docType: "upload", retentionUntil: null, ownerId: plainCm });
    const actor = (await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, id()), e(m.userId, club.founder.userId)) }))!.id;
    const today = todayBerlin();
    const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
    await db.transaction((tx) => transitionMember(tx, id(), plainCm, { toStatus: "ausgetreten", effectiveOn: future, reason: "Kündigung" }, actor, today));
    expect((await row(receipt.id))!.retentionUntil).toBe(addYears(future, 3));
    expect((await row(upload.id))!.retentionUntil).toBeNull();
    // Take the scheduled exit back.
    await db.transaction((tx) => transitionMember(tx, id(), plainCm, { toStatus: "aktiv" }, actor, today));
    expect((await row(receipt.id))!.retentionUntil).toBeNull();
    await db.transaction((tx) => transitionMember(tx, id(), plainCm, { toStatus: "ausgetreten", effectiveOn: today, reason: "sofort" }, actor, today));
    expect((await row(receipt.id))!.retentionUntil).toBe(addYears(today, 3));
    await db.transaction((tx) => transitionMember(tx, id(), plainCm, { toStatus: "aktiv", reopen: true, reason: "zurück" }, actor, today));
    expect((await row(receipt.id))!.retentionUntil).toBeNull();
  });

  describe("sweep", () => {
    it("only counts in a dry run", async () => {
      const due = await addDoc({ scope: "verein", docType: "versammlung_protokoll", retentionUntil: "2020-01-01" });
      const result = await runDocumentRetention(new Date(), { dryRun: true, clubId: id() });
      expect(result).toMatchObject({ dryRun: true, marked: 1, deleted: 0 });
      expect((await row(due.id))!.status).toBe("aktiv");
    });

    it("marks what is due, spares holds and doc types without a class, deletes after the notice and frees the quota", async () => {
      const kept = await addDoc({ scope: "verein", docType: "versammlung_protokoll", retentionUntil: "2020-01-01", title: "Gesperrt" });
      const future = await addDoc({ scope: "verein", docType: "jahresbericht", retentionUntil: "2999-01-01" });
      const unclassed = await addDoc({ scope: "verein", docType: "upload", retentionUntil: "2020-01-01" });
      await db.update(documents).set({ legalHold: true }).where(eq(documents.id, kept.id));
      const mine = await db.select().from(documents).where(and(eq(documents.clubId, id()), eq(documents.docType, "versammlung_protokoll"), eq(documents.legalHold, false)));
      expect(mine).toHaveLength(1);
      const dueId = mine[0]!.id;
      const [version] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, dueId));

      const first = await runDocumentRetention(new Date(), { dryRun: false, clubId: id() });
      expect(first).toMatchObject({ marked: 1, deleted: 0, dryRun: false });
      expect((await row(dueId))!.status).toBe("zur_loeschung");
      expect((await row(kept.id))!.status).toBe("aktiv");
      expect((await row(future.id))!.status).toBe("aktiv");
      expect((await row(unclassed.id))!.status).toBe("aktiv");
      // Marked documents are invisible to readers while they wait.
      expect((await call(club.founder, `/documents/${dueId}/download`, { clubId: id() })).status).toBe(200); // the board (schreiben) still sees it
      expect((await call(club.members.plain!, `/documents/${dueId}/download`, { clubId: id() })).status).toBe(404);

      // Within the notice period nothing is deleted.
      expect((await runDocumentRetention(new Date(), { dryRun: false, clubId: id() })).deleted).toBe(0);
      const usedBefore = (await storageUsage(id())).usedBytes;
      await db.update(documents).set({ updatedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(documents.id, dueId));
      const final = await runDocumentRetention(new Date(), { dryRun: false, clubId: id() });
      expect(final.deleted).toBe(1);
      expect(await row(dueId)).toBeUndefined();
      expect((await storageUsage(id())).usedBytes).toBe(usedBefore - version!.sizeBytes);
      await expect(stat(path.join(UPLOADS_DIR, version!.storageKey))).rejects.toThrow();
      const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, version!.storageKey));
      expect(media?.deletedAt ?? null).not.toBeNull();
      expect((await row(kept.id))).toBeDefined();
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "document.retention_purge"), eq(auditLog.subjectId, id())));
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0]!.payload)).not.toContain("Gesperrt");
      expect(audits[0]!.payload).toMatchObject({ docType: "versammlung_protokoll", count: 1 });
    });

    it("a legal hold calls off a pending deletion, even for a document that was already marked", async () => {
      const doc = await addDoc({ scope: "verein", docType: "anwesenheitsliste", retentionUntil: "2020-01-01" });
      await runDocumentRetention(new Date(), { dryRun: false, clubId: id() });
      expect((await row(doc.id))!.status).toBe("zur_loeschung");
      const hold = await call(club.founder, `/documents/${doc.id}/legal-hold`, { method: "PUT", body: { active: true, reason: "Streit" }, clubId: id() });
      expect(hold.status).toBe(200);
      expect((await body(hold)).data).toMatchObject({ legalHold: true, status: "aktiv" });
      await db.update(documents).set({ updatedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(documents.id, doc.id));
      expect((await runDocumentRetention(new Date(), { dryRun: false, clubId: id() })).deleted).toBe(0);
      expect(await row(doc.id)).toBeDefined();
    });
  });

  describe("purge re-check", () => {
    it("a hold or retention date set after the documents were selected keeps them out of the purge", async () => {
      const held = await addDoc({ scope: "verein", docType: "upload", retentionUntil: null });
      const dated = await addDoc({ scope: "verein", docType: "upload", retentionUntil: "2999-01-01" });
      const free = await addDoc({ scope: "verein", docType: "upload", retentionUntil: null });
      const selected = [held, dated, free].map((d) => ({ id: d.id, clubId: id() }));
      await db.update(documents).set({ legalHold: true }).where(eq(documents.id, held.id));
      const after: Array<() => Promise<void>> = [];
      const n = await db.transaction((tx) => purgeDocuments(tx, selected, after));
      for (const run of after) await run();
      expect(n).toBe(1);
      expect(await row(held.id)).toBeDefined();
      expect(await row(dated.id)).toBeDefined();
      expect(await row(free.id)).toBeUndefined();
    });
  });

  describe("acknowledgement proof", () => {
    it("is not deleted by a purge by hand or by the trash job, only by the end of the retention period", async () => {
      const doc = await addDoc({ scope: "verein", docType: "versammlung_protokoll", retentionUntil: null });
      const [version] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, doc.id));
      await db.insert(documentAcknowledgements).values({ clubId: id(), documentId: doc.id, versionId: version!.id, sha256: version!.sha256, clubMemberId: plainCm, status: "bestaetigt", wording: "ok" });
      await call(club.founder, `/documents/${doc.id}`, { method: "DELETE", clubId: id() });
      const manual = await call(club.founder, `/documents/${doc.id}/permanent`, { method: "DELETE", clubId: id() });
      expect(manual.status).toBe(409);
      expect((await body(manual)).error.details.code).toBe("acknowledgements");
      const emptied = await body(await call(club.founder, "/documents/trash/empty", { method: "POST", clubId: id() }));
      expect(emptied.data.kept).toBeGreaterThanOrEqual(1);
      await db.update(documents).set({ trashedAt: new Date(Date.now() - 40 * 86_400_000) }).where(eq(documents.id, doc.id));
      await purgeExpiredTrash();
      expect(await row(doc.id)).toBeDefined();
      expect(await db.select().from(documentAcknowledgements).where(eq(documentAcknowledgements.documentId, doc.id))).toHaveLength(1);
      // The retention period ending is the deliberate end of the proof.
      await db.update(documents).set({ retentionUntil: "2020-01-01", status: "zur_loeschung", updatedAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(documents.id, doc.id));
      await runDocumentRetention(new Date(), { dryRun: false, clubId: id() });
      expect(await row(doc.id)).toBeUndefined();
      expect(await db.select().from(documentAcknowledgements).where(eq(documentAcknowledgements.documentId, doc.id))).toHaveLength(0);
    });
  });

  describe("legal hold routes", () => {
    it("archive: needs verwalten, blocks deletion, can be lifted", async () => {
      const doc = await addDoc({ scope: "verein", docType: "upload", retentionUntil: null });
      expect((await call(club.members.plain!, `/documents/${doc.id}/legal-hold`, { method: "PUT", body: { active: true }, clubId: id() })).status).toBe(404);
      expect((await call(other.founder, `/documents/${doc.id}/legal-hold`, { method: "PUT", body: { active: true }, clubId: other.clubId })).status).toBe(404);
      expect((await call(club.founder, `/documents/${doc.id}/legal-hold`, { method: "PUT", body: { active: "yes" }, clubId: id() })).status).toBe(422);
      expect((await call(club.founder, `/documents/${doc.id}/legal-hold`, { method: "PUT", body: { active: true }, clubId: id() })).status).toBe(200);
      await call(club.founder, `/documents/${doc.id}`, { method: "DELETE", clubId: id() });
      const blocked = await call(club.founder, `/documents/${doc.id}/permanent`, { method: "DELETE", clubId: id() });
      expect(blocked.status).toBe(409);
      expect((await body(blocked)).error.details.code).toBe("retention");
      expect((await call(club.founder, `/documents/${doc.id}/legal-hold`, { method: "PUT", body: { active: false }, clubId: id() })).status).toBe(200);
      expect((await call(club.founder, `/documents/${doc.id}/permanent`, { method: "DELETE", clubId: id() })).status).toBe(204);
    });

    it("personal storage: only the board with documents:manage, never the person", async () => {
      const doc = await addDoc({ scope: "person", docType: "kuendigungsbestaetigung", retentionUntil: null, ownerId: plainCm });
      const url = `/member-documents/${plainCm}/${doc.id}/legal-hold`;
      expect((await call(club.members.plain!, url, { method: "PUT", body: { active: true }, clubId: id() })).status).toBe(403);
      expect((await call(other.founder, url, { method: "PUT", body: { active: true }, clubId: other.clubId })).status).toBe(404);
      const ok = await call(club.founder, url, { method: "PUT", body: { active: true }, clubId: id() });
      expect(ok.status).toBe(200);
      expect((await row(doc.id))!.legalHold).toBe(true);
      const boardView = await body(await call(club.founder, `/member-documents/${plainCm}`, { clubId: id() }));
      expect(boardView.data.find((d: { id: string }) => d.id === doc.id)).toMatchObject({ legalHold: true });
      const ownView = await body(await call(club.members.plain!, "/member-documents/me", { clubId: id() }));
      expect(ownView.data.find((d: { id: string }) => d.id === doc.id).legalHold).toBeUndefined();
    });
  });
});
