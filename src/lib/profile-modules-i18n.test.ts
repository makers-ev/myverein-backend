import { describe, expect, it } from "vitest";

import { MODULE_GROUPS, PROFILE_MODULES } from "./profile-modules.js";
import { definitionTranslations, GROUP_LABELS_EN, MODULE_TEXTS_EN, moduleText, resolveLang } from "./profile-modules-i18n.js";

describe("profile module translations", () => {
  it("has complete English text for every module and group, and no stray entries", () => {
    expect(PROFILE_MODULES).toHaveLength(35);
    expect(Object.keys(MODULE_TEXTS_EN).sort()).toEqual(PROFILE_MODULES.map((m) => m.id).sort());
    for (const m of PROFILE_MODULES) {
      const en = moduleText(m, "en");
      expect(en.label.trim(), m.id).not.toBe("");
      expect(en.description.trim(), m.id).not.toBe("");
      expect(en.label, m.id).not.toBe(m.label === en.label && /[äöüß]/i.test(m.label) ? m.label : "");
      expect(en.helpText === null, m.id).toBe(m.helpText === undefined);
      expect(/[äöüß]/i.test(`${en.label}${en.description}${en.helpText ?? ""}`), `${m.id} still German`).toBe(false);
    }
    for (const g of MODULE_GROUPS) expect(GROUP_LABELS_EN[g.id]?.trim(), g.id).toBeTruthy();
    expect(Object.keys(GROUP_LABELS_EN).sort()).toEqual(MODULE_GROUPS.map((g) => g.id).sort());
  });

  it("resolves the language: explicit query wins, Accept-Language en is honoured, default German", () => {
    expect(resolveLang(undefined)).toBe("de");
    expect(resolveLang("en")).toBe("en");
    expect(resolveLang("EN")).toBe("en");
    expect(resolveLang("fr")).toBe("de");
    expect(resolveLang("de", "en-US,en;q=0.9")).toBe("de");
    expect(resolveLang(undefined, "en-US,en;q=0.9")).toBe("en");
    expect(resolveLang(undefined, "fr-FR, en;q=0.5")).toBe("en");
    expect(resolveLang(undefined, "fr-FR")).toBe("de");
  });

  it("offers translations for an untouched module definition only", () => {
    const m = PROFILE_MODULES.find((x) => x.id === "mod_q_juleica")!;
    expect(definitionTranslations({ key: m.id, label: m.label, helpText: m.helpText ?? null })?.en.label).toBe("JuLeiCa (youth leader card)");
    expect(definitionTranslations({ key: m.id, label: "Unsere Juleica", helpText: m.helpText ?? null })).toBeNull();
    expect(definitionTranslations({ key: "manual_field", label: "x", helpText: null })).toBeNull();
  });
});
