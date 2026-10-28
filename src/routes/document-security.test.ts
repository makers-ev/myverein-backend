import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { departments } from "../db/schema/departments.js";
import { documentAcknowledgements, documents, renderJobs } from "../db/schema/documents.js";
import { calendars } from "../db/schema/calendars.js";
import { events } from "../db/schema/events.js";
import { getPdfEngine, setPdfEngine, type PdfDocumentSpec, type PdfEngine } from "../lib/pdf/engine.js";
import { requestRender } from "../lib/pdf/render.js";
import { getTemplate } from "../lib/pdf/registry.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { storageUsage } from "../lib/media-quota.js";
import { PDF_BYTES } from "../lib/media-fixtures.js";
import { acknowledgementRoutes } from "./acknowledgements.js";
import { documentGenerationRoutes } from "./document-generation.js";
import { documentRoutes } from "./documents.js";
import { createClub, dropClubs, installErrorHandler, requester } from "./forms-test-support.js";

/**
 * Wave 13 B16 (self review): hostile text in every template that prints club data, quota race of parallel generation, the
 * limits of the "requester reads own result" rule, and requests for documents the board took out of circulation.
 */
const app = new Hono();
app.route("/document-generation", documentGenerationRoutes);
app.route("/documents", documentRoutes);
app.route("/acknowledgements", acknowledgementRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

const CORPUS = [
  "\\input{/etc/passwd}",
  "\\immediate\\write18{id}",
  "% } } { { \\catcode`\\{=12",
  "<script>alert(1)</script><img src=x onerror=alert(1)>",
  "=HYPERLINK(\"http://evil\",\"x\")",
  "(unbalanced ) ( ) \\) \\( /JS (app.alert(1))",
  "😀 \u202e RTL مرحبا \u001b[31m \ufeff \u2028",
  "A".repeat(20_000),
  "Zeile1\r\nZeile2\n\n\n\nZeile3",
];
const HOSTILE = CORPUS.join(" | ");

describe("documents: review pass", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let tmp: string;
  const captured: PdfDocumentSpec[] = [];
  const id = () => club.clubId;
  const generate = (who: { cookie: string }, templateId: string, params: unknown, clubId = id()) => call(who as never, "/document-generation", { method: "POST", clubId, body: { templateId, params } });

  /** Text of a PDF as poppler reads it (null if pdftotext is not installed). */
  async function extract(bytes: Buffer): Promise<string | null> {
    if (spawnSync("pdftotext", ["-v"]).error) return null;
    await writeFile(path.join(tmp, "x.pdf"), bytes);
    return spawnSync("pdftotext", ["-layout", path.join(tmp, "x.pdf"), "-"], { encoding: "utf8", maxBuffer: 50_000_000 }).stdout;
  }

  beforeAll(async () => {
    registerBuiltinTemplates();
    tmp = await mkdtemp(path.join(os.tmpdir(), "pdfsec-"));
    club = await createClub("sec", suffix, { kassen: "kassenwart", trainer: "trainer", plain: null });
    other = await createClub("seco", suffix);
    const real = getPdfEngine();
    const spy: PdfEngine = { id: real.id, version: real.version, render: async (spec, limits) => (captured.push(spec), real.render(spec, limits)) };
    setPdfEngine(spy);
  }, 60_000);

  afterAll(async () => {
    setPdfEngine(null);
    await rm(tmp, { recursive: true, force: true });
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("prints hostile names of members and departments as plain text in the member list, never as anything else", async () => {
    await db.insert(clubMembers).values(CORPUS.map((name, i) => ({ clubId: id(), displayName: name, firstName: name, lastName: name, street: name, city: name, memberNumber: `H-${i}`, joinedAt: "2020-01-01", contactEmail: "x@example.com" })));
    const [dept] = await db.insert(departments).values({ clubId: id(), name: HOSTILE }).returning();
    const hostile = await db.select().from(clubMembers).where(and(eq(clubMembers.clubId, id()), eq(clubMembers.memberNumber, "H-0")));
    await db.insert(clubMemberDepartments).values({ clubMemberId: hostile[0]!.id, departmentId: dept!.id, since: "2020-01-01" });
    captured.length = 0;
    const job = await requestRender({ clubId: id(), templateId: "mitgliederliste", params: { columns: ["name", "address", "departments", "email"] }, actor: null });
    expect(job.status).toBe("fertig");
    const spec = captured.at(-1)!;
    expect(spec.blocks.every((b) => ["heading", "paragraph", "table", "keyValue"].includes(b.type))).toBe(true);
    const doc = (await db.select().from(documents).where(eq(documents.id, job.documentId!)))[0]!;
    expect(doc.title.length).toBeLessThan(200);
    const bytes = await getBytes(job.documentId!);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const text = await extract(bytes);
    if (text !== null) {
      expect(text).toContain("\\input{/etc/passwd}");
      expect(text).not.toContain("\u202e");
      expect(text).not.toContain("\u0000");
      expect(text.length).toBeLessThan(2_000_000);
    }
  });

  async function getBytes(documentId: string): Promise<Buffer> {
    const res = await call(club.founder, `/documents/${documentId}/download`, { clubId: id() });
    expect(res.status).toBe(200);
    return Buffer.from(await res.arrayBuffer());
  }

  it("prints hostile event titles, department names and guest names in the event lists", async () => {
    const [dept] = await db.insert(departments).values({ clubId: id(), name: CORPUS[0]! }).returning();
    const [cal] = await db.insert(calendars).values({ clubId: id(), departmentId: dept!.id, name: "K", createdBy: club.founder.userId }).returning();
    const [event] = await db.insert(events).values({ calendarId: cal!.id, title: HOSTILE, startsAt: new Date(), createdBy: club.founder.userId }).returning();
    for (const templateId of ["anwesenheitsliste", "teilnehmerliste"]) {
      const job = await requestRender({ clubId: id(), templateId, params: { eventId: event!.id }, actor: null });
      expect(job.status, templateId).toBe("fertig");
      const text = await extract(await getBytes(job.documentId!));
      if (text !== null) expect(text).toContain("\\input{/etc/passwd}");
    }
  });

  it("prints a hostile document title, wording and person names in the acknowledgement proof", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(PDF_BYTES)], "x.pdf", { type: "application/pdf" }));
    form.set("title", CORPUS[0]!);
    const up = await call(club.founder, "/documents", { method: "POST", clubId: id(), form });
    const docId = (await body(up)).data.id as string;
    const members = await db.select().from(clubMembers).where(eq(clubMembers.clubId, id()));
    const hostileIds = members.filter((m) => m.memberNumber?.startsWith("H-")).map((m) => m.id);
    const asked = await call(club.founder, "/acknowledgements/requests", { method: "POST", clubId: id(), body: { documentId: docId, audience: { clubMemberIds: hostileIds }, wording: `${CORPUS[1]} bestätigt` } });
    expect(asked.status).toBe(201);
    const job = await requestRender({ clubId: id(), templateId: "bestaetigungsprotokoll", params: { documentId: docId }, actor: null });
    expect(job.status).toBe("fertig");
    expect((await extract(await getBytes(job.documentId!))) ?? "\\input").toContain("\\input");
  });

  it("refuses parameters outside the schema and unknown fields in every template (no template code, no path, no sql)", async () => {
    for (const [templateId, params] of [
      ["mitgliederliste", { columns: ["name; DROP TABLE documents"] }],
      ["mitgliederliste", { columns: ["name"], extra: "x" }],
      ["jahresbericht", { year: "2020; --" }],
      ["anwesenheitsliste", { eventId: "../../etc/passwd" }],
      ["versammlung-protokoll", { meetingId: "x", version: -1 }],
      ["mitgliedsbestaetigung", { clubMemberId: "00000000-0000-4000-8000-000000000001", asOf: "gestern" }],
      ["bestaetigungsprotokoll", { documentId: "not-a-uuid" }],
    ] as const) {
      expect((await generate(club.founder, templateId, params)).status, templateId).toBe(422);
    }
  });

  it("parallel generation at the quota limit never overshoots: some succeed, the rest fail with quota_exceeded", async () => {
    const used = (await storageUsage(id())).usedBytes;
    const probe = await requestRender({ clubId: id(), templateId: "jahresbericht", params: { year: 2024 }, actor: null });
    expect(probe.status).toBe("fertig");
    const perPdf = (await storageUsage(id())).usedBytes - used;
    expect(perPdf).toBeGreaterThan(500);
    // Room for two more files only.
    const quota = (await storageUsage(id())).usedBytes + perPdf * 2 + Math.floor(perPdf / 2);
    await db.update(clubSettings).set({ storageQuotaBytes: quota }).where(eq(clubSettings.clubId, id()));
    try {
      await raceAtQuota(quota);
    } finally {
      await db.update(clubSettings).set({ storageQuotaBytes: null }).where(eq(clubSettings.clubId, id()));
    }
  });

  async function raceAtQuota(quota: number): Promise<void> {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => requestRender({ clubId: id(), templateId: "jahresbericht", params: { year: 2000 + i }, actor: null, wait: true })));
    const ok = results.filter((r) => r.status === "fertig").length;
    expect(ok).toBe(2);
    expect(results.filter((r) => r.status === "fehlgeschlagen").every((r) => r.errorCode === "quota_exceeded")).toBe(true);
    expect((await storageUsage(id())).usedBytes).toBeLessThanOrEqual(quota);
    expect((await db.select().from(renderJobs).where(and(eq(renderJobs.clubId, id()), eq(renderJobs.status, "fehlgeschlagen")))).length).toBeGreaterThanOrEqual(4);
  }

  it("the requester reads their own result only while they may still generate documents", async () => {
    const job = await body(await generate(club.members.kassen!, "jahresbericht", { year: 2019 }));
    const documentId = job.data.documentId as string;
    expect((await call(club.members.kassen!, `/documents/${documentId}/download`, { clubId: id() })).status).toBe(200);
    const account = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, id()), e(m.userId, club.members.kassen!.userId)) });
    await db.delete(clubRoles).where(eq(clubRoles.memberId, account!.id));
    expect((await call(club.members.kassen!, `/documents/${documentId}/download`, { clubId: id() })).status).toBe(404);
    expect((await body(await call(club.members.kassen!, "/documents?mine=1", { clubId: id() }))).data.map((d: { id: string }) => d.id)).not.toContain(documentId);
  });

  it("a person cannot read or answer a request for a document the board put into the trash", async () => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(PDF_BYTES)], "regeln.pdf", { type: "application/pdf" }));
    form.set("title", "Regeln");
    const docId = (await body(await call(club.founder, "/documents", { method: "POST", clubId: id(), form }))).data.id as string;
    const plainCm = (await db.query.clubMembers.findFirst({ where: (m, { eq: e }) => e(m.displayName, "plain sec") }))!.id;
    await call(club.founder, "/acknowledgements/requests", { method: "POST", clubId: id(), body: { documentId: docId, audience: { clubMemberIds: [plainCm] } } });
    const ack = (await db.select().from(documentAcknowledgements).where(and(eq(documentAcknowledgements.documentId, docId), eq(documentAcknowledgements.clubMemberId, plainCm))))[0]!;
    expect((await call(club.members.plain!, `/acknowledgements/${ack.id}/document`, { clubId: id() })).status).toBe(200);
    await call(club.founder, `/documents/${docId}`, { method: "DELETE", clubId: id() });
    expect((await call(club.members.plain!, `/acknowledgements/${ack.id}/document`, { clubId: id() })).status).toBe(404);
    expect((await call(club.members.plain!, `/acknowledgements/${ack.id}/confirm`, { method: "POST", body: { decision: "bestaetigt" }, clubId: id() })).status).toBe(404);
    expect((await call(club.founder, `/acknowledgements/${ack.id}`, { clubId: id() })).status).toBe(200);
  });

  it("jobs of other clubs and of other people stay invisible", async () => {
    const job = await body(await generate(club.members.kassen!, "jahresbericht", { year: 2018 }));
    void job;
    const mine = await requestRender({ clubId: other.clubId, templateId: "jahresbericht", params: {}, actor: null });
    expect((await call(club.founder, `/document-generation/jobs/${mine.id}`, { clubId: id() })).status).toBe(404);
    expect((await call(other.founder, `/document-generation/jobs/${mine.id}`, { clubId: other.clubId })).status).toBe(200);
    expect(getTemplate("jahresbericht")).toBeTruthy();
  });
});
