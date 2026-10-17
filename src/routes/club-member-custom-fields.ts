import { zValidator } from "@hono/zod-validator";
import { and, asc, count, eq, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { clubMembers } from "../db/schema/club-members.js";
import type { ClubMemberRow } from "../db/schema/club-members.js";
import { ensureClubMember, resolveClubMember } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { canBoardWrite, canReadValue, canSelfWrite, canViewCredentialOverview, isBoardLevel } from "../lib/custom-field-access.js";
import { type FieldDefinition, listDefinitions, MAX_VALUES_PER_REQUEST, validateCustomValue, writeValues } from "../lib/custom-fields.js";
import { addDays, CREDENTIAL_STATUSES, credentialExpiry, DEFAULT_EXPIRING_DAYS, MAX_EXPIRING_DAYS, type CredentialStatus } from "../lib/credentials.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import type { FieldErrorCode } from "../lib/form-schema.js";
import { FIELD_KEY_RE } from "../lib/form-schema.js";
import { invalidAnswers } from "../lib/forms.js";
import { assertMemberReadable, canSeeAllMembers, visibleStatusCondition } from "../lib/member-read-scope.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
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
const overviewLimiter = rateLimit({ windowMs: 60_000, max: 60, key: (c) => `credential-overview:${c.get("user")?.id ?? "anonymous"}` });
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

/** `self` when the writer is the account of the member the value belongs to, `board` otherwise, null without a value. No person ids. */
function enteredBy(updatedBy: string | null | undefined, ownerAccountId: string | null): "self" | "board" | null {
  if (updatedBy === undefined) return null;
  return updatedBy !== null && ownerAccountId !== null && updatedBy === ownerAccountId ? "self" : "board";
}

/** The fields of `row` the caller may see, with their values (see the module comment for the rules). */
async function buildView(c: { get(k: "clubId"): string; get(k: "clubRoleTypes"): string[]; get(k: "membership"): { id: string } }, row: ClubMemberRow, includeArchived: boolean) {
  const roleTypes = c.get("clubRoleTypes");
  const isSelf = row.memberId !== null && row.memberId === c.get("membership").id;
  if (includeArchived && !isBoardLevel(roleTypes)) throw new ForbiddenError("Archived custom fields are only visible to the board");

  const [defs, values] = await Promise.all([listDefinitions(c.get("clubId")), db.select().from(memberFieldValues).where(eq(memberFieldValues.clubMemberId, row.id))]);
  const valueOf = new Map(values.map((v) => [v.fieldId, v]));
  const viewer = { roleTypes, isSelf };
  const today = todayBerlin();

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
      // Who recorded the value: the person itself ("self": a declaration the club has not checked) or somebody else ("board").
      enteredBy: enteredBy(stored?.updatedBy, row.memberId),
      // Credential fields only: `{ status: expired|expiring|valid|missing, daysLeft, validUntil }` (Berlin day, 90-day window).
      expiry: d.fieldType === "credential" && canReadValue(d, viewer) ? credentialExpiry(stored?.value, today) : null,
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

// --- credential overview (board / Funktionsträger) ----------------------------------------------------------------
// Registered before the `/:id/...` routes so `credentials` is not taken for an id.

const overviewQuery = z.object({
  fieldKey: z.string().max(60).regex(FIELD_KEY_RE).optional(),
  status: z.enum(CREDENTIAL_STATUSES as unknown as [CredentialStatus, ...CredentialStatus[]]).optional(),
  withinDays: z.coerce.number().int().min(1).max(MAX_EXPIRING_DAYS).default(DEFAULT_EXPIRING_DAYS),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  /** Only honoured for callers who may see all members (members:write / members:read_sensitive). */
  includeFormer: z.enum(["true", "false"]).optional(),
});

/**
 * Members with their credential value and expiry status, for the credential fields the caller may see (`canReadValue`:
 * visibility and `sensitive` rules of custom-field-access.ts) and only members the caller may read (the Wave 7 scoping:
 * plain members only see probe/aktiv/ruhend members, former members only for the board with `includeFormer=true`).
 * Without `fieldKey` every visible credential field is listed (held credentials only); `status=missing` needs `fieldKey`
 * (members who do not hold that credential). An unknown, archived or invisible `fieldKey` is 404. Values never reach the
 * logs; a page with values of `sensitive` fields leaves ONE audit entry with ids only.
 */
memberCustomFieldRoutes.get("/credentials", requireAccountMember, overviewLimiter, async (c) => {
  // A club-wide list: board-level and Funktionsträger only, never plain members (even for fields visible to "mitglied").
  if (!canViewCredentialOverview(c.get("clubRoleTypes"))) throw new ForbiddenError("The credential overview is for the board and Funktionsträger");
  const parsed = overviewQuery.safeParse(c.req.query());
  if (!parsed.success) throw new ValidationError("Invalid query", { details: parsed.error.issues });
  const q = parsed.data;
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  const today = todayBerlin();
  const until = addDays(today, q.withinDays);

  if (q.status === "missing" && q.fieldKey === undefined) throw new ValidationError("status=missing needs a fieldKey", { details: { code: "field_key_required" } });

  const readable = (await listDefinitions(clubId)).filter((d) => d.fieldType === "credential" && d.archivedAt === null && canReadValue(d, { roleTypes, isSelf: false }));
  const selected = q.fieldKey === undefined ? readable : readable.filter((d) => d.key === q.fieldKey);
  // Same answer for "does not exist", "is archived", "is not a credential" and "you may not see it".
  if (q.fieldKey !== undefined && selected.length === 0) throw new NotFoundError("Custom field not found");
  const fieldsMeta = selected.map((d) => ({ id: d.id, key: d.key, label: d.label, sensitive: d.sensitive, options: d.options ?? null }));
  const empty = () => c.json({ data: [], page: q.page, pageSize: q.pageSize, total: 0, today, withinDays: q.withinDays, fields: fieldsMeta });
  if (selected.length === 0) return empty();

  const v = memberFieldValues;
  const validUntil = sql<string | null>`(${v.value} ->> 'validUntil')`;
  const statusCond: SQL | undefined =
    q.status === undefined
      ? undefined
      : q.status === "missing"
        ? isNull(v.id)
        : q.status === "expired"
          ? sql`${validUntil} < ${today}`
          : q.status === "expiring"
            ? sql`${validUntil} >= ${today} AND ${validUntil} <= ${until}`
            : sql`${isNotNull(v.id)} AND (${validUntil} IS NULL OR ${validUntil} > ${until})`;
  const scope = canSeeAllMembers(c) && q.includeFormer === "true" ? undefined : visibleStatusCondition(today);
  const where = and(eq(clubMembers.clubId, clubId), scope, q.fieldKey === undefined ? isNotNull(v.id) : undefined, statusCond);
  const join = and(eq(v.clubMemberId, clubMembers.id), inArray(v.fieldId, selected.map((d) => d.id)));

  const [totalRow] = await db.select({ n: count() }).from(clubMembers).leftJoin(v, join).where(where);
  const rows = await db
    .select({ clubMemberId: clubMembers.id, accountId: clubMembers.memberId, updatedBy: v.updatedBy, displayName: clubMembers.displayName, firstName: clubMembers.firstName, lastName: clubMembers.lastName, status: clubMembers.status, fieldId: v.fieldId, value: v.value, updatedAt: v.updatedAt })
    .from(clubMembers)
    .leftJoin(v, join)
    .where(where)
    .orderBy(sql`${validUntil} ASC NULLS LAST`, sql`lower(${clubMembers.displayName})`, asc(clubMembers.id), asc(v.fieldId))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  const byId = new Map(selected.map((d) => [d.id, d]));
  const data = rows.map((r) => {
    const def = byId.get(r.fieldId ?? selected[0]!.id)!;
    return {
      clubMemberId: r.clubMemberId,
      displayName: r.displayName,
      firstName: r.firstName,
      lastName: r.lastName,
      fieldKey: def.key,
      fieldLabel: def.label,
      sensitive: def.sensitive,
      value: r.value ?? null,
      updatedAt: r.updatedAt ?? null,
      enteredBy: r.fieldId === null ? null : enteredBy(r.updatedBy, r.accountId),
      expiry: credentialExpiry(r.value, today, q.withinDays),
    };
  });

  // Every query that touched a sensitive field is audited -- also an empty page or status=missing, because total and
  // the missing list disclose who holds the credential. Field ids always, member ids only of the rows with a value.
  const sensitiveSelected = selected.filter((d) => d.sensitive);
  if (sensitiveSelected.length > 0) {
    const sensitiveRows = rows.filter((r) => r.fieldId !== null && byId.get(r.fieldId)!.sensitive);
    await db.insert(auditLog).values({
      eventType: "member_field.sensitive_read",
      subjectId: clubId,
      payload: { clubId, via: "credentials_overview", fieldIds: sensitiveSelected.map((d) => d.id), clubMemberIds: [...new Set(sensitiveRows.map((r) => r.clubMemberId))], readBy: c.get("membership").id },
    });
  }
  return c.json({ data, page: q.page, pageSize: q.pageSize, total: totalRow?.n ?? 0, today, withinDays: q.withinDays, fields: fieldsMeta });
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
