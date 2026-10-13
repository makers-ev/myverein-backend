import { describe, expect, it } from "vitest";

import { CONSENT_HASH_SCHEME, consentEvidence, consentTextSha256, legacyConsentTextSha256 } from "./form-applications.js";

const fields = [
  { key: "name", type: "text", label: "Name" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutz", text: "Wir speichern Daten." },
  { key: "intro", type: "info", label: "Hinweis", text: "Kein Datenschutzblock" },
  { key: "consent", type: "consent", label: "Einwilligung", helpText: "Gilt bis Widerruf", required: true },
];
const version = (over: Record<string, unknown> = {}) => ({ id: "v1", privacyNotice: "Hinweis", fields, ...over }) as never;

describe("consent evidence text hash", () => {
  it("is deterministic and carries the scheme marker", () => {
    const sub = { answers: { consent: true }, submittedByUserId: "u1", onBehalfOf: "self", submittedAt: new Date("2026-01-01T00:00:00Z") } as never;
    const a = consentEvidence({ sub, version: version() });
    const b = consentEvidence({ sub, version: version({ fields: JSON.parse(JSON.stringify(fields)) }) });
    expect(a.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.textSha256).toBe(b.textSha256);
    expect(a.textHashScheme).toBe(CONSENT_HASH_SCHEME);
    expect(a.consentFieldKeys).toEqual(["consent"]);
  });

  it("changes with every displayed text: notice, consent label and helpText, privacy-notice info label and text", () => {
    const base = consentTextSha256(version());
    const mod = (i: number, patch: Record<string, unknown>) => consentTextSha256(version({ fields: fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
    const hashes = [
      consentTextSha256(version({ privacyNotice: "Anders" })),
      mod(3, { label: "Andere Einwilligung" }),
      mod(3, { helpText: "Anders" }),
      mod(1, { text: "Anderer Text" }),
      mod(1, { label: "Anderer Titel" }),
    ];
    for (const h of hashes) expect(h).not.toBe(base);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("ignores fields that are not part of the consent/privacy blocks and cannot be confused by concatenation", () => {
    const base = consentTextSha256(version());
    expect(consentTextSha256(version({ fields: fields.map((f) => (f.key === "intro" || f.key === "name" ? { ...f, text: "x", label: "y" } : f)) }))).toBe(base);
    const a = consentTextSha256(version({ privacyNotice: "a\nb", fields: [{ key: "c", type: "consent", label: "c" }] }));
    const b = consentTextSha256(version({ privacyNotice: "a", fields: [{ key: "c", type: "consent", label: "b\nc" }] }));
    expect(a).not.toBe(b);
  });

  it("keeps the legacy scheme 1 hash reproducible for old audit entries", () => {
    expect(legacyConsentTextSha256(version())).not.toBe(consentTextSha256(version()));
    expect(legacyConsentTextSha256(version())).toBe(legacyConsentTextSha256(version({ fields: fields.map((f) => ({ ...f, helpText: "irrelevant" })) })));
  });
});
