import { resolveFieldOptions, visibleFieldKeys, type FormField } from "./form-schema.js";

/**
 * Review rendering of stored answers (Wave 8 B9/B10): the answers of a submission rendered against the VERSION it was
 * filled in (labels, option labels, order and visibility as of that version -- never the current form). Pure functions.
 * Fields marked `sensitive` are only rendered for callers who may read them; everybody else gets the field with
 * `redacted: true` and no value. Nothing here logs or audits a value.
 */

export interface RenderedAnswer {
  key: string;
  label: string;
  helpText?: string;
  type: FormField["type"];
  required: boolean;
  sensitive: boolean;
  /** The field is sensitive and the caller may not read it: `value` and `display` are null. */
  redacted: boolean;
  /** Whether the applicant gave an answer. */
  answered: boolean;
  /** Raw stored value (string, number, boolean, string list) or null. */
  value: unknown;
  /** Human readable form: option labels instead of option values, `null` when unanswered or redacted. */
  display: string | string[] | boolean | number | null;
}

export interface RenderOptions {
  /** Categories of the club (key + name) to label `optionsSource: "member_categories"` values. */
  categories: ReadonlyArray<{ key: string; name: string }>;
  canReadSensitive: boolean;
}

/** Fields that carry an answer in `answers` (files and photos live in `form_submission_files`, `info` is display only). */
const ANSWER_TYPES = new Set<FormField["type"]>(["text", "textarea", "number", "date", "select", "multiselect", "checkbox", "consent"]);

export function renderAnswers(fields: readonly FormField[], answers: unknown, options: RenderOptions): RenderedAnswer[] {
  const source: Record<string, unknown> = typeof answers === "object" && answers !== null && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const visible = visibleFieldKeys(fields, source);
  const out: RenderedAnswer[] = [];
  for (const field of fields) {
    if (!ANSWER_TYPES.has(field.type) || !visible.has(field.key)) continue;
    const sensitive = field.sensitive === true;
    const redacted = sensitive && !options.canReadSensitive;
    const raw = Object.hasOwn(source, field.key) ? source[field.key] : undefined;
    const answered = raw !== undefined && raw !== null && raw !== "" && !(Array.isArray(raw) && raw.length === 0);
    const base = { key: field.key, label: field.label, ...(field.helpText ? { helpText: field.helpText } : {}), type: field.type, required: field.required === true, sensitive, answered };
    if (redacted) {
      out.push({ ...base, redacted: true, value: null, display: null });
      continue;
    }
    out.push({ ...base, redacted: false, value: answered ? raw : null, display: answered ? display(field, raw, options.categories) : null });
  }
  return out;
}

function display(field: FormField, raw: unknown, categories: RenderOptions["categories"]): RenderedAnswer["display"] {
  if (field.type === "select" || field.type === "multiselect") {
    const labels = new Map(resolveFieldOptions(field, categories).map((o) => [o.value, o.label]));
    const label = (v: unknown) => (typeof v === "string" ? (labels.get(v) ?? v) : String(v));
    return Array.isArray(raw) ? raw.map(label) : label(raw);
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  return null;
}

export interface AnswerSummaryItem {
  key: string;
  label: string;
  display: string;
}

const SUMMARY_TYPES = new Set<FormField["type"]>(["text", "select", "multiselect", "date", "number", "checkbox"]);

/**
 * A short digest for lists: the first `limit` answered, non-sensitive fields of a compact type (no free-text areas, no
 * consents), each value cut to 80 characters. Sensitive fields never appear here, whatever the caller may read.
 */
export function summarizeAnswers(rendered: readonly RenderedAnswer[], limit = 4): AnswerSummaryItem[] {
  const items: AnswerSummaryItem[] = [];
  for (const answer of rendered) {
    if (items.length >= limit) break;
    if (!SUMMARY_TYPES.has(answer.type) || answer.sensitive || !answer.answered || answer.display === null) continue;
    const text = Array.isArray(answer.display) ? answer.display.join(", ") : typeof answer.display === "boolean" ? (answer.display ? "ja" : "nein") : String(answer.display);
    items.push({ key: answer.key, label: answer.label, display: text.length > 80 ? `${text.slice(0, 79)}…` : text });
  }
  return items;
}
