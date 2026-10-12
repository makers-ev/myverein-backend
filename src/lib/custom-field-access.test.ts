import { describe, expect, it } from "vitest";

import { canBoardWrite, canReadValue, canSelfWrite } from "./custom-field-access.js";

const def = (over: Partial<Parameters<typeof canReadValue>[0]> = {}) => ({ visibleTo: "vorstand", sensitive: false, ...over });
const roles = (...r: string[]) => ["mitglied", ...r];

describe("custom field read access (deny-by-default)", () => {
  it("vorstand: only members:write / members:read_sensitive", () => {
    for (const r of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "kassenwart"]) expect(canReadValue(def(), { roleTypes: roles(r), isSelf: false }), r).toBe(true);
    for (const r of ["beisitzer", "trainer", "abteilungsleitung"]) expect(canReadValue(def(), { roleTypes: roles(r), isSelf: false }), r).toBe(false);
    expect(canReadValue(def(), { roleTypes: roles(), isSelf: false })).toBe(false);
  });

  it("funktionstraeger: board plus trainer and abteilungsleitung", () => {
    const d = def({ visibleTo: "funktionstraeger" });
    for (const r of ["vorsitz", "trainer", "abteilungsleitung"]) expect(canReadValue(d, { roleTypes: roles(r), isSelf: false }), r).toBe(true);
    expect(canReadValue(d, { roleTypes: roles(), isSelf: false })).toBe(false);
    expect(canReadValue(d, { roleTypes: roles("erziehungsberechtigt"), isSelf: false })).toBe(false);
  });

  it("mitglied: account members, not external guests (who lack the implicit role)", () => {
    const d = def({ visibleTo: "mitglied" });
    expect(canReadValue(d, { roleTypes: roles(), isSelf: false })).toBe(true);
    expect(canReadValue(d, { roleTypes: ["erziehungsberechtigt"], isSelf: false })).toBe(false);
  });

  it("sensitive needs members:read_sensitive whatever visible_to says; the person itself always reads", () => {
    const d = def({ visibleTo: "mitglied", sensitive: true });
    expect(canReadValue(d, { roleTypes: roles(), isSelf: false })).toBe(false);
    expect(canReadValue(d, { roleTypes: roles("schriftfuehrer"), isSelf: false })).toBe(false);
    expect(canReadValue(d, { roleTypes: roles("kassenwart"), isSelf: false })).toBe(true);
    expect(canReadValue(d, { roleTypes: roles(), isSelf: true })).toBe(true);
  });

  it("an unknown visible_to grants nothing", () => {
    expect(canReadValue(def({ visibleTo: "alle" }), { roleTypes: roles("vorsitz"), isSelf: false })).toBe(false);
  });
});

describe("custom field write access", () => {
  it("board needs members:write, sensitive also members:read_sensitive, archived is never writable", () => {
    expect(canBoardWrite({ sensitive: false, archivedAt: null }, roles("schriftfuehrer"))).toBe(true);
    expect(canBoardWrite({ sensitive: false, archivedAt: null }, roles("kassenwart"))).toBe(false);
    expect(canBoardWrite({ sensitive: true, archivedAt: null }, roles("schriftfuehrer"))).toBe(false);
    expect(canBoardWrite({ sensitive: true, archivedAt: null }, roles("vorsitz"))).toBe(true);
    expect(canBoardWrite({ sensitive: false, archivedAt: new Date() }, roles("vorsitz"))).toBe(false);
  });

  it("self only writes editable_by = self fields", () => {
    expect(canSelfWrite({ editableBy: "self", archivedAt: null })).toBe(true);
    expect(canSelfWrite({ editableBy: "vorstand", archivedAt: null })).toBe(false);
    expect(canSelfWrite({ editableBy: "self", archivedAt: new Date() })).toBe(false);
  });
});
