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
import { formFieldsSchema } from "../lib/form-schema.js";
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

const dto = (d: FieldDefinition, valueCount?: number) => ({
  id: d.id,
  key: d.key,
  label: d.label,
  type: d.fieldType,
  options: d.options ?? null,
  visibleTo: d.visibleTo,
  editableBy: d.editableBy,
  sensitive: d.sensitive,
  sortOrder: d.sortOrder,
  archived: d.archivedAt !== null,
  archivedAt: d.archivedAt,
  ...(valueCount !== undefined ? { valueCount } : {}),
});

/** The shape rules of a definition are the form engine's own (key format, reserved keys, clean text, option limits). */
function checkDefinition(input: { key: string; type: string; label: string; options?: Array<{ value: string; label: string }> | null }) {
  const parsed = formFieldsSchema.safeParse([{ key: input.key, type: input.type, label: input.label, ...(input.options ? { options: input.options } : {}) }]);
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
    return c.json({ data: defs.map((d) => dto(d, counts.get(d.id) ?? 0)) });
  }
  // Everybody else: the definitions whose values they may see of others, plus those they may fill in for themselves.
  const visible = defs.filter((d) => d.archivedAt === null && (canReadValue(d, { roleTypes, isSelf: false }) || canSelfWrite(d)));
  return c.json({ data: visible.map((d) => dto(d)) });
});

const optionsSchema = z.array(z.object({ value: z.string(), label: z.string() }).strict()).max(100);

const createSchema = z
  .object({
    key: z.string().max(60),
    label: z.string().max(300),
    type: z.enum(CUSTOM_FIELD_TYPES),
    options: optionsSchema.optional(),
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
  const checked = checkDefinition(body);

  try {
    const created = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`custom-field-create:${clubId}`}, 0))`);
      const [{ n }] = await tx.select({ n: count() }).from(memberFieldDefinitions).where(eq(memberFieldDefinitions.clubId, clubId));
      if (n >= MAX_CUSTOM_FIELDS_PER_CLUB) throw new ConflictError("Too many custom fields", { details: { code: "custom_field_limit", limit: MAX_CUSTOM_FIELDS_PER_CLUB } });
      const [row] = await tx
        .insert(memberFieldDefinitions)
        .values({ clubId, key: checked.key, label: checked.label, fieldType: checked.type, options: checked.options ?? null, visibleTo: body.visibleTo, editableBy: body.editableBy, sensitive: body.sensitive, sortOrder: body.sortOrder })
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
    type: z.enum(CUSTOM_FIELD_TYPES).optional(),
    options: optionsSchema.nullable().optional(),
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
    const isChoice = type === "select" || type === "multiselect";
    // Changing the type to/from a choice type without saying what the options are would leave a broken definition.
    let options = current.options as Array<{ value: string; label: string }> | null;
    if (body.options !== undefined) options = body.options;
    else if (body.type !== undefined && !isChoice) options = null;
    const checked = checkDefinition({ key: current.key, type, label: body.label ?? current.label, options });

    const values = await countValues(tx, current.id);
    if (type !== current.fieldType && values > 0) throw new ConflictError("The type of a custom field cannot change once it has values", { details: { code: "custom_field_has_values" } });
    if (isChoice && body.options !== undefined && values > 0) {
      const allowed = new Set(optionValues(checked.options));
      const stored = await tx.select({ value: memberFieldValues.value }).from(memberFieldValues).where(eq(memberFieldValues.fieldId, current.id));
      if (stored.some((s) => valueUsesOtherOption(s.value, allowed))) throw new ConflictError("An option that is in use cannot be removed", { details: { code: "option_in_use" } });
    }

    const [row] = await tx
      .update(memberFieldDefinitions)
      .set({
        label: checked.label,
        fieldType: checked.type,
        options: checked.options ?? null,
        ...(body.visibleTo !== undefined ? { visibleTo: body.visibleTo } : {}),
        ...(body.editableBy !== undefined ? { editableBy: body.editableBy } : {}),
        ...(body.sensitive !== undefined ? { sensitive: body.sensitive } : {}),
        ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      })
      .where(eq(memberFieldDefinitions.id, current.id))
      .returning();
    await tx.insert(auditLog).values({ eventType: "member_field.update", subjectId: current.id, payload: { clubId, key: current.key, changed: Object.keys(body), updatedBy: c.get("membership").id } });
    return { row: row!, values };
  });
  return c.json({ data: dto(updated.row, updated.values) });
});

// Delete when nothing refers to the field, archive when values exist (they stay for the record, nobody can read or write them).
memberFieldRoutes.delete("/:id", async (c) => {
  requireFormsWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const outcome = await db.transaction(async (tx) => {
    const current = await loadLocked(tx, clubId, c.req.param("id"));
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
  return c.json({ data: dto(restored.row, restored.values) });
});
