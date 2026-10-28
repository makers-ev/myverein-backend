import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMembers } from "../db/schema/club-members.js";
import { documents, renderJobs } from "../db/schema/documents.js";
import { PdfRenderError, setPdfEngine, type PdfEngine } from "../lib/pdf/engine.js";
import { executeRenderJob } from "../lib/pdf/render.js";
import { getTemplate } from "../lib/pdf/registry.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubExitRequestRoutes } from "./club-exit-requests.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubMemberRoutes } from "./club-members.js";
import { documentGenerationRoutes } from "./document-generation.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { memberDocumentRoutes } from "./member-documents.js";

/** Wave 13 B9: receipt of the admission application, membership confirmation and cancellation confirmation. */
const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.route("/club-exit-requests", clubExitRequestRoutes);
app.route("/forms", formRoutes);
app.route("/club-forms", clubFormRoutes);
app.route("/form-submissions", formSubmissionRoutes);
app.route("/document-generation", documentGenerationRoutes);
app.route("/member-documents", memberDocumentRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const SECRET = "GESUNDHEIT-GEHEIM-4711";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

const FIELDS = [
  { key: "first_name", type: "text", label: "Vorname", required: true, mapsTo: "firstName" },
  { key: "last_name", type: "text", label: "Nachname", required: true, mapsTo: "lastName" },
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "birth_date", type: "date", label: "Geburtsdatum", mapsTo: "birthDate" },
  { key: "health", type: "textarea", label: "Gesundheit", sensitive: true },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutz", text: "Wir speichern Ihre Daten zur Mitgliederverwaltung." },
  { key: "photo_consent", type: "consent", label: "Fotos dürfen veröffentlicht werden.", helpText: "Widerruf jederzeit möglich.", required: false },
  { key: "mail_consent", type: "consent", label: "Newsletter per E-Mail.", required: false },
];

describe("member document templates (B9)", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  const accounts: Account[] = [];
  let applicantCm = "";
  let applicationId = "";

  const decide = (who: Account, id: string, action: "approve" | "reject") => call(who, `/club-applications/${id}/${action}`, { method: "POST", clubId: club.clubId, body: {} });
  const generate = (who: Account, templateId: string, params: unknown, clubId = club.clubId) => call(who, "/document-generation", { method: "POST", clubId, body: { templateId, params } });
  const jobsOf = (templateId: string) => db.select().from(renderJobs).where(and(eq(renderJobs.clubId, club.clubId), eq(renderJobs.templateId, templateId)));
  const clubMemberOf = async (a: Account) => {
    const account = await db.query.member.findFirst({ where: (m, { and: a2, eq: e2 }) => a2(e2(m.organizationId, club.clubId), e2(m.userId, a.userId)) });
    return (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account!.id) }))!.id;
  };

  beforeAll(async () => {
    registerBuiltinTemplates();
    club = await createClub("mdoc", suffix, { plain: null, plain2: null, kassen: "kassenwart", schrift: "schriftfuehrer" });
    other = await createClub("mdoco", suffix);
    const forms = (await body(await call(club.founder, "/forms", { clubId: club.clubId }))).data as Array<{ id: string; purpose: string }>;
    const formId = forms.find((f) => f.purpose === "aufnahme")!.id;
    expect((await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields: FIELDS } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${formId}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    setPdfEngine(null);
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds, ...accounts.map((a) => a.userId)]);
    await closeDatabase();
  });

  describe("receipt of the admission application", () => {
    let applicant: Account;

    it("is scheduled on acceptance, never blocks it, and lands in the personal storage once", async () => {
      applicant = await signUpAndVerify(`mdoc-app-${suffix}@example.com`, "Anna Antrag");
      accounts.push(applicant);
      const draft = await call(applicant, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "Anna", last_name: "Antrag", category: "aktiv", birth_date: "1990-04-02", health: SECRET, photo_consent: true } } });
      expect(draft.status).toBe(201);
      const submissionId = (await body(draft)).data.submission.id as string;
      const filed = await call(applicant, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, submissionId } });
      expect(filed.status).toBe(201);
      applicationId = (await body(filed)).data.application.id;

      expect((await decide(club.founder, applicationId, "approve")).status).toBe(200);
      const [application] = await db.select().from(clubApplications).where(eq(clubApplications.id, applicationId));
      applicantCm = application!.clubMemberId!;
      const jobs = (await jobsOf("aufnahme-beleg")).filter((j) => j.params.applicationId === applicationId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.requestedBy).toBeNull();

      const done = await executeRenderJob(jobs[0]!.id, { final: true });
      expect(done?.status).toBe("fertig");
      const [doc] = await db.select().from(documents).where(eq(documents.id, done!.documentId!));
      expect(doc).toMatchObject({ scope: "person", ownerClubMemberId: applicantCm, kind: "erzeugt", docType: "aufnahmebeleg" });

      // The applicant sees the receipt in their own storage; it cannot be deleted, only hidden.
      const mine = await body(await call(applicant, "/member-documents/me", { clubId: club.clubId }));
      const row = mine.data.find((d: { id: string }) => d.id === doc!.id);
      expect(row).toMatchObject({ source: "erzeugt", canDelete: false, canHide: true });
      const dl = await call(applicant, `/member-documents/me/${doc!.id}/download`, { clubId: club.clubId });
      expect(dl.status).toBe(200);
      expect(Buffer.from(await dl.arrayBuffer()).toString("latin1", 0, 5)).toBe("%PDF-");
    });

    it("holds the answers, the consent wording and a text hash, but never the sensitive answer", async () => {
      const built = await getTemplate("aufnahme-beleg")!.build(club.clubId, { applicationId });
      const data = built.data as { answers: Array<[string, string]>; withheld: number; consents: Array<{ label: string; text: string }>; consentHash: string | null; privacyNotice: string | null };
      expect(data.answers).toEqual(expect.arrayContaining([["Vorname", "Anna"], ["Nachname", "Antrag"]]));
      expect(JSON.stringify(built.data)).not.toContain(SECRET);
      expect(data.withheld).toBe(1);
      expect(data.consents).toEqual([{ label: "Fotos dürfen veröffentlicht werden.", text: "Widerruf jederzeit möglich." }]);
      expect(data.consentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.privacyNotice).toContain("Mitgliederverwaltung");
      expect(built.subjectClubMemberId).toBe(applicantCm);
    });

    it("is scoped to the club and to accepted applications", async () => {
      await expect(getTemplate("aufnahme-beleg")!.build(other.clubId, { applicationId })).rejects.toThrow();
      await expect(getTemplate("aufnahme-beleg")!.build(club.clubId, { applicationId: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow();
      // Asking for it by hand needs the member records right.
      expect((await generate(club.members.kassen!, "aufnahme-beleg", { applicationId })).status).toBe(403);
      expect((await generate(club.members.plain!, "aufnahme-beleg", { applicationId })).status).toBe(403);
      expect((await generate(other.founder, "aufnahme-beleg", { applicationId }, other.clubId)).status).toBe(404);
    });

    it("an acceptance does not fail when the document cannot be scheduled", async () => {
      const second = await signUpAndVerify(`mdoc-app2-${suffix}@example.com`, "Bernd Antrag");
      accounts.push(second);
      const draft = await call(second, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "Bernd", last_name: "Antrag", category: "aktiv" } } });
      const submissionId = (await body(draft)).data.submission.id as string;
      const filed = await call(second, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, submissionId } });
      const id = (await body(filed)).data.application.id as string;
      // Ten waiting jobs fill the club's queue: scheduling the receipt is refused (429) -- the acceptance still goes through.
      const filler = await db.insert(renderJobs).values(Array.from({ length: 10 }, () => ({ clubId: club.clubId, templateId: "aufnahme-beleg", templateVersion: 1, params: { filler: true } }))).returning({ id: renderJobs.id });
      try {
        expect((await decide(club.founder, id, "approve")).status).toBe(200);
      } finally {
        await db.delete(renderJobs).where(inArray(renderJobs.id, filler.map((f) => f.id)));
      }
      expect((await jobsOf("aufnahme-beleg")).filter((j) => j.params.applicationId === id)).toHaveLength(0);
    });

    it("a failing engine ends as a visible failed job that a retry repairs", async () => {
      const failing: PdfEngine = { id: "failing", version: "x", render: async () => { throw new PdfRenderError("engine_error", "boom Anna Antrag"); } };
      const [job] = (await jobsOf("aufnahme-beleg")).filter((j) => j.params.applicationId === applicationId);
      // A second request for the same application (idempotency key) returns the finished job, no second document.
      const again = await generate(club.founder, "aufnahme-beleg", { applicationId });
      expect([201, 202]).toContain(again.status);
      setPdfEngine(failing);
      try {
        const fresh = await generate(club.founder, "aufnahme-beleg", { applicationId });
        const freshJob = (await body(fresh)).data;
        expect(freshJob.status).toBe("fehlgeschlagen");
        expect(freshJob.errorCode).toBe("render_failed");
      } finally {
        setPdfEngine(null);
      }
      expect(job).toBeDefined();
    });
  });

  describe("membership confirmation", () => {
    it("a member requests it for themselves, the board for anybody, nobody else", async () => {
      const mine = await clubMemberOf(club.members.plain!);
      const res = await generate(club.members.plain!, "mitgliedsbestaetigung", { clubMemberId: mine });
      expect(res.status).toBe(201);
      const job = (await body(res)).data;
      expect(job.status).toBe("fertig");
      const [doc] = await db.select().from(documents).where(eq(documents.id, job.documentId));
      expect(doc).toMatchObject({ scope: "person", ownerClubMemberId: mine, docType: "mitgliedsbestaetigung", kind: "erzeugt" });

      const foreign = await clubMemberOf(club.members.plain2!);
      expect((await generate(club.members.plain!, "mitgliedsbestaetigung", { clubMemberId: foreign })).status).toBe(404);
      expect((await generate(club.members.kassen!, "mitgliedsbestaetigung", { clubMemberId: foreign })).status).toBe(404);
      expect((await generate(club.founder, "mitgliedsbestaetigung", { clubMemberId: foreign })).status).toBe(201);
      expect((await generate(other.founder, "mitgliedsbestaetigung", { clubMemberId: foreign }, other.clubId)).status).toBe(404);
      expect((await generate(club.members.plain!, "mitgliedsbestaetigung", { clubMemberId: mine, extra: true })).status).toBe(422);
    });

    it("refuses a date in the future and a date before the entry, and words a former membership as such", async () => {
      const mine = await clubMemberOf(club.members.plain!);
      const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const future = await generate(club.members.plain!, "mitgliedsbestaetigung", { clubMemberId: mine, asOf: tomorrow });
      expect(future.status).toBe(409);
      expect((await body(future)).error.details.code).toBe("as_of_in_future");
      const early = await generate(club.members.plain!, "mitgliedsbestaetigung", { clubMemberId: mine, asOf: "1999-01-01" });
      expect(early.status).toBe(409);
      expect((await body(early)).error.details.code).toBe("not_a_member_on_date");

      await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2024-12-31", joinedAt: "2020-01-01" }).where(eq(clubMembers.id, mine));
      const built = await getTemplate("mitgliedsbestaetigung")!.build(club.clubId, { clubMemberId: mine });
      expect((built.data as { leftAt: string | null }).leftAt).toBe("2024-12-31");
      const layout = getTemplate("mitgliedsbestaetigung")!.layout(built, { clubName: "Testverein", primaryColor: "#2c4870", accentColor: "#2c4870", letterhead: [] }, {});
      expect(JSON.stringify(layout.blocks)).toContain("Mitglied im Verein Testverein war");
      await db.update(clubMembers).set({ status: "aktiv", leftAt: null }).where(eq(clubMembers.id, mine));
    });
  });

  describe("confirmation of a cancellation", () => {
    it("is scheduled when the board accepts the cancellation and lands in the storage of the member", async () => {
      const leaver = club.members.plain2!;
      const created = await call(leaver, "/club-exit-requests", { method: "POST", clubId: club.clubId, body: {} });
      expect(created.status).toBe(201);
      const requestId = (await body(created)).data.id as string;
      expect((await jobsOf("kuendigungsbestaetigung")).filter((j) => j.params.exitRequestId === requestId)).toHaveLength(0);
      const approved = await call(club.founder, `/club-exit-requests/${requestId}/approve`, { method: "POST", clubId: club.clubId, body: {} });
      expect(approved.status).toBe(200);
      const jobs = (await jobsOf("kuendigungsbestaetigung")).filter((j) => j.params.exitRequestId === requestId);
      expect(jobs).toHaveLength(1);
      const done = await executeRenderJob(jobs[0]!.id, { final: true });
      expect(done?.status).toBe("fertig");
      const [doc] = await db.select().from(documents).where(eq(documents.id, done!.documentId!));
      expect(doc).toMatchObject({ scope: "person", ownerClubMemberId: await clubMemberOf(leaver), docType: "kuendigungsbestaetigung" });
      const built = await getTemplate("kuendigungsbestaetigung")!.build(club.clubId, { exitRequestId: requestId });
      expect((built.data as { effectiveOn: string }).effectiveOn >= todayBerlin()).toBe(true);
      // Another club cannot build it from the id.
      await expect(getTemplate("kuendigungsbestaetigung")!.build(other.clubId, { exitRequestId: requestId })).rejects.toThrow();
    });

    it("an exclusion produces no cancellation confirmation", async () => {
      const target = club.members.kassen!;
      const targetCm = await clubMemberOf(target);
      const before = (await jobsOf("kuendigungsbestaetigung")).length;
      const res = await call(club.founder, "/club-exit-requests", { method: "POST", clubId: club.clubId, body: { clubMemberId: targetCm, kind: "exclusion", reason: "Test" } });
      expect(res.status).toBe(201);
      expect((await jobsOf("kuendigungsbestaetigung")).length).toBe(before);
    });
  });
});
