import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications, type ClubApplicationRow } from "../db/schema/club-applications.js";
import { forms, formSubmissionFiles, formSubmissions, formVersions, type FormRow, type FormSubmissionFileRow, type FormSubmissionRow, type FormVersionRow } from "../db/schema/forms.js";
import { mediaFiles } from "../db/schema/media-files.js";
import type { DbExecutor } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { scheduleLazyCleanup } from "../lib/form-sweeper.js";
import { applicationPendingError, closeApplicationOfSubmission, createApplicationForSubmission } from "../lib/form-applications.js";
import { assertGuardianMayApply, checkChildAnswers, type ChildWarning, childUnsupportedError, supportsChildApplication } from "../lib/form-children.js";
import { FIELD_KEY_RE, validateAnswers, visibleFieldKeys, type FormField, type ValidateResult } from "../lib/form-schema.js";
import {
  ANSWERS_BODY_LIMIT,
  applicantCategories,
  applicantDefinition,
  assertMayApply,
  clubRoleTypesOf,
  draftMaxBytesPerUser,
  ensureFormBasics,
  findCurrentForm,
  invalidAnswers,
  isUuid,
  MAX_DRAFT_FILES_PER_USER_CLUB,
  MAX_DRAFTS_PER_CLUB,
  MAX_DRAFTS_PER_USER,
  MAX_FILES_PER_SUBMISSION,
  outdatedError,
  removeFiles,
  SLUG_RE,
  submissionsPerHour,
  uploadsPerHour,
} from "../lib/forms.js";
import {
  attachUploadedImage,
  deleteMedia,
  discardStoredFile,
  findMediaByKey,
  IMAGE_TYPES,
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
  MAX_PHOTO_BYTES,
  purgeMediaFile,
  signedMediaUrls,
  storeUpload,
  streamMedia,
  streamSensitiveMedia,
} from "../lib/media.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Applicant side, write part (Wave 8 B5): draft -> fill in -> upload files -> submit / withdraw. Session only (the
 * applicant has no club yet). Every route is scoped to the CALLER's own submissions -- someone else's id, file or a
 * malformed id is always 404 (IDOR); the one exception is the file download, which the club board
 * (`members:write`, submitted applications only) may also use. Answers are validated server-side against the version the
 * submission is pinned to; they are never written to logs or audit entries (ids and counts only).
 *
 * Files: only through the central media layer (`src/lib/media.ts`): `image` fields store a non-sensitive image
 * (signed URL after the permission check), `file` fields a SENSITIVE document (authenticated stream + audit entry).
 */
export const formSubmissionRoutes = new Hono<SessionEnv>();

formSubmissionRoutes.use("*", sessionGuard);
formSubmissionRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120, key: (c) => `form-submissions:${c.get("user").id}` }));

const createLimiter = rateLimit({ windowMs: 60 * 60_000, max: submissionsPerHour(), key: (c) => `form-submission-create:${c.get("user").id}` });
const uploadLimiter = rateLimit({ windowMs: 60 * 60_000, max: uploadsPerHour(), key: (c) => `form-submission-upload:${c.get("user").id}` });
const deleteLimiter = rateLimit({ windowMs: 60 * 60_000, max: uploadsPerHour(), key: (c) => `form-submission-file-delete:${c.get("user").id}` });
const submitLimiter = rateLimit({ windowMs: 60 * 60_000, max: submissionsPerHour(), key: (c) => `form-submission-submit:${c.get("user").id}` });

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body");
};

const jsonLimit = bodyLimit({
  maxSize: ANSWERS_BODY_LIMIT,
  onError: () => {
    throw new ValidationError("Request body too large");
  },
});

const notFound = () => new NotFoundError("Submission not found");
const PURPOSE = "aufnahme" as const;
const FILE_FIELD_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

type Answers = Record<string, unknown>;
type Pinned = { form: FormRow; version: FormVersionRow };

// --- helpers -------------------------------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Answers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Copy with a null prototype: a key such as `__proto__` stays an ordinary own entry. */
function toAnswers(...sources: unknown[]): Answers {
  const out: Answers = Object.create(null);
  for (const source of sources) {
    if (source === undefined) continue;
    if (!isPlainRecord(source)) throw invalidAnswers({ _: "invalid_type" });
    for (const key of Object.keys(source)) out[key] = source[key];
  }
  return out;
}

async function lockUserClub(tx: DbExecutor, userId: string, clubId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`form-submission:${userId}:${clubId}`}, 0))`);
}

/** The caller's own submission; with `lock` the row is locked for the transaction. Foreign / unknown / malformed ids: 404. */
async function loadOwn(executor: DbExecutor, id: string, userId: string, lock = false): Promise<FormSubmissionRow> {
  if (!isUuid(id)) throw notFound();
  const query = executor
    .select()
    .from(formSubmissions)
    .where(and(eq(formSubmissions.id, id), eq(formSubmissions.submittedByUserId, userId)))
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound();
  return row;
}

async function loadPinned(executor: DbExecutor, formVersionId: string): Promise<Pinned> {
  const [row] = await executor
    .select({ form: forms, version: formVersions })
    .from(formVersions)
    .innerJoin(forms, eq(forms.id, formVersions.formId))
    .where(eq(formVersions.id, formVersionId))
    .limit(1);
  if (!row) throw new NotFoundError("Form version not found");
  return row;
}

function assertDraft(sub: FormSubmissionRow): void {
  if (sub.status !== "draft") throw new ConflictError("The submission can no longer be changed", { details: { code: "submission_not_editable", status: sub.status } });
}

async function currentDefinition(clubId: string, executor: DbExecutor) {
  const current = await findCurrentForm(clubId, PURPOSE, executor);
  return current ? applicantDefinition(current.form, current.version, await applicantCategories(clubId, executor)) : null;
}

/**
 * The version an operation runs against: the pinned one while it is still the published version of the club's
 * form. With `repinTo` naming the current published version a stale submission moves there. Anything else is
 * `409 FORM_VERSION_OUTDATED` carrying the current definition (null when the club has no such form right now).
 */
async function resolveTarget(tx: DbExecutor, sub: FormSubmissionRow, repinTo?: string): Promise<{ target: Pinned; repinned: boolean }> {
  const pinned = await loadPinned(tx, sub.formVersionId);
  const current = await findCurrentForm(sub.clubId, PURPOSE, tx);
  if (current && current.version.id === pinned.version.id && (repinTo === undefined || repinTo === pinned.version.id)) return { target: pinned, repinned: false };
  if (current && repinTo === current.version.id) return { target: current, repinned: true };
  throw outdatedError(await currentDefinition(sub.clubId, tx), sub.id);
}

/**
 * Draft validation for PATCH: only the keys the request CHANGES must be valid. A stored answer that became invalid
 * without the applicant touching it (an option or category the club archived in the meantime) neither blocks the edit
 * nor gets lost; submit validates everything strictly and names the key.
 */
function validateChanged(fields: readonly FormField[], stored: Answers, patch: unknown, categoryKeys: readonly string[]): Answers {
  const changed = new Set(isPlainRecord(patch) ? Object.keys(patch) : []);
  const candidate = toAnswers(stored, patch);
  const kept: Answers = {};
  for (let round = 0; round <= fields.length + 1; round++) {
    const result: ValidateResult = validateAnswers(fields, candidate, { mode: "draft", categoryKeys });
    if (result.ok) return { ...result.answers, ...kept };
    const bad = Object.keys(result.errors);
    if (bad.some((key) => changed.has(key) || !Object.hasOwn(candidate, key))) throw invalidAnswers(result.errors);
    for (const key of bad) {
      kept[key] = candidate[key];
      delete candidate[key];
    }
  }
  throw invalidAnswers({ _: "invalid_value" });
}

/** Answers that survive a move to another version: unknown keys and values the new field no longer accepts are dropped. */
function carryOver(fields: readonly FormField[], stored: unknown, categoryKeys: readonly string[]): { answers: Answers; dropped: string[] } {
  const answerable = new Set(fields.filter((f) => f.type !== "info" && f.type !== "file" && f.type !== "image").map((f) => f.key));
  const current: Answers = Object.create(null);
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(isPlainRecord(stored) ? stored : {})) {
    if (answerable.has(key)) current[key] = value;
    else dropped.push(key);
  }
  for (let round = 0; round <= fields.length; round++) {
    const result = validateAnswers(fields, current, { mode: "draft", categoryKeys });
    if (result.ok) return { answers: current, dropped };
    for (const key of Object.keys(result.errors)) {
      delete current[key];
      dropped.push(key);
    }
  }
  return { answers: Object.create(null), dropped: [...dropped, ...Object.keys(current)] };
}

type FileWithMedia = { file: FormSubmissionFileRow; kind: string | null; sensitive: boolean | null };

async function loadFiles(executor: DbExecutor, submissionIds: readonly string[]): Promise<FileWithMedia[]> {
  if (submissionIds.length === 0) return [];
  return executor
    .select({ file: formSubmissionFiles, kind: mediaFiles.kind, sensitive: mediaFiles.sensitive })
    .from(formSubmissionFiles)
    .leftJoin(mediaFiles, eq(mediaFiles.storageKey, formSubmissionFiles.storageKey))
    .where(inArray(formSubmissionFiles.submissionId, [...submissionIds]))
    .orderBy(formSubmissionFiles.createdAt, formSubmissionFiles.id);
}

const purgeAll = (keys: readonly string[]) => Promise.all(keys.map((key) => purgeMediaFile(key)));

/**
 * Response shape of a submission. The storage key never leaves the server: a file is addressed by its id (download
 * route) and carries a short-lived signed `url` for non-sensitive images only (null for documents).
 */
function submissionDto(sub: FormSubmissionRow, files: FileWithMedia[], urls: Map<string, string>) {
  return {
    id: sub.id,
    formId: sub.formId,
    formVersionId: sub.formVersionId,
    clubId: sub.clubId,
    onBehalfOf: sub.onBehalfOf,
    status: sub.status,
    answers: sub.answers,
    submittedAt: sub.submittedAt,
    decidedAt: sub.decidedAt,
    decisionNote: sub.decisionNote,
    createdAt: sub.createdAt,
    updatedAt: sub.updatedAt,
    files: files
      .filter((f) => f.file.submissionId === sub.id)
      .map(({ file, kind }) => ({ id: file.id, fieldKey: file.fieldKey, filename: file.filename, mimeType: file.mimeType, sizeBytes: file.sizeBytes, kind: kind ?? "document", url: urls.get(file.storageKey) ?? null, createdAt: file.createdAt })),
  };
}

async function shapeSubmissions(subs: FormSubmissionRow[], executor: DbExecutor = db) {
  const files = await loadFiles(executor, subs.map((s) => s.id));
  const urls = new Map<string, string>();
  for (const clubId of new Set(subs.map((s) => s.clubId))) {
    const keys = files.filter((f) => subs.find((s) => s.id === f.file.submissionId)?.clubId === clubId).map((f) => f.file.storageKey);
    for (const [key, url] of await signedMediaUrls(clubId, keys, "form_submission")) urls.set(key, url);
  }
  return subs.map((s) => submissionDto(s, files, urls));
}

// --- create ----------------------------------------------------------------------------------------------------

const createSchema = z
  .object({
    clubId: z.string().regex(SLUG_RE).optional(),
    clubSlug: z.string().regex(SLUG_RE).optional(),
    // Only the Aufnahme form is reachable for applicants in Wave 8. 'guardian' = a parent applies for a child (B8).
    purpose: z.literal(PURPOSE).optional(),
    onBehalfOf: z.enum(["self", "guardian"]).optional(),
    formVersionId: z.uuid().optional(),
    answers: z.unknown().optional(),
  })
  .refine((body) => body.clubId ?? body.clubSlug, { message: "clubId or clubSlug is required" });

formSubmissionRoutes.post("/", createLimiter, jsonLimit, zValidator("json", createSchema, validationHook), async (c) => {
  const userId = c.get("user").id;
  const body = c.req.valid("json");

  const org = await db.query.organization.findFirst({ where: body.clubId ? eq(organization.id, body.clubId) : eq(organization.slug, body.clubSlug!), columns: { id: true } });
  if (!org) throw new NotFoundError("Club not found");
  await ensureFormBasics(org.id);
  // The caller's own overdue drafts (and their files) go first, so they do not count against the draft caps.
  scheduleLazyCleanup({ userId });

  const created = await db.transaction(async (tx) => {
    await lockUserClub(tx, userId, org.id);
    // The cap over all clubs needs a user-wide lock (parallel drafts in two clubs).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`form-submission-user:${userId}`}, 0))`);
    const current = await findCurrentForm(org.id, PURPOSE, tx);
    if (!current) throw new NotFoundError("This club has no application form");
    const categories = await applicantCategories(org.id, tx);
    if (body.formVersionId !== undefined && body.formVersionId !== current.version.id) throw outdatedError(applicantDefinition(current.form, current.version, categories));

    const onBehalfOf = body.onBehalfOf ?? "self";
    await assertMayApply(tx, org.id, userId, onBehalfOf);
    if (onBehalfOf === "guardian") {
      if (!supportsChildApplication(current.version.fields as FormField[])) throw childUnsupportedError();
      // Counted under the user-wide lock taken above, so parallel drafts cannot exceed the cap.
      await assertGuardianMayApply(tx, { clubId: org.id, userId, emailVerified: c.get("user").emailVerified === true, countOpen: true });
    }
    const [{ drafts }] = await tx
      .select({ drafts: count() })
      .from(formSubmissions)
      .where(and(eq(formSubmissions.submittedByUserId, userId), eq(formSubmissions.clubId, org.id), eq(formSubmissions.status, "draft")));
    const [{ draftsAll }] = await tx.select({ draftsAll: count() }).from(formSubmissions).where(and(eq(formSubmissions.submittedByUserId, userId), eq(formSubmissions.status, "draft")));
    if (draftsAll >= MAX_DRAFTS_PER_USER) throw new ConflictError("Too many open drafts; continue or withdraw one", { details: { code: "draft_limit_user", limit: MAX_DRAFTS_PER_USER } });
    if (drafts >= MAX_DRAFTS_PER_CLUB) throw new ConflictError("Too many open drafts for this club; continue or withdraw one", { details: { code: "draft_limit", limit: MAX_DRAFTS_PER_CLUB } });

    let answers: Answers = {};
    if (body.answers !== undefined) {
      const result = validateAnswers(current.version.fields as FormField[], toAnswers(body.answers), { mode: "draft", categoryKeys: categories.map((k) => k.key) });
      if (!result.ok) throw invalidAnswers(result.errors);
      answers = result.answers;
    }
    const [row] = await tx
      .insert(formSubmissions)
      .values({ formId: current.form.id, formVersionId: current.version.id, clubId: org.id, submittedByUserId: userId, onBehalfOf, answers, status: "draft" })
      .returning();
    await tx.insert(auditLog).values({ eventType: "form_submission.create", subjectId: row!.id, payload: { clubId: org.id, formId: current.form.id, formVersionId: current.version.id, userId, onBehalfOf } });
    return row!;
  });
  return c.json({ data: { submission: (await shapeSubmissions([created]))[0] } }, 201);
});

// --- read ------------------------------------------------------------------------------------------------------

// Registered before "/:id" so "mine" is not read as an id.
formSubmissionRoutes.get("/mine", async (c) => {
  scheduleLazyCleanup({ userId: c.get("user").id });
  const rows = await db
    .select({ sub: formSubmissions, purpose: forms.purpose, version: formVersions.version, clubName: organization.name, clubSlug: organization.slug })
    .from(formSubmissions)
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .innerJoin(organization, eq(organization.id, formSubmissions.clubId))
    .where(eq(formSubmissions.submittedByUserId, c.get("user").id))
    .orderBy(desc(formSubmissions.createdAt), desc(formSubmissions.id))
    .limit(100);
  const shaped = await shapeSubmissions(rows.map((r) => r.sub));
  return c.json({
    data: rows.map((r, i) => ({ ...shaped[i]!, purpose: r.purpose, version: r.version, club: { id: r.sub.clubId, name: r.clubName, slug: r.clubSlug } })),
  });
});

formSubmissionRoutes.get("/:id", async (c) => {
  const sub = await loadOwn(db, c.req.param("id"), c.get("user").id);
  const pinned = await loadPinned(db, sub.formVersionId);
  const current = await findCurrentForm(sub.clubId, PURPOSE);
  const [shaped] = await shapeSubmissions([sub]);
  return c.json({
    data: {
      submission: shaped,
      form: applicantDefinition(pinned.form, pinned.version, await applicantCategories(sub.clubId)),
      // A draft on an outdated version has to move on (PATCH with `formVersionId`) before it can be edited or submitted.
      outdated: sub.status === "draft" && current?.version.id !== pinned.version.id,
    },
  });
});

// --- edit ------------------------------------------------------------------------------------------------------

const patchSchema = z.object({ answers: z.unknown().optional(), formVersionId: z.uuid().optional() });

formSubmissionRoutes.patch("/:id", jsonLimit, zValidator("json", patchSchema, validationHook), async (c) => {
  const userId = c.get("user").id;
  const body = c.req.valid("json");
  const purge: string[] = [];

  const result = await db.transaction(async (tx) => {
    const sub = await loadOwn(tx, c.req.param("id"), userId, true);
    assertDraft(sub);
    const { target, repinned } = await resolveTarget(tx, sub, body.formVersionId);
    const fields = target.version.fields as FormField[];
    const categoryKeys = (await applicantCategories(sub.clubId, tx)).map((k) => k.key);

    let base: Answers = toAnswers(sub.answers);
    let droppedAnswerKeys: string[] = [];
    if (repinned) {
      const carried = carryOver(fields, sub.answers, categoryKeys);
      base = carried.answers;
      droppedAnswerKeys = carried.dropped;
    }
    const validatedAnswers = validateChanged(fields, base, body.answers, categoryKeys);

    const [updated] = await tx
      .update(formSubmissions)
      .set({ answers: validatedAnswers, ...(repinned ? { formId: target.form.id, formVersionId: target.version.id } : {}), updatedAt: new Date() })
      .where(eq(formSubmissions.id, sub.id))
      .returning();

    if (repinned) {
      // Files that no longer fit a field of the new version (removed, or the field changed its kind) go away.
      const byKey = new Map(fields.map((f) => [f.key, f]));
      const stale = (await loadFiles(tx, [sub.id])).filter(({ file, kind }) => {
        const field = byKey.get(file.fieldKey);
        return !(field && ((field.type === "image" && kind === "image") || (field.type === "file" && kind === "document")));
      });
      purge.push(...(await removeFiles(tx, stale.map((s) => s.file))));
    }
    return { updated: updated!, repinned, droppedAnswerKeys };
  });
  await purgeAll(purge);
  return c.json({ data: { submission: (await shapeSubmissions([result.updated]))[0], repinned: result.repinned, droppedAnswerKeys: result.droppedAnswerKeys } });
});

// --- files -----------------------------------------------------------------------------------------------------

const claimSchema = z.object({ fieldKey: z.string().regex(FIELD_KEY_RE), mediaKey: z.string().regex(/^[A-Za-z0-9_./-]{1,300}$/) });

/**
 * Upload caps over all OPEN drafts of one user in one club: files and bytes (`FORM_DRAFT_MAX_BYTES_PER_USER`), so
 * drafts cannot be used as free storage. `ignoreFileIds` are files that are about to be replaced.
 */
async function assertDraftUploadCaps(executor: DbExecutor, userId: string, clubId: string, add: { files: number; bytes: number }, ignoreFileIds: readonly string[] = []): Promise<void> {
  const rows = await executor
    .select({ id: formSubmissionFiles.id, size: formSubmissionFiles.sizeBytes })
    .from(formSubmissionFiles)
    .innerJoin(formSubmissions, eq(formSubmissions.id, formSubmissionFiles.submissionId))
    .where(and(eq(formSubmissions.submittedByUserId, userId), eq(formSubmissions.clubId, clubId), eq(formSubmissions.status, "draft")));
  const kept = rows.filter((r) => !ignoreFileIds.includes(r.id));
  if (kept.length + add.files > MAX_DRAFT_FILES_PER_USER_CLUB || kept.reduce((sum, r) => sum + r.size, 0) + add.bytes > draftMaxBytesPerUser()) {
    throw new ValidationError("Too many or too large uploads in your open drafts for this club; remove files or submit first", { code: "QUOTA_EXCEEDED", details: { code: "draft_upload_cap" } });
  }
}

const fileFieldOf = (fields: readonly FormField[], fieldKey: string): FormField => {
  const field = fields.find((f) => f.key === fieldKey);
  if (!field || (field.type !== "file" && field.type !== "image")) throw new ValidationError("Not a file field of this form", { details: { fields: { [FIELD_KEY_RE.test(fieldKey) ? fieldKey : "_invalid_key"]: "unknown_field" } } });
  return field;
};

formSubmissionRoutes.post(
  "/:id/files",
  uploadLimiter,
  bodyLimit({
    maxSize: MAX_DOCUMENT_BYTES + 64 * 1024, // multipart framing overhead on top of the file itself
    onError: () => {
      throw new ValidationError(`File exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes`);
    },
  }),
  async (c) => {
    const userId = c.get("user").id;
    const id = c.req.param("id");
    // Cheap checks first, before any bytes are parsed or processed: ownership, draft, current version.
    const early = await loadOwn(db, id, userId);
    assertDraft(early);
    const { target: earlyTarget } = await resolveTarget(db, early);

    // Either a multipart upload (`file` + `fieldKey`) or a JSON claim of an already uploaded, unattached image.
    const isJson = (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
    let upload: { file: File; fieldKey: string } | null = null;
    let claim: z.infer<typeof claimSchema> | null = null;
    if (isJson) {
      const parsed = claimSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new ValidationError("fieldKey and mediaKey are required");
      claim = parsed.data;
    } else {
      const body = await c.req.parseBody();
      const file = body["file"];
      const fieldKey = body["fieldKey"];
      if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");
      if (typeof fieldKey !== "string" || !FIELD_KEY_RE.test(fieldKey)) throw new ValidationError("fieldKey is required");
      upload = { file, fieldKey };
    }
    const fieldKey = (upload ?? claim)!.fieldKey;
    const earlyField = fileFieldOf(earlyTarget.version.fields as FormField[], fieldKey);
    const isImage = earlyField.type === "image";
    if (claim && !isImage) throw new ValidationError("Only image fields accept an already uploaded file; upload documents directly");
    const maxBytes = isImage ? (earlyField.mapsTo === "photo" ? MAX_PHOTO_BYTES : MAX_IMAGE_BYTES) : MAX_DOCUMENT_BYTES;
    // Reject an over-cap upload before the (expensive) image processing; the authoritative check follows under the lock.
    if (upload) {
      const replaceable = isImage ? (await loadFiles(db, [early.id])).filter((f) => f.file.fieldKey === fieldKey).map((f) => f.file.id) : [];
      await assertDraftUploadCaps(db, userId, early.clubId, { files: 1, bytes: upload.file.size }, replaceable);
    }

    // The heavy part -- magic bytes, metadata strip, file write, quota, registry row -- runs OUTSIDE the transaction
    // that holds the submission lock; if the short transaction below fails, the stored file is removed again.
    const stored = upload
      ? await storeUpload({
          file: upload.file,
          clubId: early.clubId,
          storagePrefix: `forms/${early.clubId}/${early.id}`,
          kind: isImage ? "image" : "document",
          allowedTypes: isImage ? IMAGE_TYPES : FILE_FIELD_TYPES,
          maxBytes,
          visibility: "private",
          // Documents (IDs, certificates, ...) are sensitive: never a signed URL, only the audited stream.
          sensitive: !isImage,
          owner: { type: "form_submission", id: early.id },
          uploadedBy: userId,
        })
      : null;

    const purge: string[] = [];
    try {
      const created = await db.transaction(async (tx) => {
        const sub = await loadOwn(tx, id, userId, true);
        assertDraft(sub);
        await lockUserClub(tx, userId, sub.clubId);
        const { target } = await resolveTarget(tx, sub);
        const field = fileFieldOf(target.version.fields as FormField[], fieldKey);
        if ((field.type === "image") !== isImage) throw outdatedError(await currentDefinition(sub.clubId, tx), sub.id);

        // An image field holds exactly one photo: a new one replaces the old one.
        const existing = await loadFiles(tx, [sub.id]);
        const replaced = isImage ? existing.filter((f) => f.file.fieldKey === fieldKey) : [];
        const remaining = existing.length - replaced.length;
        if (remaining >= MAX_FILES_PER_SUBMISSION) throw new ValidationError(`At most ${MAX_FILES_PER_SUBMISSION} files per submission`);

        let media = stored;
        if (claim) {
          media = await attachUploadedImage(tx, { clubId: sub.clubId, storageKey: claim.mediaKey, uploadedBy: userId, owner: { type: "form_submission", id: sub.id } });
          if (media.sizeBytes > maxBytes || !(IMAGE_TYPES as readonly string[]).includes(media.mimeType)) throw new ValidationError("The uploaded image is not allowed for this field");
        }
        await assertDraftUploadCaps(tx, userId, sub.clubId, { files: 1, bytes: media!.sizeBytes }, replaced.map((f) => f.file.id));
        purge.push(...(await removeFiles(tx, replaced.map((f) => f.file))));

        const [row] = await tx
          .insert(formSubmissionFiles)
          .values({ submissionId: sub.id, fieldKey, storageKey: media!.storageKey, filename: media!.originalFilename, mimeType: media!.mimeType, sizeBytes: media!.sizeBytes })
          .returning();
        await tx.update(formSubmissions).set({ updatedAt: new Date() }).where(eq(formSubmissions.id, sub.id));
        await tx.insert(auditLog).values({ eventType: "form_submission.file_add", subjectId: sub.id, payload: { fileId: row!.id, fieldKey, userId, via: claim ? "claim" : "upload" } });
        return { sub, row: row!, kind: media!.kind, urlKey: media!.sensitive ? null : media!.storageKey };
      });
      await purgeAll(purge);
      const urls = created.urlKey ? await signedMediaUrls(created.sub.clubId, [created.urlKey], "form_submission") : new Map<string, string>();
      return c.json(
        { data: { file: { id: created.row.id, fieldKey: created.row.fieldKey, filename: created.row.filename, mimeType: created.row.mimeType, sizeBytes: created.row.sizeBytes, kind: created.kind, url: created.urlKey ? (urls.get(created.urlKey) ?? null) : null, createdAt: created.row.createdAt } } },
        201,
      );
    } catch (err) {
      // The short transaction rolled back: the already stored file has no feature row -- tombstone and delete it.
      if (stored) await deleteMedia(stored.storageKey).catch(() => discardStoredFile(stored.storageKey));
      throw err;
    }
  },
);

formSubmissionRoutes.delete("/:id/files/:fileId", deleteLimiter, async (c) => {
  const userId = c.get("user").id;
  const fileId = c.req.param("fileId");
  const purge = await db.transaction(async (tx) => {
    const sub = await loadOwn(tx, c.req.param("id"), userId, true);
    assertDraft(sub);
    if (!isUuid(fileId)) throw new NotFoundError("File not found");
    const [file] = await tx
      .select()
      .from(formSubmissionFiles)
      .where(and(eq(formSubmissionFiles.id, fileId), eq(formSubmissionFiles.submissionId, sub.id)))
      .limit(1);
    if (!file) throw new NotFoundError("File not found");
    const keys = await removeFiles(tx, [file]);
    await tx.update(formSubmissions).set({ updatedAt: new Date() }).where(eq(formSubmissions.id, sub.id));
    await tx.insert(auditLog).values({ eventType: "form_submission.file_remove", subjectId: sub.id, payload: { fileId, fieldKey: file.fieldKey, userId } });
    return keys;
  });
  await purgeAll(purge);
  return c.body(null, 204);
});

/**
 * Authenticated download of one file: the submitter, or the club board (`members:write`) once the form is submitted.
 * Every retrieval is audited; documents are always attachments, never served via a signed URL (media layer).
 */
formSubmissionRoutes.get("/:id/files/:fileId", async (c) => {
  const userId = c.get("user").id;
  const id = c.req.param("id");
  const fileId = c.req.param("fileId");
  if (!isUuid(id) || !isUuid(fileId)) throw notFound();

  const [sub] = await db.select().from(formSubmissions).where(eq(formSubmissions.id, id)).limit(1);
  if (!sub) throw notFound();
  let viaBoard = false;
  let boardRoles: string[] | null = null;
  if (sub.submittedByUserId !== userId) {
    // Not the submitter: only the board of THIS club, never drafts. Everyone else cannot tell the id exists.
    const roles = await clubRoleTypesOf(userId, sub.clubId);
    const [form] = await db.select({ purpose: forms.purpose }).from(forms).where(eq(forms.id, sub.formId)).limit(1);
    if (!roles || !hasClubPermission(roles, "members:write") || sub.status === "draft" || form?.purpose !== PURPOSE) throw notFound();
    viaBoard = true;
    boardRoles = roles;
  }
  const [file] = await db.select().from(formSubmissionFiles).where(and(eq(formSubmissionFiles.id, fileId), eq(formSubmissionFiles.submissionId, sub.id))).limit(1);
  if (!file) throw new NotFoundError("File not found");
  if (viaBoard) {
    // Files of a field marked `sensitive` follow the answers of such a field: members:read_sensitive.
    const pinned = await loadPinned(db, sub.formVersionId);
    const field = (pinned.version.fields as FormField[]).find((f) => f.key === file.fieldKey);
    if (field?.sensitive === true && !hasClubPermission(boardRoles ?? [], "members:read_sensitive")) throw new ForbiddenError("Missing members:read_sensitive permission");
  }
  const media = await findMediaByKey(file.storageKey);
  if (!media) throw new NotFoundError("File not found");

  const reason = viaBoard ? "form_submission:board" : "form_submission:submitter";
  if (media.sensitive) return streamSensitiveMedia(c, media, { accessedBy: userId, subjectId: sub.id, reason });
  await db.insert(auditLog).values({ eventType: "form_submission.file_access", subjectId: sub.id, payload: { fileId: file.id, accessedBy: userId, reason } });
  return streamMedia(c, media);
});

// --- submit / withdraw -----------------------------------------------------------------------------------------

/**
 * Moves a draft to `submitted` and, for an application (`aufnahme`), creates the board's `club_applications` row in the
 * SAME transaction -- a submitted application form always has exactly one application. `sub` must be locked FOR UPDATE by
 * the caller (lock order: submission row, then the per-(user, club) advisory lock, then the application insert).
 * Returns the files to `purgeMediaFile` after the commit.
 */
export async function submitDraftInTx(
  tx: DbExecutor,
  sub: FormSubmissionRow,
  userId: string,
  extraAnswers: unknown,
): Promise<{ row: FormSubmissionRow; application: ClubApplicationRow | null; purge: string[]; warnings: ChildWarning[] }> {
  const purge: string[] = [];
  // The advisory lock orders parallel submits / applies of the same user and club behind each other.
  await lockUserClub(tx, userId, sub.clubId);
  assertDraft(sub);
  const { target } = await resolveTarget(tx, sub);
  await assertMayApply(tx, sub.clubId, userId, sub.onBehalfOf === "guardian" ? "guardian" : "self");

  const fields = target.version.fields as FormField[];
  const files = await loadFiles(tx, [sub.id]);
  const categoryKeys = (await applicantCategories(sub.clubId, tx)).map((k) => k.key);
  const result = validateAnswers(fields, toAnswers(sub.answers, extraAnswers), {
    mode: "submit",
    categoryKeys,
    uploadedFieldKeys: new Set(files.map((f) => f.file.fieldKey)),
  });
  if (!result.ok) throw invalidAnswers(result.errors);
  let warnings: ChildWarning[] = [];
  if (sub.onBehalfOf === "guardian") {
    // The parent must still be allowed to sponsor (e-mail was verified at creation; the account may have left meanwhile).
    await assertGuardianMayApply(tx, { clubId: sub.clubId, userId, emailVerified: true, countOpen: false });
    warnings = checkChildAnswers(fields, result.answers);
  }

  // Files of fields the answers made invisible are not part of the application.
  const visible = visibleFieldKeys(fields, result.answers);
  const hidden = files.filter((f) => !visible.has(f.file.fieldKey));
  purge.push(...(await removeFiles(tx, hidden.map((f) => f.file))));

  const [row] = await tx
    .update(formSubmissions)
    .set({ answers: result.answers, status: "submitted", submittedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(formSubmissions.id, sub.id), eq(formSubmissions.status, "draft")))
    .returning();
  if (!row) throw new ConflictError("The submission can no longer be changed", { details: { code: "submission_not_editable" } });
  const application = target.form.purpose === PURPOSE ? await createApplicationForSubmission(tx, row, fields) : null;
  await tx.insert(auditLog).values({
    eventType: "form_submission.submit",
    subjectId: sub.id,
    payload: { clubId: sub.clubId, formId: sub.formId, formVersionId: sub.formVersionId, userId, onBehalfOf: sub.onBehalfOf, fileCount: files.length - hidden.length, ...(application ? { applicationId: application.id } : {}), ...(warnings.length > 0 ? { warnings } : {}) },
  });
  return { row, application, purge, warnings };
}

const applicationDto = (a: ClubApplicationRow) => ({ id: a.id, status: a.status, createdAt: a.createdAt });

formSubmissionRoutes.post("/:id/submit", submitLimiter, jsonLimit, zValidator("json", z.object({ answers: z.unknown().optional() }).default({}), validationHook), async (c) => {
  const userId = c.get("user").id;
  const body = c.req.valid("json");

  const submitted = await db.transaction(async (tx) => {
    const sub = await loadOwn(tx, c.req.param("id"), userId, true);
    return submitDraftInTx(tx, sub, userId, body.answers);
  });
  await purgeAll(submitted.purge);
  return c.json({ data: { submission: (await shapeSubmissions([submitted.row]))[0], application: submitted.application ? applicationDto(submitted.application) : null, warnings: submitted.warnings } });
});

/**
 * `POST /club-members/apply` with the form builder: the one entry point that files an application. Three shapes:
 * `submissionId` (an own draft is submitted, a submitted one without application gets it, one with an application is
 * returned as is), `answers` (a submission is created and submitted in one go) -- both against the club's published form,
 * stale versions answer `409 FORM_VERSION_OUTDATED`. Lock order: see `lib/form-applications.ts`.
 */
export async function applyWithForm(input: {
  userId: string;
  clubId: string;
  formVersionId?: string;
  answers?: unknown;
  submissionId?: string;
  /** New answers only: who the application is for (a submissionId carries its own). */
  onBehalfOf?: "self" | "guardian";
  emailVerified?: boolean;
}): Promise<{ application: ClubApplicationRow; submission: FormSubmissionRow; created: boolean; warnings: ChildWarning[] }> {
  const { userId, clubId } = input;
  await ensureFormBasics(clubId);
  const purge: string[] = [];

  const done = await db.transaction(async (tx) => {
    if (input.submissionId !== undefined) {
      // Same order as POST /:id/submit: submission row first.
      const sub = await loadOwn(tx, input.submissionId, userId, true);
      if (sub.clubId !== clubId) throw notFound();
      if (sub.status === "submitted") {
        const [existing] = await tx.select().from(clubApplications).where(eq(clubApplications.formSubmissionId, sub.id)).limit(1);
        if (existing) return { application: existing, submission: sub, created: false, warnings: [] };
        // A submitted application without its application row (filed before the two were linked): complete it.
        await lockUserClub(tx, userId, clubId);
        const pinned = await loadPinned(tx, sub.formVersionId);
        if (sub.onBehalfOf !== "guardian") {
          const [other] = await tx
            .select({ id: clubApplications.id, createdAt: clubApplications.createdAt })
            .from(clubApplications)
            .where(and(eq(clubApplications.userId, userId), eq(clubApplications.clubId, clubId), eq(clubApplications.status, "pending"), eq(clubApplications.onBehalfOf, "self")))
            .limit(1);
          if (other) throw applicationPendingError({ clubId, applicationId: other.id, submittedAt: other.createdAt });
        }
        return { application: await createApplicationForSubmission(tx, sub, pinned.version.fields as FormField[]), submission: sub, created: true, warnings: [] };
      }
      if (sub.status !== "draft") throw new ConflictError("The submission can no longer be changed", { details: { code: "submission_not_editable", status: sub.status } });
      if (input.onBehalfOf !== undefined && input.onBehalfOf !== sub.onBehalfOf) throw new ValidationError("onBehalfOf does not match the submission");
      if (input.formVersionId !== undefined && input.formVersionId !== sub.formVersionId) {
        // The client names the version it rendered; the draft is pinned to another one: let the client re-render.
        const current = await findCurrentForm(clubId, PURPOSE, tx);
        if (!current || current.version.id !== input.formVersionId) throw outdatedError(await currentDefinition(clubId, tx), sub.id);
      }
      const submitted = await submitDraftInTx(tx, sub, userId, input.answers);
      purge.push(...submitted.purge);
      return { application: submitted.application!, submission: submitted.row, created: true, warnings: submitted.warnings };
    }

    // New answers: a fresh submission against the CURRENT published version, submitted in the same transaction.
    await lockUserClub(tx, userId, clubId);
    const onBehalfOf = input.onBehalfOf ?? "self";
    // Same order as POST /form-submissions: (user, club) lock, then the user-wide one that guards the cap of open child applications.
    if (onBehalfOf === "guardian") await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`form-submission-user:${userId}`}, 0))`);
    const current = await findCurrentForm(clubId, PURPOSE, tx);
    if (!current) throw new NotFoundError("This club has no application form");
    const categories = await applicantCategories(clubId, tx);
    if (input.formVersionId !== undefined && input.formVersionId !== current.version.id) throw outdatedError(applicantDefinition(current.form, current.version, categories));
    await assertMayApply(tx, clubId, userId, onBehalfOf);
    if (onBehalfOf === "guardian") {
      if (!supportsChildApplication(current.version.fields as FormField[])) throw childUnsupportedError();
      await assertGuardianMayApply(tx, { clubId, userId, emailVerified: input.emailVerified === true, countOpen: true });
    }
    const draftAnswers = validateAnswers(current.version.fields as FormField[], toAnswers(input.answers ?? {}), { mode: "draft", categoryKeys: categories.map((k) => k.key) });
    if (!draftAnswers.ok) throw invalidAnswers(draftAnswers.errors);
    const [draft] = await tx
      .insert(formSubmissions)
      .values({ formId: current.form.id, formVersionId: current.version.id, clubId, submittedByUserId: userId, onBehalfOf, answers: draftAnswers.answers, status: "draft" })
      .returning();
    const submitted = await submitDraftInTx(tx, draft!, userId, undefined);
    purge.push(...submitted.purge);
    return { application: submitted.application!, submission: submitted.row, created: true, warnings: submitted.warnings };
  });
  await purgeAll(purge);
  return done;
}

formSubmissionRoutes.post("/:id/withdraw", async (c) => {
  const userId = c.get("user").id;
  const purge: string[] = [];
  const withdrawn = await db.transaction(async (tx) => {
    const sub = await loadOwn(tx, c.req.param("id"), userId, true);
    // A cancellation (austritt) is withdrawn through its exit request, which keeps the member's status consistent.
    const [kind] = await tx.select({ purpose: forms.purpose }).from(forms).where(eq(forms.id, sub.formId)).limit(1);
    if (kind?.purpose !== PURPOSE) throw new ConflictError("This submission belongs to an exit request; withdraw the exit request instead", { details: { code: "submission_not_withdrawable", status: sub.status } });
    // Once the board has decided (B6 sets decided_at together with accepted/rejected) there is nothing to withdraw.
    if ((sub.status !== "draft" && sub.status !== "submitted") || sub.decidedAt !== null) throw new ConflictError("The submission can no longer be withdrawn", { details: { code: "submission_not_withdrawable", status: sub.status } });
    // A withdrawn application keeps its answers as a record, but its uploaded files (photo, documents) are deleted.
    purge.push(...(await removeFiles(tx, (await loadFiles(tx, [sub.id])).map((f) => f.file))));
    const [row] = await tx.update(formSubmissions).set({ status: "withdrawn", updatedAt: new Date() }).where(eq(formSubmissions.id, sub.id)).returning();
    // Lock order: submission row (above), then the application row.
    await closeApplicationOfSubmission(tx, sub.id);
    await tx.insert(auditLog).values({ eventType: "form_submission.withdraw", subjectId: sub.id, payload: { clubId: sub.clubId, userId, previousStatus: sub.status } });
    return row!;
  });
  await purgeAll(purge);
  return c.json({ data: { submission: (await shapeSubmissions([withdrawn]))[0] } });
});
