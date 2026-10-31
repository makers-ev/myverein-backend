import { describe, expect, it } from "vitest";

import { renderAnswers, summarizeAnswers } from "./form-review.js";
import type { FormField } from "./form-schema.js";

const fields = [
  { key: "name", type: "text", label: "Name", required: true },
  { key: "category", type: "select", label: "Mitgliedschaft", optionsSource: "member_categories" },
  { key: "shirt", type: "select", label: "Shirt", options: [{ value: "s", label: "Klein" }, { value: "m", label: "Mittel" }] },
  { key: "hobbies", type: "multiselect", label: "Hobbys", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
  { key: "health", type: "textarea", label: "Gesundheit", sensitive: true },
  { key: "note", type: "textarea", label: "Notiz" },
  { key: "has_ice", type: "checkbox", label: "Notfallkontakt vorhanden" },
  { key: "ice", type: "text", label: "Notfallkontakt", visibleIf: { fieldKey: "has_ice", op: "checked" } },
  { key: "photo", type: "image", label: "Foto" },
  { key: "intro", type: "info", label: "Hinweis" },
  { key: "consent", type: "consent", label: "Einwilligung", required: true },
] as unknown as FormField[];

const categories = [{ key: "jugend", name: "Jugend" }];

describe("renderAnswers", () => {
  const answers = { name: "Anna", category: "jugend", shirt: "m", hobbies: ["b", "a"], health: "Allergie", note: "x".repeat(200), ice: "versteckt", consent: true };

  it("renders against the given version: labels, option labels, order; skips info, files and hidden fields", () => {
    const out = renderAnswers(fields, answers, { categories, canReadSensitive: true });
    expect(out.map((a) => a.key)).toEqual(["name", "category", "shirt", "hobbies", "health", "note", "has_ice", "consent"]);
    expect(out.find((a) => a.key === "category")).toMatchObject({ value: "jugend", display: "Jugend", label: "Mitgliedschaft" });
    expect(out.find((a) => a.key === "shirt")?.display).toBe("Mittel");
    expect(out.find((a) => a.key === "hobbies")?.display).toEqual(["Beta", "Alpha"]);
    // `ice` is hidden (has_ice unchecked): neither rendered nor leaked.
    expect(JSON.stringify(out)).not.toContain("versteckt");
    expect(out.find((a) => a.key === "has_ice")).toMatchObject({ answered: false, value: null, display: null });
    expect(out.find((a) => a.key === "consent")).toMatchObject({ value: true, display: true, required: true });
  });

  it("falls back to the stored value when an option or category no longer exists", () => {
    const out = renderAnswers(fields, { category: "weg", shirt: "xl" }, { categories, canReadSensitive: true });
    expect(out.find((a) => a.key === "category")?.display).toBe("weg");
    expect(out.find((a) => a.key === "shirt")?.display).toBe("xl");
  });

  it("redacts sensitive answers without the permission", () => {
    const out = renderAnswers(fields, answers, { categories, canReadSensitive: false });
    expect(out.find((a) => a.key === "health")).toMatchObject({ redacted: true, sensitive: true, value: null, display: null });
    expect(JSON.stringify(out)).not.toContain("Allergie");
  });

  it("tolerates garbage answers", () => {
    expect(renderAnswers(fields, null, { categories, canReadSensitive: false }).every((a) => !a.answered)).toBe(true);
    expect(renderAnswers(fields, ["x"], { categories, canReadSensitive: false })).toHaveLength(8);
  });
});

describe("summarizeAnswers", () => {
  it("takes the first answered, compact, non-sensitive fields and cuts long values", () => {
    const rendered = renderAnswers(fields, { name: "n".repeat(120), category: "jugend", shirt: "s", hobbies: ["a"], health: "geheim", note: "text", consent: true }, { categories, canReadSensitive: true });
    const summary = summarizeAnswers(rendered);
    expect(summary.map((s) => s.key)).toEqual(["name", "category", "shirt", "hobbies"]);
    expect(summary[0]!.display).toHaveLength(80);
    expect(summary[1]!.display).toBe("Jugend");
    expect(JSON.stringify(summary)).not.toContain("geheim");
    expect(summarizeAnswers(rendered, 2)).toHaveLength(2);
  });
});
