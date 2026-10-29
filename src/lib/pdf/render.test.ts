import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "../../auth/auth.js";
import { closeDatabase, db } from "../../db/client.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { clubSettings } from "../../db/schema/club-settings.js";
import { documentFolders, documents, documentVersions, renderJobs } from "../../db/schema/documents.js";
import { mediaFiles } from "../../db/schema/media-files.js";
import { documentGenerationRoutes } from "../../routes/document-generation.js";
import { documentRoutes } from "../../routes/documents.js";
import { createClub, dropClubs, installErrorHandler, requester, type Account } from "../../routes/forms-test-support.js";
import { memberDocumentRoutes } from "../../routes/member-documents.js";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { logger } from "../logger.js";
import { storageUsage } from "../media-quota.js";
import { PdfRenderError, setPdfEngine, type PdfEngine } from "./engine.js";
import { executeRenderJob, inputHashOf, MAX_ACTIVE_JOBS_PER_CLUB, renderEphemeral, requestRender, requestRenderSafely, stableStringify } from "./render.js";
import { defineTemplate, registerTemplate, unregisterTemplate } from "./registry.js";
import { registerBuiltinTemplates } from "./templates/index.js";

/** Wave 13 B8: template registry, render jobs, snapshot semantics, failure handling, limits. Own clubs only. */
const app = new Hono();
app.route("/document-generation", documentGenerationRoutes);
app.route("/documents", documentRoutes);
app.route("/member-documents", memberDocumentRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const HOSTILE = "\\input{/etc/passwd} \\immediate\\write18{id} % }}} {{{ \\catcode`\\{=12 <script>alert(1)</script> 😀 \u202e RTL مرحبا";

type Json = Record<string, unknown>;
const jobOf = async (res: Response) => ((await res.json()) as { data: { id: string; status: string; errorCode: string | null; documentId: string | null } }).data;

let flaky = 0;
let sourceGone = false;

describe("render pipeline", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let plainCm: string;
  const id = () => club.clubId;
  let tmp: string;

  const generate = (who: Account, body: Json) => call(who, "/document-generation", { method: "POST", body, clubId: id() });

  beforeAll(async () => {
    registerBuiltinTemplates();
    registerTemplate(
      defineTemplate({
        id: "test-report",
        version: 3,
        label: "Testbericht",
        description: "Liste der Mitglieder",
        destination: "archive",
        permission: "documents:generate",
        docType: "testbericht",
        sensitive: true,
        folder: { systemKey: "testberichte", name: "Testberichte" },
        sync: true,
        paramsSchema: z.object({ heading: z.string().max(200).default("Bericht") }).strict(),
        authorize: async (actor) => {
          if (!actor.roleTypes.includes("vorsitz")) throw new ForbiddenError("Missing permission");
        },
        build: async (clubId, params) => {
          if (sourceGone) throw new NotFoundError("Source gone for Mustermann");
          const rows = await db.select({ name: clubMembers.displayName }).from(clubMembers).where(eq(clubMembers.clubId, clubId));
          return { data: { heading: params.heading, names: rows.map((r) => r.name).sort() }, title: `Bericht ${params.heading}`, filename: "bericht.pdf" };
        },
        layout: (built) => ({ format: "a4", title: built.title, blocks: [{ type: "heading", text: built.data.heading }, { type: "table", columns: [{ title: "Name", width: 1 }], rows: built.data.names.map((n) => [n]) }] }),
      }),
    );
    registerTemplate(
      defineTemplate({
        id: "test-own",
        version: 1,
        label: "Eigene Bestätigung",
        description: "für das Mitglied selbst",
        destination: "person",
        permission: null,
        docType: "testbestaetigung",
        sensitive: true,
        sync: true,
        paramsSchema: z.object({ clubMemberId: z.uuid() }).strict(),
        authorize: async (actor, params) => {
          if (actor.clubMemberId !== params.clubMemberId) throw new NotFoundError("Member not found");
        },
        build: async (clubId, params) => {
          const [m] = await db.select().from(clubMembers).where(and(eq(clubMembers.id, params.clubMemberId), eq(clubMembers.clubId, clubId)));
          if (!m) throw new NotFoundError("Member not found");
          return { data: { name: m.displayName }, title: "Bestätigung", filename: "bestaetigung.pdf", subjectClubMemberId: m.id };
        },
        layout: (built) => ({ format: "a4", title: built.title, blocks: [{ type: "paragraph", text: `Bestätigung für ${built.data.name}` }] }),
      }),
    );
    registerTemplate(
      defineTemplate({
        id: "test-flaky",
        version: 1,
        label: "Flaky",
        description: "fails on purpose",
        destination: "archive",
        permission: "documents:generate",
        docType: "flaky",
        sensitive: false,
        sync: false,
        paramsSchema: z.object({}).strict(),
        authorize: async () => undefined,
        build: async () => {
          if (flaky > 0) {
            flaky -= 1;
            throw new Error("database says: Erika Mustermann, Hauptstrasse 5");
          }
          return { data: { ok: true }, title: "Flaky", filename: "f.pdf" };
        },
        layout: (built) => ({ format: "a4", title: built.title, blocks: [{ type: "paragraph", text: "ok" }] }),
      }),
    );
    club = await createClub("render", suffix, { schrift: "schriftfuehrer", plain: null, trainer: "trainer" });
    other = await createClub("rendero", suffix);
    const m = await db.query.member.findFirst({ where: (mm, { and: a2, eq: e2 }) => a2(e2(mm.organizationId, id()), e2(mm.userId, club.members.plain!.userId)) });
    plainCm = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) }))!.id;
    // hostile content inside the data the template reads
    await db.insert(clubMembers).values({ clubId: id(), displayName: HOSTILE, joinedAt: "2024-01-01" });
    tmp = await mkdtemp(path.join(os.tmpdir(), "render-test-"));
  }, 60_000);

  afterAll(async () => {
    for (const t of ["test-report", "test-own", "test-flaky"]) unregisterTemplate(t);
    setPdfEngine(null);
    if (tmp) await rm(tmp, { recursive: true, force: true });
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("hashes equal data equally regardless of key order", () => {
    expect(inputHashOf({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(inputHashOf({ b: [1, { d: undefined, c: 2 }], a: 1 }));
    expect(inputHashOf({ a: 1 })).not.toBe(inputHashOf({ a: 2 }));
    expect(stableStringify({ b: 1, a: new Date("2026-01-01T00:00:00Z") })).toBe('{"a":"2026-01-01T00:00:00.000Z","b":1}');
  });

  describe("requests", () => {
    it("refuses unknown templates, bad parameters and callers without the right before a job exists", async () => {
      const before = (await db.select().from(renderJobs).where(eq(renderJobs.clubId, id()))).length;
      expect((await generate(club.founder, { templateId: "does-not-exist" })).status).toBe(404);
      expect((await generate(club.founder, { templateId: "../../etc/passwd" })).status).toBe(404);
      expect((await generate(club.founder, { templateId: "test-report", params: { heading: 5 } })).status).toBe(422);
      expect((await generate(club.founder, { templateId: "test-report", params: { extra: "x" } })).status).toBe(422);
      expect((await generate(club.members.plain!, { templateId: "test-report" })).status).toBe(403);
      expect((await generate(club.members.schrift!, { templateId: "test-report" })).status).toBe(403); // template authorize: vorsitz only
      expect((await generate(club.members.plain!, { templateId: "test-own", params: { clubMemberId: randomUUID() } })).status).toBe(404);
      expect((await db.select().from(renderJobs).where(eq(renderJobs.clubId, id()))).length).toBe(before);
    });

    it("lists only the templates the caller may use", async () => {
      const ids = async (who: Account) => (((await (await call(who, "/document-generation/templates", { clubId: id() })).json()) as { data: Array<{ id: string }> }).data).map((t) => t.id);
      expect(await ids(club.founder)).toEqual(expect.arrayContaining(["branding-test", "test-report", "test-own", "test-flaky"]));
      const plain = await ids(club.members.plain!);
      expect(plain).toContain("test-own");
      expect(plain).not.toContain("test-report");
      expect(plain).not.toContain("branding-test");
    });
  });

  describe("snapshot", () => {
    it("stores the PDF as a sensitive generated document with template, version, input hash and engine, and escapes hostile data", async () => {
      const res = await generate(club.founder, { templateId: "test-report", params: { heading: HOSTILE } });
      expect(res.status).toBe(201);
      const job = await jobOf(res);
      expect(job).toMatchObject({ status: "fertig", errorCode: null });
      const [doc] = await db.select().from(documents).where(eq(documents.id, job.documentId!));
      expect(doc).toMatchObject({ scope: "verein", kind: "erzeugt", docType: "testbericht", status: "aktiv" });
      const [folder] = await db.select().from(documentFolders).where(eq(documentFolders.id, doc!.folderId!));
      expect(folder).toMatchObject({ systemKey: "testberichte", name: "Testberichte" });
      const [v] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, doc!.id));
      expect(v).toMatchObject({ versionNo: 1, templateId: "test-report", templateVersion: 3, engineVersion: "pdfkit-1", mimeType: "application/pdf" });
      expect(v!.inputHash).toMatch(/^[0-9a-f]{64}$/);
      const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, v!.storageKey));
      expect(media).toMatchObject({ ownerType: "generated_pdf", ownerId: doc!.id, sensitive: true, kind: "document" });

      // a sensitive report is streamed authenticated (with audit), invisible to others, and really is a PDF
      const dl = await call(club.founder, `/documents/${doc!.id}/download`, { clubId: id() });
      expect(dl.status).toBe(200);
      const bytes = Buffer.from(await dl.arrayBuffer());
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect((await call(club.members.plain!, `/documents/${doc!.id}/download`, { clubId: id() })).status).toBe(404);
      const pdftotext = spawnSync("pdftotext", ["-v"]);
      if (!pdftotext.error) {
        const file = path.join(tmp, "out.pdf");
        await writeFile(file, bytes);
        const text = spawnSync("pdftotext", [file, "-"], { encoding: "utf8" }).stdout;
        expect(text).toContain("\\input{/etc/passwd}"); // visible as plain text, not interpreted
        expect(text).not.toContain("<script>".repeat(2));
      }
    });

    it("keeps the stored document when the source changes, and 'regenerate' adds a version with a new hash only if the data changed", async () => {
      const first = await jobOf(await generate(club.founder, { templateId: "test-report", params: { heading: "Stand 1" } }));
      const docId = first.documentId!;
      const [v1] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, docId));
      const sha1 = v1!.sha256;

      const [extra] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Neu Dazugekommen", joinedAt: "2025-01-01" }).returning();
      // the stored snapshot is untouched by the new member
      const [again] = await db.select().from(documentVersions).where(eq(documentVersions.documentId, docId));
      expect(again!.sha256).toBe(sha1);

      const regenerated = await jobOf(await generate(club.founder, { templateId: "test-report", params: { heading: "Stand 1" }, replaceDocumentId: docId }));
      expect(regenerated).toMatchObject({ status: "fertig", documentId: docId });
      const versions = await db.select().from(documentVersions).where(eq(documentVersions.documentId, docId));
      expect(versions.map((v) => v.versionNo).sort()).toEqual([1, 2]);
      expect(versions.find((v) => v.versionNo === 2)!.inputHash).not.toBe(v1!.inputHash);

      await db.delete(clubMembers).where(eq(clubMembers.id, extra!.id));
      const same = await jobOf(await generate(club.founder, { templateId: "test-report", params: { heading: "Stand 1" }, replaceDocumentId: docId }));
      const v3 = (await db.select().from(documentVersions).where(eq(documentVersions.documentId, docId))).find((v) => v.versionNo === 3)!;
      expect(same.status).toBe("fertig");
      expect(v3.inputHash).toBe(v1!.inputHash);
      // regenerating a document of another club, an unknown one or an uploaded one is refused
      expect((await call(other.founder, "/document-generation", { method: "POST", body: { templateId: "test-report", replaceDocumentId: docId }, clubId: other.clubId })).status).toBe(404);
      expect((await generate(club.founder, { templateId: "test-report", replaceDocumentId: randomUUID() })).status).toBe(404);
      expect((await generate(club.members.plain!, { templateId: "test-flaky", replaceDocumentId: docId })).status).toBe(404); // not visible to a plain member
      expect((await generate(club.members.plain!, { templateId: "test-flaky" })).status).toBe(403); // the template permission is enforced centrally
    });

    it("stores a document about a person in that person's storage, where only they, a guardian and the board reach it", async () => {
      const res = await generate(club.members.plain!, { templateId: "test-own", params: { clubMemberId: plainCm } });
      expect(res.status).toBe(201);
      const job = await jobOf(res);
      const [doc] = await db.select().from(documents).where(eq(documents.id, job.documentId!));
      expect(doc).toMatchObject({ scope: "person", ownerClubMemberId: plainCm, folderId: null, kind: "erzeugt" });
      const list = (await (await call(club.members.plain!, "/member-documents/me", { clubId: id() })).json()) as { data: Array<{ id: string; source: string; canDelete: boolean }> };
      expect(list.data.find((d) => d.id === doc!.id)).toMatchObject({ source: "erzeugt", canDelete: false });
      expect((await call(club.members.plain!, `/documents/${doc!.id}`, { clubId: id() })).status).toBe(404);
    });

    it("renders the branding test page without storing anything", async () => {
      const before = (await storageUsage(id())).usedBytes;
      const out = await renderEphemeral("branding-test", id(), {});
      expect(out.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect((await storageUsage(id())).usedBytes).toBe(before);
      await expect(renderEphemeral("test-report", id(), {})).rejects.toBeInstanceOf(NotFoundError);
      // Not storable: refused up front (it is rendered by its own route), no job is created.
      const refused = await generate(club.founder, { templateId: "branding-test" });
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: { details: { code: string } } }).error.details.code).toBe("ephemeral_template");
    });
  });

  describe("failures never leak and never block", () => {
    it("marks a missing source as failed with a fixed code, writes no document and allows a manual retry after the cause is gone", async () => {
      sourceGone = true;
      const res = await generate(club.founder, { templateId: "test-report", params: { heading: "Quelle weg" } });
      expect(res.status).toBe(202);
      const job = await jobOf(res);
      expect(job).toMatchObject({ status: "fehlgeschlagen", errorCode: "source_unavailable", documentId: null });
      expect((await call(club.founder, `/document-generation/jobs/${job.id}/retry`, { method: "POST", clubId: id() })).status).toBe(202);
      expect((await db.select().from(renderJobs).where(eq(renderJobs.id, job.id)))[0]!.status).toBe("wartet");
      sourceGone = false;
      const finished = await executeRenderJob(job.id, { final: true });
      expect(finished).toMatchObject({ status: "fertig" });
      expect((await call(club.founder, `/document-generation/jobs/${job.id}/retry`, { method: "POST", clubId: id() })).status).toBe(409);
    });

    it("retries transient errors through the queue path and keeps personal data out of the log and the job row", async () => {
      const warn = vi.spyOn(logger, "warn");
      flaky = 1;
      const queued = await requestRender({ clubId: id(), templateId: "test-flaky", params: {}, actor: null, wait: false });
      expect(queued.status).toBe("wartet");
      await expect(executeRenderJob(queued.id, { final: false })).rejects.toThrow("render job failed: internal_error");
      const [afterFail] = await db.select().from(renderJobs).where(eq(renderJobs.id, queued.id));
      expect(afterFail).toMatchObject({ status: "wartet", errorCode: "internal_error" });
      expect(await executeRenderJob(queued.id, { final: false })).toMatchObject({ status: "fertig" });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("Mustermann");
      expect(logged).not.toContain("Hauptstrasse");
      expect(JSON.stringify(afterFail)).not.toContain("Mustermann");
      // the last attempt ends as failed instead of throwing
      flaky = 1;
      const last = await requestRender({ clubId: id(), templateId: "test-flaky", params: {}, actor: null, wait: false });
      expect(await executeRenderJob(last.id, { final: true })).toMatchObject({ status: "fehlgeschlagen", errorCode: "internal_error" });
      warn.mockRestore();
    });

    it("requestRenderSafely never throws into a business action", async () => {
      expect(await requestRenderSafely({ clubId: id(), templateId: "does-not-exist", params: {}, actor: null })).toBeNull();
      expect(await requestRenderSafely({ clubId: id(), templateId: "test-report", params: { heading: 5 }, actor: null })).toBeNull();
      const ok = await requestRenderSafely({ clubId: id(), templateId: "test-report", params: { heading: "System" }, actor: null });
      expect(ok?.status).toBe("wartet"); // always via the worker
    });

    it("maps engine timeouts, limits and non-PDF output to fixed codes", async () => {
      const fake = (render: PdfEngine["render"]): PdfEngine => ({ id: "fake", version: "fake-1", render });
      for (const [engine, code] of [
        [fake(async () => { throw new PdfRenderError("timeout", "slow Mustermann"); }), "render_timeout"],
        [fake(async () => { throw new PdfRenderError("page_limit", "x"); }), "render_limit"],
        [fake(async () => Buffer.from("<html>not a pdf</html>")), "render_failed"],
      ] as const) {
        setPdfEngine(engine);
        const job = await jobOf(await generate(club.founder, { templateId: "test-report", params: { heading: "x" } }));
        expect(job, code).toMatchObject({ status: "fehlgeschlagen", errorCode: code });
      }
      setPdfEngine(null);
    });

    it("fails with quota_exceeded and leaves neither a document nor a file", async () => {
      const used = (await storageUsage(id())).usedBytes;
      await db.insert(clubSettings).values({ clubId: id(), storageQuotaBytes: used + 5 }).onConflictDoUpdate({ target: clubSettings.clubId, set: { storageQuotaBytes: used + 5 } });
      const docsBefore = (await db.select().from(documents).where(eq(documents.clubId, id()))).length;
      const filesBefore = (await db.select().from(mediaFiles).where(eq(mediaFiles.clubId, id()))).length;
      const job = await jobOf(await generate(club.founder, { templateId: "test-report", params: { heading: "Quota" } }));
      expect(job).toMatchObject({ status: "fehlgeschlagen", errorCode: "quota_exceeded" });
      expect((await db.select().from(documents).where(eq(documents.clubId, id()))).length).toBe(docsBefore);
      expect((await db.select().from(mediaFiles).where(eq(mediaFiles.clubId, id()))).length).toBe(filesBefore);
      await db.update(clubSettings).set({ storageQuotaBytes: null }).where(eq(clubSettings.clubId, id()));
    });
  });

  describe("limits and visibility", () => {
    it("is idempotent for the same key, also under parallel requests", async () => {
      const key = `beleg-${randomUUID()}`;
      const jobs = await Promise.all(Array.from({ length: 5 }, () => requestRender({ clubId: id(), templateId: "test-report", params: { heading: "Einmal" }, actor: null, idempotencyKey: key, wait: false })));
      expect(new Set(jobs.map((j) => j.id)).size).toBe(1);
      const stored = await db.select().from(renderJobs).where(and(eq(renderJobs.clubId, id()), eq(renderJobs.templateId, "test-report")));
      expect(stored.filter((j) => (j.params as Json).idempotencyKey === key)).toHaveLength(1);
    });

    it("never returns a job for a key used with other parameters or by somebody else (409)", async () => {
      const key = `mismatch-${randomUUID()}`;
      const first = await requestRender({ clubId: id(), templateId: "test-report", params: { heading: "A" }, actor: null, idempotencyKey: key, wait: false });
      await expect(requestRender({ clubId: id(), templateId: "test-report", params: { heading: "B" }, actor: null, idempotencyKey: key, wait: false })).rejects.toMatchObject({ status: 409, details: { code: "idempotency_key_mismatch" } });
      const res = await generate(club.founder, { templateId: "test-report", params: { heading: "A" }, idempotencyKey: key });
      expect(res.status).toBe(409);
      expect((await requestRender({ clubId: id(), templateId: "test-report", params: { heading: "A" }, actor: null, idempotencyKey: key, wait: false })).id).toBe(first.id);
    });

    it("caps the jobs that wait or run at the same time per club with 429", async () => {
      await db.delete(renderJobs).where(and(eq(renderJobs.clubId, other.clubId)));
      const make = () => requestRender({ clubId: other.clubId, templateId: "test-flaky", params: {}, actor: null, wait: false });
      const results = await Promise.allSettled(Array.from({ length: MAX_ACTIVE_JOBS_PER_CLUB + 4 }, make));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_ACTIVE_JOBS_PER_CLUB);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(4);
      for (const r of rejected) expect(r.reason).toMatchObject({ status: 429 });
      await db.delete(renderJobs).where(eq(renderJobs.clubId, other.clubId));
    });

    it("shows jobs to their requester and to documents:manage only, never across clubs", async () => {
      const mine = await jobOf(await generate(club.members.plain!, { templateId: "test-own", params: { clubMemberId: plainCm } }));
      const get = (who: Account, jobId: string, clubId = id()) => call(who, `/document-generation/jobs/${jobId}`, { clubId });
      expect((await get(club.members.plain!, mine.id)).status).toBe(200);
      expect((await get(club.founder, mine.id)).status).toBe(200);
      expect((await get(club.members.trainer!, mine.id)).status).toBe(404);
      expect((await get(other.founder, mine.id, other.clubId)).status).toBe(404);
      expect((await get(club.founder, "not-a-uuid")).status).toBe(404);
      const own = (await (await call(club.members.plain!, "/document-generation/jobs", { clubId: id() })).json()) as { data: Array<{ id: string }> };
      expect(own.data.map((j) => j.id)).toContain(mine.id);
      expect(own.data.length).toBeLessThanOrEqual(2);
      const all = (await (await call(club.founder, "/document-generation/jobs?status=fehlgeschlagen", { clubId: id() })).json()) as { data: Array<{ status: string }> };
      expect(all.data.length).toBeGreaterThan(0);
      expect(all.data.every((j) => j.status === "fehlgeschlagen")).toBe(true);
      expect((await call(other.founder, `/document-generation/jobs/${mine.id}/retry`, { method: "POST", clubId: other.clubId })).status).toBe(404);
    });

    it("refuses external guests", async () => {
      const guest = await (await import("../../routes/forms-test-support.js")).signUpAndVerify(`render-guest-${suffix}@example.com`, "Render Guest");
      club.userIds.push(guest.userId);
      await auth.api.addMember({ body: { userId: guest.userId, organizationId: id(), role: "guest" } });
      for (const p of ["/document-generation/templates", "/document-generation/jobs"]) expect((await call(guest, p, { clubId: id() })).status).toBe(403);
    });
  });
});
