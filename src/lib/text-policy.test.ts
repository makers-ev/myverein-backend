import { describe, expect, it } from "vitest";

import { sanitizeFilename } from "./storage.js";
import { isCleanIdentifier, isCleanText } from "./text-policy.js";

const ch = (...codes: number[]) => String.fromCharCode(...codes);

describe("character policy (isCleanText)", () => {
  it("accepts ordinary text, umlauts, punctuation and emoji", () => {
    for (const ok of ["Trikotgröße", "Anna-Lena O'Neil", "Café über 100% <b>fett</b>", "Hallo 👋 Welt 🇩🇪 👨‍👩‍👧", ""]) expect(isCleanText(ok), ok).toBe(true);
  });

  it("rejects NUL, other C0/C1 controls and DEL in single-line and multi-line text", () => {
    for (const bad of [ch(0), `a${ch(0)}b`, ch(7), ch(0x1b), ch(0x7f), ch(0x85), ch(0x9f)]) {
      expect(isCleanText(bad), JSON.stringify(bad)).toBe(false);
      expect(isCleanText(bad, true), JSON.stringify(bad)).toBe(false);
    }
  });

  it("allows tab, line feed and carriage return only in multi-line text", () => {
    for (const nl of ["\n", "\t", "\r\n"]) {
      expect(isCleanText(`a${nl}b`)).toBe(false);
      expect(isCleanText(`a${nl}b`, true)).toBe(true);
    }
  });

  it("rejects bidi overrides, embeddings, isolates, marks and line/paragraph separators", () => {
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c, 0x2028, 0x2029]) {
      expect(isCleanText(`abc${ch(code)}def`, true), code.toString(16)).toBe(false);
    }
  });

  it("rejects unpaired surrogates", () => {
    expect(isCleanText(`x${ch(0xd800)}y`)).toBe(false);
  });

  it("identifiers additionally reject angle brackets", () => {
    expect(isCleanIdentifier("m")).toBe(true);
    expect(isCleanIdentifier("<script>")).toBe(false);
    expect(isCleanIdentifier("a>b")).toBe(false);
  });

  it("sanitizes file names with the same policy", () => {
    expect(sanitizeFilename(`../../x${ch(0x202e)}gnp.exe${ch(0)}`)).toBe(".._.._xgnp.exe");
    expect(sanitizeFilename(ch(0x202e))).toBe("file");
    expect(sanitizeFilename("Zeugnis 👍.pdf")).toBe("Zeugnis 👍.pdf");
  });
});
