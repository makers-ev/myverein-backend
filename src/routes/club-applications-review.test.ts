import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { member } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMembers } from "../db/schema/club-members.js";
import { formSubmissionFiles, formSubmissions, formVersions, memberFieldDefinitions } from "../db/schema/forms.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { eraseFormDataOfMember } from "../lib/form-retention.js";
import { lazyCleanup, resetLazyCleanup, settleLazyCleanups, sweepRejectedChildAnswers } from "../lib/form-sweeper.js";
import { logger } from "../lib/logger.js";
import { makePng, PDF_BYTES } from "../lib/media-fixtures.js";
import { purgeMediaFile } from "../lib/media.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubMemberRoutes } from "./club-members.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { memberFieldRoutes } from "./member-fields.js";

/**
 * Review API and hygiene (Wave 8 B10) against a real Postgres: summary in the list, full answers rendered against the ORIGINAL
 * version, mapping preview (allowlist only), files with the authenticated retrieval path, consent evidence, duplicate hint,
 * sensitive answers and files, IDOR, retention / lazy cleanup, the anonymisation hook and privacy (no values in logs / audit).
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.route("/forms", formRoutes);
app.route("/club-forms", clubFormRoutes);
app.route("/form-submissions", formSubmissionRoutes);
app.route("/member-fields", memberFieldRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const SECRET = "GESUNDHEIT-GEHEIM-4711";
const DAY = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

const FIELDS = [
  { key: "first_name", type: "text", label: "Vorname", required: true, mapsTo: "firstName" },
  { key: "last_name", type: "text", label: "Nachname", required: true, mapsTo: "lastName" },
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "birth_date", type: "date", label: "Geburtsdatum", mapsTo: "birthDate" },
  { key: "email", type: "text", label: "E-Mail", mapsTo: "contactEmail", validation: { pattern: "email" } },
  { key: "shirt", type: "select", label: "Trikotgröße", options: [{ value: "s", label: "Klein" }, { value: "m", label: "Mittel" }], customField: "shirt_size" },
  { key: "health", type: "textarea", label: "Gesundheit", sensitive: true },
  { key: "note", type: "textarea", label: "Anmerkung" },
  { key: "photo", type: "image", label: "Foto", mapsTo: "photo" },
  { key: "attest", type: "file", label: "Attest", sensitive: true },
  { key: "zeugnis", type: "file", label: "Zeugnis" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutz" },
  { key: "privacy_consent", type: "consent", label: "Ich willige ein.", required: true },
];
const answersOf = (over: Record<string, unknown> = {}) => ({ first_name: "Anna", last_name: "Review", category: "passiv", birth_date: "1990-04-02", email: "anna.review@example.com", shirt: "m", health: SECRET, note: "Hallo", privacy_consent: true, ...over });

describe("application review API and hygiene (B10)", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let formId: string;
  const accounts: Account[] = [];
  const logged: unknown[][] = [];

  const newUser = async (label: string, name?: string) => {
    const acc = await signUpAndVerify(`rev-${label}-${suffix}@example.com`, name ?? `Review ${label}`);
    accounts.push(acc);
    return acc;
  };
  const list = (who: Account, target = club) => call(who, "/club-applications", { clubId: target.clubId });
  const detail = (who: Account, id: string, target = club) => call(who, `/club-applications/${id}`, { clubId: target.clubId });
  const decide = (who: Account, id: string, action: "approve" | "reject", payload?: unknown) => call(who, `/club-applications/${id}/${action}`, { method: "POST", clubId: club.clubId, body: payload });
  const upload = (who: Account, submissionId: string, fieldKey: string, kind: "png" | "pdf") => {
    const fd = new FormData();
    fd.append("file", kind === "png" ? new File([new Uint8Array(makePng())], "foto.png", { type: "image/png" }) : new File([new Uint8Array(PDF_BYTES)], "attest-vertraulich.pdf", { type: "application/pdf" }));
    fd.append("fieldKey", fieldKey);
    return call(who, `/form-submissions/${submissionId}/files`, { method: "POST", form: fd });
  };
  /** Files an application: draft -> optional files -> apply with the draft. */
  const fileApplication = async (who: Account, answers: Record<string, unknown>, opts: { files?: Array<[string, "png" | "pdf"]>; onBehalfOf?: "guardian" } = {}) => {
    const draft = await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers, ...(opts.onBehalfOf ? { onBehalfOf: opts.onBehalfOf } : {}) } });
    expect(draft.status, await draft.clone().text()).toBe(201);
    const submissionId = (await body(draft)).data.submission.id as string;
    for (const [key, kind] of opts.files ?? []) expect((await upload(who, submissionId, key, kind)).status).toBe(201);
    const filed = await call(who, "/club-members/apply", { method: "POST", body: { clubSlug: club.slug, submissionId } });
    expect(filed.status, await filed.clone().text()).toBe(201);
    return { applicationId: (await body(filed)).data.application.id as string, submissionId };
  };

  beforeAll(async () => {
    club = await createClub("rev", suffix, { schriftfuehrer: "schriftfuehrer", plain: null });
    other = await createClub("revo", suffix);
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
    expect(
      (await call(club.founder, "/member-fields", { method: "POST", clubId: club.clubId, body: { key: "shirt_size", label: "Trikotgröße", type: "select", options: [{ value: "s", label: "Klein" }, { value: "m", label: "Mittel" }] } })).status,
    ).toBe(201);
    const forms1 = (await body(await call(club.founder, "/forms", { clubId: club.clubId }))).data as Array<{ id: string; purpose: string }>;
    formId = forms1.find((f) => f.purpose === "aufnahme")!.id;
    expect((await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields: FIELDS } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${formId}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds, ...accounts.map((a) => a.userId)]);
    await closeDatabase();
  });

  // --- rights --------------------------------------------------------------------------------------------------

  it("is for the board only and scoped to the club (IDOR)", async () => {
    const who = await newUser("rights");
    const { applicationId } = await fileApplication(who, answersOf());
    expect((await list(club.members.plain!)).status).toBe(403);
    expect((await detail(club.members.plain!, applicationId)).status).toBe(403);
    // The applicant is no member of the club: indistinguishable from an unknown club.
    expect((await list(who)).status).toBe(404);
    expect((await detail(who, applicationId)).status).toBe(404);
    expect((await app.request(`/club-applications/${applicationId}?clubId=${club.clubId}`)).status).toBe(401);
    expect((await detail(club.members.schriftfuehrer!, applicationId)).status).toBe(200);
    // Another club's board, malformed and unknown ids: all the same 404.
    expect((await detail(other.founder, applicationId, other)).status).toBe(404);
    expect((await detail(club.founder, "not-a-uuid")).status).toBe(404);
    expect((await detail(club.founder, "00000000-0000-4000-8000-000000000001")).status).toBe(404);
    // The other club's queue does not list it.
    const foreign = (await body(await list(other.founder, other))).data as Array<{ id: string }>;
    expect(foreign.find((a) => a.id === applicationId)).toBeUndefined();
  });

  // --- list ----------------------------------------------------------------------------------------------------

  it("lists a short summary: labels as of the version, no sensitive answers, file count, consent, subject name", async () => {
    const who = await newUser("list", "Konto Name");
    const { applicationId } = await fileApplication(who, answersOf(), { files: [["photo", "png"], ["zeugnis", "pdf"]] });
    const res = await list(club.founder);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const row = (JSON.parse(text).data as Array<Record<string, unknown>>).find((a) => a.id === applicationId)!;
    expect(row).toMatchObject({ legacy: false, onBehalfOf: "self", subjectName: "Anna Review", fileCount: 2, consentGiven: true, name: "Konto Name" });
    expect(row.summary).toEqual([
      { key: "first_name", label: "Vorname", display: "Anna" },
      { key: "last_name", label: "Nachname", display: "Review" },
      { key: "category", label: "Mitgliedschaft", display: "Passiv" },
      // birth date, address, phone and emergency contact are protected (members:read_sensitive) and never part of a summary
      { key: "email", label: "E-Mail", display: "anna.review@example.com" },
    ]);
    // A legacy row (before the form builder) has no summary and keeps its shape.
    const legacyUser = await newUser("legacy");
    const [legacy] = await db.insert(clubApplications).values({ userId: legacyUser.userId, clubId: club.clubId, category: "jugend", birthDate: "2010-04-05" }).returning();
    const legacyRow = ((await body(await list(club.founder))).data as Array<Record<string, unknown>>).find((a) => a.id === legacy!.id)!;
    expect(legacyRow).toMatchObject({ legacy: true, summary: [], fileCount: 0, consentGiven: null, subjectName: "Review legacy" });
  });

  // --- detail --------------------------------------------------------------------------------------------------

  it("shows the full answers against the original version, with mapping preview, files, consent and the retrieval path", async () => {
    const who = await newUser("detail", "Anna Konto");
    const { applicationId, submissionId } = await fileApplication(who, answersOf(), { files: [["photo", "png"], ["zeugnis", "pdf"], ["attest", "pdf"]] });
    const res = await detail(club.founder, applicationId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.text();
    const data = JSON.parse(text).data;
    expect(data.application).toMatchObject({ id: applicationId, status: "pending", onBehalfOf: "self", legacy: false });
    expect(data.applicant).toMatchObject({ name: "Anna Konto", email: `rev-detail-${suffix}@example.com` });
    expect(data.subject).toMatchObject({ displayName: "Anna Review", birthDate: "1990-04-02", isMinor: false });
    expect(data.form).toMatchObject({ version: 2, purpose: "aufnahme" });
    expect(data.answersRetained).toBe(true);
    const byKey = Object.fromEntries((data.answers as Array<{ key: string }>).map((a) => [a.key, a]));
    expect(Object.keys(byKey)).toEqual(["first_name", "last_name", "category", "birth_date", "email", "shirt", "health", "note", "privacy_consent"]);
    expect(byKey.category).toMatchObject({ value: "passiv", display: "Passiv", label: "Mitgliedschaft" });
    expect(byKey.shirt).toMatchObject({ value: "m", display: "Mittel" });
    expect(byKey.health).toMatchObject({ value: SECRET, redacted: false, sensitive: true });
    expect(byKey.privacy_consent).toMatchObject({ value: true });

    // Mapping preview: allowlist only, "wird übernommen als …".
    expect(data.mapping.preview).toBe(true);
    const mapping = Object.fromEntries((data.mapping.entries as Array<{ fieldKey: string }>).map((m) => [m.fieldKey, m]));
    expect(mapping.first_name).toMatchObject({ kind: "master", target: "firstName", text: "wird übernommen als Vorname", willApply: true });
    expect(mapping.email).toMatchObject({ target: "contactEmail", text: "wird übernommen als Kontakt-E-Mail", willApply: true });
    expect(mapping.category).toMatchObject({ kind: "category", target: "category", willApply: true });
    expect(mapping.photo).toMatchObject({ kind: "photo", target: "photo", text: "wird übernommen als Profilfoto", willApply: true });
    expect(mapping.shirt).toMatchObject({ kind: "custom", customFieldKey: "shirt_size", text: "wird übernommen als Zusatzfeld „Trikotgröße“", willApply: true });
    expect(mapping.health).toBeUndefined();
    expect(mapping.note).toBeUndefined();

    // Files: ids, names, kinds and the authenticated retrieval path -- never a storage key or a ready-made URL.
    expect(data.files).toHaveLength(3);
    const photo = data.files.find((f: { fieldKey: string }) => f.fieldKey === "photo");
    expect(photo).toMatchObject({ kind: "image", filename: "foto.png", mimeType: "image/png", redacted: false, path: `/form-submissions/${submissionId}/files/${photo.id}` });
    expect(text).not.toMatch(/forms\/[A-Za-z0-9]+\/[0-9a-f-]{36}\//);
    expect(text).not.toContain("http");
    // The path works for the board (and is audited by the file route).
    const fetched = await call(club.founder, photo.path);
    expect(fetched.status).toBe(200);
    expect((await call(club.founder, data.files.find((f: { fieldKey: string }) => f.fieldKey === "zeugnis").path)).status).toBe(200);

    // Consent evidence: who, when, which text.
    const sub = (await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) }))!;
    expect(data.consent).toMatchObject({ consentedBy: who.userId, role: "self", onBehalfOf: "self", consentFieldKeys: ["privacy_consent"], consentedAt: sub.submittedAt!.toISOString(), givenBy: { userId: who.userId, name: "Anna Konto" }, privacyNoticeShown: true });
    expect(data.consent.fields).toEqual([{ key: "privacy_consent", label: "Ich willige ein.", given: true }]);
    expect(data.consent.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.decision).toBeNull();
    expect(data.warnings).toEqual([]);
  });

  it("renders against the ORIGINAL version after the form changed, and tolerates an archived custom field in the preview", async () => {
    const who = await newUser("orig");
    const { applicationId } = await fileApplication(who, answersOf({ first_name: "Alt" }));
    // Publish v3 with other labels and options.
    const changed = FIELDS.map((f) => (f.key === "first_name" ? { ...f, label: "Rufname NEU" } : f.key === "shirt" ? { ...f, options: [{ value: "s", label: "Klein NEU" }, { value: "m", label: "Mittel NEU" }] } : f));
    expect((await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields: changed } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${formId}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);
    const data = (await body(await detail(club.founder, applicationId))).data;
    expect(data.form.version).toBe(2);
    const answers = Object.fromEntries((data.answers as Array<{ key: string }>).map((a) => [a.key, a]));
    expect(answers.first_name).toMatchObject({ label: "Vorname", display: "Alt" });
    expect(answers.shirt).toMatchObject({ display: "Mittel" });

    // The custom field is archived afterwards: the preview says so instead of promising a write.
    await db.update(memberFieldDefinitions).set({ archivedAt: new Date() }).where(and(eq(memberFieldDefinitions.clubId, club.clubId), eq(memberFieldDefinitions.key, "shirt_size")));
    const archived = (await body(await detail(club.founder, applicationId))).data.mapping.entries.find((m: { fieldKey: string }) => m.fieldKey === "shirt");
    expect(archived).toMatchObject({ willApply: false, reason: "custom_field_archived" });
    await db.update(memberFieldDefinitions).set({ archivedAt: null }).where(and(eq(memberFieldDefinitions.clubId, club.clubId), eq(memberFieldDefinitions.key, "shirt_size")));
  });

  it("never names a column that is not on the allowlist, even if a stored definition does", async () => {
    const who = await newUser("tamper");
    const { applicationId, submissionId } = await fileApplication(who, answersOf());
    const sub = (await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) }))!;
    const version = (await db.query.formVersions.findFirst({ where: eq(formVersions.id, sub.formVersionId) }))!;
    const tampered = (version.fields as Array<Record<string, unknown>>).map((f) => (f.key === "note" ? { ...f, mapsTo: "member_id" } : f));
    // A scratch version row so the shared one stays intact.
    const [copy] = await db.insert(formVersions).values({ formId: version.formId, version: 999, status: "archived", fields: tampered, privacyNotice: version.privacyNotice }).returning();
    await db.update(formSubmissions).set({ formVersionId: copy!.id }).where(eq(formSubmissions.id, submissionId));
    const text = await (await detail(club.founder, applicationId)).text();
    const entry = (JSON.parse(text).data.mapping.entries as Array<{ fieldKey: string }>).find((m) => m.fieldKey === "note");
    expect(entry).toMatchObject({ kind: "none", target: null, text: null, willApply: false, reason: "unknown_target" });
    expect(text).not.toContain("member_id");
    await db.update(formSubmissions).set({ formVersionId: version.id }).where(eq(formSubmissions.id, submissionId));
    await db.delete(formVersions).where(eq(formVersions.id, copy!.id));
  });

  // --- sensitive -----------------------------------------------------------------------------------------------

  it("redacts sensitive answers and files without members:read_sensitive, and audits every delivery of them", async () => {
    const who = await newUser("sens");
    const { applicationId, submissionId } = await fileApplication(who, answersOf(), { files: [["attest", "pdf"], ["zeugnis", "pdf"]] });
    const sub = (await body(await detail(club.members.schriftfuehrer!, applicationId))).data;
    expect(JSON.stringify(sub)).not.toContain(SECRET);
    expect(sub.answers.find((a: { key: string }) => a.key === "health")).toMatchObject({ redacted: true, value: null, display: null, sensitive: true });
    const attest = sub.files.find((f: { fieldKey: string }) => f.fieldKey === "attest");
    expect(attest).toMatchObject({ redacted: true, filename: null, path: null, mimeType: null });
    const zeugnis = sub.files.find((f: { fieldKey: string }) => f.fieldKey === "zeugnis");
    expect(zeugnis.redacted).toBe(false);
    // The file route follows: the Schriftführer gets 403 for the sensitive file, the founder the bytes.
    expect((await call(club.members.schriftfuehrer!, `/form-submissions/${submissionId}/files/${attest.id}`)).status).toBe(403);
    expect((await call(club.members.schriftfuehrer!, zeugnis.path)).status).toBe(200);
    expect((await call(club.founder, `/form-submissions/${submissionId}/files/${attest.id}`)).status).toBe(200);
    // Strangers still see nothing at all.
    expect((await call(club.members.plain!, `/form-submissions/${submissionId}/files/${attest.id}`)).status).toBe(404);

    const before = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_application.sensitive_read"), eq(auditLog.subjectId, applicationId)));
    expect(before).toHaveLength(0);
    const full = await body(await detail(club.founder, applicationId));
    expect(full.data.answers.find((a: { key: string }) => a.key === "health").value).toBe(SECRET);
    expect(full.data.files.find((f: { fieldKey: string }) => f.fieldKey === "attest")).toMatchObject({ redacted: false, filename: "attest-vertraulich.pdf" });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_application.sensitive_read"), eq(auditLog.subjectId, applicationId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ clubId: club.clubId, fieldKeys: ["birth_date", "health"] });
    expect(JSON.stringify(audits[0]!.payload)).not.toContain(SECRET);
  });

  // --- duplicates ----------------------------------------------------------------------------------------------

  it("hints at existing members with the same name and birth date or e-mail -- id and display name only", async () => {
    const [byName] = await db.insert(clubMembers).values({ clubId: club.clubId, displayName: "Dora Dublette", birthDate: "1985-05-05", memberNumber: "DUP-1", status: "aktiv", joinedAt: "2020-01-01" }).returning();
    const [byMail] = await db.insert(clubMembers).values({ clubId: club.clubId, displayName: "Ganz Anders", contactEmail: "dora.mail@example.com", memberNumber: "DUP-2", status: "aktiv", joinedAt: "2020-01-01", street: "Geheimstraße 1" }).returning();
    const [namesakeOtherBirth] = await db.insert(clubMembers).values({ clubId: club.clubId, displayName: "Dora Dublette", birthDate: "1999-09-09", memberNumber: "DUP-3", status: "aktiv", joinedAt: "2020-01-01" }).returning();
    const who = await newUser("dup");
    const { applicationId } = await fileApplication(who, answersOf({ first_name: "dora", last_name: "DUBLETTE", birth_date: "1985-05-05", email: "dora.mail@example.com" }));
    const text = await (await detail(club.founder, applicationId)).text();
    const dups = JSON.parse(text).data.duplicates as Array<Record<string, unknown>>;
    expect(dups.map((d) => d.clubMemberId).sort()).toEqual([byName!.id, byMail!.id].sort());
    expect(dups.find((d) => d.clubMemberId === byName!.id)).toEqual({ clubMemberId: byName!.id, displayName: "Dora Dublette", matches: ["name_birth_date"] });
    expect(dups.find((d) => d.clubMemberId === byMail!.id)).toEqual({ clubMemberId: byMail!.id, displayName: "Ganz Anders", matches: ["email"] });
    expect(dups.some((d) => d.clubMemberId === namesakeOtherBirth!.id)).toBe(false);
    expect(text).not.toContain("Geheimstraße");
    expect(text).not.toContain("DUP-");
    // Another club's members are never matched.
    await db.insert(clubMembers).values({ clubId: other.clubId, displayName: "Dora Dublette", birthDate: "1985-05-05", memberNumber: "DUP-9", status: "aktiv", joinedAt: "2020-01-01" });
    expect(JSON.parse(await (await detail(club.founder, applicationId)).text()).data.duplicates).toHaveLength(2);
    // A decided application has no duplicate hint any more.
    expect((await decide(club.founder, applicationId, "reject", { applicantMessage: "Nein" })).status).toBe(200);
    expect((await body(await detail(club.founder, applicationId))).data.duplicates).toEqual([]);
  });

  // --- child application -----------------------------------------------------------------------------------------

  it("shows a child application for the child, names the guardian as the consenting person and warns about the age", async () => {
    const parent = await newUser("kid", "Elternteil Kind");
    const { applicationId } = await fileApplication(parent, answersOf({ first_name: "Klein", last_name: "Kind", birth_date: "2016-03-04", email: `rev-kid-${suffix}@example.com` }), { onBehalfOf: "guardian" });
    const data = (await body(await detail(club.founder, applicationId))).data;
    expect(data.application.onBehalfOf).toBe("guardian");
    expect(data.applicant.name).toBe("Elternteil Kind");
    expect(data.subject).toMatchObject({ displayName: "Klein Kind", birthDate: "2016-03-04", isMinor: true });
    expect(data.consent).toMatchObject({ role: "guardian", onBehalfOf: "guardian", consentedBy: parent.userId, givenBy: { name: "Elternteil Kind" } });
    expect(data.warnings).toEqual([]);
    const listed = ((await body(await list(club.founder))).data as Array<Record<string, unknown>>).find((a) => a.id === applicationId)!;
    expect(listed).toMatchObject({ onBehalfOf: "guardian", subjectName: "Klein Kind" });
    // The parent's e-mail is not taken as a duplicate of a member that has it.
    expect(data.duplicates.every((d: { matches: string[] }) => !d.matches.includes("email"))).toBe(true);
    const adult = await fileApplication(parent, answersOf({ first_name: "Gross", last_name: "Kind", birth_date: "1990-01-01" }), { onBehalfOf: "guardian" });
    expect((await body(await detail(club.founder, adult.applicationId))).data.warnings).toEqual(["child_is_adult"]);
  });

  // --- retention and lazy cleanup ----------------------------------------------------------------------------------

  it("cleans up lazily in the scope of whoever touches it: own stale drafts, the club's overdue rejected files", async () => {
    resetLazyCleanup();
    // Stale drafts: A's is removed when A looks at their submissions, B's stays.
    const a = await newUser("lazya");
    const b = await newUser("lazyb");
    const draftOf = async (who: Account) => {
      const id = (await body(await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "Alt" } } }))).data.submission.id as string;
      expect((await upload(who, id, "zeugnis", "pdf")).status).toBe(201);
      await db.update(formSubmissions).set({ updatedAt: new Date(Date.now() - 40 * DAY) }).where(eq(formSubmissions.id, id));
      return id;
    };
    const draftA = await draftOf(a);
    const draftB = await draftOf(b);
    resetLazyCleanup();
    expect((await call(a, "/form-submissions/mine")).status).toBe(200);
    await settleLazyCleanups();
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, draftA) })).toBeUndefined();
    expect(await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, draftA))).toHaveLength(0);
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, draftB) })).toBeDefined();
    // The throttle: a second touch within the window does not sweep again.
    const draftA2 = await draftOf(a);
    await call(a, "/form-submissions/mine");
    await settleLazyCleanups();
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, draftA2) })).toBeDefined();
    resetLazyCleanup();
    await lazyCleanup({ userId: a.userId });
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, draftA2) })).toBeUndefined();
    await lazyCleanup({ userId: b.userId });
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, draftB) })).toBeUndefined();

    // Rejected application: files expire 30 days after the decision, noticed when the board opens the queue.
    const c = await newUser("lazyc");
    const { applicationId, submissionId } = await fileApplication(c, answersOf(), { files: [["zeugnis", "pdf"], ["photo", "png"]] });
    expect((await decide(club.founder, applicationId, "reject", { note: "intern" })).status).toBe(200);
    expect(await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, submissionId))).toHaveLength(2);
    await db.update(formSubmissions).set({ decidedAt: new Date(Date.now() - 40 * DAY) }).where(eq(formSubmissions.id, submissionId));
    resetLazyCleanup();
    expect((await list(club.founder)).status).toBe(200);
    await settleLazyCleanups();
    expect(await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, submissionId))).toHaveLength(0);
    const expired = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "form_submission.files_expired"), eq(auditLog.subjectId, submissionId)));
    expect(expired).toHaveLength(1);
    // The answers of an ADULT's rejected application stay as the record of the decision.
    const kept = (await body(await detail(club.founder, applicationId))).data;
    expect(kept.answersRetained).toBe(true);
    expect(kept.answers.find((x: { key: string }) => x.key === "first_name").display).toBe("Anna");
  });

  it("erases the answers of a rejected or withdrawn CHILD application after the retention time -- and only those", async () => {
    const parent = await newUser("erase");
    const rejected = await fileApplication(parent, answersOf({ first_name: "Weg", last_name: "Kind", birth_date: "2016-03-04" }), { onBehalfOf: "guardian" });
    const withdrawn = await fileApplication(parent, answersOf({ first_name: "Zurueck", last_name: "Kind", birth_date: "2016-03-04" }), { onBehalfOf: "guardian" });
    const accepted = await fileApplication(parent, answersOf({ first_name: "Bleibt", last_name: "Kind", birth_date: "2016-03-04" }), { onBehalfOf: "guardian" });
    const adult = await fileApplication(await newUser("eraseadult"), answersOf());
    expect((await decide(club.founder, rejected.applicationId, "reject", { applicantMessage: "Nein" })).status).toBe(200);
    expect((await call(parent, `/form-submissions/${withdrawn.submissionId}/withdraw`, { method: "POST" })).status).toBe(200);
    expect((await decide(club.founder, accepted.applicationId, "approve")).status).toBe(200);
    expect((await decide(club.founder, adult.applicationId, "reject")).status).toBe(200);
    // Not yet due.
    expect(await sweepRejectedChildAnswers(Date.now(), { clubId: club.clubId })).toBe(0);
    const old = new Date(Date.now() - 40 * DAY);
    for (const id of [rejected.submissionId, withdrawn.submissionId, accepted.submissionId, adult.submissionId]) await db.update(formSubmissions).set({ decidedAt: old, updatedAt: old }).where(eq(formSubmissions.id, id));
    expect(await sweepRejectedChildAnswers(Date.now(), { clubId: club.clubId })).toBe(2);
    expect(await sweepRejectedChildAnswers(Date.now(), { clubId: club.clubId })).toBe(0);
    const answersOfSub = async (id: string) => (await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, id) }))!.answers as Record<string, unknown>;
    expect(await answersOfSub(rejected.submissionId)).toEqual({});
    expect(await answersOfSub(withdrawn.submissionId)).toEqual({});
    expect((await answersOfSub(accepted.submissionId)).first_name).toBe("Bleibt");
    expect((await answersOfSub(adult.submissionId)).first_name).toBe("Anna");
    const review = (await body(await detail(club.founder, rejected.applicationId))).data;
    expect(review.answersRetained).toBe(false);
    expect(review.application.status).toBe("rejected");
    const audits = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.eventType, "form_submission.answers_erased")));
    expect(audits).not.toContain("Weg");
  });

  it("offers a tested anonymisation hook for Wave 10: answers, files and the legacy birth date of one member, nothing else", async () => {
    const who = await newUser("anon");
    const { applicationId, submissionId } = await fileApplication(who, answersOf(), { files: [["zeugnis", "pdf"]] });
    const bystander = await newUser("anonother");
    const second = await fileApplication(bystander, answersOf({ first_name: "Unbeteiligt" }), { files: [["zeugnis", "pdf"]] });
    expect((await decide(club.founder, applicationId, "approve")).status).toBe(200);
    expect((await decide(club.founder, second.applicationId, "approve")).status).toBe(200);
    const application = (await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) }))!;
    const fileKeys = (await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, submissionId))).map((f) => f.storageKey);
    expect(fileKeys).toHaveLength(1);

    const result = await db.transaction((tx) => eraseFormDataOfMember(tx, { clubId: club.clubId, clubMemberId: application.clubMemberId!, erasedBy: null }));
    expect(result).toMatchObject({ submissions: 1, files: 1, purge: fileKeys });
    await Promise.all(result.purge.map((key) => purgeMediaFile(key)));
    expect((await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) }))!.answers).toEqual({});
    expect(await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, submissionId))).toHaveLength(0);
    expect((await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) }))!.birthDate).toBeNull();
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, fileKeys[0]!)))[0]?.deletedAt).not.toBeNull();
    // The bystander's submission and a call with a foreign club are untouched.
    expect(((await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, second.submissionId) }))!.answers as Record<string, unknown>).first_name).toBe("Unbeteiligt");
    const foreign = await db.transaction((tx) => eraseFormDataOfMember(tx, { clubId: other.clubId, clubMemberId: application.clubMemberId!, erasedBy: null }));
    expect(foreign).toMatchObject({ submissions: 0, files: 0 });
    const audit = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.eventType, "form_submission.erased")));
    expect(audit).not.toContain("Anna");
    expect(await db.select().from(member).where(eq(member.userId, who.userId))).toHaveLength(1);
  });

  // --- protected master data, pagination, scrubbing -------------------------------------------------------------------

  it("treats birth date, address, phone and emergency contact as sensitive: redacted without members:read_sensitive, age band only", async () => {
    const who = await newUser("prot");
    const { applicationId } = await fileApplication(who, answersOf({ birth_date: "2015-06-07" }));
    const asBoard = await body(await detail(club.members.schriftfuehrer!, applicationId));
    const text = JSON.stringify(asBoard);
    expect(text).not.toContain("2015-06-07");
    expect(asBoard.data.answers.find((a: { key: string }) => a.key === "birth_date")).toMatchObject({ redacted: true, value: null, display: null });
    expect(asBoard.data.subject).toMatchObject({ birthDate: null, ageYears: null, ageBand: "<18", isMinor: true });
    expect(asBoard.data.application.birthDate).toBeNull();
    // The mapping preview stays.
    expect(asBoard.data.mapping.entries.find((m: { fieldKey: string }) => m.fieldKey === "birth_date")).toMatchObject({ target: "birthDate", willApply: true });
    // List: the field is kept for old clients but null without the right; the founder still gets it.
    const boardList = ((await body(await list(club.members.schriftfuehrer!))).data as Array<Record<string, unknown>>).find((a) => a.id === applicationId)!;
    expect(boardList).toHaveProperty("birthDate", null);
    const founderList = ((await body(await list(club.founder))).data as Array<Record<string, unknown>>).find((a) => a.id === applicationId)!;
    expect(founderList.birthDate).toBe("2015-06-07");
    const asFounder = (await body(await detail(club.founder, applicationId))).data;
    expect(asFounder.subject).toMatchObject({ birthDate: "2015-06-07", ageBand: "<18", isMinor: true });
    expect(typeof asFounder.subject.ageYears).toBe("number");
  });

  it("pages the queue (page, pageSize, total) with a backward compatible default", async () => {
    const res = await body(await list(club.founder));
    expect(res).toMatchObject({ page: 1, pageSize: 50 });
    expect(res.total).toBeGreaterThan(0);
    const small = await body(await call(club.founder, "/club-applications?pageSize=1&page=2", { clubId: club.clubId }));
    expect(small.data).toHaveLength(1);
    expect(small.pageSize).toBe(1);
    expect((await call(club.founder, "/club-applications?pageSize=101", { clubId: club.clubId })).status).toBe(422);
  });

  it("warns when a child carries the name of the guardian", async () => {
    const parent = await newUser("samename", "Max Mustermann");
    const { applicationId } = await fileApplication(parent, answersOf({ first_name: "Max", last_name: "Mustermann", birth_date: "2016-03-04" }), { onBehalfOf: "guardian" });
    expect((await body(await detail(club.founder, applicationId))).data.warnings).toEqual(["child_name_matches_guardian"]);
  });

  it("scrubs the application row copies the same way in the sweeper and in the anonymisation hook", async () => {
    const parent = await newUser("scrub");
    const swept = await fileApplication(parent, answersOf({ first_name: "Fege", last_name: "Kind", birth_date: "2016-03-04", category: "jugend" }), { onBehalfOf: "guardian" });
    expect((await decide(club.founder, swept.applicationId, "reject")).status).toBe(200);
    const old = new Date(Date.now() - 40 * DAY);
    await db.update(formSubmissions).set({ decidedAt: old, updatedAt: old }).where(eq(formSubmissions.id, swept.submissionId));
    expect(await sweepRejectedChildAnswers(Date.now(), { clubId: club.clubId })).toBeGreaterThanOrEqual(1);

    const erased = await fileApplication(await newUser("scrub2"), answersOf({ first_name: "Loesch", last_name: "Mich", birth_date: "2016-03-04", category: "jugend" }));
    expect((await decide(club.founder, erased.applicationId, "approve")).status).toBe(200);
    const memberId = (await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, erased.applicationId) }))!.clubMemberId!;
    await db.transaction((tx) => eraseFormDataOfMember(tx, { clubId: club.clubId, clubMemberId: memberId, erasedBy: null }));

    for (const id of [swept.applicationId, erased.applicationId]) {
      const row = (await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, id) }))!;
      expect(row.birthDate, id).toBeNull();
      expect(row.category, id).toBe("aktiv");
      const review = (await body(await detail(club.founder, id))).data;
      expect(review.subject).toMatchObject({ birthDate: null, ageYears: null, ageBand: null });
      expect(review.application.birthDate).toBeNull();
      expect(review.answers.every((a: { answered: boolean }) => !a.answered)).toBe(true);
    }
  });

  // --- privacy ---------------------------------------------------------------------------------------------------

  it("keeps answer values out of logs and audit entries", async () => {
    const audits = JSON.stringify(await db.select().from(auditLog));
    expect(audits).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain(SECRET);
    expect(JSON.stringify(logged)).not.toContain("attest-vertraulich");
  });
});
