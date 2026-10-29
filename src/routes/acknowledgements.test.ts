import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { documentAcknowledgements } from "../db/schema/documents.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { PDF_BYTES } from "../lib/media-fixtures.js";
import { getTemplate } from "../lib/pdf/registry.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { acknowledgementRoutes } from "./acknowledgements.js";
import { documentGenerationRoutes } from "./document-generation.js";
import { documentRoutes } from "./documents.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/** Wave 13 B11: acknowledgements -- request, answer (self, guardian for a child), re-authentication, expiry, paper proof, overview, export, proof PDF. */
const app = new Hono();
app.route("/acknowledgements", acknowledgementRoutes);
app.route("/documents", documentRoutes);
app.route("/document-generation", documentGenerationRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;
const yearsAgo = (n: number) => new Date(Date.now() - n * 365.25 * 86_400_000).toISOString().slice(0, 10);

describe("acknowledgements", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guardian: Account;
  let expiredGuardian: Account;
  let minorAccount: Account;
  let docId = "";
  let childCm = "";
  let paperCm = "";
  let minorCm = "";
  const id = () => club.clubId;

  const send = (who: Account, path: string, method: string, bodyJson?: unknown, clubId = id()) => call(who, path, { method, body: bodyJson, clubId });
  const get = (who: Account, path: string, clubId = id()) => call(who, path, { clubId });
  const accountMemberOf = async (a: Account) => (await db.query.member.findFirst({ where: (m, { and: a2, eq: e2 }) => a2(e2(m.organizationId, id()), e2(m.userId, a.userId)) }))!.id;
  const clubMemberOf = async (a: Account) => (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, await accountMemberOf(a)) }))!.id;
  const ackOf = async (clubMemberId: string) => (await db.select().from(documentAcknowledgements).where(and(eq(documentAcknowledgements.documentId, docId), eq(documentAcknowledgements.clubMemberId, clubMemberId))))[0]!;
  const mine = async (who: Account) => (await body(await get(who, "/acknowledgements/mine"))).data as Array<{ id: string; status: string; relation: string; canAnswer: boolean; personName: string }>;
  const join = async (label: string, role: "member" | "guest") => {
    const a = await signUpAndVerify(`ack-${label}-${suffix}@example.com`, `Ack ${label}`);
    club.userIds.push(a.userId);
    await auth.api.addMember({ body: { userId: a.userId, organizationId: id(), role } });
    return a;
  };

  beforeAll(async () => {
    registerBuiltinTemplates();
    club = await createClub("ack", suffix, { schrift: "schriftfuehrer", trainer: "trainer", plain: null, plain2: null });
    other = await createClub("acko", suffix);
    guardian = await join("guardian", "guest");
    expiredGuardian = await join("expguardian", "guest");
    minorAccount = await join("minor", "member");
    const [child] = await db.insert(clubMembers).values({ clubId: id(), displayName: "Kind Ohne Konto", birthDate: yearsAgo(9), joinedAt: "2024-01-01" }).returning();
    childCm = child!.id;
    await db.insert(guardianLinks).values({ guardianMemberId: await accountMemberOf(guardian), wardClubMemberId: childCm, confirmedAt: new Date() });
    await db.insert(guardianLinks).values({ guardianMemberId: await accountMemberOf(expiredGuardian), wardClubMemberId: childCm, confirmedAt: new Date(), validUntil: "2020-01-01" });
    const [paper] = await db.insert(clubMembers).values({ clubId: id(), displayName: "=cmd|calc Erwachsener", birthDate: yearsAgo(60), joinedAt: "2020-01-01" }).returning();
    paperCm = paper!.id;
    minorCm = await clubMemberOf(minorAccount);
    await db.update(clubMembers).set({ birthDate: yearsAgo(14) }).where(eq(clubMembers.id, minorCm));

    const form = new FormData();
    form.set("file", new File([new Uint8Array(PDF_BYTES)], "Hausordnung.pdf", { type: "application/pdf" }));
    form.set("title", "Hausordnung");
    const up = await call(club.founder, "/documents", { method: "POST", clubId: id(), form });
    expect(up.status).toBe(201);
    docId = (await body(up)).data.id;
  }, 90_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  describe("asking", () => {
    it("needs write access to the document; everybody else gets 404 and nothing is created", async () => {
      const req = { documentId: docId, audience: { all: true } };
      expect((await send(club.members.plain!, "/acknowledgements/requests", "POST", req)).status).toBe(404);
      expect((await send(club.members.trainer!, "/acknowledgements/requests", "POST", req)).status).toBe(404);
      expect((await send(other.founder, "/acknowledgements/requests", "POST", req, other.clubId)).status).toBe(404);
      expect((await send(club.founder, "/acknowledgements/requests", "POST", { documentId: "00000000-0000-4000-8000-000000000001", audience: { all: true } })).status).toBe(404);
      expect((await send(club.founder, "/acknowledgements/requests", "POST", { documentId: docId, audience: {} })).status).toBe(422);
      expect((await send(club.founder, "/acknowledgements/requests", "POST", { documentId: docId, audience: { clubMemberIds: ["00000000-0000-4000-8000-000000000001"] } })).status).toBe(422);
      expect((await send(club.founder, "/acknowledgements/requests", "POST", { documentId: docId, audience: { all: true }, dueAt: "2001-01-01" })).status).toBe(422);
      expect(await db.select().from(documentAcknowledgements).where(eq(documentAcknowledgements.clubId, id()))).toHaveLength(0);
    });

    it("asks every current member once per version, names the version hash, and repeats are skipped", async () => {
      const res = await send(club.members.schrift!, "/acknowledgements/requests", "POST", { documentId: docId, audience: { all: true }, requiresReauth: false });
      expect(res.status).toBe(201);
      const data = (await body(res)).data;
      // founder, schrift, trainer, plain, plain2, minor account, child, paper adult
      expect(data).toMatchObject({ created: 8, renewed: 0, skipped: 0, versionNo: 1 });
      expect(data.notice).toContain("keine qualifizierte");
      const row = await ackOf(childCm);
      expect(row).toMatchObject({ status: "offen", requiresReauth: false, clubId: id() });
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.wording).toContain("Hausordnung");
      const again = await body(await send(club.members.schrift!, "/acknowledgements/requests", "POST", { documentId: docId, audience: { all: true } }));
      expect(again.data).toMatchObject({ created: 0, renewed: 8, skipped: 0 });
    });
  });

  describe("answering", () => {
    it("a member sees only their own request, reads exactly that file and confirms; a repeat is idempotent, a change of mind is refused", async () => {
      const list = await mine(club.members.plain!);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ status: "offen", relation: "self", canAnswer: true });
      const ackId = list[0]!.id;
      const detail = await body(await get(club.members.plain!, `/acknowledgements/${ackId}`));
      expect(detail.data).toMatchObject({ documentTitle: "Hausordnung", versionNo: 1, canAnswer: true, isCurrentVersion: true });
      expect(detail.data.documentId).toBeNull();
      const file = await get(club.members.plain!, `/acknowledgements/${ackId}/document`);
      expect(file.status).toBe(200);
      expect(file.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await file.arrayBuffer()).toString("latin1", 0, 5)).toBe("%PDF-");
      // The same file is not reachable through the archive for this member.
      expect((await get(club.members.plain!, `/documents/${docId}/download`)).status).toBe(404);

      // Somebody else's request is not visible.
      expect((await get(club.members.plain2!, `/acknowledgements/${ackId}`)).status).toBe(404);
      expect((await send(club.members.plain2!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt" })).status).toBe(404);
      expect((await get(other.founder, `/acknowledgements/${ackId}`, other.clubId)).status).toBe(404);

      const ok = await send(club.members.plain!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt" });
      expect(ok.status).toBe(200);
      expect((await body(ok)).data).toMatchObject({ status: "bestaetigt", givenBy: "self", alreadyDone: false });
      const repeat = await send(club.members.plain!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt" });
      expect((await body(repeat)).data).toMatchObject({ status: "bestaetigt", alreadyDone: true });
      const change = await send(club.members.plain!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "abgelehnt" });
      expect(change.status).toBe(409);
      expect((await body(change)).error.details.code).toBe("already_answered");
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "acknowledgement.respond"), eq(auditLog.subjectId, await clubMemberOf(club.members.plain!))));
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0]!.payload)).not.toContain("Hausordnung");
    });

    it("parallel answers produce exactly one decision", async () => {
      const ackId = (await mine(club.members.plain2!))[0]!.id;
      const results = await Promise.all(Array.from({ length: 5 }, () => send(club.members.plain2!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "abgelehnt" })));
      expect(results.every((r) => r.status === 200)).toBe(true);
      const flags = await Promise.all(results.map(async (r) => (await body(r)).data.alreadyDone as boolean));
      expect(flags.filter((f) => !f)).toHaveLength(1);
      expect((await db.select().from(documentAcknowledgements).where(eq(documentAcknowledgements.id, ackId)))[0]!.status).toBe("abgelehnt");
    });

    it("a guardian answers for the child, the proof names the guardian; an expired link and a stranger see nothing", async () => {
      const list = await mine(guardian);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ relation: "guardian", canAnswer: true, personName: "Kind Ohne Konto" });
      expect(await mine(expiredGuardian)).toEqual([]);
      const ackId = list[0]!.id;
      expect((await send(expiredGuardian, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt" })).status).toBe(404);
      const ok = await send(guardian, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt" });
      expect(ok.status).toBe(200);
      expect((await body(ok)).data.givenBy).toBe("guardian");
      const row = await ackOf(childCm);
      expect(row).toMatchObject({ status: "bestaetigt", givenBy: "guardian", actedByUserId: guardian.userId });
      expect((await get(guardian, `/acknowledgements/${ackId}/document`)).status).toBe(200);
    });

    it("a minor with an account sees the request but cannot answer it", async () => {
      const list = await mine(minorAccount);
      expect(list[0]).toMatchObject({ relation: "self", canAnswer: false });
      const res = await send(minorAccount, `/acknowledgements/${list[0]!.id}/confirm`, "POST", { decision: "bestaetigt" });
      expect(res.status).toBe(403);
      expect((await body(res)).error.details.code).toBe("guardian_required");
    });

    it("asks for the password again when the request says so", async () => {
      const target = await clubMemberOf(club.members.trainer!);
      await send(club.founder, "/acknowledgements/requests", "POST", { documentId: docId, audience: { clubMemberIds: [target] }, requiresReauth: true });
      const ackId = (await mine(club.members.trainer!))[0]!.id;
      const none = await send(club.members.trainer!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt" });
      expect(none.status).toBe(403);
      expect((await body(none)).error.details.code).toBe("reauth_required");
      const wrong = await send(club.members.trainer!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt", password: "wrong-password-1" });
      expect((await body(wrong)).error.details.code).toBe("reauth_failed");
      expect((await ackOf(target)).status).toBe("offen");
      const ok = await send(club.members.trainer!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt", password: "test-password-123!" });
      expect(ok.status).toBe(200);
    });

    it("an expired request cannot be answered until the board renews it", async () => {
      const target = await clubMemberOf(club.members.schrift!);
      await db.update(documentAcknowledgements).set({ dueAt: new Date(Date.now() - 86_400_000) }).where(eq(documentAcknowledgements.id, (await ackOf(target)).id));
      const ackId = (await mine(club.members.schrift!))[0]!.id;
      expect((await mine(club.members.schrift!))[0]).toMatchObject({ status: "abgelaufen", canAnswer: false });
      const late = await send(club.members.schrift!, `/acknowledgements/${ackId}/confirm`, "POST", { decision: "bestaetigt" });
      expect(late.status).toBe(409);
      expect((await body(late)).error.details.code).toBe("expired");
      const tomorrow = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
      const renewed = await send(club.founder, "/acknowledgements/requests", "POST", { documentId: docId, audience: { clubMemberIds: [target] }, dueAt: tomorrow });
      expect((await body(renewed)).data).toMatchObject({ created: 0, renewed: 1 });
      expect((await mine(club.members.schrift!))[0]).toMatchObject({ status: "offen", canAnswer: true });
    });
  });

  describe("due date and constraints", () => {
    it("ends the due day at 23:59:59 in the club time zone, summer and winter time", async () => {
      const { endOfLocalDay } = await import("../lib/club-time.js");
      expect(endOfLocalDay("2026-07-15", "Europe/Berlin").toISOString()).toBe("2026-07-15T21:59:59.000Z");
      expect(endOfLocalDay("2026-12-15", "Europe/Berlin").toISOString()).toBe("2026-12-15T22:59:59.000Z");
      expect(endOfLocalDay("2026-03-28", "Europe/Berlin").toISOString()).toBe("2026-03-28T22:59:59.000Z");
      expect(endOfLocalDay("2026-03-29", "Europe/Berlin").toISOString()).toBe("2026-03-29T21:59:59.000Z");
      expect(endOfLocalDay("2026-07-15", "America/New_York").toISOString()).toBe("2026-07-16T03:59:59.000Z");
    });

    it("stores a request with that deadline and never stores the derived status abgelaufen", async () => {
      const day = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
      const target = minorCm; // still open: the request is renewed with the deadline
      const res = await send(club.founder, "/acknowledgements/requests", "POST", { documentId: docId, audience: { clubMemberIds: [target] }, dueAt: day });
      expect(res.status).toBe(201);
      const { endOfLocalDay } = await import("../lib/club-time.js");
      expect((await ackOf(target)).dueAt!.toISOString()).toBe(endOfLocalDay(day, "Europe/Berlin").toISOString());
      await expect(db.update(documentAcknowledgements).set({ status: "abgelaufen" }).where(eq(documentAcknowledgements.id, (await ackOf(target)).id))).rejects.toThrow();
    });
  });

  describe("board side", () => {
    it("records a paper proof for a person without account (date and source required, no future date), strangers get 404", async () => {
      const ackId = (await ackOf(paperCm)).id;
      const proof = { decision: "bestaetigt", proofDate: "2026-01-05", proofSource: "Unterschriftenliste Jahresversammlung" };
      expect((await send(club.members.plain!, `/acknowledgements/${ackId}/paper`, "POST", proof)).status).toBe(404);
      expect((await send(club.founder, `/acknowledgements/${ackId}/paper`, "POST", { ...proof, proofSource: "" })).status).toBe(422);
      expect((await send(club.founder, `/acknowledgements/${ackId}/paper`, "POST", { ...proof, proofDate: "2999-01-01" })).status).toBe(422);
      const ok = await send(club.founder, `/acknowledgements/${ackId}/paper`, "POST", proof);
      expect(ok.status).toBe(200);
      expect(await ackOf(paperCm)).toMatchObject({ status: "bestaetigt", givenBy: "board_paper", proofDate: "2026-01-05", actedByUserId: club.founder.userId });
      expect((await send(club.founder, `/acknowledgements/${ackId}/paper`, "POST", proof)).status).toBe(409);
    });

    it("gives the manager the overview with counts and the person's name, and nobody else", async () => {
      const res = await get(club.founder, `/acknowledgements?documentId=${docId}`);
      expect(res.status).toBe(200);
      const json = await body(res);
      expect(json.total).toBe(8);
      expect(json.summary.bestaetigt).toBeGreaterThanOrEqual(4);
      expect(json.summary.abgelehnt).toBe(1);
      const guardianRow = json.data.find((r: { personName: string }) => r.personName === "Kind Ohne Konto");
      expect(guardianRow).toMatchObject({ status: "bestaetigt", givenBy: "guardian", actedByName: "Ack guardian" });
      expect((await body(await get(club.founder, `/acknowledgements?documentId=${docId}&status=abgelehnt`))).total).toBe(1);
      expect((await get(club.members.plain!, `/acknowledgements?documentId=${docId}`)).status).toBe(404);
      expect((await body(await get(club.members.plain!, "/acknowledgements"))).total).toBe(0);
      expect((await get(club.members.trainer!, `/acknowledgements?documentId=${docId}`)).status).toBe(404);
      expect((await get(other.founder, `/acknowledgements?documentId=${docId}`, other.clubId)).status).toBe(404);
    });

    it("exports CSV with neutralised formulas, audited; a stranger gets 404", async () => {
      expect((await get(club.members.plain!, `/acknowledgements/export.csv?documentId=${docId}`)).status).toBe(404);
      const res = await get(club.founder, `/acknowledgements/export.csv?documentId=${docId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      const text = await res.text();
      expect(text).toContain("'=cmd|calc Erwachsener");
      expect(text).not.toMatch(/(^|;|\n)=cmd/);
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "acknowledgement.export"), eq(auditLog.subjectId, docId)));
      expect(audits).toHaveLength(1);
    });

    it("reminds only open requests, at most once a day", async () => {
      const first = await body(await send(club.founder, "/acknowledgements/remind", "POST", { documentId: docId }));
      expect(first.data.reminded).toBeGreaterThan(0);
      expect((await body(await send(club.founder, "/acknowledgements/remind", "POST", { documentId: docId }))).data.reminded).toBe(0);
      expect((await send(club.members.plain!, "/acknowledgements/remind", "POST", { documentId: docId })).status).toBe(404);
    });
  });

  describe("proof PDF", () => {
    it("is generated for the manager of the document and names the guardian who acted", async () => {
      const gen = (who: Account) => send(who, "/document-generation", "POST", { templateId: "bestaetigungsprotokoll", params: { documentId: docId } });
      const res = await gen(club.founder);
      expect(res.status).toBe(201);
      const job = (await body(res)).data;
      expect(job.status).toBe("fertig");
      expect((await get(club.founder, `/documents/${job.documentId}/download`)).status).toBe(200);
      // A plain member has no right to the template, a trainer (documents:generate) no write access to the document.
      expect((await gen(club.members.plain!)).status).toBe(403);
      expect((await gen(club.members.trainer!)).status).toBe(404);
      expect((await send(other.founder, "/document-generation", "POST", { templateId: "bestaetigungsprotokoll", params: { documentId: docId } }, other.clubId)).status).toBe(404);

      const built = await getTemplate("bestaetigungsprotokoll")!.build(id(), { documentId: docId });
      const data = built.data as { rows: Array<{ name: string; by: string; status: string }>; counts: Record<string, number>; sha256: string };
      expect(data.rows.find((r) => r.name === "Kind Ohne Konto")!.by).toBe("Erziehungsberechtigte(r): Ack guardian");
      expect(data.rows.find((r) => r.name.includes("Erwachsener"))!.by).toContain("Papiernachweis");
      expect(data.counts["bestaetigt"]).toBeGreaterThanOrEqual(4);
      expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
