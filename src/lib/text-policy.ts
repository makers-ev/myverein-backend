import { z } from "zod";

/**
 * Shared character policy of the form builder (Wave 8) for everything a person types: definition texts (form name,
 * labels, help texts, option labels/values, info text, privacy notice) and answers.
 *
 * Rejected: C0/C1 control characters (NUL would otherwise be a Postgres error = 500), DEL, the bidirectional
 * overrides/embeddings/isolates and marks (text that displays differently from what it contains), the line/paragraph
 * separators and unpaired surrogates. Multi-line text (textarea answers, info text, privacy notice) additionally allows
 * `\n`, `\r` and `\t`. Emoji and every other printable character are fine.
 *
 * `<` is NOT filtered in labels: clients render all of this strictly as text (README "Form builder"). It is rejected
 * in keys (their regex has no `<`) and in option values, which clients may use as identifiers.
 */

/** Code point ranges that are never accepted (C0/C1 controls incl. NUL and DEL, bidi marks/overrides/isolates, line/paragraph separators). */
const FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
/** Allowed control characters in multi-line text: tab, line feed, carriage return. */
const MULTILINE_ALLOWED = new Set([0x09, 0x0a, 0x0d]);

export function isCleanText(value: string, multiline = false): boolean {
  if (!value.isWellFormed()) return false;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (multiline && MULTILINE_ALLOWED.has(cp)) continue;
    if (FORBIDDEN_RANGES.some(([from, to]) => cp >= from && cp <= to)) return false;
  }
  return true;
}

/** Zod refinement for a string schema: `cleanText(z.string().max(200))`. */
export function cleanText<T extends z.ZodString>(schema: T, multiline = false) {
  return schema.refine((v) => isCleanText(v, multiline), { message: "contains characters that are not allowed (control or bidi characters)" });
}

/** For identifiers (option values, keys): clean single-line text without `<`/`>`. */
export function isCleanIdentifier(value: string): boolean {
  return isCleanText(value) && !/[<>]/.test(value);
}
