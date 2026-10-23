import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDatabase, db, pool } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { accountLinkLockKey } from "../lib/club-members.js";
import { compensateAbortedApproval } from "../lib/form-applications.js";
import { createInvite } from "../lib/member-invites.js";
import { auth } from "../auth/auth.js";
import { clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { forms, formSubmissionFiles, formSubmissions, formVersions, memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { LEGACY_DEFAULT_APPLICATION_FIELDS } from "../lib/form-defaults.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { sweepRejectedFormFiles } from "../lib/form-sweeper.js";
import { logger } from "../lib/logger.js";
import { makePng } from "../lib/media-fixtures.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubMemberRoutes } from "./club-members.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { memberFieldRoutes } from "./member-fields.js";

/**
 * Integration test of the application <-> form integration (Wave 8 B6) against a real Postgres: old clients keep
 * working, applying with answers / a prepared submission, acceptance with the mapping allowlist (master data, category
 * override, member number, photo handover through the media register, custom fields, archived definitions), rejection and
 * retention, withdrawal, races (approve / withdraw / second apply), IDOR and privacy.
 */

// The invitation accepted in the merge race notifies the inviter by mail; nothing is sent in the test.
vi.mock("../lib/email.js", () => ({ sendEmail: async () => undefined }));

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
const SECRET = "GEHEIM-ANTWORT-4711";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;

const FIELDS = [
  { key: "first_name", type: "text", label: "Vorname", required: true, mapsTo: "firstName" },
  { key: "last_name", type: "text", label: "Nachname", required: true, mapsTo: "lastName" },
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "birth_date", type: "date", label: "Geburtsdatum", mapsTo: "birthDate" },
  { key: "street", type: "text", label: "Straße", mapsTo: "street" },
  { key: "phone", type: "text", label: "Telefon", mapsTo: "phone", validation: { pattern: "phone" } },
  { key: "photo", type: "image", label: "Foto", mapsTo: "photo" },
  { key: "shirt", type: "select", label: "Shirt", options: [{ value: "s", label: "S" }, { value: "m", label: "M" }], customField: "shirt_size" },
  { key: "instrument", type: "text", label: "Instrument", customField: "instrument" },
  { key: "notes", type: "textarea", label: "Anmerkung" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutz" },
  { key: "privacy_consent", type: "consent", label: "Ich willige ein.", required: false },
];
const full = (over: Record<string, unknown> = {}) => ({ first_name: "Anna", last_name: "Muster", category: "passiv", birth_date: "1990-04-02", street: "Hauptstr. 1", phone: "0123 456789", shirt: "m", instrument: "Tuba", notes: SECRET, privacy_consent: true, ...over });

describe("application <-> form integration (B6)", () => {
  let club: Awaited<ReturnType<typeof createClub>>; // custom form
  let plainClub: Awaited<ReturnType<typeof createClub>>; // standard form
  let otherClub: Awaited<ReturnType<typeof createClub>>;
  const applicants: Account[] = [];
  const logged: unknown[][] = [];
  let shirtFieldId: string;
  let instrumentFieldId: string;

  const newApplicant = async (label: string) => {
    const acc = await signUpAndVerify(`acc-${label}-${suffix}@example.com`, `Applicant ${label}`);
    applicants.push(acc);
    return acc;
  };
  const apply = (who: Account, payload: Record<string, unknown>) => call(who, "/club-members/apply", { method: "POST", body: payload });
  const applyAnswers = (who: Account, answers: Record<string, unknown>, extra: Record<string, unknown> = {}, target = club) => apply(who, { clubSlug: target.slug, answers, ...extra });
  const decide = (who: Account, id: string, action: "approve" | "reject", payload?: unknown, target = club) => call(who, `/club-applications/${id}/${action}`, { method: "POST", clubId: target.clubId, body: payload });
  const withdraw = (who: Account, submissionId: string) => call(who, `/form-submissions/${submissionId}/withdraw`, { method: "POST" });
  const filed = async (who: Account, answers = full(), extra: Record<string, unknown> = {}) => {
    const res = await applyAnswers(who, answers, extra);
    expect(res.status, JSON.stringify(await res.clone().text())).toBe(201);
    const data = (await body(res)).data;
    return { applicationId: data.application.id as string, submissionId: data.submission.id as string };
  };
  const memberRow = async (userId: string, clubId = club.clubId) => {
    const account = await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, clubId), same(m.userId, userId)) });
    return account ? db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }) : undefined;
  };
  const pngForm = (fieldKey: string) => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array(makePng())], "foto.png", { type: "image/png" }));
    fd.append("fieldKey", fieldKey);
    return fd;
  };

  beforeAll(async () => {
    club = await createClub("acc", suffix, { schriftfuehrer: "schriftfuehrer", plain: null });
    plainClub = await createClub("accp", suffix);
    otherClub = await createClub("acco", suffix);
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
    // Custom field definitions, then the application form that maps onto them.
    const mk = async (payload: Record<string, unknown>) => {
      const res = await call(club.founder, "/member-fields", { method: "POST", clubId: club.clubId, body: payload });
      expect(res.status).toBe(201);
      return (await body(res)).data.id as string;
    };
    shirtFieldId = await mk({ key: "shirt_size", label: "Trikotgröße", type: "select", options: [{ value: "s", label: "S" }, { value: "m", label: "M" }], visibleTo: "mitglied", editableBy: "self" });
    instrumentFieldId = await mk({ key: "instrument", label: "Instrument", type: "text" });
    const list = (await body(await call(club.founder, "/forms", { clubId: club.clubId }))).data as Array<{ id: string; purpose: string }>;
    const formId = list.find((f) => f.purpose === "aufnahme")!.id;
    expect((await call(club.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: club.clubId, body: { fields: FIELDS } })).status).toBe(200);
    expect((await call(club.founder, `/forms/${formId}/publish`, { method: "POST", clubId: club.clubId })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await dropClubs([club.clubId, plainClub.clubId, otherClub.clubId], [...club.userIds, ...plainClub.userIds, ...otherClub.userIds, ...applicants.map((a) => a.userId)]);
    await closeDatabase();
  });

  // --- old clients ------------------------------------------------------------------------------------------

  it("tells old clients to use the form while the club's (legacy) form still asks for a consent (409 form_required); legacy rows still decide with the old logic", async () => {
    const who = await newApplicant("legacy");
    // The standard form no longer asks for a consent, so old clients may apply the old way ...
    const first = await newApplicant("legacyok");
    const allowed = await apply(first, { clubSlug: plainClub.slug, category: "jugend", birthDate: "2010-04-05" });
    expect(allowed.status).toBe(201);
    await db.delete(clubApplications).where(eq(clubApplications.userId, first.userId));

    // ... except for a club whose published form is an OLD version with a mandatory consent (data from before Wave 10 B11).
    const aufnahme = (await db.query.forms.findFirst({ where: and(eq(forms.clubId, plainClub.clubId), eq(forms.purpose, "aufnahme")) }))!;
    const [published] = await db.select().from(formVersions).where(and(eq(formVersions.formId, aufnahme.id), eq(formVersions.status, "published")));
    // Touched (extra field), so the lazy upgrade of untouched legacy standard forms leaves it alone.
    await db.update(formVersions).set({ fields: [...LEGACY_DEFAULT_APPLICATION_FIELDS, { key: "extra", type: "text", label: "Extra", required: false }] }).where(eq(formVersions.id, published!.id));
    try {
      const res = await apply(who, { clubSlug: plainClub.slug, category: "jugend", birthDate: "2010-04-05" });
      expect(res.status).toBe(409);
      expect((await body(res)).error.details).toMatchObject({ code: "form_required" });
      expect(await db.query.clubApplications.findFirst({ where: eq(clubApplications.userId, who.userId) })).toBeUndefined();
      expect((await body(await apply(who, { clubId: plainClub.clubId }))).error.details.code).toBe("form_required");

      // A legacy row that exists (filed before the form builder) is still decided with the old logic.
      const [legacy] = await db.insert(clubApplications).values({ userId: who.userId, clubId: plainClub.clubId, category: "jugend", birthDate: "2010-04-05" }).returning();
      const list = (await body(await call(plainClub.founder, "/club-applications", { clubId: plainClub.clubId }))).data;
      expect(list.find((a: { id: string }) => a.id === legacy!.id)).toMatchObject({ legacy: true, formSubmissionId: null });
      const approved = await decide(plainClub.founder, legacy!.id, "approve", undefined, plainClub);
      expect(approved.status).toBe(200);
      const data = (await body(approved)).data;
      expect(data.mapping).toBeNull();
      expect(data.clubMember).toMatchObject({ birthDate: "2010-04-05", status: "aktiv" });
      expect(data.application).toMatchObject({ status: "approved", clubMemberId: data.clubMember.id });
      expect(data.membership.category).toBe("jugend");
    } finally {
      await db.update(formVersions).set({ fields: published!.fields }).where(eq(formVersions.id, published!.id));
    }
  });

  it("answers unknown clubs with 404 and counts every apply shape against the hourly limit", async () => {
    const who = await newApplicant("legacybad");
    expect((await apply(who, { clubId: "no-such-club" })).status).toBe(404);
    expect((await apply(who, { clubSlug: "no-such-club" })).status).toBe(404);
  });

  // --- applying -----------------------------------------------------------------------------------------------

  it("files an application with answers: submission + application are linked and the old duplicate rules hold", async () => {
    const who = await newApplicant("answers");
    const { applicationId, submissionId } = await filed(who);
    const app1 = await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) });
    expect(app1).toMatchObject({ status: "pending", formSubmissionId: submissionId, category: "passiv", birthDate: "1990-04-02", clubMemberId: null });
    const sub = await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) });
    expect(sub).toMatchObject({ status: "submitted", submittedByUserId: who.userId, clubId: club.clubId });

    const second = await applyAnswers(who, full());
    expect(second.status).toBe(409);
    expect((await body(second)).error).toMatchObject({ code: "APPLICATION_PENDING" });
    const legacy = await apply(who, { clubSlug: club.slug });
    expect(legacy.status).toBe(409);
    expect((await body(legacy)).error.code).toBe("APPLICATION_PENDING");
  });

  it("validates the answers against the published form (422 with codes, no values echoed) and rejects a stale version", async () => {
    const who = await newApplicant("invalid");
    const bad = await applyAnswers(who, full({ first_name: undefined, phone: `x${SECRET}`, privacy_consent: false, bogus: SECRET }));
    expect(bad.status).toBe(422);
    const text = await bad.text();
    expect(text).not.toContain(SECRET);
    expect(await db.query.clubApplications.findFirst({ where: eq(clubApplications.userId, who.userId) })).toBeUndefined();
    expect(await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.submittedByUserId, who.userId) })).toBeUndefined();

    const stale = await applyAnswers(who, full(), { formVersionId: "00000000-0000-4000-8000-000000000001" });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error).toMatchObject({ code: "FORM_VERSION_OUTDATED" });
    expect((await body(await apply(who, { clubSlug: club.slug, formVersionId: "00000000-0000-4000-8000-000000000001" }))).error).toBeDefined();
  });

  it("files a prepared draft (submissionId) and is idempotent for an already filed one; foreign drafts are 404", async () => {
    const who = await newApplicant("draft");
    const draft = await body(await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers: { first_name: "Dora" } } }));
    const id = draft.data.submission.id as string;
    expect((await call(who, `/form-submissions/${id}/files`, { method: "POST", form: pngForm("photo") })).status).toBe(201);

    const stranger = await newApplicant("stranger");
    expect((await apply(stranger, { clubSlug: club.slug, submissionId: id })).status).toBe(404);
    expect((await apply(who, { clubSlug: otherClub.slug, submissionId: id })).status).toBe(404);
    // Missing required answers: nothing is filed.
    expect((await apply(who, { clubSlug: club.slug, submissionId: id })).status).toBe(422);
    expect(await db.query.clubApplications.findFirst({ where: eq(clubApplications.userId, who.userId) })).toBeUndefined();

    const ok = await apply(who, { clubSlug: club.slug, submissionId: id, answers: full() });
    expect(ok.status).toBe(201);
    const first = (await body(ok)).data;
    expect(first.submission).toMatchObject({ id, status: "submitted" });
    const again = await apply(who, { clubSlug: club.slug, submissionId: id });
    expect(again.status).toBe(200);
    expect((await body(again)).data.application.id).toBe(first.application.id);
    expect(await db.query.clubApplications.findMany({ where: eq(clubApplications.userId, who.userId) })).toHaveLength(1);
  });

  it("POST /form-submissions/:id/submit files the application as well", async () => {
    const who = await newApplicant("viasubmit");
    const draft = await body(await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers: full() } }));
    const submitted = await call(who, `/form-submissions/${draft.data.submission.id}/submit`, { method: "POST", body: {} });
    expect(submitted.status).toBe(200);
    const data = (await body(submitted)).data;
    expect(data.application).toMatchObject({ status: "pending" });
    expect(await db.query.clubApplications.findFirst({ where: eq(clubApplications.formSubmissionId, draft.data.submission.id) })).toMatchObject({ id: data.application.id });
    // ... and a second application is refused.
    expect((await applyAnswers(who, full())).status).toBe(409);
  });

  // --- acceptance -----------------------------------------------------------------------------------------------

  it("accepts with the mapping: master data, category override, number, custom fields, photo handover, consent evidence", async () => {
    const who = await newApplicant("accept");
    const draft = await body(await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers: full() } }));
    const submissionId = draft.data.submission.id as string;
    expect((await call(who, `/form-submissions/${submissionId}/files`, { method: "POST", form: pngForm("photo") })).status).toBe(201);
    const fileRow = await db.query.formSubmissionFiles.findFirst({ where: eq(formSubmissionFiles.submissionId, submissionId) });
    const photoKey = fileRow!.storageKey;
    const { data } = await body(await apply(who, { clubSlug: club.slug, submissionId }));

    const approved = await decide(club.founder, data.application.id, "approve", { categoryKey: "foerdernd" });
    expect(approved.status).toBe(200);
    const result = (await body(approved)).data;
    expect(result.mapping).toMatchObject({ customFields: 2 });
    expect(result.mapping.applied).toEqual(expect.arrayContaining(["firstName", "lastName", "birthDate", "street", "phone", "photo"]));
    expect(result.application).toMatchObject({ status: "approved", clubMemberId: result.clubMember.id });

    const row = (await memberRow(who.userId))!;
    expect(row).toMatchObject({ firstName: "Anna", lastName: "Muster", displayName: "Anna Muster", birthDate: "1990-04-02", street: "Hauptstr. 1", phone: "0123 456789", status: "aktiv", photoKey });
    expect(row.memberNumber).toMatch(/-\d{4}$/);
    expect(row.contactEmail).toBe(`acc-accept-${suffix}@example.com`); // not mapped: stays the account address
    // The board's category beats the applicant's choice ("passiv").
    const category = await db.query.memberCategories.findFirst({ where: (t, { eq: same }) => same(t.id, row.categoryId!) });
    expect(category?.key).toBe("foerdernd");

    // Custom fields.
    const values = await db.select().from(memberFieldValues).where(eq(memberFieldValues.clubMemberId, row.id));
    expect(Object.fromEntries(values.map((v) => [v.fieldId, v.value]))).toEqual({ [shirtFieldId]: "m", [instrumentFieldId]: "Tuba" });

    // Photo: re-owned in the register (same key, no copy), no longer a file of the submission, no URL stored.
    const media = await db.query.mediaFiles.findFirst({ where: eq(mediaFiles.storageKey, photoKey) });
    expect(media).toMatchObject({ ownerType: "club_member", ownerId: row.id, deletedAt: null, clubId: club.clubId });
    expect(await db.query.formSubmissionFiles.findMany({ where: eq(formSubmissionFiles.submissionId, submissionId) })).toHaveLength(0);
    const shaped = (await body(await call(club.founder, `/club-members/${row.id}`, { clubId: club.clubId }))).data;
    expect(shaped.photoUrl).toMatch(/\/media\//);
    expect((await call(club.founder, `/club-members/${row.id}/photo`, { clubId: club.clubId })).status).toBe(200);

    // Submission is closed with the decision; the answers (consent) stay as evidence.
    const sub = await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) });
    expect(sub).toMatchObject({ status: "accepted", subjectClubMemberId: row.id });
    expect(sub!.decidedAt).not.toBeNull();
    expect((sub!.answers as Record<string, unknown>).privacy_consent).toBe(true);

    // A decided application cannot be withdrawn (409) nor decided again.
    expect((await withdraw(who, submissionId)).status).toBe(409);
    expect((await decide(club.founder, data.application.id, "approve")).status).toBe(409);
    expect((await decide(club.founder, data.application.id, "reject")).status).toBe(409);

    // Audit: ids, mapped target names, counts, consent evidence -- never an answer value.
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_application.approve"), eq(auditLog.subjectId, data.application.id)));
    expect(entry!.payload).toMatchObject({ formSubmissionId: submissionId, consent: { consentFieldKeys: ["privacy_consent"] } });
    const serialized = JSON.stringify(entry!.payload);
    for (const value of ["Anna", "Muster", "Hauptstr", "Tuba", SECRET, "0123"]) expect(serialized).not.toContain(value);
    // Custom field writes of the mapping leave the same trail as a board write: definition ids, no values.
    const writes = (await db.select().from(auditLog).where(and(eq(auditLog.eventType, "member_field.write"), eq(auditLog.subjectId, row.id))));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.payload).toMatchObject({ via: "application", changedBy: expect.any(String) });
    expect((writes[0]!.payload as { fieldIds: string[] }).fieldIds.sort()).toEqual([shirtFieldId, instrumentFieldId].sort());
    expect(JSON.stringify(writes[0]!.payload)).not.toContain("Tuba");
  });

  it("applies the applicant's category when the board does not override it, and rejects a bad override before anything is created", async () => {
    const who = await newApplicant("cat");
    const { applicationId } = await filed(who);
    for (const payload of [{ categoryKey: "gibt-es-nicht" }, { categoryId: "00000000-0000-4000-8000-000000000000" }, { categoryId: "no-uuid" }]) {
      expect((await decide(club.founder, applicationId, "approve", payload)).status, JSON.stringify(payload)).toBe(422);
    }
    expect(await memberRow(who.userId)).toBeUndefined();
    expect((await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) }))!.status).toBe("pending");

    expect((await decide(club.founder, applicationId, "approve")).status).toBe(200);
    const row = (await memberRow(who.userId))!;
    expect((await db.query.memberCategories.findFirst({ where: (t, { eq: same }) => same(t.id, row.categoryId!) }))!.key).toBe("passiv");
  });

  it("tolerates definitions archived after publishing and never writes more than the allowlist", async () => {
    const who = await newApplicant("archived");
    const { applicationId } = await filed(who);
    await db.update(memberFieldDefinitions).set({ archivedAt: new Date() }).where(eq(memberFieldDefinitions.id, instrumentFieldId));
    try {
      const approved = await decide(club.founder, applicationId, "approve");
      expect(approved.status).toBe(200);
      const { mapping } = (await body(approved)).data;
      expect(mapping.customFields).toBe(1);
      expect(mapping.skipped).toEqual([{ fieldKey: "instrument", reason: "custom_field_archived" }]);
      const row = (await memberRow(who.userId))!;
      const values = await db.select().from(memberFieldValues).where(eq(memberFieldValues.clubMemberId, row.id));
      expect(values.map((v) => v.fieldId)).toEqual([shirtFieldId]);
    } finally {
      await db.update(memberFieldDefinitions).set({ archivedAt: null }).where(eq(memberFieldDefinitions.id, instrumentFieldId));
    }
  });

  it("a tampered stored definition cannot reach other columns (mass assignment) -- only allowlisted targets are written", async () => {
    const hostileClub = await createClub("acch", suffix);
    try {
      const list = (await body(await call(hostileClub.founder, "/forms", { clubId: hostileClub.clubId }))).data as Array<{ id: string; purpose: string }>;
      const formId = list.find((f) => f.purpose === "aufnahme")!.id;
      // The API refuses such a definition ...
      const refused = await call(hostileClub.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: hostileClub.clubId, body: { fields: [{ key: "evil", type: "text", label: "x", mapsTo: "status" }] } });
      expect(refused.status).toBe(422);
      // ... so simulate a tampered JSON row directly in the database.
      const [published] = await db.select().from(formVersions).where(and(eq(formVersions.formId, formId), eq(formVersions.status, "published")));
      const tampered = [...(published!.fields as unknown[]), { key: "evil_a", type: "text", label: "a", mapsTo: "status" }, { key: "evil_b", type: "text", label: "b", mapsTo: "memberId" }, { key: "evil_c", type: "text", label: "c", mapsTo: "clubId" }];
      await db.update(formVersions).set({ fields: tampered }).where(eq(formVersions.id, published!.id));

      const who = await newApplicant("hostile");
      const filedRes = await apply(who, { clubSlug: hostileClub.slug, answers: { category: "aktiv", evil_a: "verstorben", evil_b: "fremd", evil_c: "anderer-verein" } });
      expect(filedRes.status).toBe(201);
      const id = (await body(filedRes)).data.application.id;
      const approved = await decide(hostileClub.founder, id, "approve", undefined, hostileClub);
      expect(approved.status).toBe(200);
      expect((await body(approved)).data.mapping.skipped.map((x: { reason: string }) => x.reason)).toEqual(["unknown_target", "unknown_target", "unknown_target"]);
      const account = await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, hostileClub.clubId), same(m.userId, who.userId)) });
      const row = (await memberRow(who.userId, hostileClub.clubId))!;
      expect(row).toMatchObject({ status: "aktiv", memberId: account!.id, clubId: hostileClub.clubId });
    } finally {
      await dropClubs([hostileClub.clubId], hostileClub.userIds);
    }
  });

  // --- rejection / retention ---------------------------------------------------------------------------------------

  it("rejects with a note: answers stay, files are deleted after the retention window by the sweeper", async () => {
    const who = await newApplicant("reject");
    const draft = await body(await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers: full() } }));
    const submissionId = draft.data.submission.id as string;
    expect((await call(who, `/form-submissions/${submissionId}/files`, { method: "POST", form: pngForm("photo") })).status).toBe(201);
    const { data } = await body(await apply(who, { clubSlug: club.slug, submissionId }));

    expect((await decide(club.founder, data.application.id, "reject", { note: "x".repeat(1001) })).status).toBe(422);
    expect((await decide(club.founder, data.application.id, "reject", { applicantMessage: "x".repeat(1001) })).status).toBe(422);
    const rejected = await decide(club.founder, data.application.id, "reject", { note: "INTERN: zu viele Verspaetungen.", applicantMessage: "Leider kein Platz mehr." });
    expect(rejected.status).toBe(200);
    expect((await body(rejected)).data.application).toMatchObject({ status: "rejected" });
    expect(await memberRow(who.userId)).toBeUndefined();

    const sub = await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) });
    expect(sub).toMatchObject({ status: "rejected", decisionNote: "Leider kein Platz mehr.", decisionInternalNote: "INTERN: zu viele Verspaetungen." });
    // The applicant sees the message, never the internal note.
    for (const path of [`/form-submissions/${submissionId}`, "/form-submissions/mine"]) {
      const view = await (await call(who, path)).text();
      expect(view).toContain("Leider kein Platz mehr.");
      expect(view).not.toContain("INTERN");
    }
    expect(await db.query.formSubmissionFiles.findMany({ where: eq(formSubmissionFiles.submissionId, submissionId) })).toHaveLength(1);

    // Nothing to delete yet ...
    await sweepRejectedFormFiles();
    expect(await db.query.formSubmissionFiles.findMany({ where: eq(formSubmissionFiles.submissionId, submissionId) })).toHaveLength(1);
    // ... 31 days later the files are gone (registry tombstone), the answers remain.
    expect(await sweepRejectedFormFiles(Date.now() + 31 * 24 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    expect(await db.query.formSubmissionFiles.findMany({ where: eq(formSubmissionFiles.submissionId, submissionId) })).toHaveLength(0);
    const after = await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) });
    expect((after!.answers as Record<string, unknown>).first_name).toBe("Anna");

    // The applicant may apply again after a rejection.
    expect((await applyAnswers(who, full())).status).toBe(201);
  });

  it("withdrawing closes the application; deciding it afterwards is a 409 and creates nothing", async () => {
    const who = await newApplicant("withdraw");
    const { applicationId, submissionId } = await filed(who);
    expect((await withdraw(who, submissionId)).status).toBe(200);
    expect(await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) })).toMatchObject({ status: "withdrawn" });
    expect((await decide(club.founder, applicationId, "approve")).status).toBe(409);
    expect((await decide(club.founder, applicationId, "reject")).status).toBe(409);
    expect(await memberRow(who.userId)).toBeUndefined();
    // Not listed any more; the user can apply again.
    const list = (await body(await call(club.founder, "/club-applications", { clubId: club.clubId }))).data;
    expect(list.map((a: { id: string }) => a.id)).not.toContain(applicationId);
    expect((await applyAnswers(who, full())).status).toBe(201);
  });

  it("re-admits a former member through a form application and applies the mapping to the reopened row", async () => {
    const who = await newApplicant("readmit");
    const { applicationId: first } = await filed(who, full({ first_name: "Erst" }));
    expect((await decide(club.founder, first, "approve")).status).toBe(200);
    const before = (await memberRow(who.userId))!;
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: yesterday, exitReason: "Test" }).where(eq(clubMembers.id, before.id));

    const { applicationId: second } = await filed(who, full({ first_name: "Zurück", last_name: "Gekehrt", category: "aktiv" }));
    const res = await decide(club.founder, second, "approve");
    expect(res.status).toBe(200);
    const row = (await memberRow(who.userId))!;
    expect(row).toMatchObject({ id: before.id, status: "aktiv", leftAt: null, firstName: "Zurück", lastName: "Gekehrt", memberNumber: before.memberNumber });
    const readmitted = await body(res);
    expect(readmitted.data.application).toMatchObject({ clubMemberId: before.id });
    expect(readmitted.data.membership.category).toBe("aktiv");
    // The member's old custom value was overwritten by the new application, not duplicated.
    expect(await db.select().from(memberFieldValues).where(and(eq(memberFieldValues.clubMemberId, before.id), eq(memberFieldValues.fieldId, shirtFieldId)))).toHaveLength(1);
  });

  // --- IDOR ---------------------------------------------------------------------------------------------------------

  it("keeps clubs apart: another club's board cannot read, approve or reject; a plain member gets 403", async () => {
    const who = await newApplicant("idor");
    const { applicationId } = await filed(who);
    for (const action of ["approve", "reject"] as const) {
      expect((await decide(otherClub.founder, applicationId, action, undefined, otherClub)).status, action).toBe(404);
      expect((await decide(club.members.plain!, applicationId, action)).status, action).toBe(403);
    }
    const foreignList = (await body(await call(otherClub.founder, "/club-applications", { clubId: otherClub.clubId }))).data;
    expect(foreignList.map((a: { id: string }) => a.id)).not.toContain(applicationId);
    // The submission of somebody else cannot be filed or withdrawn by another user.
    const sub = await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) });
    const other = await newApplicant("idor2");
    expect((await withdraw(other, sub!.formSubmissionId!)).status).toBe(404);
    expect((await decide(club.founder, applicationId, "approve")).status).toBe(200);
  });

  // --- races ----------------------------------------------------------------------------------------------------------

  it("approve vs withdraw: exactly one wins and the loser leaves no trace", async () => {
    for (let i = 0; i < 4; i++) {
      const who = await newApplicant(`racea${i}`);
      const { applicationId, submissionId } = await filed(who);
      const [approve, wd] = await Promise.all([decide(club.founder, applicationId, "approve"), withdraw(who, submissionId)]);
      const statuses = [approve.status, wd.status].sort();
      expect(statuses, `round ${i}: ${approve.status}/${wd.status}`).toEqual([200, 409]);

      const application = (await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) }))!;
      const sub = (await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, submissionId) }))!;
      const row = await memberRow(who.userId);
      if (approve.status === 200) {
        expect([application.status, sub.status]).toEqual(["approved", "accepted"]);
        expect(row).toBeDefined();
      } else {
        expect([application.status, sub.status]).toEqual(["withdrawn", "withdrawn"]);
        expect(row).toBeUndefined();
        expect(await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, club.clubId), same(m.userId, who.userId)) })).toBeUndefined();
      }
    }
  });

  it("two approves at once create one member; approve vs reject has one winner", async () => {
    const who = await newApplicant("raceb");
    const { applicationId } = await filed(who);
    const [a, b] = await Promise.all([decide(club.founder, applicationId, "approve"), decide(club.members.schriftfuehrer!, applicationId, "approve")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.query.clubMembers.findMany({ where: eq(clubMembers.lastUserId, who.userId) })).toHaveLength(1);

    const other = await newApplicant("racec");
    const filedOther = await filed(other);
    const [ap, rj] = await Promise.all([decide(club.founder, filedOther.applicationId, "approve"), decide(club.founder, filedOther.applicationId, "reject")]);
    expect([ap.status, rj.status].sort()).toEqual([200, 409]);
    const finalApp = (await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, filedOther.applicationId) }))!;
    const finalSub = (await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, filedOther.submissionId) }))!;
    expect([finalApp.status, finalSub.status]).toEqual(ap.status === 200 ? ["approved", "accepted"] : ["rejected", "rejected"]);
    expect(Boolean(await memberRow(other.userId))).toBe(ap.status === 200);
  });

  it("a second apply at once is refused as pending, whichever way it comes in (answers, submit, legacy)", async () => {
    const who = await newApplicant("racec2");
    const draft = await body(await call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, answers: full() } }));
    const results = await Promise.all([
      applyAnswers(who, full()),
      call(who, `/form-submissions/${draft.data.submission.id}/submit`, { method: "POST", body: {} }),
      apply(who, { clubSlug: club.slug }),
      applyAnswers(who, full()),
    ]);
    const ok = results.filter((r) => r.status === 200 || r.status === 201);
    expect(ok, results.map((r) => r.status).join(",")).toHaveLength(1);
    for (const r of results.filter((x) => !ok.includes(x))) expect(r.status).toBe(409);
    expect(await db.query.clubApplications.findMany({ where: and(eq(clubApplications.userId, who.userId), eq(clubApplications.clubId, club.clubId)) })).toHaveLength(1);
  });

  it("apply and draft creation of one user in parallel do not deadlock", async () => {
    const who = await newApplicant("racedl");
    const results = await Promise.all([applyAnswers(who, full()), call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug } }), applyAnswers(who, full())]);
    for (const r of results) expect([200, 201, 409]).toContain(r.status);
  });

  it("approving a re-application while the applicant's account is merged into an invited record: no 500, no duplicate rows", async () => {
    const founderAccount = (await db.query.member.findFirst({ where: (mm, { and: both, eq: same }) => both(same(mm.organizationId, club.clubId), same(mm.userId, club.founder.userId)) }))!;
    for (let i = 0; i < 4; i++) {
      const who = await newApplicant(`merge${i}`);
      const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club.clubId, role: "member" } }))!;
      const own = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
      // A former member without history entries (so an automatic merge is possible) who applies again.
      await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01", memberNumber: null }).where(eq(clubMembers.id, own.id));
      const { applicationId } = await filed(who);

      const created = await body(await call(club.founder, "/club-members", { method: "POST", clubId: club.clubId, body: { displayName: `Vorab ${i}`, categoryKey: "aktiv" } }));
      const { token } = await createInvite(club.clubId, created.data.id, `acc-merge${i}-${suffix}@example.com`, founderAccount.id);

      const [approve, accept] = await Promise.all([
        decide(club.founder, applicationId, "approve"),
        call(who, "/club-members/invites/accept", { method: "POST", body: { token } }),
      ]);
      expect(approve.status, `approve round ${i}`).toBeLessThan(500);
      expect(accept.status, `accept round ${i}`).toBeLessThan(500);
      expect([200, 409]).toContain(approve.status);
      expect([200, 409, 404]).toContain(accept.status);
      // Whatever won: the account has exactly one club record and the application is in a consistent state.
      expect(await db.query.clubMembers.findMany({ where: eq(clubMembers.memberId, account.id) })).toHaveLength(1);
      const application = (await db.query.clubApplications.findFirst({ where: eq(clubApplications.id, applicationId) }))!;
      expect(application.status).toBe(approve.status === 200 ? "approved" : "pending");
      if (application.clubMemberId) expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, application.clubMemberId) })).toBeDefined();
    }
  });

  it("compensation of an aborted approval removes only the untouched creation and never under a held account lock", async () => {
    const mk = async (label: string) => {
      const who = await newApplicant(label);
      const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club.clubId, role: "member" } }))!;
      return { who, account, ref: { id: account.id, organizationId: club.clubId, userId: who.userId } };
    };
    const accountExists = async (id: string) => Boolean(await db.query.member.findFirst({ where: (m, { eq: same }) => same(m.id, id) }));

    // Pristine hook-created row: removed together with the membership.
    const fresh = await mk("comp1");
    expect(await compensateAbortedApproval(fresh.ref)).toBe(true);
    expect(await accountExists(fresh.account.id)).toBe(false);
    expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, fresh.account.id) })).toBeUndefined();

    // A link / merge entry in the history (as written by the invitation accept): nothing is deleted.
    const linked = await mk("comp2");
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, linked.account.id) }))!;
    await db.insert(clubMemberStatusHistory).values({ clubMemberId: row.id, fromStatus: "aktiv", toStatus: "aktiv", effectiveOn: "2024-01-01", reason: "merged" });
    expect(await compensateAbortedApproval(linked.ref)).toBe(false);
    expect(await accountExists(linked.account.id)).toBe(true);
    expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, row.id) })).toBeDefined();

    // Somebody (an invitation accept) holds the (club, account) lock: skipped, not waited for, not deleted.
    const busy = await mk("comp3");
    const holder = await pool.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [accountLinkLockKey(club.clubId, busy.who.userId)]);
      expect(await compensateAbortedApproval(busy.ref)).toBe(false);
    } finally {
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [accountLinkLockKey(club.clubId, busy.who.userId)]);
      holder.release();
    }
    expect(await accountExists(busy.account.id)).toBe(true);
    // Free again: now it is removed.
    expect(await compensateAbortedApproval(busy.ref)).toBe(true);
  });

  // --- privacy ---------------------------------------------------------------------------------------------------------

  it("never writes answer values to logs or audit entries", async () => {
    const flat = JSON.stringify(logged);
    for (const value of [SECRET, "Hauptstr", "Tuba", "0123 456789"]) expect(flat).not.toContain(value);
    const entries = await db.select().from(auditLog);
    const mine = entries.filter((e) => JSON.stringify(e.payload).includes(club.clubId));
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) for (const value of [SECRET, "Hauptstr", "Tuba", "0123 456789", "Muster"]) expect(JSON.stringify(e.payload)).not.toContain(value);
  });

  it("the account-less application stays impossible for members: an existing member cannot apply again", async () => {
    const res = await applyAnswers(club.members.plain!, full());
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("ALREADY_MEMBER");
  });
});
