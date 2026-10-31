import { stat } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { documents, documentVersions } from "../db/schema/documents.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { storeGeneratedPdf } from "../lib/media.js";
import { PDF_BYTES } from "../lib/media-fixtures.js";
import { storageUsage } from "../lib/media-quota.js";
import { UPLOADS_DIR } from "../lib/storage.js";
import { documentRoutes } from "./documents.js";
import { memberDocumentRoutes } from "./member-documents.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/**
 * Wave 13 B6: personal storage. Self, guardian of a ward without account, board with logging, strangers, expiry of the
 * guardian link, receipts that can only be hidden, board deletion with a reason, retention and legal hold.
 */
const app = new Hono();
app.route("/member-documents", memberDocumentRoutes);
app.route("/documents", documentRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

type Json = Record<string, unknown>;
type Doc = { id: string; source: string; canDelete: boolean; canHide: boolean; hidden: boolean; title: string };
const read = async (res: Response) => (await res.json()) as { data: Doc[] & Doc; relation?: string; owner?: Json; error?: { code: string; details?: Json } };
const pdf = (extra = "") => new File([new Uint8Array(Buffer.concat([PDF_BYTES, Buffer.from(extra)]))], "Beleg.pdf", { type: "application/pdf" });
const form = (file: File, extra: Record<string, string> = {}) => {
  const f = new FormData();
  f.set("file", file);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
};
const yearsAgo = (n: number) => new Date(Date.now() - n * 365.25 * 86_400_000).toISOString().slice(0, 10);
const dayPlus = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

describe("personal document storage", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guardian: Account;
  let guardian2: Account;
  let stranger: Account;
  let plainCm: string;
  let otherCm: string;
  let childCm: string;
  let guardianAccountMember: string;
  let linkId: string;
  const id = () => club.clubId;

  const get = (who: Account, p: string) => call(who, p, { clubId: id() });
  const send = (who: Account, p: string, method: string, bodyJson?: unknown) => call(who, p, { method, body: bodyJson, clubId: id() });
  const upload = (who: Account, memberId: string, file = pdf(), extra: Record<string, string> = {}) => call(who, `/member-documents/${memberId}`, { method: "POST", clubId: id(), form: form(file, extra) });
  const accountMemberOf = async (a: Account) => (await db.query.member.findFirst({ where: (m, { and: a2, eq: e2 }) => a2(e2(m.organizationId, id()), e2(m.userId, a.userId)) }))!.id;
  const clubMemberOf = async (a: Account) => (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, await accountMemberOf(a)) }))!.id;
  const receipt = async (ownerId: string, docType = "aufnahmebeleg") => {
    const media = await storeGeneratedPdf({ buffer: PDF_BYTES, clubId: id(), directory: "personal", filename: "Beleg.pdf", owner: { type: "member_document", id: null }, sensitive: true, uploadedBy: null });
    const [doc] = await db.insert(documents).values({ clubId: id(), scope: "person", ownerClubMemberId: ownerId, kind: "erzeugt", docType, title: "Aufnahmebeleg" }).returning();
    const [v] = await db.insert(documentVersions).values({ documentId: doc!.id, clubId: id(), versionNo: 1, storageKey: media.storageKey, mimeType: "application/pdf", sizeBytes: media.sizeBytes, sha256: media.sha256, originalFilename: "Beleg.pdf", templateId: "aufnahme-beleg", templateVersion: 1 }).returning();
    await db.update(documents).set({ currentVersionId: v!.id }).where(eq(documents.id, doc!.id));
    return doc!.id;
  };

  beforeAll(async () => {
    club = await createClub("pers", suffix, { trainer: "trainer", plain: null, plain2: null });
    other = await createClub("perso", suffix);
    plainCm = await clubMemberOf(club.members.plain!);
    otherCm = await clubMemberOf(club.members.plain2!);
    const join = async (label: string, role: "member" | "guest") => {
      const a = await signUpAndVerify(`pers-${label}-${suffix}@example.com`, `Pers ${label}`);
      club.userIds.push(a.userId);
      await auth.api.addMember({ body: { userId: a.userId, organizationId: id(), role } });
      return a;
    };
    guardian = await join("guardian", "guest");
    guardian2 = await join("guardian2", "guest");
    stranger = await join("stranger", "guest");
    guardianAccountMember = await accountMemberOf(guardian);
    const [child] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Kind Ohne Konto", birthDate: yearsAgo(9), joinedAt: "2024-01-01" }).returning();
    childCm = child!.id;
    const [link] = await db.insert(guardianLinks).values({ guardianMemberId: guardianAccountMember, wardClubMemberId: childCm, confirmedAt: new Date() }).returning();
    linkId = link!.id;
    await db.insert(guardianLinks).values({ guardianMemberId: await accountMemberOf(guardian2), wardClubMemberId: childCm, confirmedAt: new Date(), validUntil: dayPlus(-1) });
  }, 90_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  describe("the member itself", () => {
    let docId: string;

    it("uploads, lists, downloads (sensitive, audited) and removes an own upload for good", async () => {
      const up = await upload(club.members.plain!, "me", pdf("mine"), { title: "Mein Zeugnis" });
      expect(up.status).toBe(201);
      const created = (await read(up)).data;
      docId = created.id;
      expect(created).toMatchObject({ source: "member", canDelete: true, canHide: false, title: "Mein Zeugnis" });
      const [doc] = await db.select().from(documents).where(eq(documents.id, docId));
      expect(doc).toMatchObject({ scope: "person", ownerClubMemberId: plainCm, kind: "hochgeladen", docType: "upload" });
      const [v] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, docId));
      const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, v!.storageKey));
      expect(media).toMatchObject({ ownerType: "member_document", sensitive: true, kind: "document" });
      expect(v!.storageKey.startsWith(`${id()}/personal/`)).toBe(true);

      const listed = await read(await get(club.members.plain!, "/member-documents/me"));
      expect(listed.relation).toBe("self");
      expect(listed.data.map((d) => d.id)).toContain(docId);
      const dl = await get(club.members.plain!, `/member-documents/${plainCm}/${docId}/download`);
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-disposition")).toContain("attachment");
      expect(dl.headers.get("cache-control")).toContain("no-store");
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "media.sensitive_access"), eq(auditLog.subjectId, docId)));
      expect(audits).toHaveLength(1);

      const before = (await storageUsage(id())).usedBytes;
      expect((await send(club.members.plain!, `/member-documents/me/${docId}`, "DELETE")).status).toBe(204);
      expect((await storageUsage(id())).usedBytes).toBe(before - v!.sizeBytes);
      await expect(stat(path.join(UPLOADS_DIR, v!.storageKey))).rejects.toThrow();
      expect((await get(club.members.plain!, `/member-documents/me/${docId}/download`)).status).toBe(404);
    });

    it("cannot delete receipts, only hide and unhide them", async () => {
      const rid = await receipt(plainCm);
      const row = (await read(await get(club.members.plain!, "/member-documents/me"))).data.find((d) => d.id === rid)!;
      expect(row).toMatchObject({ source: "erzeugt", canDelete: false, canHide: true });
      const del = await send(club.members.plain!, `/member-documents/me/${rid}`, "DELETE");
      expect(del.status).toBe(409);
      expect((await read(del)).error?.details).toMatchObject({ code: "not_deletable" });
      expect((await send(club.members.plain!, `/member-documents/me/${rid}/hide`, "POST")).status).toBe(200);
      expect((await read(await get(club.members.plain!, "/member-documents/me"))).data.map((d) => d.id)).not.toContain(rid);
      expect((await read(await get(club.members.plain!, "/member-documents/me?includeHidden=1"))).data.find((d) => d.id === rid)?.hidden).toBe(true);
      expect((await get(club.members.plain!, `/member-documents/me/${rid}/download`)).status).toBe(404);
      expect((await get(club.members.plain!, `/member-documents/me/${rid}/download?includeHidden=1`)).status).toBe(200);
      expect((await send(club.members.plain!, `/member-documents/me/${rid}/unhide`, "POST")).status).toBe(200);
      expect((await read(await get(club.members.plain!, "/member-documents/me"))).data.map((d) => d.id)).toContain(rid);
    });

    it("rejects the same hostile files as the archive and never mixes the storage with the archive routes", async () => {
      expect((await upload(club.members.plain!, "me", new File([new Uint8Array(Buffer.from("MZ"))], "x.pdf", { type: "application/pdf" }))).status).toBe(422);
      expect((await upload(club.members.plain!, "me", new File([], "leer.pdf", { type: "application/pdf" }))).status).toBe(422);
      const id1 = (await read(await upload(club.members.plain!, "me", pdf("archive-check")))).data.id;
      for (const who of [club.founder, club.members.plain!]) {
        expect((await get(who, `/documents/${id1}`)).status).toBe(404);
        expect((await get(who, `/documents/${id1}/download`)).status).toBe(404);
        expect((await send(who, `/documents/${id1}`, "DELETE")).status).toBe(404);
      }
      const search = (await (await get(club.founder, "/documents?q=archive-check")).json()) as { data: unknown[] };
      expect(search.data).toHaveLength(0);
    });
  });

  describe("strangers and other members", () => {
    it("answers 404 for every route to another member, a trainer, an unlinked guest, an expired link and another club", async () => {
      const rid = await receipt(plainCm, "mitgliedsbestaetigung");
      const probes = [
        ["GET", `/member-documents/${plainCm}`],
        ["GET", `/member-documents/${plainCm}/${rid}/download`],
        ["GET", `/member-documents/${plainCm}/access-log`],
        ["POST", `/member-documents/${plainCm}/${rid}/hide`],
        ["DELETE", `/member-documents/${plainCm}/${rid}`],
      ] as const;
      for (const who of [club.members.plain2!, club.members.trainer!, stranger, guardian2]) {
        for (const [method, p] of probes) expect((await send(who, p, method)).status, `${method} ${p}`).toBe(404);
        expect((await upload(who, plainCm)).status).toBe(404);
      }
      for (const [method, p] of probes) expect((await call(other.founder, p, { method, clubId: other.clubId })).status).toBe(404);
      // a document of another member addressed under the own id is not found either (IDOR on the document id)
      expect((await get(club.members.plain2!, `/member-documents/me/${rid}/download`)).status).toBe(404);
      expect((await get(club.members.plain2!, `/member-documents/${otherCm}/${rid}/download`)).status).toBe(404);
      expect((await get(club.members.plain!, "/member-documents/not-a-uuid")).status).toBe(404);
    });
  });

  describe("board access", () => {
    it("is allowed with documents:read_personal, is logged per access and visible to the member but not to the board", async () => {
      const board = await read(await get(club.founder, `/member-documents/${plainCm}`));
      expect(board.relation).toBe("board");
      expect(board.data.length).toBeGreaterThan(0);
      const first = board.data[0]!;
      expect((await get(club.founder, `/member-documents/${plainCm}/${first.id}/download`)).status).toBe(200);
      const up = await upload(club.founder, plainCm, pdf("board"), { title: "Vom Vorstand" });
      expect(up.status).toBe(201);
      expect((await read(up)).data).toMatchObject({ source: "vorstand", canDelete: true });

      const log = (await (await get(club.members.plain!, "/member-documents/me/access-log")).json()) as { data: Array<{ action: string; byName: string | null; documentTitle: string | null }> };
      expect(log.data.map((e) => e.action).sort()).toEqual(expect.arrayContaining(["list", "download", "upload"]));
      expect(log.data.every((e) => typeof e.byName === "string")).toBe(true);
      expect(log.data.some((e) => e.documentTitle === "Vom Vorstand")).toBe(true);
      expect((await get(club.founder, `/member-documents/${plainCm}/access-log`)).status).toBe(404);
      // the member's own and the guardian's accesses are not logged as board accesses
      const before = log.data.length;
      await get(club.members.plain!, "/member-documents/me");
      const after = (await (await get(club.members.plain!, "/member-documents/me/access-log")).json()) as { data: unknown[] };
      expect(after.data).toHaveLength(before);
    });

    it("deletes only with a reason and never under legal hold or retention", async () => {
      const rid = await receipt(plainCm, "kuendigung");
      expect((await send(club.founder, `/member-documents/${plainCm}/${rid}`, "DELETE")).status).toBe(422);
      expect((await send(club.founder, `/member-documents/${plainCm}/${rid}`, "DELETE", { reason: "weil ich will" })).status).toBe(422);
      await db.update(documents).set({ legalHold: true }).where(eq(documents.id, rid));
      expect((await send(club.founder, `/member-documents/${plainCm}/${rid}`, "DELETE", { reason: "fehlerhaft" })).status).toBe(409);
      await db.update(documents).set({ legalHold: false, retentionUntil: "2999-01-01" }).where(eq(documents.id, rid));
      expect((await send(club.founder, `/member-documents/${plainCm}/${rid}`, "DELETE", { reason: "fehlerhaft" })).status).toBe(409);
      await db.update(documents).set({ retentionUntil: null }).where(eq(documents.id, rid));
      expect((await send(club.founder, `/member-documents/${plainCm}/${rid}`, "DELETE", { reason: "fehlerhaft" })).status).toBe(204);
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_document.delete"), eq(auditLog.subjectId, plainCm)));
      expect(audits.map((a) => (a.payload as Json).reason)).toContain("fehlerhaft");
      // the board cannot hide / unhide on behalf of the member
      expect((await send(club.founder, `/member-documents/${plainCm}/${rid}/hide`, "POST")).status).toBe(404);
    });
  });

  describe("guardian of a ward without account", () => {
    it("sees and uploads for the ward while the link is live, and loses access when it expires, is unconfirmed or the ward turns 18", async () => {
      const boardDoc = await upload(club.founder, childCm, pdf("kind"), { title: "Anmeldung Kind" });
      expect(boardDoc.status).toBe(201);
      const list = await read(await get(guardian, `/member-documents/${childCm}`));
      expect(list.relation).toBe("guardian");
      expect(list.owner).toMatchObject({ hasAccount: false });
      expect(list.data.map((d) => d.title)).toContain("Anmeldung Kind");
      expect((await get(guardian, `/member-documents/${childCm}/${list.data[0]!.id}/download`)).status).toBe(200);
      const own = await upload(guardian, childCm, pdf("eltern"), { title: "Attest" });
      expect(own.status).toBe(201);
      const ownDoc = (await read(own)).data;
      expect(ownDoc).toMatchObject({ source: "member", canDelete: true });
      expect((await send(guardian, `/member-documents/${childCm}/${ownDoc.id}`, "DELETE")).status).toBe(204);
      // the guardian cannot reach any other member's storage 
      expect((await get(guardian, `/member-documents/${plainCm}`)).status).toBe(404);

      await db.update(guardianLinks).set({ confirmedAt: null }).where(eq(guardianLinks.id, linkId));
      expect((await get(guardian, `/member-documents/${childCm}`)).status).toBe(404);
      await db.update(guardianLinks).set({ confirmedAt: new Date() }).where(eq(guardianLinks.id, linkId));
      expect((await get(guardian, `/member-documents/${childCm}`)).status).toBe(200);
      await db.update(clubMembers).set({ birthDate: yearsAgo(19) }).where(eq(clubMembers.id, childCm));
      expect((await get(guardian, `/member-documents/${childCm}`)).status).toBe(404);
      expect((await upload(guardian, childCm)).status).toBe(404);
      expect((await get(club.founder, `/member-documents/${childCm}`)).status).toBe(200);
    });
  });
});
