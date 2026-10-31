import { describe, expect, it } from "vitest";

import { assemblyRulesSchema, emptyAssemblyRules, majorityFor, mergeAssemblyRules, missingAssemblyRules, parseStoredAssemblyRules } from "./assembly-rules.js";

describe("assembly rules", () => {
  it("has no legal default and closed feature switches", () => {
    const r = emptyAssemblyRules();
    expect(assemblyRulesSchema.safeParse(r).success).toBe(true);
    expect(r.invitationMinDays).toBeNull();
    expect(r.quorumMode).toBeNull();
    expect(Object.values(r.majorityByTopic).every((v) => v === null)).toBe(true);
    expect([r.onlineAllowed, r.circularAllowed, r.secretBallotDigitalAllowed, r.termExpiryEffect]).toEqual(["none", false, false, "none"]);
  });

  it("falls back to 'allgemein' for a topic without its own majority", () => {
    const r = emptyAssemblyRules();
    expect(majorityFor(r, "wahl")).toBeNull();
    r.majorityByTopic.allgemein = "einfach";
    r.majorityByTopic.wahl = "absolut";
    expect(majorityFor(r, "wahl")).toBe("absolut");
    expect(majorityFor(r, "entlastung")).toBe("einfach");
  });

  it("reads an unknown or broken stored document as empty and tolerates missing keys", () => {
    expect(parseStoredAssemblyRules(null)).toEqual(emptyAssemblyRules());
    expect(parseStoredAssemblyRules({ invitationMinDays: "x" })).toEqual(emptyAssemblyRules());
    expect(parseStoredAssemblyRules({ invitationMinDays: 7 }).invitationMinDays).toBe(7);
  });

  it("merges topics one by one and lists conditional gaps", () => {
    const merged = assemblyRulesSchema.parse(mergeAssemblyRules(emptyAssemblyRules(), { majorityByTopic: { wahl: "einfach" }, quorumMode: "absolute", proxyAllowed: true }));
    expect(merged.majorityByTopic.wahl).toBe("einfach");
    expect(merged.majorityByTopic.allgemein).toBeNull();
    const missing = missingAssemblyRules(merged);
    expect(missing).toEqual(expect.arrayContaining(["quorumValue", "maxProxiesPerPerson", "majorityByTopic.allgemein"]));
  });
});
