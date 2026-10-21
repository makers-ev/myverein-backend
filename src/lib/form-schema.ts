import { z } from "zod";

import { cleanText, isCleanIdentifier, isCleanText } from "./text-policy.js";
import { MAPPING_TARGET_KEYS, mappingAcceptsType, type MappingTarget } from "./form-mapping.js";

/**
 * Field definition and answer validation of the form builder (Wave 8 B3, ADR-005).
 *
 * `formFieldsSchema` validates the definition an editor saves; `validateAnswers` is the server-side authority for what
 * a submission may contain (client validation is convenience only). Both are pure functions without I/O.
 */

export const FIELD_TYPES = ["text", "textarea", "number", "date", "select", "multiselect", "checkbox", "consent", "credential", "file", "image", "info"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const MAX_FIELDS = 60;
export const MAX_OPTIONS = 50;
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** Keys that match FIELD_KEY_RE but are dangerous as object keys or reserved by the engine. */
const RESERVED_KEYS = new Set(["constructor", "prototype", "hasownproperty", "tostring", "valueof"]);
const TEXT_MAX = 200;
const TEXTAREA_MAX = 5000;
const SELECT_ONLY_TYPES: readonly FieldType[] = ["select", "multiselect"];
/** Longest free-text level ("Stufe") of a credential. */
export const CREDENTIAL_LEVEL_MAX = 80;
/** Credential dates must lie in this range (typos like year 0202 or 20260 are refused). */
export const CREDENTIAL_MIN_DATE = "1900-01-01";
export const CREDENTIAL_MAX_DATE = "2100-12-31";
const FILE_TYPES: readonly FieldType[] = ["file", "image"];
const CONDITION_SOURCE_TYPES: readonly FieldType[] = ["text", "select", "multiselect", "checkbox", "consent"];

export const PATTERN_PRESETS = {
  email: /^[^\s@]{1,64}@[^\s@.]{1,255}(?:\.[^\s@.]{1,63}){1,10}$/,
  postal_code: /^\d{5}$/,
  phone: /^\+?[0-9 ()/-]{5,25}$/,
} as const;
export type PatternPreset = keyof typeof PATTERN_PRESETS;

const keySchema = z
  .string()
  .regex(FIELD_KEY_RE)
  .refine((k) => !RESERVED_KEYS.has(k), "reserved key");

const optionsSource = z.enum(["member_categories"]);

const validationSchema = z
  .object({
    minLength: z.number().int().min(0).max(TEXTAREA_MAX).optional(),
    maxLength: z.number().int().min(1).max(TEXTAREA_MAX).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    minDate: z.iso.date().optional(),
    maxDate: z.iso.date().optional(),
    pattern: z.enum(Object.keys(PATTERN_PRESETS) as [PatternPreset, ...PatternPreset[]]).optional(),
  })
  .strict();

const visibleIfSchema = z
  .object({
    fieldKey: keySchema,
    op: z.enum(["eq", "neq", "in", "checked"]),
    value: z.union([z.string().max(80).refine(isCleanIdentifier, "not allowed"), z.number().finite(), z.boolean(), z.array(z.string().max(80).refine(isCleanIdentifier, "not allowed")).min(1).max(MAX_OPTIONS)]).optional(),
  })
  .strict();

const fieldSchema = z
  .object({
    key: keySchema,
    type: z.enum(FIELD_TYPES),
    label: cleanText(z.string().trim().min(1).max(200)),
    helpText: cleanText(z.string().trim().max(500)).optional(),
    required: z.boolean().optional(),
    options: z.array(z.object({ value: z.string().trim().min(1).max(80).refine(isCleanIdentifier, "not allowed"), label: cleanText(z.string().trim().min(1).max(200)) }).strict()).min(1).max(MAX_OPTIONS).optional(),
    optionsSource: optionsSource.optional(),
    validation: validationSchema.optional(),
    visibleIf: visibleIfSchema.optional(),
    mapsTo: z.enum(MAPPING_TARGET_KEYS).optional(),
    customField: keySchema.optional(),
    infoKind: z.enum(["privacy_notice"]).optional(),
    // Consent block only (Wave 10 B3): the key of a club consent purpose. A ticked box is recorded as a consent event of
    // that purpose when the application is accepted. Always voluntary: such a field can never be `required`.
    purposeKey: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),
    text: cleanText(z.string().trim().max(2000), true).optional(),
    // Marks answers that need special protection (health, ...): review visibility (members:read_sensitive) in B6/B10.
    sensitive: z.boolean().optional(),
  })
  .strict();

export type FormField = z.infer<typeof fieldSchema>;

/** Definition of a form version: at most 60 fields, unique keys, consistent per type, `visibleIf` only on earlier fields. */
export const formFieldsSchema = z
  .array(fieldSchema)
  .max(MAX_FIELDS)
  .superRefine((fields, ctx) => {
    const seen = new Map<string, FormField>();
    const mapped = new Set<MappingTarget>();
    const customKeys = new Set<string>();
    fields.forEach((field, i) => {
      const issue = (message: string, path: Array<string | number> = []) => ctx.addIssue({ code: "custom", message, path: [i, ...path] });
      if (seen.has(field.key)) issue("duplicate key", ["key"]);

      const isSelect = SELECT_ONLY_TYPES.includes(field.type);
      if (isSelect && (field.options === undefined) === (field.optionsSource === undefined)) issue("select needs exactly one of options and optionsSource", ["options"]);
      // A credential may list its levels ("Stufe"), but never takes an options source.
      const levelOptions = field.type === "credential" && field.options !== undefined && field.optionsSource === undefined;
      if (!isSelect && !levelOptions && (field.options !== undefined || field.optionsSource !== undefined)) issue("options only for select/multiselect (and the levels of a credential)", ["options"]);
      if (field.options && new Set(field.options.map((o) => o.value)).size !== field.options.length) issue("duplicate option value", ["options"]);

      if (field.purposeKey !== undefined) {
        if (field.type !== "consent") issue("purposeKey only for consent fields", ["purposeKey"]);
        else if (field.required) issue("a consent for a purpose is voluntary and cannot be required", ["required"]);
      }

      if (field.type === "info") {
        if (field.required || field.mapsTo || field.customField || field.validation || field.sensitive) issue("info fields carry no answer", ["type"]);
      } else if (field.infoKind !== undefined || field.text !== undefined) {
        issue("infoKind/text only for info", ["infoKind"]);
      }

      if (field.mapsTo !== undefined) {
        if (field.customField !== undefined) issue("mapsTo and customField are exclusive", ["mapsTo"]);
        if (!mappingAcceptsType(field.mapsTo, field.type)) issue("mapsTo does not fit the field type", ["mapsTo"]);
        if (field.mapsTo === "category" && field.optionsSource !== "member_categories") issue("category mapping needs optionsSource member_categories", ["mapsTo"]);
        if (mapped.has(field.mapsTo)) issue("mapsTo target used twice", ["mapsTo"]);
        mapped.add(field.mapsTo);
      }
      if (field.customField !== undefined) {
        if (["info", "file", "image"].includes(field.type)) issue("customField does not fit the field type", ["customField"]);
        if (customKeys.has(field.customField)) issue("customField used twice", ["customField"]);
        customKeys.add(field.customField);
      }

      const v = field.validation;
      if (v) {
        const textual = field.type === "text" || field.type === "textarea";
        // A credential's maxLength is the length of its free-text level (exclusive with a list of levels).
        const levelText = field.type === "credential" && v.minLength === undefined && field.options === undefined;
        if ((v.minLength !== undefined || v.maxLength !== undefined) && !textual && !levelText) issue("length limits only for text", ["validation"]);
        if (field.type === "credential" && v.maxLength !== undefined && v.maxLength > CREDENTIAL_LEVEL_MAX) issue(`maxLength of a credential level is at most ${CREDENTIAL_LEVEL_MAX}`, ["validation"]);
        if (v.pattern !== undefined && field.type !== "text") issue("pattern only for text", ["validation"]);
        if ((v.min !== undefined || v.max !== undefined) && field.type !== "number") issue("min/max only for number", ["validation"]);
        if ((v.minDate !== undefined || v.maxDate !== undefined) && field.type !== "date") issue("date limits only for date", ["validation"]);
        if (field.type === "text" && v.maxLength !== undefined && v.maxLength > TEXT_MAX) issue(`maxLength of a text field is at most ${TEXT_MAX}`, ["validation"]);
        if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) issue("minLength > maxLength", ["validation"]);
        if (v.min !== undefined && v.max !== undefined && v.min > v.max) issue("min > max", ["validation"]);
        if (v.minDate !== undefined && v.maxDate !== undefined && v.minDate > v.maxDate) issue("minDate > maxDate", ["validation"]);
      }

      const cond = field.visibleIf;
      if (cond) {
        const source = seen.get(cond.fieldKey);
        if (!source) issue("visibleIf must reference an earlier field", ["visibleIf", "fieldKey"]);
        else if (!CONDITION_SOURCE_TYPES.includes(source.type)) issue("visibleIf source type not supported", ["visibleIf", "fieldKey"]);
        else {
          const bool = source.type === "checkbox" || source.type === "consent";
          const opsOk = bool ? cond.op === "checked" : source.type === "multiselect" ? cond.op === "in" : cond.op !== "checked";
          if (!opsOk) issue("visibleIf operator does not fit the source field", ["visibleIf", "op"]);
          else if (cond.op === "checked" ? cond.value !== undefined : cond.value === undefined || Array.isArray(cond.value) !== (cond.op === "in")) issue("visibleIf value does not fit the operator", ["visibleIf", "value"]);
          else if (cond.op !== "checked") {
            const values = (Array.isArray(cond.value) ? cond.value : [cond.value]) as unknown[];
            if (values.some((x) => typeof x !== "string")) issue("visibleIf value must be text", ["visibleIf", "value"]);
            else if (source.options && values.some((x) => !source.options!.some((o) => o.value === x))) issue("visibleIf value is not an option of the source field", ["visibleIf", "value"]);
          }
        }
      }
      seen.set(field.key, field);
    });
  });

export interface ValidateContext {
  /** `draft` skips the required checks (a work in progress); `submit` enforces them. */
  mode: "draft" | "submit";
  /** Keys of the club's active categories; resolves `optionsSource: "member_categories"`. */
  categoryKeys?: readonly string[];
  /** Field keys of `file`/`image` fields that already have an uploaded file (answers never carry file data). */
  uploadedFieldKeys?: ReadonlySet<string>;
}

export type FieldErrorCode = "unknown_field" | "required" | "invalid_type" | "invalid_value" | "too_short" | "too_long" | "too_small" | "too_large" | "invalid_format" | "not_an_option";

export type ValidateResult = { ok: true; answers: Record<string, unknown> } | { ok: false; errors: Record<string, FieldErrorCode> };

type Answers = Record<string, unknown>;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

function isPlainObject(value: unknown): value is Answers {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function conditionHolds(field: FormField, values: Answers, visibleKeys: ReadonlySet<string>): boolean {
  const cond = field.visibleIf;
  if (!cond) return true;
  // A field behind a hidden field is hidden too.
  if (!visibleKeys.has(cond.fieldKey)) return false;
  const actual = Object.hasOwn(values, cond.fieldKey) ? values[cond.fieldKey] : undefined;
  switch (cond.op) {
    case "checked":
      return actual === true;
    case "eq":
      return !isEmpty(actual) && actual === cond.value;
    case "neq":
      return actual !== cond.value;
    case "in": {
      const allowed = cond.value as string[];
      if (Array.isArray(actual)) return actual.some((a) => allowed.includes(a as string));
      return typeof actual === "string" && allowed.includes(actual);
    }
  }
}

/** Keys of the answerable fields whose `visibleIf` holds for `answers` (a field behind a hidden field is hidden too). */
export function visibleFieldKeys(fields: readonly FormField[], answers: unknown): Set<string> {
  const values: Answers = isPlainObject(answers) ? answers : {};
  const visible = new Set<string>();
  for (const field of fields) {
    if (field.type === "info") continue;
    if (conditionHolds(field, values, visible)) visible.add(field.key);
  }
  return visible;
}

export interface CredentialValue {
  valid: true;
  level?: string;
  obtainedOn?: string;
  validUntil?: string;
}

const CREDENTIAL_KEYS = new Set(["valid", "level", "obtainedOn", "validUntil"]);

/**
 * A credential ("holds it") is `{ valid: true, level?, obtainedOn?, validUntil? }`. `valid` must be `true` (not held = no
 * value at all, clear with null); `level` only when the definition has levels (`options`) or a free-text level
 * (`validation.maxLength`); dates are strict `YYYY-MM-DD`, `validUntil >= obtainedOn`. The result has exactly these keys.
 */
function cleanCredential(field: FormField, value: unknown, optionValues: readonly string[]): { value: unknown } | { error: FieldErrorCode } {
  if (!isPlainObject(value)) return { error: "invalid_type" };
  if (Object.keys(value).some((k) => !CREDENTIAL_KEYS.has(k))) return { error: "invalid_value" };
  if (value.valid !== true) return { error: "invalid_value" };
  const out: CredentialValue = { valid: true };
  const level = Object.hasOwn(value, "level") ? value.level : undefined;
  if (level !== undefined && level !== null && level !== "") {
    if (typeof level !== "string") return { error: "invalid_type" };
    if (field.options) {
      if (!optionValues.includes(level)) return { error: "not_an_option" };
      out.level = level;
    } else if (field.validation?.maxLength !== undefined) {
      const text = level.trim();
      if (text.length > field.validation.maxLength) return { error: "too_long" };
      if (!isCleanText(text)) return { error: "invalid_value" };
      if (text !== "") out.level = text;
    } else {
      return { error: "invalid_value" };
    }
  }
  for (const key of ["obtainedOn", "validUntil"] as const) {
    const raw = Object.hasOwn(value, key) ? value[key] : undefined;
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string") return { error: "invalid_type" };
    if (!isIsoDate(raw)) return { error: "invalid_value" };
    if (raw < CREDENTIAL_MIN_DATE) return { error: "too_small" };
    if (raw > CREDENTIAL_MAX_DATE) return { error: "too_large" };
    out[key] = raw;
  }
  if (out.obtainedOn !== undefined && out.validUntil !== undefined && out.validUntil < out.obtainedOn) return { error: "invalid_value" };
  return { value: out };
}

/** Validates one non-empty answer against its field. Returns the cleaned value or an error code. */
function cleanValue(field: FormField, value: unknown, optionValues: readonly string[]): { value: unknown } | { error: FieldErrorCode } {
  const v = field.validation;
  switch (field.type) {
    case "text":
    case "textarea": {
      if (typeof value !== "string") return { error: "invalid_type" };
      const text = value.trim();
      const hardMax = field.type === "text" ? TEXT_MAX : TEXTAREA_MAX;
      if (text.length > Math.min(v?.maxLength ?? hardMax, hardMax)) return { error: "too_long" };
      if (text.length < (v?.minLength ?? 0)) return { error: "too_short" };
      if (!isCleanText(text, field.type === "textarea")) return { error: "invalid_value" };
      if (v?.pattern && !PATTERN_PRESETS[v.pattern].test(text)) return { error: "invalid_format" };
      return { value: text };
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { error: "invalid_type" };
      if (v?.min !== undefined && value < v.min) return { error: "too_small" };
      if (v?.max !== undefined && value > v.max) return { error: "too_large" };
      return { value };
    }
    case "date": {
      if (typeof value !== "string") return { error: "invalid_type" };
      if (!isIsoDate(value)) return { error: "invalid_value" };
      if (v?.minDate !== undefined && value < v.minDate) return { error: "too_small" };
      if (v?.maxDate !== undefined && value > v.maxDate) return { error: "too_large" };
      return { value };
    }
    case "select": {
      if (typeof value !== "string") return { error: "invalid_type" };
      return optionValues.includes(value) ? { value } : { error: "not_an_option" };
    }
    case "multiselect": {
      if (!Array.isArray(value)) return { error: "invalid_type" };
      if (value.some((x) => typeof x !== "string")) return { error: "invalid_type" };
      if (new Set(value).size !== value.length || value.length > MAX_OPTIONS) return { error: "invalid_value" };
      return (value as string[]).every((x) => optionValues.includes(x)) ? { value } : { error: "not_an_option" };
    }
    case "checkbox":
    case "consent":
      return typeof value === "boolean" ? { value } : { error: "invalid_type" };
    case "credential":
      return cleanCredential(field, value, optionValues);
    default:
      return { error: "invalid_value" };
  }
}

/**
 * Validates `answers` against a version's field definition.
 *
 * - Unknown keys (including `__proto__`, `constructor`) -> `unknown_field`; so is an answer for an `info`/`file`/`image` field.
 * - A field whose `visibleIf` does not hold is dropped from the result and is never required.
 * - On `submit`, required fields must be filled; required `checkbox`/`consent` must be `true`; required `file`/`image`
 *   fields need an entry in `uploadedFieldKeys`.
 * - Empty values (`undefined`, `null`, `""`, `[]`) count as not answered and are not stored.
 */
export function validateAnswers(fields: readonly FormField[], answers: unknown, ctx: ValidateContext): ValidateResult {
  if (!isPlainObject(answers)) return { ok: false, errors: { _: "invalid_type" } };
  // Null prototype: an answer key such as `__proto__` must become an own entry of the error map, not hit the setter.
  const errors: Record<string, FieldErrorCode> = Object.create(null);
  const known = new Map(fields.map((f) => [f.key, f]));

  for (const key of Object.keys(answers)) {
    const field = known.get(key);
    if (!field || field.type === "info" || FILE_TYPES.includes(field.type)) errors[key] = "unknown_field";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const cleaned: Answers = {};
  const visibleKeys = new Set<string>();
  for (const field of fields) {
    if (field.type === "info") continue;
    const visible = conditionHolds(field, cleaned, visibleKeys);
    if (!visible) continue;
    visibleKeys.add(field.key);

    if (FILE_TYPES.includes(field.type)) {
      if (ctx.mode === "submit" && field.required && !ctx.uploadedFieldKeys?.has(field.key)) errors[field.key] = "required";
      continue;
    }

    // Koppelungsverbot (Art. 7(4) GDPR): a consent is never enforced, not even in a form version published with `required`.
    const required = field.type === "consent" ? false : field.required;
    const raw = Object.hasOwn(answers, field.key) ? answers[field.key] : undefined;
    const optionValues = field.options ? field.options.map((o) => o.value) : field.optionsSource === "member_categories" ? [...(ctx.categoryKeys ?? [])] : [];

    if (isEmpty(raw) || (raw === false && (field.type === "checkbox" || field.type === "consent") && !required)) {
      if (ctx.mode === "submit" && required) errors[field.key] = "required";
      continue;
    }
    const result = cleanValue(field, raw, optionValues);
    if ("error" in result) {
      errors[field.key] = result.error;
      continue;
    }
    if ((field.type === "checkbox" || field.type === "consent") && required && result.value !== true) {
      if (ctx.mode === "submit") errors[field.key] = "required";
      continue;
    }
    cleaned[field.key] = result.value;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answers: cleaned };
}

/** Option list the client must offer for a field, with `member_categories` resolved. */
export function resolveFieldOptions(field: FormField, categories: ReadonlyArray<{ key: string; name: string }>): Array<{ value: string; label: string }> {
  if (field.options) return field.options;
  if (field.optionsSource === "member_categories") return categories.map((c) => ({ value: c.key, label: c.name }));
  return [];
}
