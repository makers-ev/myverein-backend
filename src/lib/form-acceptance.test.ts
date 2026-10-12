import { describe, expect, it } from "vitest";

import { planAcceptance } from "./form-acceptance.js";
import type { FormField } from "./form-schema.js";

const f = (field: Record<string, unknown>) => field as unknown as FormField;

describe("planAcceptance (mapping allowlist)", () => {
  const fields = [
    f({ key: "first_name", type: "text", label: "Vorname", mapsTo: "firstName" }),
    f({ key: "last_name", type: "text", label: "Nachname", mapsTo: "lastName" }),
    f({ key: "birth_date", type: "date", label: "Geburtsdatum", mapsTo: "birthDate" }),
    f({ key: "mail", type: "text", label: "E-Mail", mapsTo: "contactEmail" }),
    f({ key: "category", type: "select", label: "Kategorie", optionsSource: "member_categories", mapsTo: "category" }),
    f({ key: "photo", type: "image", label: "Foto", mapsTo: "photo" }),
    f({ key: "shirt", type: "select", label: "Shirt", options: [{ value: "m", label: "M" }], customField: "shirt_size" }),
    f({ key: "note", type: "textarea", label: "Notiz" }),
  ];

  it("maps answers to the allowlisted targets, the category key and custom fields", () => {
    const plan = planAcceptance(fields, { first_name: " Anna ", last_name: "Muster", birth_date: "2012-05-01", mail: "anna@example.com", category: "Jugend", shirt: "m", note: "bleibt nur Antwort" });
    expect(plan.master).toEqual({ firstName: "Anna", lastName: "Muster", birthDate: "2012-05-01", contactEmail: "anna@example.com" });
    expect(plan.categoryKey).toBe("jugend");
    expect(plan.photoFieldKey).toBe("photo");
    expect(plan.custom).toEqual([{ fieldKey: "shirt", customKey: "shirt_size", type: "select", sensitive: false, value: "m" }]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips values that do not fit the target any more instead of failing, naming the field key only", () => {
    const plan = planAcceptance(fields, { first_name: "x".repeat(101), birth_date: "2012-02-31", mail: "not an address", last_name: 42 });
    expect(plan.master).toEqual({});
    expect(plan.skipped.map((s) => [s.fieldKey, s.reason])).toEqual(
      expect.arrayContaining([
        ["first_name", "invalid_value"],
        ["birth_date", "invalid_value"],
        ["mail", "invalid_value"],
        ["last_name", "not_a_text"],
      ]),
    );
    expect(JSON.stringify(plan.skipped)).not.toContain("not an address");
  });

  it("ignores hidden fields and their dependants", () => {
    const conditional = [
      f({ key: "guardian", type: "checkbox", label: "Kind" }),
      f({ key: "phone", type: "text", label: "Telefon", mapsTo: "phone", visibleIf: { fieldKey: "guardian", op: "checked" } }),
    ];
    expect(planAcceptance(conditional, { guardian: false, phone: "0123456" }).master).toEqual({});
    expect(planAcceptance(conditional, { guardian: true, phone: "0123456" }).master).toEqual({ phone: "0123456" });
  });

  it("can only ever produce allowlisted targets, whatever a stored definition claims (no mass assignment)", () => {
    const hostile = [
      f({ key: "evil_a", type: "text", label: "a", mapsTo: "memberId" }),
      f({ key: "evil_b", type: "text", label: "b", mapsTo: "status" }),
      f({ key: "evil_c", type: "text", label: "c", mapsTo: "__proto__" }),
      f({ key: "evil_d", type: "text", label: "d", mapsTo: "photo" }),
      f({ key: "evil_e", type: "text", label: "e", mapsTo: "id" }),
    ];
    const plan = planAcceptance(hostile, { evil_a: "x", evil_b: "gelöscht", evil_c: "y", evil_d: "z", evil_e: "00000000-0000-4000-8000-000000000000" });
    expect(plan.master).toEqual({});
    expect(plan.categoryKey).toBeNull();
    expect(plan.photoFieldKey).toBeNull();
    expect(plan.custom).toEqual([]);
    expect(plan.skipped.map((s) => s.reason).every((r) => r === "unknown_target" || r === "type_mismatch")).toBe(true);
  });

  it("a target is used once and answers with prototype keys are harmless", () => {
    const twice = [f({ key: "a_phone", type: "text", label: "a", mapsTo: "phone" }), f({ key: "b_phone", type: "text", label: "b", mapsTo: "phone" })];
    const plan = planAcceptance(twice, JSON.parse('{"a_phone":"0123456","b_phone":"9999999","__proto__":{"polluted":true}}'));
    expect(plan.master).toEqual({ phone: "0123456" });
    expect(plan.skipped).toEqual([{ fieldKey: "b_phone", reason: "unknown_target" }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
