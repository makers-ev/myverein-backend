import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubInfoPages, clubInfoPageVersions } from "../db/schema/club-info-pages.js";
import { documents, documentVersions } from "../db/schema/documents.js";
import { storeGeneratedPdf } from "../lib/media.js";
import { PDF_BYTES } from "../lib/media-fixtures.js";
import { clubInfoRoutes } from "./club-info.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/** Wave 13 B4: versioned club documents (history, restore, link and size rules, attachment, races, rights). */
const app = new Hono();
app.route("/club-info", clubInfoRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

type Json = Record<string, unknown>;
const json = async (res: Response) => (await res.json()) as { data: Json & { versionNo?: number }; unchanged?: boolean; error?: { code: string } };

describe("club info versions", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guest: Account;
  const put = (who: Account, slug: string, body: unknown, clubId = club.clubId) => call(who, `/club-info/${slug}`, { method: "PUT", body, clubId });

  beforeAll(async () => {
    club = await createClub("info", suffix, { trainer: "trainer", plain: null, schrift: "schriftfuehrer" });
    other = await createClub("infoo", suffix);
    guest = await signUpAndVerify(`info-guest-${suffix}@example.com`, "Info Guest");
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: club.clubId, role: "guest" } });
    club.userIds.push(guest.userId);
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("writes version 1 on create, a new version per real change and nothing for an identical save", async () => {
    const created = await put(club.founder, "satzung", { title: "Satzung", contentMarkdown: "# Satzung\n\n§ 1", validFrom: "2026-01-01", note: "Erstfassung" });
    expect(created.status).toBe(201);
    expect((await json(created)).data).toMatchObject({ slug: "satzung", currentVersion: 1, validFrom: "2026-01-01", attachment: null });

    const updated = await put(club.founder, "satzung", { title: "Satzung", contentMarkdown: "# Satzung\n\n§ 1 neu", validFrom: "2026-01-01", note: "§ 1 geändert" });
    expect(updated.status).toBe(200);
    expect((await json(updated)).data.currentVersion).toBe(2);

    const same = await put(club.founder, "satzung", { title: "Satzung", contentMarkdown: "# Satzung\n\n§ 1 neu", validFrom: "2026-01-01" });
    const sameBody = await json(same);
    expect(sameBody.unchanged).toBe(true);
    expect(sameBody.data.currentVersion).toBe(2);

    const versions = await json(await call(club.founder, "/club-info/satzung/versions", { clubId: club.clubId }));
    expect(versions.data).toHaveLength(2);
    expect((versions.data as unknown as Json[]).map((v) => [v.versionNo, v.current, v.note])).toEqual([[2, true, "§ 1 geändert"], [1, false, "Erstfassung"]]);
    expect((versions.data as unknown as Json[])[0]).not.toHaveProperty("contentMarkdown");
    expect(((versions.data as unknown as Json[])[0]!).createdByName).toBeTruthy();
  });

  it("returns old versions with their content and keeps the history when a version is restored", async () => {
    const v1 = await json(await call(club.founder, "/club-info/satzung/versions/1", { clubId: club.clubId }));
    expect(v1.data).toMatchObject({ versionNo: 1, contentMarkdown: "# Satzung\n\n§ 1", current: false });
    const restored = await call(club.founder, "/club-info/satzung/versions/1/restore", { method: "POST", body: {}, clubId: club.clubId });
    expect(restored.status).toBe(200);
    const page = (await json(restored)).data;
    expect(page).toMatchObject({ currentVersion: 3, contentMarkdown: "# Satzung\n\n§ 1" });
    const list = (await json(await call(club.founder, "/club-info/satzung/versions", { clubId: club.clubId }))).data as unknown as Json[];
    expect(list.map((v) => v.versionNo)).toEqual([3, 2, 1]);
    expect(list[0]!.note).toBe("Wiederhergestellt aus Version 1");
    expect((await call(club.founder, "/club-info/satzung/versions/9/restore", { method: "POST", body: {}, clubId: club.clubId })).status).toBe(404);
    expect((await call(club.founder, "/club-info/satzung/versions/abc", { clubId: club.clubId })).status).toBe(404);
  });

  it("lists metadata only in the aggregate and the content in the detail", async () => {
    const info = await json(await call(club.members.plain!, "/club-info", { clubId: club.clubId }));
    const pages = (info.data as unknown as { pages: Json[] }).pages;
    const satzung = pages.find((p) => p.slug === "satzung")!;
    expect(satzung).toMatchObject({ title: "Satzung", hasContent: true, hasAttachment: false, currentVersion: 3 });
    expect(satzung).not.toHaveProperty("contentMarkdown");
    const detail = await json(await call(club.members.plain!, "/club-info/satzung", { clubId: club.clubId }));
    expect(detail.data.contentMarkdown).toBe("# Satzung\n\n§ 1");
  });

  it("lets every member read but only club_info:write holders change anything", async () => {
    for (const who of [club.members.trainer!, club.members.plain!, guest]) {
      expect((await put(who, "satzung", { title: "Hack" })).status).toBe(403);
      expect((await call(who, "/club-info/satzung/versions/1/restore", { method: "POST", body: {}, clubId: club.clubId })).status).toBe(403);
      expect((await call(who, "/club-info/satzung", { method: "DELETE", clubId: club.clubId })).status).toBe(403);
    }
    expect((await put(club.members.schrift!, "leitbild", { title: "Leitbild" })).status).toBe(201);
    // Members see the history without author names, external guests not at all.
    const plainVersions = (await json(await call(club.members.plain!, "/club-info/satzung/versions", { clubId: club.clubId }))).data as unknown as Json[];
    expect(plainVersions[0]!.createdByName).toBeNull();
    expect((await call(guest, "/club-info/satzung/versions", { clubId: club.clubId })).status).toBe(403);
    expect((await call(guest, "/club-info/satzung/versions/1", { clubId: club.clubId })).status).toBe(403);
  });

  it("keeps the pages of another club invisible", async () => {
    expect((await call(other.founder, "/club-info/satzung", { clubId: other.clubId })).status).toBe(404);
    expect((await call(other.founder, "/club-info/satzung/versions", { clubId: other.clubId })).status).toBe(404);
    expect((await call(other.founder, "/club-info/satzung", { clubId: club.clubId })).status).toBe(404);
  });

  it("accepts only http(s) links, bounded markdown and clean text", async () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "ftp://example.org/x", "vbscript:x", " javascript:alert(1)", "//evil.example"]) {
      expect((await put(club.founder, "links", { title: "L", externalUrl: bad })).status, bad).toBe(422);
    }
    expect((await put(club.founder, "links", { title: "L", externalUrl: "https://example.org/verband" })).status).toBe(201);
    expect((await put(club.founder, "links", { title: "L", externalUrl: "HTTP://example.org/x" })).status).toBe(200);
    expect((await put(club.founder, "links", { title: "L", contentMarkdown: "a".repeat(100_001) })).status).toBe(422);
    expect((await put(club.founder, "links", { title: "L", contentMarkdown: "evil‮text" })).status).toBe(422);
    expect((await put(club.founder, "links", { title: "L", validFrom: "2026-13-45" })).status).toBe(422);
    expect((await put(club.founder, "links", { title: "" })).status).toBe(422);
    expect((await put(club.founder, "Not A Slug!", { title: "x" })).status).toBe(422);
  });

  it("numbers parallel writes without gaps or duplicates, also for a parallel first write", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => put(club.founder, "race", { title: `Titel ${i}`, contentMarkdown: `Inhalt ${i}` })));
    expect(results.map((r) => r.status).filter((s) => s === 201)).toHaveLength(1);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const [page] = await db.select().from(clubInfoPages).where(and(eq(clubInfoPages.clubId, club.clubId), eq(clubInfoPages.slug, "race")));
    const versions = await db.select({ n: clubInfoPageVersions.versionNo }).from(clubInfoPageVersions).where(eq(clubInfoPageVersions.pageId, page!.id));
    expect(versions.map((v) => v.n).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(page!.currentVersion).toBe(8);
  });

  it("audits the version number but never the content, and deleting removes the history", async () => {
    const [page] = await db.select().from(clubInfoPages).where(and(eq(clubInfoPages.clubId, club.clubId), eq(clubInfoPages.slug, "satzung")));
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, page!.id)));
    expect(audits.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(audits.map((a) => a.payload))).not.toContain("§ 1");
    expect(audits.some((a) => (a.payload as Json).version === 3 && (a.payload as Json).restoredFromVersion === 1)).toBe(true);
    expect((await call(club.founder, "/club-info/satzung", { method: "DELETE", clubId: club.clubId })).status).toBe(204);
    expect(await db.select().from(clubInfoPageVersions).where(eq(clubInfoPageVersions.pageId, page!.id))).toHaveLength(0);
    expect((await call(club.founder, "/club-info/satzung", { clubId: club.clubId })).status).toBe(404);
  });

  describe("PDF attachment", () => {
    const makeDoc = async (clubId: string, opts: { scope?: "verein" | "person"; mime?: string; status?: string } = {}) => {
      const media = await storeGeneratedPdf({ buffer: PDF_BYTES, clubId, directory: "documents", filename: "beschluss.pdf", owner: { type: "document", id: null }, sensitive: false, uploadedBy: null });
      const [doc] = await db.insert(documents).values({ clubId, scope: "verein", kind: "hochgeladen", title: "Satzung (beschlossen)", status: opts.status ?? "aktiv" }).returning();
      const [ver] = await db.insert(documentVersions).values({ documentId: doc!.id, clubId, versionNo: 1, storageKey: media.storageKey, mimeType: opts.mime ?? "application/pdf", sizeBytes: media.sizeBytes, sha256: media.sha256, originalFilename: "beschluss.pdf" }).returning();
      await db.update(documents).set({ currentVersionId: ver!.id }).where(eq(documents.id, doc!.id));
      return doc!.id;
    };

    it("attaches an archive PDF, shows its metadata and streams it to every member", async () => {
      const documentId = await makeDoc(club.clubId);
      const res = await put(club.founder, "satzung-pdf", { title: "Satzung als PDF", documentId });
      expect(res.status).toBe(201);
      expect((await json(res)).data.attachment).toMatchObject({ documentId, title: "Satzung (beschlossen)", mimeType: "application/pdf" });
      const file = await call(club.members.plain!, "/club-info/satzung-pdf/attachment", { clubId: club.clubId });
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("application/pdf");
      expect(file.headers.get("content-disposition")).toContain("attachment");
      expect(file.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await file.arrayBuffer()).toString("latin1", 0, 5)).toBe("%PDF-");
      expect((await call(guest, "/club-info/satzung-pdf/attachment", { clubId: club.clubId })).status).toBe(403);
      expect((await call(club.members.plain!, "/club-info/leitbild/attachment", { clubId: club.clubId })).status).toBe(404);
    });

    it("refuses documents of another club, non-PDFs, trashed and personal documents and unknown ids", async () => {
      const foreign = await makeDoc(other.clubId);
      const image = await makeDoc(club.clubId, { mime: "image/png" });
      const trashed = await makeDoc(club.clubId, { status: "im_papierkorb" });
      for (const documentId of [foreign, image, trashed, randomUUID()]) {
        expect((await put(club.founder, "satzung-pdf", { title: "x", documentId })).status, documentId).toBe(422);
      }
    });
  });
});
