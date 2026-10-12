import { describe, expect, it } from "vitest";

import { DEFAULT_APPLICATION_FIELDS, DEFAULT_EXIT_FIELDS } from "./form-defaults.js";
import { FIELD_KEY_RE, formFieldsSchema, MAX_FIELDS, MAX_OPTIONS, resolveFieldOptions, validateAnswers, type FormField } from "./form-schema.js";

const parse = (fields: unknown) => formFieldsSchema.safeParse(fields);
const f = (over: Record<string, unknown>) => ({ key: "name", type: "text", label: "Name", ...over });
const defs = (fields: unknown): FormField[] => {
  const r = parse(fields);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
};
const submit = { mode: "submit" as const };

describe("field definition", () => {
  it("accepts the standard forms", () => {
    expect(parse(DEFAULT_APPLICATION_FIELDS).success).toBe(true);
    expect(parse(DEFAULT_EXIT_FIELDS).success).toBe(true);
  });

  it("enforces the key format and rejects reserved and duplicate keys", () => {
    for (const key of ["A", "1a", "a", "has space", "x".repeat(42), "__proto__", "constructor", "prototype"]) expect(parse([f({ key })]).success, key).toBe(false);
    expect(FIELD_KEY_RE.test("shirt_size")).toBe(true);
    expect(parse([f({ key: "aa" }), f({ key: "aa" })]).success).toBe(false);
  });

  it("limits fields, options and unknown properties", () => {
    const many = Array.from({ length: MAX_FIELDS + 1 }, (_, i) => f({ key: `field_${i}` }));
    expect(parse(many).success).toBe(false);
    expect(parse(many.slice(0, MAX_FIELDS)).success).toBe(true);
    const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `o${i}`, label: `O${i}` }));
    expect(parse([f({ type: "select", options: opts(MAX_OPTIONS) })]).success).toBe(true);
    expect(parse([f({ type: "select", options: opts(MAX_OPTIONS + 1) })]).success).toBe(false);
    expect(parse([f({ unexpected: 1 })]).success).toBe(false);
    expect(parse([f({ label: "x".repeat(201) })]).success).toBe(false);
  });

  it("requires exactly one option source for selects and none otherwise", () => {
    expect(parse([f({ type: "select" })]).success).toBe(false);
    expect(parse([f({ type: "select", options: [{ value: "a", label: "A" }], optionsSource: "member_categories" })]).success).toBe(false);
    expect(parse([f({ type: "select", optionsSource: "member_categories" })]).success).toBe(true);
    expect(parse([f({ type: "text", options: [{ value: "a", label: "A" }] })]).success).toBe(false);
    expect(parse([f({ type: "select", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] })]).success).toBe(false);
  });

  it("allows only preset patterns and validation that fits the type", () => {
    expect(parse([f({ validation: { pattern: "postal_code" } })]).success).toBe(true);
    expect(parse([f({ validation: { pattern: "(a+)+$" } })]).success).toBe(false);
    expect(parse([f({ type: "number", validation: { pattern: "email" } })]).success).toBe(false);
    expect(parse([f({ type: "number", validation: { minLength: 1 } })]).success).toBe(false);
    expect(parse([f({ type: "number", validation: { min: 5, max: 1 } })]).success).toBe(false);
    expect(parse([f({ type: "date", validation: { minDate: "2020-01-01", maxDate: "2019-01-01" } })]).success).toBe(false);
  });

  it("restricts visibleIf to one condition on an earlier field", () => {
    const base = [f({ key: "has_car", type: "checkbox" }), f({ key: "plate", visibleIf: { fieldKey: "has_car", op: "checked" } })];
    expect(parse(base).success).toBe(true);
    expect(parse([...base].reverse()).success).toBe(false);
    expect(parse([f({ key: "plate", visibleIf: { fieldKey: "plate", op: "checked" } })]).success).toBe(false);
    expect(parse([f({ key: "aa", type: "text" }), f({ key: "bb", visibleIf: { fieldKey: "aa", op: "checked" } })]).success).toBe(false);
    const sel = f({ key: "aa", type: "select", options: [{ value: "x", label: "X" }] });
    expect(parse([sel, f({ key: "bb", visibleIf: { fieldKey: "aa", op: "eq", value: "x" } })]).success).toBe(true);
    expect(parse([sel, f({ key: "bb", visibleIf: { fieldKey: "aa", op: "eq", value: "nope" } })]).success).toBe(false);
    expect(parse([f({ key: "aa", type: "multiselect", options: [{ value: "x", label: "X" }] }), f({ key: "bb", visibleIf: { fieldKey: "aa", op: "eq", value: "x" } })]).success).toBe(false);
    expect(parse([f({ key: "aa", type: "checkbox" }), f({ key: "bb", visibleIf: { fieldKey: "aa", op: "eq", value: "x" } })]).success).toBe(false);
    expect(parse([f({ key: "aa" }), f({ key: "bb", visibleIf: { fieldKey: "aa", op: "in", value: "x" } })]).success).toBe(false);
    expect(parse([f({ key: "aa" }), f({ key: "bb", visibleIf: { fieldKey: "aa", op: "in", value: ["x", "y"] } })]).success).toBe(true);
    expect(parse([f({ key: "aa" }), f({ key: "bb", visibleIf: { fieldKey: "aa", op: "eq" } })]).success).toBe(false);
    expect(parse([f({ key: "aa", type: "date" }), f({ key: "bb", visibleIf: { fieldKey: "aa", op: "eq", value: "x" } })]).success).toBe(false);
  });

  it("rejects definitions whose limits the engine would ignore or bypass", () => {
    expect(parse([f({ validation: { maxLength: 201 } })]).success).toBe(false);
    expect(parse([f({ type: "textarea", validation: { maxLength: 1000 } })]).success).toBe(true);
    expect(parse([f({ type: "select", options: [{ value: "foo", label: "Foo" }], mapsTo: "category" })]).success).toBe(false);
    expect(parse([f({ type: "select", optionsSource: "member_categories", mapsTo: "category" })]).success).toBe(true);
  });

  it("validates the mapping targets: allowlist, type fit, uniqueness, exclusivity", () => {
    expect(parse([f({ mapsTo: "city" })]).success).toBe(true);
    expect(parse([f({ mapsTo: "id" })]).success).toBe(false);
    expect(parse([f({ mapsTo: "club_id" })]).success).toBe(false);
    expect(parse([f({ type: "number", mapsTo: "city" })]).success).toBe(false);
    expect(parse([f({ key: "aa", mapsTo: "city" }), f({ key: "bb", mapsTo: "city" })]).success).toBe(false);
    expect(parse([f({ mapsTo: "city", customField: "shirt" })]).success).toBe(false);
    expect(parse([f({ customField: "shirt" })]).success).toBe(true);
    expect(parse([f({ type: "file", customField: "doc" })]).success).toBe(false);
    expect(parse([f({ type: "info", mapsTo: "city" })]).success).toBe(false);
    expect(parse([f({ type: "text", infoKind: "privacy_notice" })]).success).toBe(false);
  });
});

describe("validateAnswers", () => {
  it("types, trims and returns only known visible answers", () => {
    const fields = defs([
      f({ key: "first", required: true }),
      f({ key: "age", type: "number", validation: { min: 0, max: 120 } }),
      f({ key: "born", type: "date", validation: { maxDate: "2030-01-01" } }),
      f({ key: "size", type: "select", options: [{ value: "s", label: "S" }, { value: "m", label: "M" }] }),
      f({ key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }),
      f({ key: "newsletter", type: "checkbox" }),
    ]);
    const r = validateAnswers(fields, { first: "  Anna ", age: 30, born: "2000-02-29", size: "m", tags: ["a", "b"], newsletter: true }, submit);
    expect(r).toEqual({ ok: true, answers: { first: "Anna", age: 30, born: "2000-02-29", size: "m", tags: ["a", "b"], newsletter: true } });
  });

  it("reports type, range, length, option and format errors per field", () => {
    const fields = defs([
      f({ key: "tx", validation: { minLength: 3, maxLength: 5 } }),
      f({ key: "nr", type: "number", validation: { min: 1, max: 3 } }),
      f({ key: "dt", type: "date", validation: { minDate: "2020-01-01" } }),
      f({ key: "sl", type: "select", options: [{ value: "a", label: "A" }] }),
      f({ key: "ms", type: "multiselect", options: [{ value: "a", label: "A" }] }),
      f({ key: "mail", validation: { pattern: "email" } }),
      f({ key: "zip", validation: { pattern: "postal_code" } }),
      f({ key: "tel", validation: { pattern: "phone" } }),
      f({ key: "ck", type: "checkbox" }),
    ]);
    const r = validateAnswers(fields, { tx: "ab", nr: 4, dt: "2019-12-31", sl: "z", ms: ["a", "a"], mail: "x@", zip: "1234", tel: "abc", ck: "yes" }, submit);
    expect(r).toEqual({ ok: false, errors: { tx: "too_short", nr: "too_large", dt: "too_small", sl: "not_an_option", ms: "invalid_value", mail: "invalid_format", zip: "invalid_format", tel: "invalid_format", ck: "invalid_type" } });
    expect(validateAnswers(fields, { tx: "abcdef" }, submit)).toMatchObject({ ok: false, errors: { tx: "too_long" } });
    expect(validateAnswers(fields, { nr: "3" }, submit)).toMatchObject({ ok: false, errors: { nr: "invalid_type" } });
    expect(validateAnswers(fields, { nr: Number.NaN }, submit)).toMatchObject({ ok: false, errors: { nr: "invalid_type" } });
    expect(validateAnswers(fields, { dt: "2020-02-30" }, submit)).toMatchObject({ ok: false, errors: { dt: "invalid_value" } });
    expect(validateAnswers(fields, { dt: "01.01.2021" }, submit)).toMatchObject({ ok: false, errors: { dt: "invalid_value" } });
    expect(validateAnswers(fields, { mail: "anna@example.org", zip: "12345", tel: "+49 (30) 123-45" }, submit).ok).toBe(true);
  });

  it("enforces required fields on submit but not on draft, and counts empty values as missing", () => {
    const fields = defs([f({ key: "first", required: true }), f({ key: "tags", type: "multiselect", required: true, options: [{ value: "a", label: "A" }] })]);
    expect(validateAnswers(fields, { first: "  ", tags: [] }, submit)).toEqual({ ok: false, errors: { first: "required", tags: "required" } });
    expect(validateAnswers(fields, { first: null }, submit)).toMatchObject({ ok: false, errors: { first: "required" } });
    expect(validateAnswers(fields, {}, { mode: "draft" })).toEqual({ ok: true, answers: {} });
    expect(validateAnswers(fields, { first: "x".repeat(300) }, { mode: "draft" })).toMatchObject({ ok: false, errors: { first: "too_long" } });
  });

  it("requires consent and required checkboxes to be true", () => {
    const fields = defs([f({ key: "agree", type: "consent", label: "Ja", required: true }), f({ key: "opt", type: "checkbox" })]);
    expect(validateAnswers(fields, { agree: false }, submit)).toEqual({ ok: false, errors: { agree: "required" } });
    expect(validateAnswers(fields, {}, submit)).toEqual({ ok: false, errors: { agree: "required" } });
    expect(validateAnswers(fields, { agree: true, opt: false }, submit)).toEqual({ ok: true, answers: { agree: true } });
    expect(validateAnswers(fields, { agree: "true" }, submit)).toMatchObject({ ok: false, errors: { agree: "invalid_type" } });
  });

  it("drops hidden fields and does not require them", () => {
    const fields = defs([
      f({ key: "has_car", type: "checkbox" }),
      f({ key: "plate", required: true, visibleIf: { fieldKey: "has_car", op: "checked" } }),
      f({ key: "kind", type: "select", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C" }] }),
      f({ key: "why_a", visibleIf: { fieldKey: "kind", op: "eq", value: "a" } }),
      f({ key: "why_bc", visibleIf: { fieldKey: "kind", op: "in", value: ["b", "c"] } }),
      f({ key: "why_not_a", visibleIf: { fieldKey: "kind", op: "neq", value: "a" } }),
    ]);
    expect(validateAnswers(fields, { has_car: false, plate: "B-XY 1" }, submit)).toEqual({ ok: true, answers: {} });
    expect(validateAnswers(fields, { has_car: true }, submit)).toEqual({ ok: false, errors: { plate: "required" } });
    expect(validateAnswers(fields, { has_car: true, plate: "B-XY 1", kind: "a", why_a: "x", why_bc: "y", why_not_a: "z" }, submit)).toEqual({ ok: true, answers: { has_car: true, plate: "B-XY 1", kind: "a", why_a: "x" } });
    expect(validateAnswers(fields, { kind: "b", why_bc: "y", why_not_a: "z" }, submit)).toEqual({ ok: true, answers: { kind: "b", why_bc: "y", why_not_a: "z" } });
  });

  it("chains conditions: a field behind a hidden field stays hidden", () => {
    const fields = defs([
      f({ key: "aa", type: "checkbox" }),
      f({ key: "bb", type: "checkbox", visibleIf: { fieldKey: "aa", op: "checked" } }),
      f({ key: "cc", required: true, visibleIf: { fieldKey: "bb", op: "checked" } }),
    ]);
    expect(validateAnswers(fields, { aa: false, bb: true, cc: "x" }, submit)).toEqual({ ok: true, answers: {} });
  });

  it("hides dependants of a hidden field even for negative conditions", () => {
    const fields = defs([
      f({ key: "gate", type: "checkbox" }),
      f({ key: "mid", visibleIf: { fieldKey: "gate", op: "checked" } }),
      f({ key: "leaf", required: true, visibleIf: { fieldKey: "mid", op: "neq", value: "x" } }),
    ]);
    expect(validateAnswers(fields, { gate: false, leaf: "y" }, submit)).toEqual({ ok: true, answers: {} });
  });

  it("rejects unknown keys and prototype-pollution keys", () => {
    const fields = defs([f({ key: "first" })]);
    expect(validateAnswers(fields, { first: "a", other: "b" }, submit)).toEqual({ ok: false, errors: { other: "unknown_field" } });
    for (const key of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
      const payload = JSON.parse(`{"${key}": {"polluted": true}}`);
      expect(validateAnswers(fields, payload, submit), key).toEqual({ ok: false, errors: { [key]: "unknown_field" } });
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // A form that defines a field named like an Object.prototype member never reads from the prototype chain.
    expect(validateAnswers(defs([f({ key: "first" })]), {}, submit)).toEqual({ ok: true, answers: {} });
  });

  it("rejects non-object payloads", () => {
    const fields = defs([f({ key: "first" })]);
    for (const bad of [null, undefined, "x", 1, [], [{ first: "a" }], new Date()]) expect(validateAnswers(fields, bad, submit).ok, String(bad)).toBe(false);
  });

  it("rejects answers for info, file and image fields; required uploads need a stored file", () => {
    const fields = defs([f({ key: "note", type: "info", label: "Hinweis" }), f({ key: "photo", type: "image", required: true }), f({ key: "doc", type: "file" })]);
    expect(validateAnswers(fields, { note: "x" }, submit)).toEqual({ ok: false, errors: { note: "unknown_field" } });
    expect(validateAnswers(fields, { photo: "evil.png" }, submit)).toEqual({ ok: false, errors: { photo: "unknown_field" } });
    expect(validateAnswers(fields, {}, submit)).toEqual({ ok: false, errors: { photo: "required" } });
    expect(validateAnswers(fields, {}, { ...submit, uploadedFieldKeys: new Set(["photo"]) })).toEqual({ ok: true, answers: {} });
    expect(validateAnswers(fields, {}, { mode: "draft" })).toEqual({ ok: true, answers: {} });
  });

  it("resolves member_categories against the club's active categories", () => {
    const fields = defs(DEFAULT_APPLICATION_FIELDS);
    const ctx = { ...submit, categoryKeys: ["aktiv", "jugend"], uploadedFieldKeys: new Set<string>() };
    expect(validateAnswers(fields, { category: "jugend", privacy_consent: true }, ctx)).toEqual({ ok: true, answers: { category: "jugend", privacy_consent: true } });
    expect(validateAnswers(fields, { category: "passiv", privacy_consent: true }, ctx)).toEqual({ ok: false, errors: { category: "not_an_option" } });
    expect(validateAnswers(fields, { category: "aktiv" }, ctx)).toEqual({ ok: false, errors: { privacy_consent: "required" } });
    expect(resolveFieldOptions(fields[0]!, [{ key: "aktiv", name: "Aktiv" }])).toEqual([{ value: "aktiv", label: "Aktiv" }]);
  });
});
