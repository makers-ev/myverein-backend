import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { memberFieldDefinitions, memberFieldValues, type MemberFieldDefinitionRow } from "../db/schema/forms.js";
import type { DbExecutor } from "./club-members.js";
import { type FieldErrorCode, type FormField, validateAnswers } from "./form-schema.js";

/**
 * Custom fields of a club member (Wave 8 B7, ADR-005): definitions per club, values per member. Values are validated
 * with the SAME engine as form answers (`validateAnswers`), so a value that is stored always fits the definition.
 */

export const CUSTOM_FIELD_TYPES = ["text", "textarea", "number", "date", "select", "multiselect", "checkbox", "credential"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Definitions per club (a cap against abuse, far above any real club). */
export const MAX_CUSTOM_FIELDS_PER_CLUB = 100;
/** Keys per value write request. */
export const MAX_VALUES_PER_REQUEST = 100;

export type FieldDefinition = Pick<MemberFieldDefinitionRow, "id" | "key" | "label" | "fieldType" | "options" | "validation" | "helpText" | "visibleTo" | "editableBy" | "sensitive" | "sortOrder" | "archivedAt">;

/** The form-engine view of a definition (`select`/`multiselect` carry their options, the rest has no extra rules). */
export function definitionToFormField(def: Pick<MemberFieldDefinitionRow, "key" | "label" | "fieldType"> & Partial<Pick<MemberFieldDefinitionRow, "options" | "validation">>): FormField {
  const options = Array.isArray(def.options) ? (def.options as Array<{ value: string; label: string }>) : undefined;
  const hasOptions = def.fieldType === "select" || def.fieldType === "multiselect" || (def.fieldType === "credential" && options !== undefined);
  const validation = def.validation && typeof def.validation === "object" ? (def.validation as FormField["validation"]) : undefined;
  return { key: def.key, label: def.label, type: def.fieldType as FormField["type"], ...(hasOptions ? { options } : {}), ...(validation ? { validation } : {}) };
}

export type CustomValueResult = { ok: true; value: unknown | undefined } | { ok: false; code: FieldErrorCode };

/**
 * Validates one value against its definition. `value: undefined` in the result means "cleared" (null, empty text, empty
 * list, unchecked checkbox are all the same: no value stored).
 */
export function validateCustomValue(def: Pick<MemberFieldDefinitionRow, "key" | "label" | "fieldType"> & Partial<Pick<MemberFieldDefinitionRow, "options" | "validation">>, value: unknown): CustomValueResult {
  const result = validateAnswers([definitionToFormField(def)], { [def.key]: value }, { mode: "submit" });
  if (!result.ok) return { ok: false, code: result.errors[def.key] ?? "invalid_value" };
  return { ok: true, value: Object.hasOwn(result.answers, def.key) ? result.answers[def.key] : undefined };
}

export type CustomAssignmentCheck = { ok: true; value: unknown | undefined } | { ok: false; reason: "custom_field_unknown" | "custom_field_archived" | "custom_field_type_mismatch" | "custom_field_not_sensitive" | "invalid_value" };

/**
 * Whether an answer of an application form can be written to the custom field it names (acceptance, B6, and its preview,
 * B10 -- one function so both always agree). A definition that was archived, deleted, retyped or un-flagged `sensitive` after
 * the form was published is TOLERATED (the value is skipped with a reason), never an error.
 */
export function checkCustomAssignment(def: Pick<MemberFieldDefinitionRow, "key" | "label" | "fieldType" | "options" | "sensitive" | "archivedAt"> | undefined, assignment: { type: FormField["type"]; sensitive: boolean; value: unknown }): CustomAssignmentCheck {
  if (!def) return { ok: false, reason: "custom_field_unknown" };
  if (def.archivedAt) return { ok: false, reason: "custom_field_archived" };
  if (def.fieldType !== (assignment.type === "consent" ? "checkbox" : assignment.type)) return { ok: false, reason: "custom_field_type_mismatch" };
  if (assignment.sensitive && !def.sensitive) return { ok: false, reason: "custom_field_not_sensitive" };
  const checked = validateCustomValue(def, assignment.value);
  return checked.ok ? { ok: true, value: checked.value } : { ok: false, reason: "invalid_value" };
}

/** Option values a select/multiselect definition currently offers. */
export function optionValues(options: unknown): string[] {
  return Array.isArray(options) ? (options as Array<{ value: string }>).map((o) => o.value) : [];
}

/** True if a stored value uses an option that is not in `allowed` (select: a string, multiselect: a list). */
export function valueUsesOtherOption(value: unknown, allowed: ReadonlySet<string>): boolean {
  if (typeof value === "string") return !allowed.has(value);
  if (Array.isArray(value)) return value.some((v) => typeof v !== "string" || !allowed.has(v));
  // credential: only its level refers to an option
  if (value !== null && typeof value === "object" && "level" in value && typeof (value as { level: unknown }).level === "string") return !allowed.has((value as { level: string }).level);
  return false;
}

/** All definitions of a club in display order. */
export async function listDefinitions(clubId: string, executor: DbExecutor = db): Promise<FieldDefinition[]> {
  return executor.select().from(memberFieldDefinitions).where(eq(memberFieldDefinitions.clubId, clubId)).orderBy(asc(memberFieldDefinitions.sortOrder), asc(memberFieldDefinitions.label), asc(memberFieldDefinitions.id));
}

/**
 * Share-locks the named definitions (id order) for the rest of the transaction. A concurrent type change, archive or
 * delete (which lock the definition FOR UPDATE) then waits for this write, and this write sees their outcome.
 */
export async function lockDefinitions(tx: DbExecutor, clubId: string, ids: readonly string[]): Promise<FieldDefinition[]> {
  if (ids.length === 0) return [];
  return tx.select().from(memberFieldDefinitions).where(and(eq(memberFieldDefinitions.clubId, clubId), inArray(memberFieldDefinitions.id, [...ids]))).orderBy(asc(memberFieldDefinitions.id)).for("share");
}

/** Writes (or clears) values of ONE member. Validation happened before; `updatedBy` is the writer's `member.id`. */
export async function writeValues(tx: DbExecutor, clubMemberId: string, updatedBy: string, changes: ReadonlyArray<{ fieldId: string; value: unknown | undefined }>): Promise<void> {
  const now = new Date();
  for (const change of changes) {
    if (change.value === undefined) {
      await tx.delete(memberFieldValues).where(and(eq(memberFieldValues.clubMemberId, clubMemberId), eq(memberFieldValues.fieldId, change.fieldId)));
      continue;
    }
    await tx
      .insert(memberFieldValues)
      .values({ clubMemberId, fieldId: change.fieldId, value: change.value, updatedBy, updatedAt: now })
      .onConflictDoUpdate({ target: [memberFieldValues.clubMemberId, memberFieldValues.fieldId], set: { value: change.value, updatedBy, updatedAt: now } });
  }
}

/** Number of stored values of a definition (decides archive vs. delete and whether the type may change). */
export async function countValues(tx: DbExecutor, fieldId: string): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberFieldValues).where(eq(memberFieldValues.fieldId, fieldId));
  return row?.n ?? 0;
}
