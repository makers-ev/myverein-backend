import { describe, expect, it } from "vitest";

import { addDays, credentialExpiry, daysBetween, formatCredential } from "./credentials.js";
import { validateCustomValue } from "./custom-fields.js";
import { formFieldsSchema, FIELD_KEY_RE } from "./form-schema.js";
import { todayBerlin } from "./member-lifecycle.js";
import { findModule, isNeverMandatoryKey, MODULE_GROUPS, PROFILE_MODULES } from "./profile-modules.js";

const plain = { key: "c_plain", label: "Staplerschein", fieldType: "credential" };
const levels = { key: "c_lvl", label: "Lizenz", fieldType: "credential", options: [{ value: "c", label: "C" }, { value: "b", label: "B" }] };
const free = { key: "c_free", label: "Schiri", fieldType: "credential", validation: { maxLength: 10 } };

describe("credential value validation", () => {
  it("accepts the documented shape and normalises it", () => {
    expect(validateCustomValue(plain, { valid: true })).toEqual({ ok: true, value: { valid: true } });
    expect(validateCustomValue(plain, { valid: true, obtainedOn: "2024-02-29", validUntil: "2027-01-31" })).toEqual({ ok: true, value: { valid: true, obtainedOn: "2024-02-29", validUntil: "2027-01-31" } });
    expect(validateCustomValue(plain, { valid: true, validUntil: "2027-01-31", obtainedOn: "" })).toEqual({ ok: true, value: { valid: true, validUntil: "2027-01-31" } });
    expect(validateCustomValue(plain, { valid: true, obtainedOn: "2025-05-05", validUntil: "2025-05-05" }).ok).toBe(true);
  });

  it("treats null / empty as cleared (not held)", () => {
    for (const v of [null, undefined, "", []]) expect(validateCustomValue(plain, v)).toEqual({ ok: true, value: undefined });
  });

  it("rejects everything else", () => {
    const code = (def: Parameters<typeof validateCustomValue>[0], v: unknown) => {
      const r = validateCustomValue(def, v);
      return r.ok ? "ok" : r.code;
    };
    expect(code(plain, true)).toBe("invalid_type");
    expect(code(plain, "ja")).toBe("invalid_type");
    expect(code(plain, [1])).toBe("invalid_type");
    expect(code(plain, { valid: false })).toBe("invalid_value");
    expect(code(plain, {})).toBe("invalid_value");
    expect(code(plain, { valid: "true" })).toBe("invalid_value");
    expect(code(plain, { valid: true, extra: 1 })).toBe("invalid_value");
    expect(code(plain, { valid: true, __proto__x: 1 })).toBe("invalid_value");
    expect(code(plain, { valid: true, level: "A" })).toBe("invalid_value"); // no levels defined
    expect(code(plain, { valid: true, validUntil: "2026-02-30" })).toBe("invalid_value");
    expect(code(plain, { valid: true, validUntil: "2026-2-3" })).toBe("invalid_value");
    expect(code(plain, { valid: true, validUntil: 20260101 })).toBe("invalid_type");
    expect(code(plain, { valid: true, validUntil: "1899-12-31" })).toBe("too_small");
    expect(code(plain, { valid: true, validUntil: "2101-01-01" })).toBe("too_large");
    expect(code(plain, { valid: true, obtainedOn: "2026-05-02", validUntil: "2026-05-01" })).toBe("invalid_value");
  });

  it("checks levels: an option list or a free text with a limit", () => {
    expect(validateCustomValue(levels, { valid: true, level: "b" })).toEqual({ ok: true, value: { valid: true, level: "b" } });
    expect(validateCustomValue(levels, { valid: true }).ok).toBe(true);
    expect(validateCustomValue(levels, { valid: true, level: "x" })).toEqual({ ok: false, code: "not_an_option" });
    expect(validateCustomValue(levels, { valid: true, level: 3 })).toEqual({ ok: false, code: "invalid_type" });
    expect(validateCustomValue(free, { valid: true, level: "  Landesliga " })).toEqual({ ok: true, value: { valid: true, level: "Landesliga" } });
    expect(validateCustomValue(free, { valid: true, level: "x".repeat(11) })).toEqual({ ok: false, code: "too_long" });
    expect(validateCustomValue(free, { valid: true, level: "bidi‮" })).toEqual({ ok: false, code: "invalid_value" });
  });

  it("is a custom field type with levels or a level limit, never both", () => {
    expect(formFieldsSchema.safeParse([{ key: "ab", type: "credential", label: "x", options: [{ value: "a", label: "A" }] }]).success).toBe(true);
    expect(formFieldsSchema.safeParse([{ key: "ab", type: "credential", label: "x", validation: { maxLength: 60 } }]).success).toBe(true);
    expect(formFieldsSchema.safeParse([{ key: "ab", type: "credential", label: "x", validation: { maxLength: 60 }, options: [{ value: "a", label: "A" }] }]).success).toBe(false);
    expect(formFieldsSchema.safeParse([{ key: "ab", type: "credential", label: "x", optionsSource: "member_categories" }]).success).toBe(false);
    expect(formFieldsSchema.safeParse([{ key: "ab", type: "credential", label: "x", validation: { min: 1 } }]).success).toBe(false);
  });
});

describe("credential expiry", () => {
  const today = "2026-07-01";
  it("computes status and days left (valid through validUntil)", () => {
    expect(credentialExpiry(null, today)).toEqual({ status: "missing", daysLeft: null, validUntil: null });
    expect(credentialExpiry({ valid: true }, today)).toEqual({ status: "valid", daysLeft: null, validUntil: null });
    expect(credentialExpiry({ valid: true, validUntil: "2026-06-30" }, today)).toEqual({ status: "expired", daysLeft: -1, validUntil: "2026-06-30" });
    expect(credentialExpiry({ valid: true, validUntil: "2026-07-01" }, today)).toMatchObject({ status: "expiring", daysLeft: 0 });
    expect(credentialExpiry({ valid: true, validUntil: "2026-09-29" }, today)).toMatchObject({ status: "expiring", daysLeft: 90 });
    expect(credentialExpiry({ valid: true, validUntil: "2026-09-30" }, today)).toMatchObject({ status: "valid", daysLeft: 91 });
    expect(credentialExpiry({ valid: true, validUntil: "2026-07-10" }, today, 7)).toMatchObject({ status: "valid" });
    expect(credentialExpiry({ valid: true, validUntil: "2026-07-08" }, today, 7)).toMatchObject({ status: "expiring", daysLeft: 7 });
  });

  it("flips at Berlin midnight, not UTC midnight", () => {
    const value = { valid: true, validUntil: "2026-06-30" };
    // 2026-06-30 21:59:59Z is 23:59:59 in Berlin (CEST): still the last valid day.
    expect(todayBerlin(new Date("2026-06-30T21:59:59Z"))).toBe("2026-06-30");
    expect(credentialExpiry(value, todayBerlin(new Date("2026-06-30T21:59:59Z")))).toMatchObject({ status: "expiring", daysLeft: 0 });
    // One second later it is 2026-07-01 in Berlin: expired, although UTC is still the 30th.
    expect(todayBerlin(new Date("2026-06-30T22:00:00Z"))).toBe("2026-07-01");
    expect(credentialExpiry(value, todayBerlin(new Date("2026-06-30T22:00:00Z")))).toMatchObject({ status: "expired", daysLeft: -1 });
    // Winter time (CET, UTC+1) and the year change.
    expect(todayBerlin(new Date("2026-12-31T22:59:59Z"))).toBe("2026-12-31");
    expect(todayBerlin(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });

  it("does date maths across month ends, leap days and DST changes", () => {
    expect(daysBetween("2028-02-28", "2028-03-01")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2); // DST change in Germany on 2026-03-29
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("formats an export cell that cannot start a formula", () => {
    expect(formatCredential({ valid: true, level: "B", obtainedOn: "2020-01-01", validUntil: "2027-01-01" })).toBe("Ja, Stufe: B, seit: 2020-01-01, bis: 2027-01-01");
    expect(formatCredential({ valid: true })).toBe("Ja");
    expect(formatCredential({ valid: true, level: "=HYPERLINK(1)" }).startsWith("Ja")).toBe(true);
    expect(formatCredential(null)).toBe("");
  });
});

describe("profile module catalog", () => {
  it("has unique, well-formed ids and valid definitions", () => {
    expect(new Set(PROFILE_MODULES.map((m) => m.id)).size).toBe(PROFILE_MODULES.length);
    for (const m of PROFILE_MODULES) {
      expect(m.id.startsWith("mod_") && FIELD_KEY_RE.test(m.id), m.id).toBe(true);
      expect(MODULE_GROUPS.some((g) => g.id === m.group)).toBe(true);
      const parsed = formFieldsSchema.safeParse([{ key: m.id, type: m.type, label: m.label, ...(m.options ? { options: m.options } : {}), ...(m.validation ? { validation: m.validation } : {}), ...(m.helpText ? { helpText: m.helpText } : {}) }]);
      expect(parsed.success, `${m.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      expect(m.editableBy).toBe("self");
    }
  });

  it("applies the visibility / sensitivity decisions", () => {
    for (const m of PROFILE_MODULES.filter((x) => x.group === "kinderschutz")) expect([m.visibleTo, m.sensitive, m.type], m.id).toEqual(["vorstand", true, "credential"]);
    for (const m of PROFILE_MODULES.filter((x) => x.group !== "kinderschutz")) expect([m.visibleTo, m.sensitive], m.id).toEqual(["funktionstraeger", false]);
    expect(findModule("mod_ks_fuehrungszeugnis")!.helpText).toContain("nicht erfasst");
    expect(findModule("mod_nope")).toBeUndefined();
    expect(isNeverMandatoryKey("mod_q_juleica") && isNeverMandatoryKey("mod_fs_stapler") && isNeverMandatoryKey("mod_ks_praevention")).toBe(true);
    expect(isNeverMandatoryKey("mod_sp_trikot")).toBe(false);
    expect(isNeverMandatoryKey("some_custom")).toBe(false);
  });

  it("contains exactly the agreed modules", () => {
    expect(PROFILE_MODULES.map((m) => m.label)).toEqual([
      "Führerscheinklassen", "Klasse C/D gültig bis", "Schlüsselzahl 95", "Fahrgastbeförderung (P-Schein)", "Staplerschein", "Feuerwehr-Führerschein",
      "Übungsleiter-Lizenz", "JuLeiCa", "Schiedsrichter-/Kampfrichter-Lizenz", "Rettungsschwimmer", "Sanitäter", "Erste-Hilfe-Kurs", "Bootsführerschein", "Segelschein", "Tauchbrevet", "Hygienebelehrung", "Funkschein",
      "Erweitertes Führungszeugnis", "Selbstverpflichtungserklärung", "Präventionsschulung",
      "Einsatzbereitschaft", "Fahrzeug/Anhänger vorhanden", "Freie Sitzplätze", "Berufliche Fähigkeiten", "Sprachen",
      "Trikotgröße", "Konfektionsgröße", "Schuhgröße", "Position/Spielhand", "Schwimmabzeichen", "Verbandspass-/Startpass-Nr.", "Zweitverein",
      "Anrede/Titel", "Bevorzugter Kanal", "Zweite Telefonnummer",
    ]);
  });
});
