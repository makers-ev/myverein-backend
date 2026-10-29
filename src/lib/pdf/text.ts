/**
 * Text handling for generated PDFs (ADR-010). The engine uses the PDF standard fonts (WinAnsi / Windows-1252), so every
 * string is normalised to what that encoding can show: German umlauts, sz, accented Latin letters, quotes, dashes and
 * the euro sign pass; everything else (emoji, CJK, Arabic/Hebrew, bidi controls) is replaced by `?` in a controlled way.
 * There is no template language: user text is only ever drawn as plain text, never interpreted.
 */

/** Code points 0x80-0x9F of Windows-1252 that map to printable characters (the rest of that block is undefined). */
const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

/** Latin characters outside Windows-1252 that have a faithful ASCII spelling. */
const TRANSLITERATE: Record<string, string> = {
  ł: "l", Ł: "L", đ: "d", Đ: "D", ø: "o", Ø: "O", ı: "i", ğ: "g", Ğ: "G", ş: "s", Ş: "S", ć: "c", Ć: "C", č: "c", Č: "C",
  ś: "s", Ś: "S", ź: "z", Ź: "Z", ż: "z", Ż: "Z", ń: "n", Ń: "N", ę: "e", Ę: "E", ą: "a", Ą: "A", ě: "e", Ě: "E", ř: "r",
  Ř: "R", ů: "u", Ů: "U", ő: "o", Ő: "O", ű: "u", Ű: "U", ă: "a", Ă: "A", ț: "t", Ț: "T", ș: "s", Ș: "S", ā: "a", ē: "e",
  ī: "i", ō: "o", ū: "u", "−": "-", "‘": "'", " ": " ",
};

function inWinAnsi(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return CP1252_EXTRA.has(ch);
}

export interface PdfTextOptions {
  /** Maximum number of characters (code points); longer text is cut and ends with an ellipsis. */
  maxLength?: number;
  /** Keep line breaks (paragraph text); otherwise they become spaces. */
  multiline?: boolean;
}

/** Safe text for the PDF: NFC, no control/bidi characters, only WinAnsi glyphs, bounded length. Never throws. */
export function pdfText(value: unknown, options: PdfTextOptions = {}): string {
  const maxLength = options.maxLength ?? 500;
  let input = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  // Bound the work first: a hostile 100 MB string must not be normalised in full.
  if (input.length > maxLength * 4 + 16) input = input.slice(0, maxLength * 4 + 16);
  input = input.isWellFormed() ? input : input.toWellFormed();
  input = input.normalize("NFC");
  let out = "";
  for (const raw of input) {
    let ch = raw;
    if (ch === "\n" || ch === "\r") {
      ch = options.multiline ? "\n" : " ";
      if (raw === "\r") continue;
    } else if (ch === "\t") ch = " ";
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 && ch !== "\n") continue; // C0 controls dropped
    if ((cp >= 0x7f && cp <= 0x9f && !inWinAnsi(ch)) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x2028 && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff) continue;
    if (ch === "\n" || inWinAnsi(ch)) out += ch;
    else if (TRANSLITERATE[ch] !== undefined) out += TRANSLITERATE[ch];
    else {
      // Combining marks glued to a replaced base letter would leave stray accents: drop them.
      if (/\p{M}/u.test(ch)) continue;
      out += "?";
    }
  }
  out = out.replace(/ {2,}/g, " ");
  out = options.multiline ? out.replace(/\n{3,}/g, "\n\n").trim() : out.trim();
  const chars = Array.from(out);
  if (chars.length > maxLength) return `${chars.slice(0, Math.max(0, maxLength - 1)).join("").trimEnd()}…`;
  return out;
}
