import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { departments } from "../db/schema/departments.js";
import { documentFolders, documents, documentVersions } from "../db/schema/documents.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { purgeExpiredTrash } from "../lib/documents.js";
import { makePng, PDF_BYTES } from "../lib/media-fixtures.js";
import { storageUsage } from "../lib/media-quota.js";
import { UPLOADS_DIR } from "../lib/storage.js";
import { documentRoutes } from "./documents.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/**
 * Wave 13 B5: archive folders with rights (role / department / member, nearest folder decides), uploads through the media
 * layer, versions, trash, retention blocks, IDOR between clubs and quota. Scoped to its own clubs.
 */
const app = new Hono();
app.route("/documents", documentRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

type Json = Record<string, unknown>;
const body = async (res: Response) => (await res.json()) as { data: Json & { id: string; versions?: Json[]; level?: string }; error?: { code: string; details?: Json } };
const list = async (res: Response) => ((await res.json()) as { data: Array<Json & { id: string }>; total: number }).data;

const pdf = (extra = ""): File => new File([new Uint8Array(Buffer.concat([PDF_BYTES, Buffer.from(extra)]))], "Protokoll 2026.pdf", { type: "application/pdf" });
const form = (fields: Record<string, string | File>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("document archive", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guest: Account;
  let deptId: string;
  let trainerMemberId: string;
  let plainMemberId: string;
  const clubId = () => club.clubId;

  const post = (who: Account, path: string, json?: unknown, id = clubId()) => call(who, path, { method: "POST", body: json, clubId: id });
  const folder = async (who: Account, name: string, parentId?: string) => (await body(await post(who, "/documents/folders", { name, parentId }))).data.id;
  const upload = (who: Account, folderId: string | null, file: File = pdf(), extra: Record<string, string> = {}) =>
    call(who, "/documents", { method: "POST", clubId: clubId(), form: form({ file, ...(folderId ? { folderId } : {}), ...extra }) });
  const setRights = (folderId: string, entries: unknown[]) => call(club.founder, `/documents/folders/${folderId}/permissions`, { method: "PUT", body: { entries }, clubId: clubId() });

  beforeAll(async () => {
    club = await createClub("docs", suffix, { schrift: "schriftfuehrer", trainer: "trainer", kassen: "kassenwart", plain: null });
    other = await createClub("docso", suffix);
    guest = await signUpAndVerify(`docs-guest-${suffix}@example.com`, "Docs Guest");
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: club.clubId, role: "guest" } });
    club.userIds.push(guest.userId);
    const [dept] = await db.insert(departments).values({ clubId: club.clubId, name: "Fussball" }).returning();
    deptId = dept!.id;
    const cmOf = async (a: Account) => {
      const m = await db.query.member.findFirst({ where: (mm, { and: a2, eq: e2 }) => a2(e2(mm.organizationId, club.clubId), e2(mm.userId, a.userId)) });
      return (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) }))!.id;
    };
    trainerMemberId = await cmOf(club.members.trainer!);
    plainMemberId = await cmOf(club.members.plain!);
    await db.insert(clubMemberDepartments).values({ clubMemberId: trainerMemberId, departmentId: deptId });
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  describe("folders", () => {
    it("lets only documents:manage create root folders, rejects duplicates, too deep nesting and cycles", async () => {
      expect((await post(club.members.plain!, "/documents/folders", { name: "Hack" })).status).toBe(403);
      expect((await post(club.members.schrift!, "/documents/folders", { name: "Hack" })).status).toBe(403);
      const root = await folder(club.founder, "Satzung & Ordnungen");
      expect((await post(club.founder, "/documents/folders", { name: "satzung & ordnungen" })).status).toBe(409);
      expect((await post(club.founder, "/documents/folders", { name: "mit/Slash" })).status).toBe(422);
      let parent = root;
      for (let i = 2; i <= 5; i++) parent = await folder(club.founder, `Ebene ${i}`, parent);
      const tooDeep = await post(club.founder, "/documents/folders", { name: "Ebene 6", parentId: parent });
      expect(tooDeep.status).toBe(422);
      expect((await body(tooDeep)).error?.details).toMatchObject({ code: "folder_depth" });
      const sub = await folder(club.founder, "Kind", root);
      expect((await call(club.founder, `/documents/folders/${root}`, { method: "PATCH", body: { parentId: sub }, clubId: clubId() })).status).toBe(409);
      expect((await call(club.founder, `/documents/folders/${sub}`, { method: "PATCH", body: { name: "Kind 2" }, clubId: clubId() })).status).toBe(200);
      expect((await call(club.founder, `/documents/folders/${root}`, { method: "DELETE", clubId: clubId() })).status).toBe(409);
    });

    it("protects system folders and only removes empty ones", async () => {
      const [sys] = await db.insert(documentFolders).values({ clubId: clubId(), name: "Protokolle", systemKey: "protokolle" }).returning();
      expect((await call(club.founder, `/documents/folders/${sys!.id}`, { method: "PATCH", body: { name: "X" }, clubId: clubId() })).status).toBe(409);
      expect((await call(club.founder, `/documents/folders/${sys!.id}`, { method: "DELETE", clubId: clubId() })).status).toBe(409);
      const empty = await folder(club.founder, "Leer");
      expect((await call(club.founder, `/documents/folders/${empty}`, { method: "DELETE", clubId: clubId() })).status).toBe(204);
    });
  });

  describe("rights", () => {
    let vorstand: string;
    let sub: string;
    let docId: string;

    it("hides a folder without any right from everybody except the board roles (404, not 403)", async () => {
      vorstand = await folder(club.founder, "Vorstand intern");
      sub = await folder(club.founder, "Beschlüsse", vorstand);
      const up = await upload(club.founder, sub);
      expect(up.status).toBe(201);
      docId = (await body(up)).data.id;
      for (const who of [club.members.plain!, club.members.trainer!, club.members.kassen!]) {
        expect((await call(who, `/documents/${docId}`, { clubId: clubId() })).status).toBe(404);
        expect((await call(who, `/documents/${docId}/download`, { clubId: clubId() })).status).toBe(404);
        expect((await call(who, `/documents?folderId=${sub}`, { clubId: clubId() })).status).toBe(404);
        expect((await list(await call(who, "/documents/folders", { clubId: clubId() }))).map((f) => f.id)).not.toContain(vorstand);
      }
      expect((await call(club.members.schrift!, `/documents/${docId}`, { clubId: clubId() })).status).toBe(200);
      expect((await list(await call(club.members.schrift!, `/documents?folderId=${sub}`, { clubId: clubId() }))).map((d) => d.id)).toEqual([docId]);
    });

    it("grants by role, department and single member, and the nearest folder with entries decides", async () => {
      expect((await setRights(vorstand, [{ subjectType: "rolle", roleType: "trainer", level: "lesen" }])).status).toBe(200);
      // inherited: the sub-folder has no entries of its own
      expect((await call(club.members.trainer!, `/documents/${docId}`, { clubId: clubId() })).status).toBe(200);
      expect((await call(club.members.plain!, `/documents/${docId}`, { clubId: clubId() })).status).toBe(404);
      const detail = await body(await call(club.members.trainer!, `/documents/${docId}`, { clubId: clubId() }));
      expect(detail.data.level).toBe("lesen");
      expect(detail.data).not.toHaveProperty("legalHold");

      // own entries on the sub-folder restrict what the parent granted
      expect((await setRights(sub, [{ subjectType: "mitglied", clubMemberId: plainMemberId, level: "lesen" }])).status).toBe(200);
      expect((await call(club.members.trainer!, `/documents/${docId}`, { clubId: clubId() })).status).toBe(404);
      expect((await call(club.members.plain!, `/documents/${docId}`, { clubId: clubId() })).status).toBe(200);

      expect((await setRights(sub, [{ subjectType: "abteilung", departmentId: deptId, level: "schreiben" }])).status).toBe(200);
      expect((await call(club.members.plain!, `/documents/${docId}`, { clubId: clubId() })).status).toBe(404);
      expect((await call(club.members.trainer!, `/documents/${docId}`, { clubId: clubId() })).status).toBe(200);

      // empty list = inherit again
      expect((await setRights(sub, [])).status).toBe(200);
      const perms = (await (await call(club.founder, `/documents/folders/${sub}/permissions`, { clubId: clubId() })).json()) as { inheritsFrom: string | null };
      expect(perms.inheritsFrom).toBe(vorstand);
    });

    it("separates reading from writing and managing", async () => {
      await setRights(sub, [{ subjectType: "rolle", roleType: "trainer", level: "lesen" }, { subjectType: "mitglied", clubMemberId: plainMemberId, level: "schreiben" }]);
      // reader: no upload, no version, no trash, no move; 403 (the folder is visible)
      expect((await upload(club.members.trainer!, sub)).status).toBe(403);
      expect((await call(club.members.trainer!, `/documents/${docId}`, { method: "DELETE", clubId: clubId() })).status).toBe(403);
      expect((await call(club.members.trainer!, `/documents/${docId}/versions`, { method: "POST", clubId: clubId(), form: form({ file: pdf("v") }) })).status).toBe(403);
      // writer may upload, trash and restore, but neither manage rights nor delete for good
      const mine = await upload(club.members.plain!, sub, pdf("plain"));
      expect(mine.status).toBe(201);
      const mineId = (await body(mine)).data.id;
      expect((await call(club.members.plain!, `/documents/${mineId}`, { method: "DELETE", clubId: clubId() })).status).toBe(204);
      expect((await call(club.members.plain!, `/documents/${mineId}`, { clubId: clubId() })).status).toBe(200); // writers still see trashed documents
      expect((await call(club.members.trainer!, `/documents/${mineId}`, { clubId: clubId() })).status).toBe(404); // readers do not
      expect((await call(club.members.plain!, `/documents/${mineId}`, { method: "DELETE", clubId: clubId() })).status).toBe(409);
      expect((await call(club.members.plain!, `/documents/${mineId}/permanent`, { method: "DELETE", clubId: clubId() })).status).toBe(403);
      expect((await post(club.members.plain!, `/documents/${mineId}/restore`)).status).toBe(200);
      expect((await call(club.members.plain!, `/documents/folders/${sub}/permissions`, { clubId: clubId() })).status).toBe(403);
      expect((await setRights(sub, [])).status).toBe(200);
    });

    it("validates the entries of a folder right", async () => {
      expect((await setRights(vorstand, [{ subjectType: "rolle", level: "lesen" }])).status).toBe(422);
      expect((await setRights(vorstand, [{ subjectType: "rolle", roleType: "trainer", departmentId: deptId, level: "lesen" }])).status).toBe(422);
      expect((await setRights(vorstand, [{ subjectType: "rolle", roleType: "trainer", level: "lesen" }, { subjectType: "rolle", roleType: "trainer", level: "schreiben" }])).status).toBe(422);
      expect((await setRights(vorstand, [{ subjectType: "abteilung", departmentId: randomUUID(), level: "lesen" }])).status).toBe(422);
      expect((await setRights(vorstand, [{ subjectType: "mitglied", clubMemberId: randomUUID(), level: "lesen" }])).status).toBe(422);
      await setRights(vorstand, []);
    });
  });

  describe("uploads, versions, downloads", () => {
    let folderId: string;
    let docId: string;

    it("stores an upload through the media layer and downloads it as an attachment", async () => {
      folderId = await folder(club.founder, "Allgemein");
      await setRights(folderId, [{ subjectType: "rolle", roleType: "mitglied", level: "lesen" }]);
      const res = await upload(club.founder, folderId, pdf(), { title: "Beitragsordnung", note: "Erstfassung" });
      expect(res.status).toBe(201);
      const created = await body(res);
      docId = created.data.id;
      expect(created.data).toMatchObject({ title: "Beitragsordnung", status: "aktiv", kind: "hochgeladen", level: "verwalten", currentVersion: { versionNo: 1, mimeType: "application/pdf" } });
      expect(JSON.stringify(created)).not.toMatch(/storageKey|storage_key|\/documents\/[0-9a-f-]{36}\./);

      const [v] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, docId));
      const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, v!.storageKey));
      expect(media).toMatchObject({ ownerType: "document", ownerId: docId, kind: "document", sensitive: false, clubId: clubId() });
      expect(v!.storageKey.startsWith(`${clubId()}/documents/`)).toBe(true);

      const dl = await call(club.members.plain!, `/documents/${docId}/download`, { clubId: clubId() });
      expect(dl.status).toBe(200);
      expect(dl.headers.get("content-type")).toBe("application/pdf");
      expect(dl.headers.get("content-disposition")).toContain("attachment");
      expect(dl.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    });

    it("rejects spoofed, empty, oversized and unsupported files and leaves no document behind", async () => {
      const before = (await db.select({ id: documents.id }).from(documents).where(eq(documents.clubId, clubId()))).length;
      const png = new File([new Uint8Array(makePng(false))], "x.pdf", { type: "application/pdf" });
      expect((await upload(club.founder, folderId, png)).status).toBe(422);
      expect((await upload(club.founder, folderId, new File([], "leer.pdf", { type: "application/pdf" }))).status).toBe(422);
      expect((await upload(club.founder, folderId, new File([new Uint8Array(Buffer.from("MZ binary"))], "a.exe", { type: "application/octet-stream" }))).status).toBe(422);
      expect((await upload(club.founder, folderId, new File([new Uint8Array(Buffer.from("<svg onload=alert(1)>"))], "a.svg", { type: "image/svg+xml" }))).status).toBe(422);
      const big = Buffer.concat([PDF_BYTES, Buffer.alloc(10 * 1024 * 1024)]);
      expect((await upload(club.founder, folderId, new File([new Uint8Array(big)], "gross.pdf", { type: "application/pdf" }))).status).toBe(422);
      expect((await call(club.founder, "/documents", { method: "POST", clubId: clubId(), form: form({ folderId }) })).status).toBe(422);
      expect((await upload(club.founder, randomUUID())).status).toBe(404);
      expect((await db.select({ id: documents.id }).from(documents).where(eq(documents.clubId, clubId()))).length).toBe(before);
    });

    it("sanitises the file name and keeps path traversal out of the storage key", async () => {
      const evil = new File([new Uint8Array(PDF_BYTES)], "../../etc/pass‮wd\u0000.pdf", { type: "application/pdf" });
      const res = await upload(club.founder, folderId, evil, { title: "Evil" });
      expect(res.status).toBe(201);
      const id = (await body(res)).data.id;
      const [v] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, id));
      expect(v!.storageKey).not.toContain("..");
      expect([...v!.originalFilename].some((ch) => ["/", "\\", String.fromCharCode(0x202e), String.fromCharCode(0)].includes(ch))).toBe(false);
      await call(club.founder, `/documents/${id}`, { method: "DELETE", clubId: clubId() });
    });

    it("numbers parallel new versions without gaps and keeps the old ones downloadable", async () => {
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => call(club.founder, `/documents/${docId}/versions`, { method: "POST", clubId: clubId(), form: form({ file: pdf(`-v${i}`), note: `n${i}` }) })));
      expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
      const detail = await body(await call(club.founder, `/documents/${docId}`, { clubId: clubId() }));
      expect((detail.data.versions ?? []).map((v) => v.versionNo)).toEqual([6, 5, 4, 3, 2, 1]);
      expect(detail.data.currentVersion).toMatchObject({ versionNo: 6 });
      const old = await call(club.founder, `/documents/${docId}/download?versionNo=1`, { clubId: clubId() });
      expect(old.status).toBe(200);
      expect(Buffer.from(await old.arrayBuffer()).length).toBe(PDF_BYTES.length);
      expect((await call(club.founder, `/documents/${docId}/download?versionNo=99`, { clubId: clubId() })).status).toBe(404);
    });

    it("searches titles over everything the caller may read and pages the list", async () => {
      expect((await list(await call(club.members.plain!, "/documents?q=beitrag", { clubId: clubId() }))).map((d) => d.id)).toContain(docId);
      expect((await list(await call(club.members.plain!, "/documents?q=Vorstand%25", { clubId: clubId() }))).length).toBe(0);
      const paged = (await (await call(club.founder, `/documents?folderId=${folderId}&pageSize=1`, { clubId: clubId() })).json()) as { data: unknown[]; total: number };
      expect(paged.data).toHaveLength(1);
      expect(paged.total).toBeGreaterThanOrEqual(1);
      // documents without a folder are board-only
      expect((await list(await call(club.members.plain!, "/documents", { clubId: clubId() }))).length).toBe(0);
    });

    it("moves a document between folders only with write rights on both", async () => {
      const target = await folder(club.founder, "Ziel");
      expect((await call(club.founder, `/documents/${docId}`, { method: "PATCH", body: { folderId: target, title: "Umbenannt" }, clubId: clubId() })).status).toBe(200);
      expect((await call(club.members.plain!, `/documents/${docId}`, { method: "PATCH", body: { title: "x" }, clubId: clubId() })).status).toBe(404);
      expect((await call(club.founder, `/documents/${docId}`, { method: "PATCH", body: { folderId: randomUUID() }, clubId: clubId() })).status).toBe(404);
      await call(club.founder, `/documents/${docId}`, { method: "PATCH", body: { folderId }, clubId: clubId() });
    });
  });

  describe("trash, retention and removal", () => {
    it("deletes for good only from the trash, never under legal hold or retention, and frees the quota", async () => {
      const f = await folder(club.founder, "Papierkorb-Test");
      const id = (await body(await upload(club.founder, f, pdf("trash")))).data.id;
      expect((await call(club.founder, `/documents/${id}/permanent`, { method: "DELETE", clubId: clubId() })).status).toBe(409); // not in the trash
      await call(club.founder, `/documents/${id}`, { method: "DELETE", clubId: clubId() });
      const usage = await storageUsage(clubId());
      expect(usage.trashBytes).toBeGreaterThan(0);

      await db.update(documents).set({ legalHold: true }).where(eq(documents.id, id));
      const held = await call(club.founder, `/documents/${id}/permanent`, { method: "DELETE", clubId: clubId() });
      expect(held.status).toBe(409);
      expect((await body(held)).error?.details).toMatchObject({ code: "retention" });
      await db.update(documents).set({ legalHold: false, retentionUntil: "2999-01-01" }).where(eq(documents.id, id));
      expect((await call(club.founder, `/documents/${id}/permanent`, { method: "DELETE", clubId: clubId() })).status).toBe(409);
      await db.update(documents).set({ retentionUntil: null }).where(eq(documents.id, id));

      const [v] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, id));
      const before = (await storageUsage(clubId())).usedBytes;
      expect((await call(club.founder, `/documents/${id}/permanent`, { method: "DELETE", clubId: clubId() })).status).toBe(204);
      expect((await storageUsage(clubId())).usedBytes).toBe(before - v!.sizeBytes);
      await expect(stat(path.join(UPLOADS_DIR, v!.storageKey))).rejects.toThrow();
      expect((await call(club.founder, `/documents/${id}`, { clubId: clubId() })).status).toBe(404);
    });

    it("empties the trash for documents:manage only and reports what had to stay", async () => {
      const f = await folder(club.founder, "Leeren");
      const ids = [(await body(await upload(club.founder, f, pdf("a")))).data.id, (await body(await upload(club.founder, f, pdf("b")))).data.id];
      for (const id of ids) await call(club.founder, `/documents/${id}`, { method: "DELETE", clubId: clubId() });
      await db.update(documents).set({ legalHold: true }).where(eq(documents.id, ids[1]!));
      expect((await post(club.members.schrift!, "/documents/trash/empty")).status).toBe(403);
      const res = await body(await post(club.founder, "/documents/trash/empty"));
      expect(res.data).toMatchObject({ kept: 1 });
      expect(Number(res.data.removed)).toBeGreaterThanOrEqual(1);
      expect((await call(club.founder, `/documents/${ids[0]}`, { clubId: clubId() })).status).toBe(404);
      expect((await call(club.founder, `/documents/${ids[1]}`, { clubId: clubId() })).status).toBe(200);
    });

    it("the daily job removes documents that have been in the trash for more than 30 days", async () => {
      const f = await folder(club.founder, "Job");
      const oldId = (await body(await upload(club.founder, f, pdf("old")))).data.id;
      const youngId = (await body(await upload(club.founder, f, pdf("young")))).data.id;
      for (const id of [oldId, youngId]) await call(club.founder, `/documents/${id}`, { method: "DELETE", clubId: clubId() });
      await db.update(documents).set({ trashedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(documents.id, oldId));
      expect(await purgeExpiredTrash()).toBeGreaterThanOrEqual(1);
      expect((await call(club.founder, `/documents/${oldId}`, { clubId: clubId() })).status).toBe(404);
      expect((await call(club.founder, `/documents/${youngId}`, { clubId: clubId() })).status).toBe(200);
    });
  });

  describe("isolation", () => {
    it("answers every route 404 for ids of another club and 403 for external guests", async () => {
      const f = await folder(club.founder, "Fremd");
      const id = (await body(await upload(club.founder, f))).data.id;
      const asOther = (path: string, init: { method?: string; body?: unknown } = {}) => call(other.founder, path, { ...init, clubId: other.clubId });
      expect((await asOther(`/documents/${id}`)).status).toBe(404);
      expect((await asOther(`/documents/${id}/download`)).status).toBe(404);
      expect((await asOther(`/documents/${id}`, { method: "DELETE" })).status).toBe(404);
      expect((await asOther(`/documents/${id}/versions`, { method: "POST" })).status).toBe(404);
      expect((await asOther(`/documents/folders/${f}`, { method: "PATCH", body: { name: "x" } })).status).toBe(404);
      expect((await asOther(`/documents/folders/${f}/permissions`)).status).toBe(404);
      expect((await asOther(`/documents?folderId=${f}`)).status).toBe(404);
      expect((await call(other.founder, "/documents", { method: "POST", clubId: other.clubId, form: form({ file: pdf(), folderId: f }) })).status).toBe(404);
      // the other club's founder cannot reach it by claiming the club either
      expect((await call(other.founder, `/documents/${id}`, { clubId: club.clubId })).status).toBe(404);
      for (const path of ["/documents", "/documents/folders", `/documents/${id}`, `/documents/${id}/download`]) expect((await call(guest, path, { clubId: clubId() })).status, path).toBe(403);
      expect((await call(guest, "/documents", { method: "POST", clubId: clubId(), form: form({ file: pdf() }) })).status).toBe(403);
    });
  });

  describe("quota", () => {
    it("refuses an upload over the club's quota with 422 QUOTA_EXCEEDED and creates no document", async () => {
      const usedNow = (await storageUsage(clubId())).usedBytes;
      await db.insert(clubSettings).values({ clubId: clubId(), storageQuotaBytes: usedNow + 10 }).onConflictDoUpdate({ target: clubSettings.clubId, set: { storageQuotaBytes: usedNow + 10 } });
      const f = await folder(club.founder, "Quota");
      const before = (await db.select({ id: documents.id }).from(documents).where(and(eq(documents.clubId, clubId())))).length;
      const res = await upload(club.founder, f, pdf("quota"));
      expect(res.status).toBe(422);
      expect((await body(res)).error).toMatchObject({ code: "QUOTA_EXCEEDED", details: { code: "club_quota" } });
      expect((await db.select({ id: documents.id }).from(documents).where(and(eq(documents.clubId, clubId())))).length).toBe(before);
      await db.update(clubSettings).set({ storageQuotaBytes: null }).where(eq(clubSettings.clubId, clubId()));
    });
  });

  it("audits uploads and folder changes with ids only", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.clubId, clubId()));
    const types = new Set(rows.map((r) => r.eventType));
    for (const t of ["document.upload", "document.version_add", "document.trash", "document.restore", "document.purge", "document_folder.create", "document_folder.permissions"]) expect(types.has(t), t).toBe(true);
    expect(JSON.stringify(rows.map((r) => r.payload))).not.toMatch(/Beitragsordnung|Protokoll 2026|Umbenannt/);
  });
});
