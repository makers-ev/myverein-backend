import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { memberCategories } from "../db/schema/club-members.js";
import { forms, formSubmissionFiles, formSubmissions, formVersions, memberFieldDefinitions } from "../db/schema/forms.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { ensureClubFormDefaults } from "../lib/form-defaults.js";
import { sweepStaleFormDrafts } from "../lib/form-sweeper.js";
import { PDF_BYTES, makePng } from "../lib/media-fixtures.js";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, storeUpload } from "../lib/media.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubMemberRoutes } from "./club-members.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { aufnahmeFields, createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/**
 * Hardening of the form builder (Wave 8 review round): character policy at the routes, applicant-selectable
 * categories, draft caps and sweeper, atomic defaults, lenient draft validation, upload failure cleanup, editor caps,
 * sensitive flag checks and the withdraw rule.
 */

const app = new Hono();
app.route("/forms", formRoutes);
app.route("/club-forms", clubFormRoutes);
app.route("/form-submissions", formSubmissionRoutes);
app.route("/club-members", clubMemberRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now() + 1;
const ch = (...codes: number[]) => String.fromCharCode(...codes);
const DAY = 24 * 60 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;
const fileForm = (fieldKey: string, bytes: Buffer, name: string, type: string) => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], name, { type }));
  fd.append("fieldKey", fieldKey);
  return fd;
};

const FIELDS = aufnahmeFields([
  { key: "nick", type: "text", label: "Spitzname" },
  { key: "about", type: "textarea", label: "Über dich" },
  { key: "photo", type: "image", label: "Foto", mapsTo: "photo" },
  { key: "doc_a", type: "file", label: "Dokument A" },
  { key: "doc_b", type: "file", label: "Dokument B" },
]);

describe("form builder hardening", () => {
  let h: Awaited<ReturnType<typeof createClub>>;
  const extraClubs: Array<Awaited<ReturnType<typeof createClub>>> = [];
  const applicants: Account[] = [];
  let formId: string;

  const applicant = async (label: string) => {
    const a = await signUpAndVerify(`hard-${label}-${suffix}@example.com`, `Hard ${label}`);
    applicants.push(a);
    return a;
  };
  const draft = async (who: Account, slug: string, extra: Record<string, unknown> = {}) => {
    const res = await call(who, "/form-submissions", { method: "POST", body: { clubSlug: slug, ...extra } });
    return res;
  };
  const draftId = async (who: Account, slug = h.slug) => {
    const res = await draft(who, slug);
    expect(res.status).toBe(201);
    return (await body(res)).data.submission.id as string;
  };
  const upload = (who: Account, id: string, fieldKey: string, bytes: Buffer, type: string, name = "f.bin") => call(who, `/form-submissions/${id}/files`, { method: "POST", form: fileForm(fieldKey, bytes, name, type) });
  const patch = (who: Account, id: string, answers: unknown) => call(who, `/form-submissions/${id}`, { method: "PATCH", body: { answers } });
  const submit = (who: Account, id: string, answers: unknown = {}) => call(who, `/form-submissions/${id}/submit`, { method: "POST", body: { answers } });
  const categoryId = async (key: string) => (await db.query.memberCategories.findFirst({ where: and(eq(memberCategories.clubId, h.clubId), eq(memberCategories.key, key)) }))!.id;

  beforeAll(async () => {
    h = await createClub("h1", suffix);
    await ensureClubFormDefaults(h.clubId);
    formId = ((await body(await call(h.founder, "/forms?purpose=aufnahme", { clubId: h.clubId }))).data as Array<{ id: string }>)[0]!.id;
    expect((await call(h.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: h.clubId, body: { fields: FIELDS } })).status).toBe(200);
    expect((await call(h.founder, `/forms/${formId}/publish`, { method: "POST", clubId: h.clubId })).status).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await dropClubs([h.clubId, ...extraClubs.map((c) => c.clubId)], [...h.userIds, ...extraClubs.flatMap((c) => c.userIds), ...applicants.map((a) => a.userId)]);
    await closeDatabase();
  });

  // --- M2: character policy -----------------------------------------------------------------------------

  it("answers 422 (never 500) for NUL, bidi and control characters in definitions and answers; emoji pass", async () => {
    const put = (fields: unknown, extra: Record<string, unknown> = {}) => call(h.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: h.clubId, body: { fields, ...extra } });
    const withLabel = (label: string) => FIELDS.map((f) => (f.key === "nick" ? { ...f, label } : f));
    expect((await put(withLabel(`Spitz${ch(0)}name`))).status).toBe(422);
    expect((await put(withLabel(`Spitz${ch(0x202e)}name`))).status).toBe(422);
    expect((await put(withLabel("Spitzname 😀 <b>"))).status).toBe(200);
    expect((await put(FIELDS, { privacyNotice: `Text${ch(0)}` })).status).toBe(422);
    expect((await put(FIELDS, { name: `Name${ch(0x202e)}` })).status).toBe(422);
    expect((await put(FIELDS, { privacyNotice: "Zeile 1\nZeile 2 👍" })).status).toBe(200);
    expect((await call(h.founder, "/forms", { method: "POST", clubId: h.clubId, body: { purpose: "umfrage", name: `x${ch(0)}` } })).status).toBe(422);
    await call(h.founder, `/forms/${formId}/draft`, { method: "DELETE", clubId: h.clubId });

    const who = await applicant("policy");
    const id = await draftId(who);
    for (const answers of [{ nick: `a${ch(0)}b` }, { nick: `a${ch(0x202e)}` }, { nick: "a\nb" }, { about: `x${ch(0)}` }]) {
      const res = await patch(who, id, answers);
      expect(res.status, JSON.stringify(answers)).toBe(422);
    }
    expect((await patch(who, id, { nick: "Zoë 😀", about: "Zeile 1\nZeile 2" })).status).toBe(200);
    // Other client strings that reach the database.
    expect((await draft(who, `a${ch(0)}b`)).status).toBe(422);
    expect((await call(who, `/club-forms/a%00b/aufnahme`)).status).toBe(404);
    const claim = await call(who, `/form-submissions/${id}/files`, { method: "POST", body: { fieldKey: "photo", mediaKey: `x${ch(0)}y` } });
    expect(claim.status).toBe(422);
    const nulField = await call(who, `/form-submissions/${id}/files`, { method: "POST", form: fileForm(`photo${ch(0)}`, makePng(), "p.png", "image/png") });
    expect(nulField.status).toBe(422);
    const nasty = await upload(who, id, "photo", makePng(), "image/png", `evil${ch(0x202e)}gnp.exe`);
    expect(nasty.status).toBe(201);
    expect((await body(nasty)).data.file.filename).toBe("evilgnp.exe");
  });

  it("answers 400 for a malformed JSON body (not 500)", async () => {
    const who = await applicant("badjson");
    const id = await draftId(who);
    const res = await app.request(`/form-submissions/${id}`, { method: "PATCH", headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": "badjson" }, body: "{not json" });
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("BAD_REQUEST");
  });

  // --- M3: applicant-selectable categories ---------------------------------------------------------------

  it("offers and accepts only applicant-selectable categories; the board opens more via the categories API", async () => {
    const who = await applicant("cats");
    const def = (await body(await call(who, `/club-forms/${h.slug}/aufnahme`))).data;
    const options = def.fields.find((f: { key: string }) => f.key === "category").options.map((o: { value: string }) => o.value);
    expect(options).toEqual(["aktiv", "passiv", "foerdernd", "jugend"]);

    const created = await draft(who, h.slug, { answers: { category: "ehrenmitglied" } });
    expect(created.status).toBe(422);
    expect((await body(created)).error.details.fields).toEqual({ category: "not_an_option" });
    const id = await draftId(who);
    expect((await patch(who, id, { category: "ehrenmitglied" })).status).toBe(422);

    const cats = (await body(await call(h.founder, "/club-members/categories", { clubId: h.clubId }))).data as Array<{ key: string; applicantSelectable: boolean }>;
    expect(Object.fromEntries(cats.map((c) => [c.key, c.applicantSelectable]))).toMatchObject({ aktiv: true, passiv: true, foerdernd: true, jugend: true, ehrenmitglied: false });

    const ehren = await categoryId("ehrenmitglied");
    expect((await call(h.founder, `/club-members/categories/${ehren}`, { method: "PATCH", clubId: h.clubId, body: { applicantSelectable: true } })).status).toBe(200);
    expect((await patch(who, id, { category: "ehrenmitglied" })).status).toBe(200);
    // A custom category is closed until the board opens it.
    const custom = await body(await call(h.founder, "/club-members/categories", { method: "POST", clubId: h.clubId, body: { name: "Gönner" } }));
    expect(custom.data.applicantSelectable).toBe(false);
    expect((await patch(who, id, { category: custom.data.key })).status).toBe(422);
    // Closing it again removes it from the applicant form; plain members cannot flip the flag.
    expect((await call(h.founder, `/club-members/categories/${ehren}`, { method: "PATCH", clubId: h.clubId, body: { applicantSelectable: false } })).status).toBe(200);
    const def2 = (await body(await call(who, `/club-forms/${h.slug}/aufnahme`))).data;
    expect(def2.fields.find((f: { key: string }) => f.key === "category").options.map((o: { value: string }) => o.value)).not.toContain("ehrenmitglied");
    expect((await call(who, `/club-members/categories/${ehren}`, { method: "PATCH", clubId: h.clubId, body: { applicantSelectable: true } })).status).toBe(404);
  });

  it("refuses to publish an aufnahme form when no category can be chosen", async () => {
    await db.update(memberCategories).set({ applicantSelectable: false }).where(eq(memberCategories.clubId, h.clubId));
    try {
      expect((await call(h.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: h.clubId, body: { fields: FIELDS } })).status).toBe(200);
      const res = await call(h.founder, `/forms/${formId}/publish`, { method: "POST", clubId: h.clubId });
      expect(res.status).toBe(422);
      expect((await body(res)).error.details.problems).toEqual([{ code: "no_selectable_category" }]);
    } finally {
      await db.update(memberCategories).set({ applicantSelectable: true }).where(and(eq(memberCategories.clubId, h.clubId), inArray(memberCategories.key, ["aktiv", "passiv", "foerdernd", "jugend"])));
      await call(h.founder, `/forms/${formId}/draft`, { method: "DELETE", clubId: h.clubId });
    }
  });

  // --- M1: caps and sweeper ------------------------------------------------------------------------------

  it("caps open drafts per user across all clubs", async () => {
    for (const label of ["h2", "h3", "h4", "h5"]) extraClubs.push(await createClub(label, suffix));
    const who = await applicant("usercap");
    const slugs = [h.slug, ...extraClubs.map((c) => c.slug)];
    const statuses: number[] = [];
    for (const slug of slugs.slice(0, 3)) for (let i = 0; i < 3; i++) statuses.push((await draft(who, slug)).status);
    statuses.push((await draft(who, slugs[3]!)).status); // 10th
    expect(statuses).toEqual([...Array(10).fill(201)]);
    const eleventh = await draft(who, slugs[4]!);
    expect(eleventh.status).toBe(409);
    expect((await body(eleventh)).error.details.code).toBe("draft_limit_user");
  }, 60_000);

  it("caps files and bytes over all open drafts of a user in one club and counts the delete bucket separately", async () => {
    const who = await applicant("filecap");
    const ids = [await draftId(who), await draftId(who), await draftId(who)];
    expect((await upload(who, ids[0]!, "photo", makePng(), "image/png")).status).toBe(201);
    for (const key of ["doc_a", "doc_b", "doc_a", "doc_b"]) expect((await upload(who, ids[0]!, key, PDF_BYTES, "application/pdf")).status).toBe(201);
    for (let i = 0; i < 5; i++) expect((await upload(who, ids[1]!, "doc_a", PDF_BYTES, "application/pdf")).status).toBe(201);
    const over = await upload(who, ids[2]!, "doc_a", PDF_BYTES, "application/pdf");
    expect(over.status).toBe(422);
    expect((await body(over)).error.details.code).toBe("draft_upload_cap");
    // Freeing a slot (delete) lets the next upload through; a replaced photo does not count twice.
    const files = (await body(await call(who, `/form-submissions/${ids[1]}`))).data.submission.files as Array<{ id: string }>;
    expect((await call(who, `/form-submissions/${ids[1]}/files/${files[0]!.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await upload(who, ids[2]!, "doc_a", PDF_BYTES, "application/pdf")).status).toBe(201);
    expect((await upload(who, ids[0]!, "photo", makePng(), "image/png")).status).toBe(201);
  });

  it("caps the bytes (FORM_DRAFT_MAX_BYTES_PER_USER)", async () => {
    const previous = process.env.FORM_DRAFT_MAX_BYTES_PER_USER;
    process.env.FORM_DRAFT_MAX_BYTES_PER_USER = "3000";
    try {
      const who = await applicant("bytecap");
      const id = await draftId(who);
      const doc = Buffer.concat([PDF_BYTES, Buffer.alloc(1200)]);
      expect((await upload(who, id, "doc_a", doc, "application/pdf")).status).toBe(201);
      expect((await upload(who, id, "doc_b", doc, "application/pdf")).status).toBe(201);
      const third = await upload(who, id, "doc_a", doc, "application/pdf");
      expect(third.status).toBe(422);
      expect((await body(third)).error.details.code).toBe("draft_upload_cap");
      expect((await db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerId, id), eq(mediaFiles.ownerType, "form_submission")))).filter((m) => m.deletedAt === null)).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.FORM_DRAFT_MAX_BYTES_PER_USER;
      else process.env.FORM_DRAFT_MAX_BYTES_PER_USER = previous;
    }
  });

  it("sweeps drafts idle for more than the TTL with their files, and nothing else", async () => {
    const who = await applicant("sweep");
    const old = await draftId(who);
    const fresh = await draftId(who);
    const submitted = await draftId(who);
    expect((await upload(who, old, "doc_a", PDF_BYTES, "application/pdf")).status).toBe(201);
    const [fileRow] = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, old));
    expect((await submit(who, submitted, { category: "aktiv", privacy_consent: true, nick: "GEHEIM-SWEEP" })).status).toBe(200);
    const longAgo = new Date(Date.now() - 31 * DAY);
    await db.update(formSubmissions).set({ updatedAt: longAgo }).where(inArray(formSubmissions.id, [old, submitted]));

    const result = await sweepStaleFormDrafts();
    expect(result.drafts).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(formSubmissions).where(eq(formSubmissions.id, old))).toEqual([]);
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, fileRow!.storageKey)))[0]!.deletedAt).not.toBeNull();
    expect(await db.select().from(formSubmissions).where(inArray(formSubmissions.id, [fresh, submitted]))).toHaveLength(2);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, old), eq(auditLog.eventType, "form_submission.draft_swept")));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.payload)).not.toContain("GEHEIM");
    // A draft edited within the TTL stays.
    await db.update(formSubmissions).set({ updatedAt: new Date(Date.now() - 29 * DAY) }).where(eq(formSubmissions.id, fresh));
    await sweepStaleFormDrafts();
    expect(await db.select().from(formSubmissions).where(eq(formSubmissions.id, fresh))).toHaveLength(1);
  });

  it("removes registry entries of form submissions that never got a file row (hard failure between upload and commit)", async () => {
    const who = await applicant("orphan");
    const id = await draftId(who);
    const media = await storeUpload({ file: new File([new Uint8Array(makePng())], "o.png", { type: "image/png" }), clubId: h.clubId, kind: "image", allowedTypes: IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES, owner: { type: "form_submission", id }, uploadedBy: who.userId });
    await sweepStaleFormDrafts();
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, media.storageKey)))[0]!.deletedAt).toBeNull(); // too young
    await db.update(mediaFiles).set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(mediaFiles.storageKey, media.storageKey));
    const result = await sweepStaleFormDrafts();
    expect(result.orphans).toBeGreaterThanOrEqual(1);
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, media.storageKey)))[0]!.deletedAt).not.toBeNull();
  });

  // --- M4: defaults ----------------------------------------------------------------------------------------

  it("seeds the standard forms atomically (parallel callers), repairs a form without a published version and does not write on reads", async () => {
    const fresh = await createClub("h6", suffix);
    extraClubs.push(fresh);
    await Promise.all(Array.from({ length: 8 }, () => ensureClubFormDefaults(fresh.clubId)));
    const rows = await db.select({ id: forms.id, purpose: forms.purpose, v: formVersions.version, status: formVersions.status }).from(forms).innerJoin(formVersions, eq(formVersions.formId, forms.id)).where(eq(forms.clubId, fresh.clubId));
    expect(rows.map((r) => `${r.purpose}:${r.v}:${r.status}`).sort()).toEqual(["aufnahme:1:published", "austritt:1:published"]);

    // Broken state: active form, no published version, an open draft.
    const aufnahme = rows.find((r) => r.purpose === "aufnahme")!;
    await db.delete(formVersions).where(eq(formVersions.formId, aufnahme.id));
    await db.insert(formVersions).values({ formId: aufnahme.id, version: 1, status: "draft", fields: [] });
    expect((await call(fresh.founder, `/club-forms/${fresh.slug}/aufnahme`)).status).toBe(200); // repaired on this access
    const versions = await db.select().from(formVersions).where(eq(formVersions.formId, aufnahme.id));
    expect(versions.map((v) => `${v.version}:${v.status}`).sort()).toEqual(["2:published", "3:draft"]);

    // Reads leave a complete club alone: a category deleted behind the back stays deleted.
    await db.delete(memberCategories).where(and(eq(memberCategories.clubId, fresh.clubId), eq(memberCategories.key, "ehrenmitglied")));
    expect((await call(fresh.founder, `/club-forms/${fresh.slug}/aufnahme`)).status).toBe(200);
    expect(await db.select().from(memberCategories).where(and(eq(memberCategories.clubId, fresh.clubId), eq(memberCategories.key, "ehrenmitglied")))).toEqual([]);
  }, 60_000);

  // --- L3: upload failure cleanup ----------------------------------------------------------------------------

  it("leaves no registered file behind when an upload loses against a parallel submit", async () => {
    const who = await applicant("raceup");
    const id = await draftId(who);
    expect((await patch(who, id, { category: "aktiv", privacy_consent: true })).status).toBe(200);
    const results = await Promise.all([
      submit(who, id),
      upload(who, id, "doc_a", PDF_BYTES, "application/pdf"),
      upload(who, id, "doc_b", PDF_BYTES, "application/pdf"),
      upload(who, id, "photo", makePng(), "image/png"),
    ]);
    expect(results[0]!.status).toBe(200);
    const live = await db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerType, "form_submission"), eq(mediaFiles.ownerId, id), isNull(mediaFiles.deletedAt)));
    const fileRows = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, id));
    // Every live registry entry has a file row, and the other way round: nothing orphaned either way.
    expect(live.map((m) => m.storageKey).sort()).toEqual(fileRows.map((f) => f.storageKey).sort());
    for (const r of results.slice(1)) expect([201, 409]).toContain(r.status);
  });

  // --- L4: lenient draft validation --------------------------------------------------------------------------

  it("lets a PATCH through when an UNCHANGED answer became invalid, and names the key on submit", async () => {
    const who = await applicant("lenient");
    const id = await draftId(who);
    expect((await patch(who, id, { category: "passiv", nick: "Mo" })).status).toBe(200);
    const passiv = await categoryId("passiv");
    expect([200, 204]).toContain((await call(h.founder, `/club-members/categories/${passiv}`, { method: "DELETE", clubId: h.clubId })).status);

    const ok = await patch(who, id, { nick: "Moritz" });
    expect(ok.status).toBe(200);
    expect((await body(ok)).data.submission.answers).toEqual({ category: "passiv", nick: "Moritz" });
    // Changing the broken key itself is still validated.
    expect((await patch(who, id, { category: "passiv" })).status).toBe(422);

    const res = await submit(who, id, { privacy_consent: true });
    expect(res.status).toBe(422);
    expect((await body(res)).error.details.fields).toEqual({ category: "not_an_option" });
    expect((await patch(who, id, { category: "aktiv" })).status).toBe(200);
    expect((await submit(who, id, { privacy_consent: true })).status).toBe(200);
  });

  // --- L5: editor caps and audit ---------------------------------------------------------------------------

  it("caps active forms per club and versions per form, and audits draft saves without content", async () => {
    const c = await createClub("h7", suffix);
    extraClubs.push(c);
    await ensureClubFormDefaults(c.clubId);
    let last = 0;
    let firstId = "";
    for (let i = 0; i < 49; i++) {
      const res = await call(c.founder, "/forms", { method: "POST", clubId: c.clubId, body: { purpose: "umfrage", name: `Umfrage ${i}` } });
      last = res.status;
      if (i === 0) firstId = (await body(res)).data.form.id;
      if (last !== 201) break;
    }
    expect(last).toBe(409); // 2 standard + 48 = 50 active, the 49th creation is refused
    const full = await call(c.founder, "/forms", { method: "POST", clubId: c.clubId, body: { purpose: "umfrage", name: "Zu viel" } });
    expect((await body(full)).error.details.code).toBe("form_limit");

    expect((await call(c.founder, `/forms/${firstId}/draft`, { method: "PUT", clubId: c.clubId, body: { fields: [{ key: "dish", type: "text", label: "GEHEIM-LABEL" }] } })).status).toBe(200);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, firstId), eq(auditLog.eventType, "form.draft_save")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ clubId: c.clubId, version: 1, fieldCount: 1 });
    expect(JSON.stringify(audit[0]!.payload)).not.toContain("GEHEIM");

    await db.delete(formVersions).where(eq(formVersions.formId, firstId));
    await db.insert(formVersions).values(Array.from({ length: 200 }, (_, i) => ({ formId: firstId, version: i + 1, status: "archived", fields: [] })));
    const capped = await call(c.founder, `/forms/${firstId}/draft`, { method: "PUT", clubId: c.clubId, body: { fields: [] } });
    expect(capped.status).toBe(409);
    expect((await body(capped)).error.details.code).toBe("version_limit");
  }, 90_000);

  // --- M5: sensitive flag -----------------------------------------------------------------------------------

  it("checks the sensitive flag at publish: no master-data mapping, custom fields must be sensitive too", async () => {
    const fields = (extra: unknown[]) => aufnahmeFields(extra);
    const save = (f: unknown[]) => call(h.founder, `/forms/${formId}/draft`, { method: "PUT", clubId: h.clubId, body: { fields: f, privacyNotice: "Text" } });
    const problems = async () => (await body(await call(h.founder, `/forms/${formId}/publish`, { method: "POST", clubId: h.clubId }))).error.details.problems;
    try {
      expect((await save(fields([{ key: "street", type: "text", label: "Straße", sensitive: true, mapsTo: "street" }]))).status).toBe(200);
      expect(await problems()).toEqual([{ code: "sensitive_mapping_not_allowed", fieldKey: "street" }]);

      await db.insert(memberFieldDefinitions).values({ clubId: h.clubId, key: "allergien", label: "Allergien", fieldType: "textarea", sensitive: false });
      const allergy = [{ key: "allergy", type: "textarea", label: "Allergien", sensitive: true, customField: "allergien" }];
      expect((await save(fields(allergy))).status).toBe(200);
      expect(await problems()).toEqual([{ code: "custom_field_not_sensitive", fieldKey: "allergy" }]);

      await db.update(memberFieldDefinitions).set({ sensitive: true }).where(and(eq(memberFieldDefinitions.clubId, h.clubId), eq(memberFieldDefinitions.key, "allergien")));
      expect((await call(h.founder, `/forms/${formId}/publish`, { method: "POST", clubId: h.clubId })).status).toBe(200);
      // The applicant definition carries the flag (a hint for the client) but never the custom-field key.
      const def = (await body(await call(h.founder, `/club-forms/${h.slug}/aufnahme`))).data;
      const field = def.fields.find((f: { key: string }) => f.key === "allergy");
      expect(field.sensitive).toBe(true);
      expect(field.customField).toBeUndefined();
    } finally {
      await call(h.founder, `/forms/${formId}/draft`, { method: "DELETE", clubId: h.clubId });
    }
  });

  // --- L6: withdraw after a decision ------------------------------------------------------------------------

  it("refuses to withdraw once the board decided (decided_at set)", async () => {
    const who = await applicant("decided");
    const id = await draftId(who);
    expect((await submit(who, id, { category: "aktiv", privacy_consent: true })).status).toBe(200);
    await db.update(formSubmissions).set({ decidedAt: new Date() }).where(eq(formSubmissions.id, id));
    const res = await call(who, `/form-submissions/${id}/withdraw`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((await body(res)).error.details.code).toBe("submission_not_withdrawable");
    expect((await db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, id) }))!.status).toBe("submitted");
  });
});
