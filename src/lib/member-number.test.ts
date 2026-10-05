import { describe, expect, it } from "vitest";

import { clubAbbreviation } from "./member-number.js";

describe("clubAbbreviation", () => {
  it("takes the first 4 alphanumeric characters, uppercased", () => {
    expect(clubAbbreviation("demo-sportverein")).toBe("DEMO");
    expect(clubAbbreviation("tsv-1860")).toBe("TSV1");
    expect(clubAbbreviation("a-b-c-d-e")).toBe("ABCD");
  });

  it("keeps short slugs as they are", () => {
    expect(clubAbbreviation("fc")).toBe("FC");
  });

  it("falls back to CLUB for empty or non-alphanumeric slugs", () => {
    expect(clubAbbreviation("")).toBe("CLUB");
    expect(clubAbbreviation("---")).toBe("CLUB");
    expect(clubAbbreviation(null)).toBe("CLUB");
    expect(clubAbbreviation(undefined)).toBe("CLUB");
  });
});
