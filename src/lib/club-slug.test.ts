import { describe, expect, it } from "vitest";

import { assertValidClubSlug, isReservedSlug, pickFreeSlug, SLUG_MAX_LENGTH, slugifyClubName } from "./club-slug.js";
import { ValidationError } from "./errors.js";

describe("slugifyClubName", () => {
  it("lowercases and joins words with dashes", () => {
    expect(slugifyClubName("TV Bad Orb 1899")).toBe("tv-bad-orb-1899");
    expect(slugifyClubName("  Spaced   Out   Verein  ")).toBe("spaced-out-verein");
  });

  it("transliterates umlauts and sharp s", () => {
    expect(slugifyClubName("Schützenverein Bärenstraße")).toBe("schuetzenverein-baerenstrasse");
    expect(slugifyClubName("Öko Übung Ärzte")).toBe("oeko-uebung-aerzte");
  });

  it("transliterates letters that do not decompose", () => {
    expect(slugifyClubName("Søren Łódź Đorđe")).toBe("soren-lodz-dorde");
    expect(slugifyClubName("Ærø Œuvre Þór")).toBe("aero-oeuvre-thor");
  });

  it("drops other diacritics", () => {
    expect(slugifyClubName("Café Français")).toBe("cafe-francais");
  });

  it("strips legal-form additions", () => {
    expect(slugifyClubName("TV Bad Orb e.V.")).toBe("tv-bad-orb");
    expect(slugifyClubName("TV Bad Orb e. V.")).toBe("tv-bad-orb");
    expect(slugifyClubName("TV Bad Orb eV")).toBe("tv-bad-orb");
    expect(slugifyClubName("TV Bad Orb E.V")).toBe("tv-bad-orb");
    expect(slugifyClubName("Turnverein Bad Orb eingetragener Verein")).toBe("turnverein-bad-orb");
  });

  it("does not strip an 'ev' that is part of a word", () => {
    expect(slugifyClubName("Bevern Sportverein")).toBe("bevern-sportverein");
    expect(slugifyClubName("Steven Fanclub")).toBe("steven-fanclub");
  });

  it("removes emoji and special characters", () => {
    expect(slugifyClubName("Kicker ⚽ United!!! #1")).toBe("kicker-united-1");
    expect(slugifyClubName("A/B\\C_D")).toBe("a-b-c-d");
  });

  it("falls back for names without usable characters", () => {
    expect(slugifyClubName("!!!")).toBe("verein");
    expect(slugifyClubName("⚽🏆")).toBe("verein");
    expect(slugifyClubName("")).toBe("verein");
    expect(slugifyClubName("e.V.")).toBe("verein");
  });

  it("pads too-short names", () => {
    expect(slugifyClubName("TV")).toBe("tv-verein");
    expect(slugifyClubName("A")).toBe("a-verein");
  });

  it("never returns a reserved slug", () => {
    expect(slugifyClubName("Admin")).toBe("admin-verein");
    expect(slugifyClubName("Demo e.V.")).toBe("demo-verein");
    expect(slugifyClubName("API")).toBe("api-verein");
    expect(isReservedSlug(slugifyClubName("www"))).toBe(false);
    for (const word of ["Vereine", "join", "Dashboard", "mobile", "web", "docs", "blog", "news", "billing", "security", "privacy", "impressum", "datenschutz", "agb", "contact", "imprint", "support", "help", "me"]) {
      expect(isReservedSlug(slugifyClubName(word)), word).toBe(false);
      expect(isReservedSlug(word.toLowerCase()), word).toBe(true);
    }
    expect(isReservedSlug("verein")).toBe(false); // stays the fallback
  });

  it("limits the length to 50 characters without a trailing dash", () => {
    const slug = slugifyClubName("Sportverein ".repeat(10));
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    const edge = slugifyClubName(`${"a".repeat(49)} bcd`);
    expect(edge).toBe("a".repeat(49));
  });

  it("always yields a string that passes assertValidClubSlug", () => {
    for (const name of ["TV Bad Orb e.V.", "⚽", "Ü", "x".repeat(200), "Admin", "1", "--", "Ärzte ohne Grenzen e.V."]) {
      expect(() => assertValidClubSlug(slugifyClubName(name))).not.toThrow();
    }
  });
});

describe("assertValidClubSlug", () => {
  it("accepts well-formed slugs", () => {
    expect(() => assertValidClubSlug("tv-bad-orb")).not.toThrow();
    expect(() => assertValidClubSlug("abc")).not.toThrow();
  });

  it("rejects bad length, characters, double/edge dashes and reserved words", () => {
    for (const bad of ["ab", "a".repeat(51), "Upper", "with space", "under_score", "-lead", "trail-", "dou--ble", "ümlaut", "admin", "demo"]) {
      expect(() => assertValidClubSlug(bad), bad).toThrow(ValidationError);
    }
  });
});

describe("pickFreeSlug", () => {
  it("returns the base when free", () => {
    expect(pickFreeSlug("tv-bad-orb", new Set())).toBe("tv-bad-orb");
  });

  it("appends -2, -3, ... on collisions", () => {
    expect(pickFreeSlug("tv-bad-orb", new Set(["tv-bad-orb"]))).toBe("tv-bad-orb-2");
    expect(pickFreeSlug("tv-bad-orb", new Set(["tv-bad-orb", "tv-bad-orb-2"]))).toBe("tv-bad-orb-3");
    expect(pickFreeSlug("tv-bad-orb", new Set(["tv-bad-orb", "tv-bad-orb-3"]))).toBe("tv-bad-orb-2");
  });

  it("keeps the suffixed slug within the length limit", () => {
    const base = "a".repeat(SLUG_MAX_LENGTH);
    const result = pickFreeSlug(base, new Set([base]));
    expect(result).toBe(`${"a".repeat(SLUG_MAX_LENGTH - 2)}-2`);
    expect(result.length).toBe(SLUG_MAX_LENGTH);
  });
});
