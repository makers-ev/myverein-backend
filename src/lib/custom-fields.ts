import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { memberFieldDefinitions, memberFieldValues, type MemberFieldDefinitionRow } from "../db/schema/forms.js";
import type { DbExecutor } from "./club-members.js";
import { type FieldErrorCode, type FormField, validateAnswers } from "./form-schema.js";

/**
 * Custom fields of a club member (Wave 8 B7, ADR-005): definitions per club, values per member. Values are validated
 * with the SAME engine as form answers (`validateAnswers`), so a value that is stored always fits the definition.
 */

export const CUSTOM_FIELD_TYPES = ["text", "textarea", "number", "date", "select", "multiselect", "checkbox"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/** Definitions per club (a cap against abuse, far above any real club). */
export const MAX_CUSTOM_FIELDS_PER_CLUB = 100;
/** Keys per value write request. */
export const MAX_VALUES_PER_REQUEST = 100;

export type FieldDefinition = Pick<MemberFieldDefinitionRow, "id" | "key" | "label" | "fieldType" | "options" | "visibleTo" | "editableBy" | "sensitive" | "sortOrder" | "archivedAt">;

/** The form-engine view of a definition (`select`/`multiselect` carry their options, the rest has no extra rules). */
export function definitionToFormField(def: Pick<MemberFieldDefinitionRow, "key" | "label" | "fieldType" | "options">): FormField {
  const options = Array.isArray(def.options) ? (def.options as Array<{ value: string; label: string }>) : undefined;
  return { key: def.key, label: def.label, type: def.fieldType as FormField["type"], ...(def.fieldType === "select" || def.fieldType === "multiselect" ? { options } : {}) };
}

export type CustomValueResult = { ok: true; value: unknown | undefined } | { ok: false; code: FieldErrorCode };

/**
 * Validates one value against its definition. `value: undefined` in the result means "cleared" (null, empty text, empty
 * list, unchecked checkbox are all the same: no value stored).
 */
export function validateCustomValue(def: Pick<MemberFieldDefinitionRow, "key" | "label" | "fieldType" | "options">, value: unknown): CustomValueResult {
  const result = validateAnswers([definitionToFormField(def)], { [def.key]: value }, { mode: "submit" });
  if (!result.ok) return { ok: false, code: result.errors[def.key] ?? "invalid_value" };
  return { ok: true, value: Object.hasOwn(result.answers, def.key) ? result.answers[def.key] : undefined };
}

/** Option values a select/multiselect definition currently offers. */
export function optionValues(options: unknown): string[] {
  return Array.isArray(options) ? (options as Array<{ value: string }>).map((o) => o.value) : [];
}

/** True if a stored value uses an option that is not in `allowed` (select: a string, multiselect: a list). */
export function valueUsesOtherOption(value: unknown, allowed: ReadonlySet<string>): boolean {
  if (typeof value === "string") return !allowed.has(value);
  if (Array.isArray(value)) return value.some((v) => typeof v !== "string" || !allowed.has(v));
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
