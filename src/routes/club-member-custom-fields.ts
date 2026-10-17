import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import type { ClubMemberRow } from "../db/schema/club-members.js";
import { ensureClubMember, resolveClubMember } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { canBoardWrite, canReadValue, canSelfWrite, isBoardLevel } from "../lib/custom-field-access.js";
import { type FieldDefinition, listDefinitions, MAX_VALUES_PER_REQUEST, validateCustomValue, writeValues } from "../lib/custom-fields.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import type { FieldErrorCode } from "../lib/form-schema.js";
import { FIELD_KEY_RE } from "../lib/form-schema.js";
import { invalidAnswers } from "../lib/forms.js";
import { assertMemberReadable } from "../lib/member-read-scope.js";
import type { ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";

/**
 * Custom field VALUES of a club member (Wave 8 B7), mounted below `/club-members` (so `sessionGuard` + `clubGuard` already
 * ran). Rights are decided per definition in `src/lib/custom-field-access.ts` (deny-by-default); read scoping of the
 * member row is the Wave 7 one (`assertMemberReadable`: guests and hidden former members are 404). Values are validated
 * by the form engine against the definition. Values never reach logs or audit entries: reads of sensitive values by
 * somebody else and every write leave an audit entry with ids only.
 */
export const memberCustomFieldRoutes = new Hono<ClubEnv>();

const writeLimiter = rateLimit({ windowMs: 60_000, max: 60, key: (c) => `member-custom-fields:${c.get("user")?.id ?? "anonymous"}` });
const jsonLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: () => {
    throw new ValidationError("Request body too large");
  },
});
const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const writeSchema = z.object({ values: z.record(z.string().max(60), z.unknown()).refine((v) => Object.keys(v).length >= 1 && Object.keys(v).length <= MAX_VALUES_PER_REQUEST, { message: `1 to ${MAX_VALUES_PER_REQUEST} values` }) });

type Mode = "board" | "self";

/** The fields of `row` the caller may see, with their values (see the module comment for the rules). */
async function buildView(c: { get(k: "clubId"): string; get(k: "clubRoleTypes"): string[]; get(k: "membership"): { id: string } }, row: ClubMemberRow, includeArchived: boolean) {
  const roleTypes = c.get("clubRoleTypes");
  const isSelf = row.memberId !== null && row.memberId === c.get("membership").id;
  if (includeArchived && !isBoardLevel(roleTypes)) throw new ForbiddenError("Archived custom fields are only visible to the board");

  const [defs, values] = await Promise.all([listDefinitions(c.get("clubId")), db.select().from(memberFieldValues).where(eq(memberFieldValues.clubMemberId, row.id))]);
  const valueOf = new Map(values.map((v) => [v.fieldId, v]));
  const viewer = { roleTypes, isSelf };

  const shown = defs.filter((d) => {
    if (d.archivedAt !== null && !includeArchived) return false;
    if (canReadValue(d, { roleTypes, isSelf: false })) return true;
    // The person itself additionally sees what it may fill in and everything that was recorded about it.
    return isSelf && (canSelfWrite(d) || valueOf.has(d.id));
  });
  const items = shown.map((d) => {
    const stored = canReadValue(d, viewer) ? valueOf.get(d.id) : undefined;
    return {
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
      editable: canBoardWrite(d, roleTypes) || (isSelf && canSelfWrite(d)),
      value: stored?.value ?? null,
      updatedAt: stored?.updatedAt ?? null,
    };
  });

  // Reading somebody else's sensitive data (Art. 9 candidates: allergies, health, ...) is audited per retrieval, ids only.
  const sensitiveRead = items.filter((i) => i.sensitive && i.value !== null);
  if (!isSelf && sensitiveRead.length > 0) {
    await db.insert(auditLog).values({
      eventType: "member_field.sensitive_read",
      subjectId: row.id,
      payload: { clubId: c.get("clubId"), clubMemberId: row.id, fieldIds: sensitiveRead.map((i) => i.id), readBy: c.get("membership").id },
    });
  }
  return items;
}

/**
 * Validates and writes the named values of one member. `unknown_field` (422) for keys that do not exist, are archived or
 * that the caller may not even see (indistinguishable on purpose); `403` for a visible field the caller may not change.
 */
async function writeView(
  c: { get(k: "clubId"): string; get(k: "clubRoleTypes"): string[]; get(k: "membership"): { id: string } },
  row: ClubMemberRow,
  input: Record<string, unknown>,
  mode: Mode,
): Promise<void> {
  const roleTypes = c.get("clubRoleTypes");
  const keys = Object.keys(input);
  const errors: Record<string, FieldErrorCode> = Object.create(null);
  const wellFormed = keys.filter((k) => FIELD_KEY_RE.test(k));
  for (const k of keys) if (!wellFormed.includes(k)) errors[k] = "unknown_field";

  await db.transaction(async (tx) => {
    // FOR SHARE (id order): a concurrent type change / archive / delete of a definition waits for this write.
    const defs: FieldDefinition[] = wellFormed.length === 0 ? [] : await tx.select().from(memberFieldDefinitions).where(and(eq(memberFieldDefinitions.clubId, c.get("clubId")), inArray(memberFieldDefinitions.key, wellFormed))).orderBy(memberFieldDefinitions.id).for("share");
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const changes: Array<{ fieldId: string; value: unknown | undefined }> = [];
    let forbidden = false;

    for (const key of wellFormed) {
      const def = byKey.get(key);
      // Same visibility as the read view, so a key the caller cannot see is indistinguishable from one that does not exist.
      const visible = def !== undefined && (canReadValue(def, { roleTypes, isSelf: false }) || (mode === "self" && canSelfWrite(def)));
      if (!def || def.archivedAt !== null || !visible) {
        errors[key] = "unknown_field";
        continue;
      }
      if (mode === "board" ? !canBoardWrite(def, roleTypes) : !canSelfWrite(def)) {
        forbidden = true;
        continue;
      }
      const checked = validateCustomValue(def, Object.hasOwn(input, key) ? input[key] : undefined);
      if (!checked.ok) errors[key] = checked.code;
      else changes.push({ fieldId: def.id, value: checked.value });
    }
    if (Object.keys(errors).length > 0) throw invalidAnswers(errors);
    if (forbidden) throw new ForbiddenError(mode === "board" ? "Missing permission to change one of these custom fields" : "One of these custom fields can only be changed by the board");

    await writeValues(tx, row.id, c.get("membership").id, changes);
    await tx.insert(auditLog).values({
      eventType: "member_field.write",
      subjectId: row.id,
      payload: { clubId: c.get("clubId"), clubMemberId: row.id, fieldIds: changes.map((x) => x.fieldId), changedBy: c.get("membership").id, via: mode },
    });
  });
}

// --- own values -----------------------------------------------------------------------------------------------
// Registered before the `/:id/...` routes so `me` is not taken for an id.

// External guests (guardians) are not members of the club's data: no own custom field record, read or write.
const requireAccountMember = createMiddleware<ClubEnv>(async (c, next) => {
  if (c.get("membership").role === "guest") throw new ForbiddenError("External guests have no member profile fields");
  await next();
});

memberCustomFieldRoutes.get("/me/custom-fields", requireAccountMember, async (c) => {
  const row = await ensureClubMember(db, c.get("membership"));
  return c.json({ data: { clubMemberId: row.id, fields: await buildView(c, row, false) } });
});

memberCustomFieldRoutes.patch("/me/custom-fields", requireAccountMember, writeLimiter, jsonLimit, zValidator("json", writeSchema, validationHook), async (c) => {
  const row = await ensureClubMember(db, c.get("membership"));
  await writeView(c, row, c.req.valid("json").values, "self");
  return c.json({ data: { clubMemberId: row.id, fields: await buildView(c, row, false) } });
});

// --- a member's values (board / visibility rules) ---------------------------------------------------------------

memberCustomFieldRoutes.get("/:id/custom-fields", async (c) => {
  const row = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  assertMemberReadable(c, row);
  return c.json({ data: { clubMemberId: row.id, fields: await buildView(c, row, c.req.query("includeArchived") === "true") } });
});

const requireMembersWrite = createMiddleware<ClubEnv>(async (c, next) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  await next();
});

memberCustomFieldRoutes.put("/:id/custom-fields", requireMembersWrite, writeLimiter, jsonLimit, zValidator("json", writeSchema, validationHook), async (c) => {
  const row = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  await writeView(c, row, c.req.valid("json").values, "board");
  return c.json({ data: { clubMemberId: row.id, fields: await buildView(c, row, false) } });
});
