import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { FORM_PURPOSES, forms, formVersions, type FormRow, type FormVersionRow } from "../db/schema/forms.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import type { DbExecutor } from "../lib/club-members.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { ensureClubFormDefaults } from "../lib/form-defaults.js";
import { formFieldsSchema, type FormField } from "../lib/form-schema.js";
import { DEFINITION_BODY_LIMIT, formDto, isUuid, MAX_ACTIVE_FORMS_PER_CLUB, MAX_VERSIONS_PER_FORM, fileFieldProblems, keyTypeProblems, publishProblems, versionDto, versionSummaryDto, type PublishProblem } from "../lib/forms.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { cleanText } from "../lib/text-policy.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Form management for the board (Wave 8 B4, ADR-005). EVERY route needs `forms:write` -- reads included, a draft may
 * contain unpublished wording. Forms of other clubs are 404, never 403. Versions: `draft` -> `published` -> `archived`;
 * a published/archived row is never edited. Publishing flips the draft to `published` and archives the previous
 * version in one transaction under a row lock on the form (two parallel publishes -> exactly one new version).
 */
export const formRoutes = new Hono<ClubEnv>();

formRoutes.use("*", sessionGuard);
// Per user (not per IP): office networks share one address. Failed attempts count as well.
formRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120, key: (c) => `forms:${c.get("user").id}` }));
formRoutes.use("*", clubGuard);
formRoutes.use("*", async (c, next) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "forms:write")) throw new ForbiddenError("Missing forms:write permission");
  await next();
});

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const jsonLimit = bodyLimit({
  maxSize: DEFINITION_BODY_LIMIT,
  onError: () => {
    throw new ValidationError("Request body too large");
  },
});

const nameSchema = cleanText(z.string().trim().min(1).max(120));
const privacyNoticeSchema = cleanText(z.string().trim().max(10_000), true).nullable();

function parseFields(input: unknown): FormField[] {
  const parsed = formFieldsSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid field definition", { details: { issues: parsed.error.issues } });
  return parsed.data;
}

function problemsError(message: string, problems: PublishProblem[]): ValidationError {
  return new ValidationError(message, { details: { problems } });
}

const notFound = () => new NotFoundError("Form not found");

/** Loads (and with `lock` row-locks) a form of the caller's club. Foreign / unknown / malformed ids: 404. */
async function loadForm(executor: DbExecutor, id: string, clubId: string, lock = false): Promise<FormRow> {
  if (!isUuid(id)) throw notFound();
  const query = executor
    .select()
    .from(forms)
    .where(and(eq(forms.id, id), eq(forms.clubId, clubId)))
    .limit(1);
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound();
  return row;
}

async function versionsOf(executor: DbExecutor, formId: string): Promise<FormVersionRow[]> {
  return executor.select().from(formVersions).where(eq(formVersions.formId, formId)).orderBy(desc(formVersions.version));
}

formRoutes.get(
  "/",
  zValidator("query", z.object({ purpose: z.enum(FORM_PURPOSES).optional(), includeArchived: z.enum(["true", "false"]).optional() }), validationHook),
  async (c) => {
    const clubId = c.get("clubId");
    const { purpose, includeArchived } = c.req.valid("query");
    // A club that never touched the builder still has its standard forms: create them lazily (idempotent).
    await ensureClubFormDefaults(clubId);

    const rows = await db
      .select()
      .from(forms)
      .where(and(eq(forms.clubId, clubId), ...(purpose ? [eq(forms.purpose, purpose)] : []), ...(includeArchived === "true" ? [] : [isNull(forms.archivedAt)])))
      .orderBy(asc(forms.purpose), asc(forms.createdAt), asc(forms.id));
    const versions = rows.length
      ? await db
          .select({ formId: formVersions.formId, version: formVersions.version, status: formVersions.status })
          .from(formVersions)
          .where(inArray(formVersions.formId, rows.map((r) => r.id)))
      : [];

    return c.json({
      data: rows.map((form) => {
        const own = versions.filter((v) => v.formId === form.id);
        return {
          ...formDto(form),
          publishedVersion: own.find((v) => v.status === "published")?.version ?? null,
          draftVersion: own.find((v) => v.status === "draft")?.version ?? null,
          versionCount: own.length,
        };
      }),
    });
  },
);

const createSchema = z.object({
  purpose: z.enum(FORM_PURPOSES),
  name: nameSchema,
  fields: z.unknown().optional(),
  privacyNotice: privacyNoticeSchema.optional(),
});

formRoutes.post("/", jsonLimit, zValidator("json", createSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const fields = body.fields === undefined ? [] : parseFields(body.fields);
  const unsupported = fileFieldProblems(body.purpose, fields);
  if (unsupported.length > 0) throw problemsError("This form type cannot contain file fields", unsupported);
  // aufnahme/austritt exist from the start (standard forms); creating them first makes a duplicate a clean 409 and
  // keeps the lazy default seeding from racing the new form.
  await ensureClubFormDefaults(clubId);

  try {
    const created = await db.transaction(async (tx) => {
      // Serialise creators of one club so the cap cannot be overshot by parallel requests.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`forms-create:${clubId}`}, 0))`);
      const [{ active }] = await tx.select({ active: count() }).from(forms).where(and(eq(forms.clubId, clubId), isNull(forms.archivedAt)));
      if (active >= MAX_ACTIVE_FORMS_PER_CLUB) throw new ConflictError(`At most ${MAX_ACTIVE_FORMS_PER_CLUB} active forms per club`, { details: { code: "form_limit", limit: MAX_ACTIVE_FORMS_PER_CLUB } });
      const [form] = await tx.insert(forms).values({ clubId, purpose: body.purpose, name: body.name }).returning();
      const [draft] = await tx.insert(formVersions).values({ formId: form!.id, version: 1, status: "draft", fields, privacyNotice: body.privacyNotice ?? null }).returning();
      await tx.insert(auditLog).values({ eventType: "form.create", subjectId: form!.id, payload: { clubId, purpose: form!.purpose, createdBy: c.get("membership").id } });
      return { form: form!, draft: draft! };
    });
    return c.json({ data: { form: formDto(created.form), draft: versionDto(created.draft) } }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError("The club already has an active form for this purpose; edit it instead", { details: { code: "form_purpose_exists", purpose: body.purpose } });
    }
    throw err;
  }
});

formRoutes.get("/:id", async (c) => {
  const form = await loadForm(db, c.req.param("id"), c.get("clubId"));
  const versions = await versionsOf(db, form.id);
  const published = versions.find((v) => v.status === "published");
  const draft = versions.find((v) => v.status === "draft");
  return c.json({ data: { form: formDto(form), published: published ? versionDto(published) : null, draft: draft ? versionDto(draft) : null } });
});

const draftSchema = z.object({
  name: nameSchema.optional(),
  fields: z.unknown(),
  privacyNotice: privacyNoticeSchema.optional(),
});

/** Saves the draft of a form (creates it when there is none). Runs under the form's row lock. */
async function saveDraft(clubId: string, formId: string, savedBy: string, body: z.infer<typeof draftSchema>, expectedVersion?: number) {
  if (body.fields === undefined) throw new ValidationError("fields is required");
  const fields = parseFields(body.fields);
  return db.transaction(async (tx) => {
    const form = await loadForm(tx, formId, clubId, true);
    if (form.archivedAt) throw new ConflictError("The form is archived", { details: { code: "form_archived" } });
    const unsupported = fileFieldProblems(form.purpose, fields);
    if (unsupported.length > 0) throw problemsError("This form type cannot contain file fields", unsupported);
    const history = await keyTypeProblems(form.id, fields, tx);
    if (history.length > 0) throw problemsError("A key of a published field keeps its type", history);

    const versions = await versionsOf(tx, form.id);
    const existing = versions.find((v) => v.status === "draft");
    if (expectedVersion !== undefined && existing?.version !== expectedVersion) {
      throw new ConflictError("The draft changed in the meantime", { details: { code: "version_immutable", version: expectedVersion } });
    }
    const published = versions.find((v) => v.status === "published");
    let draft: FormVersionRow;
    if (existing) {
      [draft] = await tx
        .update(formVersions)
        .set({ fields, ...(body.privacyNotice !== undefined ? { privacyNotice: body.privacyNotice } : {}), updatedAt: new Date() })
        .where(and(eq(formVersions.id, existing.id), eq(formVersions.status, "draft")))
        .returning();
    } else {
      if (versions.length >= MAX_VERSIONS_PER_FORM) throw new ConflictError(`At most ${MAX_VERSIONS_PER_FORM} versions per form`, { details: { code: "version_limit", limit: MAX_VERSIONS_PER_FORM } });
      const next = Math.max(0, ...versions.map((v) => v.version)) + 1;
      // A new draft starts with the privacy notice of the live version unless the editor sends one.
      [draft] = await tx
        .insert(formVersions)
        .values({ formId: form.id, version: next, status: "draft", fields, privacyNotice: body.privacyNotice !== undefined ? body.privacyNotice : (published?.privacyNotice ?? null) })
        .returning();
    }
    let saved = form;
    if (body.name !== undefined && body.name !== form.name) {
      [saved] = await tx.update(forms).set({ name: body.name, updatedAt: new Date() }).where(eq(forms.id, form.id)).returning();
    }
    // Ids and counts only -- the definition itself is not part of the audit trail.
    await tx.insert(auditLog).values({ eventType: "form.draft_save", subjectId: form.id, payload: { clubId, version: draft!.version, fieldCount: fields.length, savedBy } });
    return { form: saved!, draft: draft! };
  });
}

formRoutes.put("/:id/draft", jsonLimit, zValidator("json", draftSchema, validationHook), async (c) => {
  const saved = await saveDraft(c.get("clubId"), c.req.param("id"), c.get("membership").id, c.req.valid("json"));
  return c.json({ data: { form: formDto(saved.form), draft: versionDto(saved.draft) } });
});

// Published / archived versions are immutable: this route exists so an editor that holds a version number gets an
// explicit 409 instead of a silent copy; it only accepts the number of the current draft.
formRoutes.put("/:id/versions/:n", jsonLimit, zValidator("json", draftSchema, validationHook), async (c) => {
  const form = await loadForm(db, c.req.param("id"), c.get("clubId"));
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError("Version not found");
  const [version] = await db.select().from(formVersions).where(and(eq(formVersions.formId, form.id), eq(formVersions.version, n))).limit(1);
  if (!version) throw new NotFoundError("Version not found");
  if (version.status !== "draft") throw new ConflictError("A published version is immutable; save a new draft instead", { details: { code: "version_immutable", version: n, status: version.status } });
  const saved = await saveDraft(c.get("clubId"), form.id, c.get("membership").id, c.req.valid("json"), n);
  return c.json({ data: { form: formDto(saved.form), draft: versionDto(saved.draft) } });
});

formRoutes.delete("/:id/draft", async (c) => {
  const clubId = c.get("clubId");
  await db.transaction(async (tx) => {
    const form = await loadForm(tx, c.req.param("id"), clubId, true);
    const deleted = await tx.delete(formVersions).where(and(eq(formVersions.formId, form.id), eq(formVersions.status, "draft"))).returning({ version: formVersions.version });
    if (deleted.length === 0) throw new NotFoundError("The form has no draft");
    await tx.insert(auditLog).values({ eventType: "form.draft_discard", subjectId: form.id, payload: { clubId, version: deleted[0]!.version, discardedBy: c.get("membership").id } });
  });
  return c.body(null, 204);
});

formRoutes.post("/:id/publish", async (c) => {
  const clubId = c.get("clubId");
  const result = await db.transaction(async (tx) => {
    // Serialises parallel publishes: the loser re-reads after the winner committed, finds no draft and gets 409.
    const form = await loadForm(tx, c.req.param("id"), clubId, true);
    if (form.archivedAt) throw new ConflictError("The form is archived", { details: { code: "form_archived" } });
    const versions = await versionsOf(tx, form.id);
    const draft = versions.find((v) => v.status === "draft");
    if (!draft) throw new ConflictError("There is no draft to publish", { details: { code: "no_draft" } });
    const previous = versions.find((v) => v.status === "published");

    const fields = parseFields(draft.fields);
    const problems = [...(await keyTypeProblems(form.id, fields, tx)), ...(await publishProblems({ clubId, purpose: form.purpose, fields, privacyNotice: draft.privacyNotice }, tx))];
    if (problems.length > 0) throw problemsError("The form cannot be published", problems);

    // Archive first: the unique index allows only one published row per form at any moment.
    if (previous) await tx.update(formVersions).set({ status: "archived", updatedAt: new Date() }).where(eq(formVersions.id, previous.id));
    const [published] = await tx
      .update(formVersions)
      .set({ status: "published", publishedAt: new Date(), publishedBy: c.get("membership").id, updatedAt: new Date() })
      .where(and(eq(formVersions.id, draft.id), eq(formVersions.status, "draft")))
      .returning();
    if (!published) throw new ConflictError("There is no draft to publish", { details: { code: "no_draft" } });
    await tx.update(forms).set({ updatedAt: new Date() }).where(eq(forms.id, form.id));
    await tx.insert(auditLog).values({
      eventType: "form.publish",
      subjectId: form.id,
      payload: { clubId, purpose: form.purpose, version: published.version, previousVersion: previous?.version ?? null, publishedBy: c.get("membership").id },
    });
    return { form, published };
  });
  return c.json({ data: { form: formDto(result.form), version: versionDto(result.published) } });
});

// Archiving closes the form: its published version becomes `archived`, an open draft is dropped, applicants no longer
// get it. For aufnahme/austritt the club must always have a form, so a fresh standard form (v1) is created lazily on
// the next access -- archiving the customised one effectively resets the club to the standard form.
formRoutes.post("/:id/archive", async (c) => {
  const clubId = c.get("clubId");
  const archived = await db.transaction(async (tx) => {
    const form = await loadForm(tx, c.req.param("id"), clubId, true);
    if (form.archivedAt) throw new ConflictError("The form is already archived", { details: { code: "form_archived" } });
    await tx.update(formVersions).set({ status: "archived", updatedAt: new Date() }).where(and(eq(formVersions.formId, form.id), eq(formVersions.status, "published")));
    await tx.delete(formVersions).where(and(eq(formVersions.formId, form.id), eq(formVersions.status, "draft")));
    const [row] = await tx.update(forms).set({ archivedAt: sql`now()`, updatedAt: new Date() }).where(eq(forms.id, form.id)).returning();
    await tx.insert(auditLog).values({ eventType: "form.archive", subjectId: form.id, payload: { clubId, purpose: form.purpose, archivedBy: c.get("membership").id } });
    return row!;
  });
  return c.json({ data: { form: formDto(archived) } });
});

formRoutes.get("/:id/versions", async (c) => {
  const form = await loadForm(db, c.req.param("id"), c.get("clubId"));
  return c.json({ data: (await versionsOf(db, form.id)).map(versionSummaryDto) });
});

formRoutes.get("/:id/versions/:n", async (c) => {
  const form = await loadForm(db, c.req.param("id"), c.get("clubId"));
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n < 1) throw new NotFoundError("Version not found");
  const [version] = await db.select().from(formVersions).where(and(eq(formVersions.formId, form.id), eq(formVersions.version, n))).limit(1);
  if (!version) throw new NotFoundError("Version not found");
  return c.json({ data: { form: formDto(form), version: versionDto(version) } });
});
