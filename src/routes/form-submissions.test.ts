import { stat } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { forms, formSubmissionFiles, formSubmissions, formVersions } from "../db/schema/forms.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { logger } from "../lib/logger.js";
import { GPS_MARKER, makeJpeg, makePng, makeWebp, PDF_BYTES } from "../lib/media-fixtures.js";
import { getObject, UPLOADS_DIR } from "../lib/storage.js";
import { storeUpload, IMAGE_TYPES, MAX_IMAGE_BYTES } from "../lib/media.js";
import { clubFormRoutes } from "./club-forms.js";
import { formRoutes } from "./forms.js";
import { formSubmissionRoutes } from "./form-submissions.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/**
 * Integration test of the applicant side (Wave 8 B5) against a real Postgres: draft/patch/submit lifecycle with
 * server-side validation, FORM_VERSION_OUTDATED and re-pinning, file uploads through the media layer (allowlist, magic
 * bytes, size, count, replace, claim, sensitivity, tombstones), IDOR, board download with audit, rate limits, races and
 * privacy (no answer content in responses of errors, logs or audit entries).
 */

const app = new Hono();
app.route("/forms", formRoutes);
app.route("/club-forms", clubFormRoutes);
app.route("/form-submissions", formSubmissionRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
const MARKER = "GEHEIM-MARKER-4711";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const body = async (res: Response) => (await res.json()) as any;
const png = () => makePng();
const fileForm = (fieldKey: string | null, bytes: Buffer, name: string, type: string) => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], name, { type }));
  if (fieldKey !== null) fd.append("fieldKey", fieldKey);
  return fd;
};

const CUSTOM_FIELDS = [
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "sport", type: "select", label: "Sport", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  { key: "sport_note", type: "text", label: "Notiz", visibleIf: { fieldKey: "sport", op: "eq", value: "a" } },
  { key: "scan", type: "file", label: "Nachweis", required: true, visibleIf: { fieldKey: "sport", op: "eq", value: "b" } },
  { key: "extra_doc", type: "file", label: "Weitere Datei" },
  { key: "photo", type: "image", label: "Foto", mapsTo: "photo" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutz" },
  { key: "privacy_consent", type: "consent", label: "Einwilligung", required: true },
];

describe("form submissions (applicant side)", () => {
  let a: Awaited<ReturnType<typeof createClub>>;
  let c: Awaited<ReturnType<typeof createClub>>;
  let b: Awaited<ReturnType<typeof createClub>>;
  let formCId: string;
  const applicants: Account[] = [];
  const logged: unknown[][] = [];

  const newApplicant = async (label: string) => {
    const acc = await signUpAndVerify(`subm-${label}-${suffix}@example.com`, `Applicant ${label}`);
    applicants.push(acc);
    return acc;
  };
  const createDraft = (who: Account, club: { slug: string }, extra: Record<string, unknown> = {}) => call(who, "/form-submissions", { method: "POST", body: { clubSlug: club.slug, ...extra } });
  const draftId = async (who: Account, club: { slug: string }, extra: Record<string, unknown> = {}) => {
    const res = await createDraft(who, club, extra);
    expect(res.status).toBe(201);
    return (await body(res)).data.submission.id as string;
  };
  const patch = (who: Account, id: string, payload: unknown) => call(who, `/form-submissions/${id}`, { method: "PATCH", body: payload });
  const upload = (who: Account, id: string, fieldKey: string | null, bytes: Buffer, name: string, type: string) => call(who, `/form-submissions/${id}/files`, { method: "POST", form: fileForm(fieldKey, bytes, name, type) });
  const submit = (who: Account, id: string, payload: unknown = {}) => call(who, `/form-submissions/${id}/submit`, { method: "POST", body: payload });
  const getSub = async (who: Account, id: string) => (await body(await call(who, `/form-submissions/${id}`))).data;
  const rowOf = (id: string) => db.query.formSubmissions.findFirst({ where: eq(formSubmissions.id, id) });

  beforeAll(async () => {
    a = await createClub("sa", suffix, { member: null });
    b = await createClub("sb", suffix);
    c = await createClub("sc", suffix, { member: null });
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(args);
      }) as never);
    }
    // Club C gets a custom form (v2) with conditions and file fields.
    const list = (await body(await call(c.founder, "/forms", { clubId: c.clubId }))).data as Array<{ id: string; purpose: string }>;
    formCId = list.find((f) => f.purpose === "aufnahme")!.id;
    expect((await call(c.founder, `/forms/${formCId}/draft`, { method: "PUT", clubId: c.clubId, body: { fields: CUSTOM_FIELDS } })).status).toBe(200);
    expect((await call(c.founder, `/forms/${formCId}/publish`, { method: "POST", clubId: c.clubId })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await dropClubs([a.clubId, b.clubId, c.clubId], [...a.userIds, ...b.userIds, ...c.userIds, ...applicants.map((x) => x.userId)]);
    await closeDatabase();
  });

  // --- creating ------------------------------------------------------------------------------------------

  it("requires a session and a known club", async () => {
    expect((await app.request("/form-submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clubSlug: a.slug }) })).status).toBe(401);
    expect((await app.request("/form-submissions/mine")).status).toBe(401);
    const who = await newApplicant("known");
    expect((await createDraft(who, { slug: "no-such-club" })).status).toBe(404);
    expect((await call(who, "/form-submissions", { method: "POST", body: {} })).status).toBe(422);
  });

  it("creates a draft pinned to the published version (by slug or id) with optional validated answers", async () => {
    const who = await newApplicant("create");
    const res = await createDraft(who, a, { answers: { category: "aktiv", birth_date: "2010-05-17" } });
    expect(res.status).toBe(201);
    const sub = (await body(res)).data.submission;
    expect(sub).toMatchObject({ status: "draft", onBehalfOf: "self", clubId: a.clubId, answers: { category: "aktiv", birth_date: "2010-05-17" }, files: [] });
    const row = await rowOf(sub.id);
    expect(row!.submittedByUserId).toBe(who.userId);
    expect(row!.formVersionId).toBe(sub.formVersionId);

    const byId = await call(who, "/form-submissions", { method: "POST", body: { clubId: a.clubId, formVersionId: sub.formVersionId } });
    expect(byId.status).toBe(201);
    // Not an Aufnahme form / not the self variant: refused (child application is B8).
    expect((await createDraft(who, a, { purpose: "austritt" })).status).toBe(422);
    expect((await createDraft(who, a, { onBehalfOf: "guardian" })).status).toBe(422);
    // Invalid initial answers are not stored.
    const before = (await body(await call(who, "/form-submissions/mine"))).data.length;
    const bad = await createDraft(who, a, { answers: { category: "no-such-category" } });
    expect(bad.status).toBe(422);
    expect((await body(bad)).error.details.fields).toEqual({ category: "not_an_option" });
    expect((await body(await call(who, "/form-submissions/mine"))).data.length).toBe(before);
  });

  it("refuses members, caps open drafts per club and creates at most the cap under parallel requests", async () => {
    const member = a.members.member!;
    const res = await createDraft(member, a);
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("ALREADY_MEMBER");

    const who = await newApplicant("cap");
    const results = await Promise.all(Array.from({ length: 6 }, () => createDraft(who, a)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409, 409, 409]);
    const conflict = results.find((r) => r.status === 409)!;
    expect((await body(conflict)).error.details.code).toBe("draft_limit");
  });

  it("rate-limits creating drafts per user", async () => {
    const who = await newApplicant("ratec");
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await createDraft(who, a)).status);
    expect(statuses.slice(0, 3)).toEqual([201, 201, 201]);
    expect(statuses.slice(3, 20).every((s) => s === 409)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  // --- editing -------------------------------------------------------------------------------------------

  it("merges answers on PATCH, removes with null and validates server-side without echoing values", async () => {
    const who = await newApplicant("patch");
    const id = await draftId(who, c);
    const first = await body(await patch(who, id, { answers: { sport: "a", sport_note: MARKER } }));
    expect(first.data.submission.answers).toEqual({ sport: "a", sport_note: MARKER });
    const second = await body(await patch(who, id, { answers: { category: "aktiv", sport_note: null } }));
    expect(second.data.submission.answers).toEqual({ sport: "a", category: "aktiv" });

    // Unknown / prototype keys / info + file keys / wrong types / bad options: 422 with codes only.
    for (const answers of [{ nope: 1 }, { privacy_notice: "x" }, { scan: "x" }, { category: MARKER }, { sport_note: 12345 }]) {
      const res = await patch(who, id, { answers });
      expect(res.status, JSON.stringify(Object.keys(answers))).toBe(422);
      expect(JSON.stringify(await body(res))).not.toContain(MARKER);
    }
    const protoReal = await app.request(`/form-submissions/${id}`, { method: "PATCH", headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": "proto" }, body: '{"answers":{"__proto__":{"polluted":true},"constructor":"x"}}' });
    expect(protoReal.status).toBe(422);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect((await getSub(who, id)).submission.answers).toEqual({ sport: "a", category: "aktiv" });
    // The hidden field is dropped when its condition stops holding.
    const flipped = await body(await patch(who, id, { answers: { sport: "b" } }));
    expect(flipped.data.submission.answers).toEqual({ sport: "b", category: "aktiv" });
  });

  it("answers 404 to everybody but the submitter for every route (IDOR) and for malformed ids", async () => {
    const owner = await newApplicant("idor-owner");
    const other = await newApplicant("idor-other");
    const id = await draftId(owner, c);
    const up = await upload(owner, id, "extra_doc", PDF_BYTES, "a.pdf", "application/pdf");
    expect(up.status).toBe(201);
    const fileId = (await body(up)).data.file.id;

    const probes: Array<[string, string, unknown?]> = [
      ["GET", `/form-submissions/${id}`],
      ["PATCH", `/form-submissions/${id}`, { answers: {} }],
      ["POST", `/form-submissions/${id}/submit`, {}],
      ["POST", `/form-submissions/${id}/withdraw`],
      ["DELETE", `/form-submissions/${id}/files/${fileId}`],
      ["GET", `/form-submissions/${id}/files/${fileId}`],
      ["GET", "/form-submissions/not-a-uuid"],
      ["GET", `/form-submissions/${id}/files/not-a-uuid`],
    ];
    for (const [method, p, payload] of probes) {
      const res = await call(other, p, { method, body: payload });
      expect(res.status, `${method} ${p}`).toBe(404);
    }
    const foreignUpload = await upload(other, id, "extra_doc", PDF_BYTES, "a.pdf", "application/pdf");
    expect(foreignUpload.status).toBe(404);
    // A file id of the owner's other submission does not resolve through a submission of the same owner.
    const second = await draftId(owner, c);
    expect((await call(owner, `/form-submissions/${second}/files/${fileId}`)).status).toBe(404);
    expect((await call(owner, `/form-submissions/${second}/files/${fileId}`, { method: "DELETE" })).status).toBe(404);
    expect((await body(await call(other, "/form-submissions/mine"))).data).toEqual([]);
    // The owner's submission is untouched.
    expect((await getSub(owner, id)).submission.files).toHaveLength(1);
  });

  // --- uploads -------------------------------------------------------------------------------------------

  it("stores a photo through the media layer: private path, registry row, EXIF stripped, signed URL, no storage key", async () => {
    const who = await newApplicant("photo");
    const id = await draftId(who, c);
    const res = await upload(who, id, "photo", makeJpeg(), "../../etc/passwd.jpg", "image/jpeg");
    expect(res.status).toBe(201);
    const text = JSON.stringify(await body(res.clone()));
    const file = (await body(res)).data.file;
    expect(file).toMatchObject({ fieldKey: "photo", kind: "image", mimeType: "image/jpeg" });
    expect(file.filename).not.toContain("/");
    expect(file.url).toMatch(/\/media\/forms\/.+\?exp=\d+&sig=/);
    expect(text).not.toContain("storageKey");

    const [fileRow] = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.id, file.id));
    expect(fileRow!.storageKey.startsWith(`forms/${c.clubId}/${id}/`)).toBe(true);
    const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, fileRow!.storageKey));
    expect(media).toMatchObject({ ownerType: "form_submission", ownerId: id, clubId: c.clubId, kind: "image", sensitive: false, visibility: "private", uploadedBy: who.userId, deletedAt: null });
    expect((await getObject(fileRow!.storageKey)).toString("latin1")).not.toContain(GPS_MARKER);

    // The owner sees the signed URL again; replacing the photo tombstones the old one.
    expect((await getSub(who, id)).submission.files[0].url).toMatch(/sig=/);
    const again = await upload(who, id, "photo", png(), "neu.png", "image/png");
    expect(again.status).toBe(201);
    const files = (await getSub(who, id)).submission.files;
    expect(files).toHaveLength(1);
    expect(files[0].mimeType).toBe("image/png");
    const [old] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, fileRow!.storageKey));
    expect(old!.deletedAt).not.toBeNull();
    await expect(stat(path.join(UPLOADS_DIR, fileRow!.storageKey))).rejects.toThrow();
  });

  it("stores documents as sensitive files without a URL", async () => {
    const who = await newApplicant("doc");
    const id = await draftId(who, c);
    const res = await upload(who, id, "extra_doc", PDF_BYTES, "zeugnis.pdf", "application/pdf");
    expect(res.status).toBe(201);
    const file = (await body(res)).data.file;
    expect(file).toMatchObject({ kind: "document", mimeType: "application/pdf", url: null });
    const [row] = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.id, file.id));
    const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, row!.storageKey));
    expect(media).toMatchObject({ sensitive: true, kind: "document", ownerType: "form_submission" });
    // A JPEG scan is fine in a file field too (and stays a sensitive document).
    expect((await upload(who, id, "extra_doc", makeJpeg(), "scan.jpg", "image/jpeg")).status).toBe(201);
  });

  it("rejects bad uploads: allowlist, magic bytes vs declared type, size, field rules, missing parts", async () => {
    const who = await newApplicant("badup");
    const id = await draftId(who, c);
    const expect422 = async (res: Response, why: string) => expect(res.status, why).toBe(422);
    await expect422(await upload(who, id, "extra_doc", Buffer.from("MZ\x90\x00 not an image"), "x.png", "image/png"), "exe as png");
    await expect422(await upload(who, id, "extra_doc", PDF_BYTES, "x.png", "image/png"), "pdf declared as png");
    await expect422(await upload(who, id, "extra_doc", makePng(), "x.pdf", "application/pdf"), "png declared as pdf");
    await expect422(await upload(who, id, "extra_doc", Buffer.from("hello text"), "x.txt", "text/plain"), "text");
    await expect422(await upload(who, id, "extra_doc", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "x.svg", "image/svg+xml"), "svg");
    await expect422(await upload(who, id, "extra_doc", makeWebp(), "x.webp", "image/webp"), "webp is not allowed in file fields");
    await expect422(await upload(who, id, "photo", PDF_BYTES, "x.pdf", "application/pdf"), "pdf in an image field");
    await expect422(await upload(who, id, "photo", Buffer.alloc(0), "empty.png", "image/png"), "empty");
    await expect422(await upload(who, id, "privacy_notice", png(), "x.png", "image/png"), "info field");
    await expect422(await upload(who, id, "category", png(), "x.png", "image/png"), "non-file field");
    await expect422(await upload(who, id, "no_such_field", png(), "x.png", "image/png"), "unknown field");
    await expect422(await upload(who, id, null, png(), "x.png", "image/png"), "missing fieldKey");
    const noFile = new FormData();
    noFile.append("fieldKey", "photo");
    await expect422(await call(who, `/form-submissions/${id}/files`, { method: "POST", form: noFile }), "missing file");
    const huge = Buffer.concat([PDF_BYTES, Buffer.alloc(11 * 1024 * 1024)]);
    await expect422(await upload(who, id, "extra_doc", huge, "huge.pdf", "application/pdf"), "11 MB");
    const bigPhoto = Buffer.concat([makePng(false), Buffer.alloc(MAX_IMAGE_BYTES / 2 + 100)]);
    await expect422(await upload(who, id, "photo", bigPhoto, "big.png", "image/png"), "photo above 5 MB");
    expect((await getSub(who, id)).submission.files).toEqual([]);
    expect(await db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerType, "form_submission"), eq(mediaFiles.ownerId, id)))).toEqual([]);
  });

  it("limits a submission to 5 files and rate-limits uploads per user", async () => {
    const who = await newApplicant("count");
    const id = await draftId(who, c);
    expect((await upload(who, id, "photo", png(), "p.png", "image/png")).status).toBe(201);
    for (let i = 0; i < 4; i++) expect((await upload(who, id, "extra_doc", PDF_BYTES, `d${i}.pdf`, "application/pdf")).status).toBe(201);
    const sixth = await upload(who, id, "extra_doc", PDF_BYTES, "d5.pdf", "application/pdf");
    expect(sixth.status).toBe(422);
    // Replacing the photo is still possible at the cap.
    expect((await upload(who, id, "photo", png(), "p2.png", "image/png")).status).toBe(201);

    const limited = await newApplicant("ratef");
    const lid = await draftId(limited, c);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await upload(limited, lid, "no_such_field", png(), "x.png", "image/png")).status);
    expect(statuses.slice(0, 30).every((s) => s === 422)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it("claims an unattached image of the same user and club exactly once", async () => {
    const who = await newApplicant("claim");
    const other = await newApplicant("claim-other");
    const id = await draftId(who, c);
    const unattached = async (user: Account, clubId: string) =>
      (await storeUpload({ file: new File([new Uint8Array(png())], "u.png", { type: "image/png" }), clubId, kind: "image", allowedTypes: IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES, uploadedBy: user.userId })).storageKey;
    const claim = (key: string, fieldKey = "photo") => call(who, `/form-submissions/${id}/files`, { method: "POST", body: { fieldKey, mediaKey: key } });

    expect((await claim("nope/missing.png")).status).toBe(422);
    expect((await claim(await unattached(other, c.clubId))).status).toBe(422); // somebody else's upload
    expect((await claim(await unattached(who, b.clubId))).status).toBe(422); // another club's upload
    const key = await unattached(who, c.clubId);
    expect((await claim(key, "extra_doc")).status).toBe(422); // documents are uploaded directly
    expect((await claim(key, "category")).status).toBe(422);
    const ok = await claim(key);
    expect(ok.status).toBe(201);
    expect((await body(ok)).data.file).toMatchObject({ fieldKey: "photo", kind: "image", url: expect.stringContaining("sig=") });
    const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, key));
    expect(media).toMatchObject({ ownerType: "form_submission", ownerId: id });
    expect((await claim(key)).status).toBe(422); // each upload can be claimed once
    const id2 = await draftId(who, c);
    expect((await call(who, `/form-submissions/${id2}/files`, { method: "POST", body: { fieldKey: "photo", mediaKey: key } })).status).toBe(422);
    expect((await call(who, `/form-submissions/${id}/files`, { method: "POST", body: { fieldKey: "photo" } })).status).toBe(422);
  });

  it("deletes a file (row, registry tombstone, bytes) while the submission is a draft", async () => {
    const who = await newApplicant("del");
    const id = await draftId(who, c);
    const fileId = (await body(await upload(who, id, "extra_doc", PDF_BYTES, "x.pdf", "application/pdf"))).data.file.id;
    const [row] = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.id, fileId));
    expect((await call(who, `/form-submissions/${id}/files/${fileId}`, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.id, fileId))).toEqual([]);
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, row!.storageKey)))[0]!.deletedAt).not.toBeNull();
    await expect(stat(path.join(UPLOADS_DIR, row!.storageKey))).rejects.toThrow();
    expect((await call(who, `/form-submissions/${id}/files/${fileId}`, { method: "DELETE" })).status).toBe(404);
  });

  // --- submit --------------------------------------------------------------------------------------------

  it("submits against the pinned version: required fields, hidden fields and files, conditions", async () => {
    const who = await newApplicant("submit");
    const id = await draftId(who, c);
    const empty = await submit(who, id);
    expect(empty.status).toBe(422);
    expect((await body(empty)).error.details.fields).toEqual({ category: "required", privacy_consent: "required" });

    // sport = b makes the scan mandatory (a required file field).
    await patch(who, id, { answers: { category: "aktiv", privacy_consent: true, sport: "b" } });
    const noScan = await submit(who, id);
    expect((await body(noScan)).error.details.fields).toEqual({ scan: "required" });
    const scanId = (await body(await upload(who, id, "scan", PDF_BYTES, "scan.pdf", "application/pdf"))).data.file.id;
    const [scanRow] = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.id, scanId));

    // Final answers are sent with the submit; sport = a hides the scan again -> its file is dropped, the note counts.
    const ok = await submit(who, id, { answers: { sport: "a", sport_note: MARKER } });
    expect(ok.status).toBe(200);
    const done = (await body(ok)).data.submission;
    expect(done).toMatchObject({ status: "submitted", answers: { category: "aktiv", privacy_consent: true, sport: "a", sport_note: MARKER }, files: [] });
    expect(done.submittedAt).toBeTruthy();
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, scanRow!.storageKey)))[0]!.deletedAt).not.toBeNull();

    // Submitted means frozen.
    expect((await submit(who, id)).status).toBe(409);
    expect((await patch(who, id, { answers: { sport: "b" } })).status).toBe(409);
    expect((await upload(who, id, "extra_doc", PDF_BYTES, "x.pdf", "application/pdf")).status).toBe(409);
    expect((await call(who, `/form-submissions/${id}/files/${scanId}`, { method: "DELETE" })).status).toBe(409);

    // One open application per user and club.
    const second = await createDraft(who, c);
    expect(second.status).toBe(409);
    expect((await body(second)).error.code).toBe("APPLICATION_PENDING");
  });

  it("lets only one of several parallel submits win", async () => {
    const who = await newApplicant("race");
    const id = await draftId(who, a, { answers: { category: "aktiv", privacy_consent: true } });
    const results = await Promise.all(Array.from({ length: 5 }, () => submit(who, id)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect((await rowOf(id))!.status).toBe("submitted");
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, id), eq(auditLog.eventType, "form_submission.submit")));
    expect(audit).toHaveLength(1);
  });

  it("completes the standard form end to end (club with the default form)", async () => {
    const who = await newApplicant("std");
    const form = (await body(await call(who, `/club-forms/${a.slug}/aufnahme`))).data;
    expect(form.fields.map((f: { key: string }) => f.key)).toEqual(["category", "birth_date", "photo", "privacy_notice", "privacy_consent"]);
    const id = await draftId(who, a, { formVersionId: form.formVersionId });
    expect((await submit(who, id, { answers: { category: "aktiv" } })).status).toBe(422); // consent missing
    const ok = await submit(who, id, { answers: { category: "aktiv", privacy_consent: true } });
    expect(ok.status).toBe(200);
    expect((await body(ok)).data.submission.status).toBe("submitted");
    // The consent is evidence of the pinned version: submission -> version id -> immutable text.
    expect((await rowOf(id))!.formVersionId).toBe(form.formVersionId);
  });

  // --- withdraw / mine -----------------------------------------------------------------------------------

  it("withdraws a draft or submitted application, deletes its files and allows a new one", async () => {
    const who = await newApplicant("withdraw");
    const id = await draftId(who, c, { answers: { category: "aktiv", privacy_consent: true } });
    const fileId = (await body(await upload(who, id, "photo", png(), "p.png", "image/png"))).data.file.id;
    const [row] = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.id, fileId));
    expect((await submit(who, id)).status).toBe(200);

    const res = await call(who, `/form-submissions/${id}/withdraw`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await body(res)).data.submission).toMatchObject({ status: "withdrawn", files: [], answers: { category: "aktiv", privacy_consent: true } });
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, row!.storageKey)))[0]!.deletedAt).not.toBeNull();
    expect((await call(who, `/form-submissions/${id}/withdraw`, { method: "POST" })).status).toBe(409);
    expect((await patch(who, id, { answers: {} })).status).toBe(409);
    expect((await createDraft(who, c)).status).toBe(201);

    const draft = await draftId(who, c);
    expect((await call(who, `/form-submissions/${draft}/withdraw`, { method: "POST" })).status).toBe(200);
  });

  it("lists only the caller's own submissions with club info", async () => {
    const who = await newApplicant("mine");
    const id = await draftId(who, c);
    const list = (await body(await call(who, "/form-submissions/mine"))).data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, purpose: "aufnahme", version: 2, club: { id: c.clubId, slug: c.slug } });
    expect(Object.keys(list[0].club).sort()).toEqual(["id", "name", "slug"]);
  });

  // --- board access to files -----------------------------------------------------------------------------

  it("lets the board download files of SUBMITTED applications only, audited, nobody else", async () => {
    const who = await newApplicant("board");
    const id = await draftId(who, c, { answers: { category: "aktiv", privacy_consent: true } });
    const photo = (await body(await upload(who, id, "photo", png(), "p.png", "image/png"))).data.file.id;
    const doc = (await body(await upload(who, id, "extra_doc", PDF_BYTES, "d.pdf", "application/pdf"))).data.file.id;
    const plainMember = c.members.member!;

    // Draft: the board cannot see it (404), the submitter can.
    expect((await call(c.founder, `/form-submissions/${id}/files/${photo}`)).status).toBe(404);
    expect((await call(who, `/form-submissions/${id}/files/${photo}`)).status).toBe(200);
    expect((await submit(who, id)).status).toBe(200);

    const img = await call(c.founder, `/form-submissions/${id}/files/${photo}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toMatch(/^inline/);
    expect(img.headers.get("cache-control")).toContain("no-store");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    const pdf = await call(c.founder, `/form-submissions/${id}/files/${doc}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(Buffer.from(await pdf.arrayBuffer()).equals(PDF_BYTES)).toBe(true);

    // Audit entries for both retrievals (never skipped), carrying who and why but no content.
    const entries = await db.select().from(auditLog).where(eq(auditLog.subjectId, id));
    const access = entries.filter((e) => e.eventType === "form_submission.file_access" || e.eventType === "media.sensitive_access");
    expect(access.map((e) => e.eventType).sort()).toEqual(["form_submission.file_access", "form_submission.file_access", "media.sensitive_access"]);
    expect(access.filter((e) => (e.payload as { reason?: string }).reason === "form_submission:board")).toHaveLength(2);
    expect(access.some((e) => e.eventType === "media.sensitive_access" && (e.payload as { accessedBy: string }).accessedBy === c.founder.userId)).toBe(true);

    // Not allowed: plain member of the club, board of another club, a stranger.
    for (const [label, acc] of [["plain member", plainMember], ["other board", b.founder], ["stranger", await newApplicant("stranger")]] as const) {
      expect((await call(acc, `/form-submissions/${id}/files/${photo}`)).status, label).toBe(404);
      expect((await call(acc, `/form-submissions/${id}/files/${doc}`)).status, label).toBe(404);
    }
    // The submitter sees their own documents too (audited).
    expect((await call(who, `/form-submissions/${id}/files/${doc}`)).status).toBe(200);
    // Board rights do not leak to the rest of the submission API.
    expect((await call(c.founder, `/form-submissions/${id}`)).status).toBe(404);
    expect((await call(c.founder, `/form-submissions/${id}/withdraw`, { method: "POST" })).status).toBe(404);
  });

  // --- versions ------------------------------------------------------------------------------------------

  it("answers a stale draft with 409 FORM_VERSION_OUTDATED, re-pins it and keeps the answers by key", async () => {
    const who = await newApplicant("outdated");
    const keeper = await newApplicant("outdated-keeper");
    const id = await draftId(who, c, { answers: { category: "aktiv", sport: "a", sport_note: MARKER } });
    const photoId = (await body(await upload(who, id, "photo", png(), "p.png", "image/png"))).data.file.id;
    const docId = (await body(await upload(who, id, "extra_doc", PDF_BYTES, "d.pdf", "application/pdf"))).data.file.id;
    const [docRow] = await db.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.id, docId));
    const oldVersion = (await rowOf(id))!.formVersionId;

    // The board publishes v3: sport_note and extra_doc vanish, a new required field appears, the category label stays.
    const v3 = CUSTOM_FIELDS.filter((f) => !["sport_note", "extra_doc"].includes(f.key)).concat([{ key: "motivation", type: "text", label: "Warum?", required: true } as never]);
    expect((await call(c.founder, `/forms/${formCId}/draft`, { method: "PUT", clubId: c.clubId, body: { fields: v3 } })).status).toBe(200);
    expect((await call(c.founder, `/forms/${formCId}/publish`, { method: "POST", clubId: c.clubId })).status).toBe(200);

    // Reads still work and say it is outdated; the old definition stays renderable.
    const read = await getSub(who, id);
    expect(read.outdated).toBe(true);
    expect(read.form.version).toBe(2);

    // Every write against the old version is refused with the new definition attached.
    for (const res of [await patch(who, id, { answers: { sport: "b" } }), await submit(who, id), await upload(who, id, "photo", png(), "q.png", "image/png")]) {
      expect(res.status).toBe(409);
      const err = (await body(res)).error;
      expect(err.code).toBe("FORM_VERSION_OUTDATED");
      expect(err.details.submissionId).toBe(id);
      expect(err.details.currentVersion.version).toBe(3);
      expect(err.details.currentVersion.fields.map((f: { key: string }) => f.key)).toContain("motivation");
      expect(JSON.stringify(err)).not.toContain(MARKER);
      expect(JSON.stringify(err)).not.toContain("mapsTo");
    }
    // Wrong target: an unknown / old version id cannot be re-pinned to.
    expect((await patch(who, id, { formVersionId: oldVersion })).status).toBe(409);
    expect((await patch(who, id, { formVersionId: "00000000-0000-4000-8000-000000000009" })).status).toBe(409);

    // A new draft after the publish is pinned to v3; asking for the old version id is refused the same way.
    const stale = await call(keeper, "/form-submissions", { method: "POST", body: { clubSlug: c.slug, formVersionId: oldVersion } });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error.code).toBe("FORM_VERSION_OUTDATED");

    // Re-pin: answers carried over by key, dropped ones reported, files of vanished fields removed, photo kept.
    const current = (await body(await call(who, `/club-forms/${c.slug}/aufnahme`))).data;
    const moved = await patch(who, id, { formVersionId: current.formVersionId, answers: { motivation: "Sport" } });
    expect(moved.status).toBe(200);
    const result = (await body(moved)).data;
    expect(result).toMatchObject({ repinned: true, droppedAnswerKeys: ["sport_note"] });
    expect(result.submission.answers).toEqual({ category: "aktiv", sport: "a", motivation: "Sport" });
    expect(result.submission.formVersionId).toBe(current.formVersionId);
    expect(result.submission.files.map((f: { id: string }) => f.id)).toEqual([photoId]);
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, docRow!.storageKey)))[0]!.deletedAt).not.toBeNull();
    expect((await getSub(who, id)).outdated).toBe(false);

    const done = await submit(who, id, { answers: { privacy_consent: true } });
    expect(done.status).toBe(200);
    // Old submissions keep their version: the first one of this suite is still on v2.
    const v2Submissions = await db.select().from(formSubmissions).where(and(eq(formSubmissions.clubId, c.clubId), eq(formSubmissions.status, "submitted")));
    expect(v2Submissions.some((s) => s.formVersionId === oldVersion)).toBe(true);
    expect((await rowOf(id))!.formVersionId).toBe(current.formVersionId);
  });

  it("reports FORM_VERSION_OUTDATED with a null definition when the club has no such form", async () => {
    const who = await newApplicant("noform");
    const id = await draftId(who, c);
    // Simulate the window between archiving and the lazy standard form: archive without re-seeding.
    await db.update(forms).set({ archivedAt: new Date() }).where(eq(forms.id, formCId));
    await db.update(formVersions).set({ status: "archived" }).where(and(eq(formVersions.formId, formCId), eq(formVersions.status, "published")));
    const res = await submit(who, id);
    expect(res.status).toBe(409);
    const err = (await body(res)).error;
    expect(err.code).toBe("FORM_VERSION_OUTDATED");
    expect(err.details.currentVersion).toBeNull();
  });

  // --- privacy -------------------------------------------------------------------------------------------

  it("never writes answer contents to logs or audit entries", async () => {
    const all = await db.select().from(auditLog);
    const subs = await db.select({ id: formSubmissions.id }).from(formSubmissions).where(eq(formSubmissions.clubId, c.clubId));
    const ids = new Set(subs.map((s) => s.id));
    const mine = all.filter((e) => e.subjectId !== null && ids.has(e.subjectId));
    expect(mine.length).toBeGreaterThan(10);
    expect(JSON.stringify(mine)).not.toContain(MARKER);
    expect(JSON.stringify(logged)).not.toContain(MARKER);
  });
});
