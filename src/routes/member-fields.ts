import { zValidator } from "@hono/zod-validator";
import { and, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { FIELD_EDITABLE_BY, FIELD_VISIBLE_TO, memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { canReadValue, canSelfWrite } from "../lib/custom-field-access.js";
import { countValues, CUSTOM_FIELD_TYPES, type FieldDefinition, listDefinitions, MAX_CUSTOM_FIELDS_PER_CLUB, optionValues, valueUsesOtherOption } from "../lib/custom-fields.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { formFieldsSchema, type FormField } from "../lib/form-schema.js";
import { MODULE_GROUPS, moduleSortOrder, NEVER_MANDATORY_GROUPS, PROFILE_MODULES, findModule, type ProfileModule } from "../lib/profile-modules.js";
import { isUuid } from "../lib/forms.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Definitions of the custom fields of a club's members (Wave 8 B7): "Trikotgroesse", "Instrument", "Allergien", ...
 * Managing them needs `forms:write` (like the form builder, which maps application answers onto them). Everybody else
 * only reads the definitions they may see values of (`src/lib/custom-field-access.ts`). The VALUES live under
 * `/club-members/:id/custom-fields` (`routes/club-member-custom-fields.ts`).
 *
 * A definition that has values is never deleted (it is archived, the values stay for the record) and its type never
 * changes after the first value. Audit entries carry ids and the (non-personal) definition key, never values.
 */
export const memberFieldRoutes = new Hono<ClubEnv>();

memberFieldRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
memberFieldRoutes.use("*", sessionGuard);
memberFieldRoutes.use("*", clubGuard);

// Deny first: every writing method needs forms:write before the body is even looked at.
memberFieldRoutes.use("*", async (c, next) => {
  if (c.req.method !== "GET") requireFormsWrite(c.get("clubRoleTypes"));
  await next();
});

const jsonLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: () => {
    throw new ValidationError("Request body too large");
  },
});
const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

function requireFormsWrite(roleTypes: string[]): void {
  if (!hasClubPermission(roleTypes, "forms:write")) throw new ForbiddenError("Missing forms:write permission");
}

/** The number of stored values of a sensitive definition is itself sensitive: only members:read_sensitive sees it. */
const countFor = (d: Pick<FieldDefinition, "sensitive">, n: number, roleTypes: string[]): number | null => (d.sensitive && !hasClubPermission(roleTypes, "members:read_sensitive") ? null : n);

const dto = (d: FieldDefinition, valueCount?: number | null) => ({
  id: d.id,
  key: d.key,
  label: d.label,
  type: d.fieldType,
  options: d.options ?? null,
  validation: d.validation ?? null,
  helpText: d.helpText ?? null,
  visibleTo: d.visibleTo,
  editableBy: d.editableBy,
  sensitive: d.sensitive,
  sortOrder: d.sortOrder,
  archived: d.archivedAt !== null,
  archivedAt: d.archivedAt,
  ...(valueCount !== undefined ? { valueCount } : {}),
});

/** The shape rules of a definition are the form engine's own (key format, reserved keys, clean text, option limits). */
function checkDefinition(input: { key: string; type: string; label: string; options?: Array<{ value: string; label: string }> | null; validation?: unknown; helpText?: string | null }) {
  const parsed = formFieldsSchema.safeParse([
    { key: input.key, type: input.type, label: input.label, ...(input.options ? { options: input.options } : {}), ...(input.validation ? { validation: input.validation } : {}), ...(input.helpText ? { helpText: input.helpText } : {}) },
  ]);
  if (!parsed.success) throw new ValidationError("Invalid field definition", { details: { issues: parsed.error.issues.map((i) => ({ path: i.path.slice(1), message: i.message })) } });
  return parsed.data[0]!;
}

async function loadLocked(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], clubId: string, id: string): Promise<FieldDefinition> {
  if (!isUuid(id)) throw new NotFoundError("Custom field not found");
  // FOR UPDATE: a value write (FOR SHARE on the definition) waits, so "has values?" cannot change under us.
  const [row] = await tx.select().from(memberFieldDefinitions).where(and(eq(memberFieldDefinitions.id, id), eq(memberFieldDefinitions.clubId, clubId))).for("update");
  if (!row) throw new NotFoundError("Custom field not found");
  return row;
}

memberFieldRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  const manager = hasClubPermission(roleTypes, "forms:write");
  const includeArchived = c.req.query("includeArchived") === "true";
  if (includeArchived && !manager) throw new ForbiddenError("Missing forms:write permission");

  const defs = (await listDefinitions(clubId)).filter((d) => includeArchived || d.archivedAt === null);
  if (manager) {
    const counts = new Map((await db.select({ fieldId: memberFieldValues.fieldId, n: count() }).from(memberFieldValues).innerJoin(memberFieldDefinitions, eq(memberFieldDefinitions.id, memberFieldValues.fieldId)).where(eq(memberFieldDefinitions.clubId, clubId)).groupBy(memberFieldValues.fieldId)).map((r) => [r.fieldId, r.n]));
    return c.json({ data: defs.map((d) => dto(d, countFor(d, counts.get(d.id) ?? 0, roleTypes))) });
  }
  // Everybody else: the definitions whose values they may see of others, plus those they may fill in for themselves.
  const visible = defs.filter((d) => d.archivedAt === null && (canReadValue(d, { roleTypes, isSelf: false }) || canSelfWrite(d)));
  return c.json({ data: visible.map((d) => dto(d)) });
});

// --- Profile module catalog (Profil-Bausteine) -------------------------------------------------------------------
// Registered before the `/:id` routes. Optional ready-made fields the board switches on per club (src/lib/profile-modules.ts).

type ModuleState = "active" | "archived" | "inactive";

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The board changed the definition after activation (label, type, options, limits, visibility, flags). */
function isCustomized(m: ProfileModule, d: FieldDefinition): boolean {
  return d.label !== m.label || d.fieldType !== m.type || !sameJson(d.options, m.options) || !sameJson(d.validation, m.validation) || d.visibleTo !== m.visibleTo || d.editableBy !== m.editableBy || d.sensitive !== m.sensitive || (d.helpText ?? null) !== (m.helpText ?? null);
}

const moduleDto = (m: ProfileModule, d: FieldDefinition | undefined) => ({
  id: m.id,
  group: m.group,
  label: m.label,
  description: m.description,
  helpText: m.helpText ?? null,
  type: m.type,
  options: m.options ?? null,
  validation: m.validation ?? null,
  visibleTo: m.visibleTo,
  editableBy: m.editableBy,
  sensitive: m.sensitive,
  // Never mandatory for members: custom fields have no `required` flag and forms cannot require these (see README).
  mandatory: false,
  neverMandatoryGroup: NEVER_MANDATORY_GROUPS.includes(m.group),
  state: (d === undefined ? "inactive" : d.archivedAt === null ? "active" : "archived") as ModuleState,
  fieldId: d?.id ?? null,
  customized: d === undefined ? false : isCustomized(m, d),
});

memberFieldRoutes.get("/catalog", async (c) => {
  requireFormsWrite(c.get("clubRoleTypes"));
  const defs = await listDefinitions(c.get("clubId"));
  const byKey = new Map(defs.map((d) => [d.key, d]));
  return c.json({
    data: {
      groups: MODULE_GROUPS,
      modules: PROFILE_MODULES.map((m) => moduleDto(m, byKey.get(m.id))),
      limit: { used: defs.length, max: MAX_CUSTOM_FIELDS_PER_CLUB },
    },
  });
});

/** Switching a sensitive module (Kinderschutz) on or off is a decision about protected data: members:read_sensitive as well. */
function requireSensitiveFor(m: ProfileModule, roleTypes: string[]): void {
  if (m.sensitive && !hasClubPermission(roleTypes, "members:read_sensitive")) throw new ForbiddenError("Missing members:read_sensitive permission for a module with sensitive data");
}

function moduleOr404(id: string): ProfileModule {
  const m = findModule(id);
  if (!m) throw new NotFoundError("Profile module not found");
  return m;
}

// Idempotent: an active module is returned as is, an archived one is restored (with the board's customisations), a missing
// one is created from the template. An existing definition is NEVER overwritten. Serialised with the manual create route.
memberFieldRoutes.post("/catalog/:moduleId/activate", async (c) => {
  requireFormsWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const mod = moduleOr404(c.req.param("moduleId"));
  requireSensitiveFor(mod, c.get("clubRoleTypes"));

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`custom-field-create:${clubId}`}, 0))`);
    const [existing] = await tx.select().from(memberFieldDefinitions).where(and(eq(memberFieldDefinitions.clubId, clubId), eq(memberFieldDefinitions.key, mod.id))).for("update");
    if (existing && existing.archivedAt === null) return { row: existing, created: false, reactivated: false };
    if (existing) {
      const [row] = await tx.update(memberFieldDefinitions).set({ archivedAt: null }).where(eq(memberFieldDefinitions.id, existing.id)).returning();
      await tx.insert(auditLog).values({ eventType: "profile_module.activate", subjectId: existing.id, payload: { clubId, moduleId: mod.id, reactivated: true, by: c.get("membership").id } });
      return { row: row!, created: false, reactivated: true };
    }
    const [{ n }] = await tx.select({ n: count() }).from(memberFieldDefinitions).where(eq(memberFieldDefinitions.clubId, clubId));
    if (n >= MAX_CUSTOM_FIELDS_PER_CLUB) throw new ConflictError("Too many custom fields", { details: { code: "custom_field_limit", limit: MAX_CUSTOM_FIELDS_PER_CLUB } });
    const [row] = await tx
      .insert(memberFieldDefinitions)
      .values({ clubId, key: mod.id, label: mod.label, helpText: mod.helpText ?? null, fieldType: mod.type, options: mod.options ?? null, validation: (mod.validation as FormField["validation"] | undefined) ?? null, visibleTo: mod.visibleTo, editableBy: mod.editableBy, sensitive: mod.sensitive, sortOrder: moduleSortOrder(mod.id) })
      .returning();
    await tx.insert(auditLog).values({ eventType: "profile_module.activate", subjectId: row!.id, payload: { clubId, moduleId: mod.id, reactivated: false, sensitive: mod.sensitive, by: c.get("membership").id } });
    return { row: row!, created: true, reactivated: false };
  });
  return c.json({ data: { module: moduleDto(mod, outcome.row), created: outcome.created, reactivated: outcome.reactivated, field: dto(outcome.row, outcome.created ? 0 : undefined) } }, outcome.created ? 201 : 200);
});

// Archives the definition (the values stay for the record, nobody can read or write them); idempotent.
memberFieldRoutes.post("/catalog/:moduleId/deactivate", async (c) => {
  requireFormsWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const mod = moduleOr404(c.req.param("moduleId"));
  requireSensitiveFor(mod, c.get("clubRoleTypes"));

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(memberFieldDefinitions).where(and(eq(memberFieldDefinitions.clubId, clubId), eq(memberFieldDefinitions.key, mod.id))).for("update");
    if (!existing) return { row: undefined, changed: false };
    if (existing.archivedAt !== null) return { row: existing, changed: false };
    const [row] = await tx.update(memberFieldDefinitions).set({ archivedAt: new Date() }).where(eq(memberFieldDefinitions.id, existing.id)).returning();
    await tx.insert(auditLog).values({ eventType: "profile_module.deactivate", subjectId: existing.id, payload: { clubId, moduleId: mod.id, by: c.get("membership").id } });
    return { row: row!, changed: true };
  });
  return c.json({ data: { module: moduleDto(mod, result.row), changed: result.changed } });
});

/** Who may read a field, narrow to wide (an unknown value counts as the narrowest). */
const VISIBILITY_RANK: Record<string, number> = { vorstand: 0, funktionstraeger: 1, mitglied: 2 };

const optionsSchema = z.array(z.object({ value: z.string(), label: z.string() }).strict()).max(100);

/** The only limit a board can set by hand: the length of a credential's free-text level (1-80). */
const levelLimitSchema = z.object({ maxLength: z.number().int().min(1).max(80) }).strict();

const createSchema = z
  .object({
    key: z.string().max(60),
    label: z.string().max(300),
    helpText: z.string().max(500).optional(),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: optionsSchema.optional(),
    validation: levelLimitSchema.optional(),
    visibleTo: z.enum(FIELD_VISIBLE_TO).default("vorstand"),
    editableBy: z.enum(FIELD_EDITABLE_BY).default("vorstand"),
    sensitive: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(100_000).default(0),
  })
  .strict();

memberFieldRoutes.post("/", jsonLimit, zValidator("json", createSchema, validationHook), async (c) => {
  requireFormsWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  if (body.validation !== undefined && body.type !== "credential") throw new ValidationError("validation is only available for credential fields");
  const checked = checkDefinition(body);

  try {
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`custom-field-create:${clubId}`}, 0))`);
      const [{ n }] = await tx.select({ n: count() }).from(memberFieldDefinitions).where(eq(memberFieldDefinitions.clubId, clubId));
      if (n >= MAX_CUSTOM_FIELDS_PER_CLUB) throw new ConflictError("Too many custom fields", { details: { code: "custom_field_limit", limit: MAX_CUSTOM_FIELDS_PER_CLUB } });
      const [row] = await tx
        .insert(memberFieldDefinitions)
        .values({ clubId, key: checked.key, label: checked.label, helpText: checked.helpText ?? null, fieldType: checked.type, options: checked.options ?? null, validation: checked.validation ?? null, visibleTo: body.visibleTo, editableBy: body.editableBy, sensitive: body.sensitive, sortOrder: body.sortOrder })
        .returning();
      await tx.insert(auditLog).values({ eventType: "member_field.create", subjectId: row!.id, payload: { clubId, key: row!.key, sensitive: row!.sensitive, createdBy: c.get("membership").id } });
      return row!;
    });
    return c.json({ data: dto(created, 0) }, 201);
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("A custom field with this key already exists", { details: { code: "custom_field_exists" } });
    throw err;
  }
});

const updateSchema = z
  .object({
    label: z.string().max(300).optional(),
    helpText: z.string().max(500).nullable().optional(),
    type: z.enum(CUSTOM_FIELD_TYPES).optional(),
    options: optionsSchema.nullable().optional(),
    validation: levelLimitSchema.nullable().optional(),
    visibleTo: z.enum(FIELD_VISIBLE_TO).optional(),
    editableBy: z.enum(FIELD_EDITABLE_BY).optional(),
    sensitive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

memberFieldRoutes.patch("/:id", jsonLimit, zValidator("json", updateSchema, validationHook), async (c) => {
  requireFormsWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const body = c.req.valid("json");

  const updated = await db.transaction(async (tx) => {
    const current = await loadLocked(tx, clubId, c.req.param("id"));
    if (current.archivedAt !== null) throw new ConflictError("An archived custom field cannot be changed; restore it first", { details: { code: "custom_field_archived" } });

    const type = body.type ?? current.fieldType;
    // select/multiselect need options; a credential may carry its levels as options.
    const isChoice = type === "select" || type === "multiselect" || type === "credential";
    // Changing the type to/from a choice type without saying what the options are would leave a broken definition.
    let options = current.options as Array<{ value: string; label: string }> | null;
    if (body.options !== undefined) options = body.options;
    else if (body.type !== undefined && !isChoice) options = null;
    const helpText = body.helpText !== undefined ? body.helpText : current.helpText;
    // Limits of a definition stay with it (they only fit the type they were made for).
    if (body.validation && type !== "credential") throw new ValidationError("validation is only available for credential fields");
    const validation = body.validation !== undefined ? body.validation : type === current.fieldType ? current.validation : null;
    const checked = checkDefinition({ key: current.key, type, label: body.label ?? current.label, options, validation, helpText });

    const values = await countValues(tx, current.id);

    // Protection of recorded data (Art. 9 candidates): lowering `sensitive` or widening who may read a field that is sensitive
    // or already holds values is a decision about data that was entered under the old rules -- members:read_sensitive only.
    const readSensitive = hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive");
    const lowersSensitive = body.sensitive === false && current.sensitive;
    const widens = body.visibleTo !== undefined && VISIBILITY_RANK[body.visibleTo]! > (VISIBILITY_RANK[current.visibleTo] ?? 0);
    if ((lowersSensitive || (widens && (current.sensitive || values > 0))) && !readSensitive) {
      throw new ForbiddenError("Missing members:read_sensitive permission to lower the protection of a field that holds or may hold sensitive data");
    }
    // One-way: once a field with values is sensitive it stays sensitive (create a new field instead).
    if (lowersSensitive && values > 0) throw new ConflictError("A sensitive custom field with values stays sensitive", { details: { code: "sensitive_locked" } });

    if (type !== current.fieldType && values > 0) throw new ConflictError("The type of a custom field cannot change once it has values", { details: { code: "custom_field_has_values" } });
    const newMax = (checked.validation as { maxLength?: number } | undefined)?.maxLength;
    if (body.validation !== undefined && newMax !== undefined && values > 0) {
      const stored = await tx.select({ value: memberFieldValues.value }).from(memberFieldValues).where(eq(memberFieldValues.fieldId, current.id));
      if (stored.some((s) => typeof (s.value as { level?: unknown } | null)?.level === "string" && ((s.value as { level: string }).level.length > newMax))) throw new ConflictError("A level that is in use is longer than the new limit", { details: { code: "option_in_use" } });
    }
    if (isChoice && body.options !== undefined && values > 0) {
      const allowed = new Set(optionValues(checked.options));
      const stored = await tx.select({ value: memberFieldValues.value }).from(memberFieldValues).where(eq(memberFieldValues.fieldId, current.id));
      if (stored.some((s) => valueUsesOtherOption(s.value, allowed))) throw new ConflictError("An option that is in use cannot be removed", { details: { code: "option_in_use" } });
    }

    const [row] = await tx
      .update(memberFieldDefinitions)
      .set({
        label: checked.label,
        helpText: checked.helpText ?? null,
        fieldType: checked.type,
        options: checked.options ?? null,
        validation: checked.validation ?? null,
        ...(body.visibleTo !== undefined ? { visibleTo: body.visibleTo } : {}),
        ...(body.editableBy !== undefined ? { editableBy: body.editableBy } : {}),
        ...(body.sensitive !== undefined ? { sensitive: body.sensitive } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      })
      .where(eq(memberFieldDefinitions.id, current.id))
      .returning();
    await tx.insert(auditLog).values({
      eventType: "member_field.update",
      subjectId: current.id,
      // Property names and the old / new protection flags -- never values.
      payload: {
        clubId,
        key: current.key,
        changed: Object.keys(body),
        updatedBy: c.get("membership").id,
        flags: { sensitive: { from: current.sensitive, to: row!.sensitive }, visibleTo: { from: current.visibleTo, to: row!.visibleTo }, editableBy: { from: current.editableBy, to: row!.editableBy } },
      },
    });
    return { row: row!, values };
  });
  return c.json({ data: dto(updated.row, countFor(updated.row, updated.values, c.get("clubRoleTypes"))) });
});

// Delete when nothing refers to the field, archive when values exist (they stay for the record, nobody can read or write them).
memberFieldRoutes.delete("/:id", async (c) => {
  requireFormsWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const outcome = await db.transaction(async (tx) => {
    const current = await loadLocked(tx, clubId, c.req.param("id"));
    // The answer (deleted vs archived) tells whether values exist: for sensitive definitions only members:read_sensitive may ask.
    if (current.sensitive && !hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive")) throw new ForbiddenError("Missing members:read_sensitive permission for a sensitive custom field");
    const values = await countValues(tx, current.id);
    if (values > 0) {
      if (current.archivedAt === null) await tx.update(memberFieldDefinitions).set({ archivedAt: new Date() }).where(eq(memberFieldDefinitions.id, current.id));
    } else {
      await tx.delete(memberFieldDefinitions).where(eq(memberFieldDefinitions.id, current.id));
    }
    const result = values > 0 ? ("archived" as const) : ("deleted" as const);
    await tx.insert(auditLog).values({ eventType: result === "archived" ? "member_field.archive" : "member_field.delete", subjectId: current.id, payload: { clubId, key: current.key, deletedBy: c.get("membership").id } });
    return { id: current.id, outcome: result };
  });
  return c.json({ data: outcome });
});

memberFieldRoutes.post("/:id/unarchive", async (c) => {
  requireFormsWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const restored = await db.transaction(async (tx) => {
    const current = await loadLocked(tx, clubId, c.req.param("id"));
    if (current.archivedAt === null) throw new ConflictError("The custom field is not archived");
    const [row] = await tx.update(memberFieldDefinitions).set({ archivedAt: null }).where(eq(memberFieldDefinitions.id, current.id)).returning();
    await tx.insert(auditLog).values({ eventType: "member_field.unarchive", subjectId: current.id, payload: { clubId, key: current.key, restoredBy: c.get("membership").id } });
    return { row: row!, values: await countValues(tx, current.id) };
  });
  return c.json({ data: dto(restored.row, countFor(restored.row, restored.values, c.get("clubRoleTypes"))) });
});
