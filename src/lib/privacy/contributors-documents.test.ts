import { stat } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../../db/client.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { documentAcknowledgements, documentFolders, documentPermissions, documents, documentVersions, memberCards, renderJobs } from "../../db/schema/documents.js";
import { createClub, dropClubs } from "../../routes/forms-test-support.js";
import { createUploadedDocument } from "../documents.js";
import { PDF_BYTES } from "../media-fixtures.js";
import { UPLOADS_DIR } from "../storage.js";
import { documentData } from "./contributors-documents.js";

/** Wave 13: documents are part of the export (Art. 15) and the erasure (Art. 17); retention and legal hold block the deletion. */
const suffix = Date.now();
const pdf = (extra: string) => new File([new Uint8Array(Buffer.concat([PDF_BYTES, Buffer.from(extra)]))], `${extra}.pdf`, { type: "application/pdf" });

describe("privacy contributor for documents", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let personId: string;
  let otherId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    club = await createClub("privdoc", suffix, {});
    [{ id: personId }] = await db.insert(clubMembers).values({ clubId: club.clubId, displayName: "Person Ohne Konto", joinedAt: "2024-01-01" }).returning({ id: clubMembers.id });
    [{ id: otherId }] = await db.insert(clubMembers).values({ clubId: club.clubId, displayName: "Andere Person", joinedAt: "2024-01-01" }).returning({ id: clubMembers.id });
    const make = async (label: string, owner: string) => {
      const created = await createUploadedDocument({ clubId: club.clubId, scope: "person", folderId: null, ownerClubMemberId: owner, docType: "upload", title: label, file: pdf(label), uploadedBy: club.founder.userId });
      ids[label] = created.document.id;
      return created;
    };
    await make("frei", personId);
    await make("gesperrt", personId);
    await make("fremd", otherId);
    await db.update(documents).set({ legalHold: true }).where(eq(documents.id, ids["gesperrt"]!));
    const archive = await createUploadedDocument({ clubId: club.clubId, scope: "verein", folderId: null, ownerClubMemberId: null, docType: "upload", title: "Hausordnung", file: pdf("hausordnung"), uploadedBy: club.founder.userId });
    const doc = archive.document.id;
    const [version] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, doc));
    await db.insert(documentAcknowledgements).values({ clubId: club.clubId, documentId: doc, versionId: version!.id, sha256: version!.sha256, clubMemberId: personId, status: "bestaetigt", wording: "Ich habe die Hausordnung gelesen." });
    await db.insert(memberCards).values({ clubId: club.clubId, clubMemberId: personId });
    const [folder] = await db.insert(documentFolders).values({ clubId: club.clubId, name: "F" }).returning();
    await db.insert(documentPermissions).values({ clubId: club.clubId, folderId: folder!.id, subjectType: "mitglied", clubMemberId: personId, level: "lesen" });
    await db.insert(renderJobs).values({ clubId: club.clubId, templateId: "x", templateVersion: 1, subjectClubMemberId: personId });
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId], club.userIds);
    await closeDatabase();
  });

  const subject = () => ({ clubId: club.clubId, clubMemberId: personId, accountMemberId: null, userId: null });

  it("exports the personal documents, acknowledgements, card and requests of exactly this person", async () => {
    const data = (await documentData.exportSubject(db, subject())) as { personalDocuments: Array<{ title: string; versions: unknown[] }>; acknowledgements: Array<{ wording: string }>; membershipCard: { status: string } | null; generatedDocumentRequests: unknown[] };
    expect(data.personalDocuments.map((d) => d.title).sort()).toEqual(["frei", "gesperrt"]);
    expect(data.personalDocuments[0]!.versions).toHaveLength(1);
    expect(data.acknowledgements).toHaveLength(1);
    expect(data.acknowledgements[0]!.wording).toContain("Hausordnung");
    expect(data.membershipCard).toMatchObject({ status: "aktiv" });
    expect(data.generatedDocumentRequests).toHaveLength(1);
    expect(JSON.stringify(data)).not.toContain("fremd");
  });

  it("erases what may go, keeps what a legal hold or a proof duty protects, and never touches other people", async () => {
    const [v] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, ids["frei"]!));
    const outcome = await db.transaction((tx) => documentData.eraseSubject(tx, subject()));
    expect(outcome.deleted).toBe(1 + 1 + 1 + 1); // document, folder right, card, job
    expect(outcome.kept).toBe(2); // the locked document and the acknowledgement
    expect(outcome.keptReason).toMatch(/legal hold/);
    expect(outcome.purge).toHaveLength(1);
    expect(outcome.purge![0]).toBe(v!.storageKey);
    expect(await db.select().from(documents).where(eq(documents.id, ids["frei"]!))).toHaveLength(0);
    expect(await db.select().from(documents).where(eq(documents.id, ids["gesperrt"]!))).toHaveLength(1);
    expect(await db.select().from(documents).where(eq(documents.id, ids["fremd"]!))).toHaveLength(1);
    expect(await db.select().from(memberCards).where(eq(memberCards.clubMemberId, personId))).toHaveLength(0);
    expect(await db.select().from(documentAcknowledgements).where(eq(documentAcknowledgements.clubMemberId, personId))).toHaveLength(1);
    // the caller removes the files after the commit; until then the file is still there
    await expect(stat(path.join(UPLOADS_DIR, v!.storageKey))).resolves.toBeTruthy();
  });

  it("a dry run (rolled back transaction) changes nothing", async () => {
    class Rollback extends Error {}
    await expect(
      db.transaction(async (tx) => {
        await documentData.eraseSubject(tx, { ...subject(), clubMemberId: otherId });
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await db.select().from(documents).where(eq(documents.id, ids["fremd"]!))).toHaveLength(1);
  });
});
