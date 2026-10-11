/**
 * CSV helpers for the member import/export (Wave 7 B10): RFC 4180 parser with delimiter detection, Excel-DE friendly
 * writer (UTF-8 BOM, `;`, CRLF) and spreadsheet formula-injection escaping. Pure functions, no database access.
 */

export const CSV_BOM = "﻿";
export type CsvDelimiter = ";" | "," | "\t";

/** Hard limits (env-tunable, clamped), see README "Configuration". */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}
export const importMaxRows = () => envInt("MEMBER_IMPORT_MAX_ROWS", 2000, 1, 20_000);
export const importMaxBytes = () => envInt("MEMBER_IMPORT_MAX_BYTES", 1_048_576, 1024, 10_485_760);

/** Picks the delimiter that occurs most often in the first line outside of quotes (ties prefer `;`, the German Excel default). */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ";": 0, ",": 0, "\t": 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch as CsvDelimiter] += 1;
  }
  return counts[";"] >= counts[","] && counts[";"] >= counts["\t"] ? ";" : counts[","] >= counts["\t"] ? "," : "\t";
}

export class CsvParseError extends Error {}

/** Parses CSV text into rows of cells. Handles quoted fields (`""` escape, embedded delimiters/newlines), CRLF/LF/CR, a BOM and blank lines (skipped). */
export function parseCsv(input: string, delimiter: CsvDelimiter): string[][] {
  const text = input.startsWith(CSV_BOM) ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellStarted = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0]!.trim() !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
    } else if (ch === delimiter) {
      endCell();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
    } else {
      cell += ch;
      cellStarted = true;
    }
  }
  if (quoted) throw new CsvParseError("Unterminated quoted field");
  if (cellStarted || cell !== "" || row.length > 0) endRow();
  return rows;
}

/** First characters a spreadsheet interprets as a formula (OWASP CSV injection), plus TAB/CR which can smuggle one in. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Neutralises a cell for export: a leading `=`, `+`, `-`, `@`, TAB or CR gets a `'` prefix so Excel/LibreOffice show text instead of evaluating it. */
export function escapeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** Undoes `escapeFormula` on import (round trip of our own export): `'=...` -> `=...`. */
export function unescapeFormula(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** One export cell: formula-escaped, quoted when it contains the delimiter, a quote or a line break. */
export function csvCell(value: string | number | null | undefined, delimiter: CsvDelimiter = ";"): string {
  if (value === null || value === undefined) return "";
  const text = escapeFormula(String(value));
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Whole file for Excel DE: BOM + header + rows, `;`-separated, CRLF line ends. */
export function buildCsv(header: string[], rows: Array<Array<string | number | null | undefined>>, delimiter: CsvDelimiter = ";"): string {
  const lines = [header, ...rows].map((r) => r.map((v) => csvCell(v, delimiter)).join(delimiter));
  return `${CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** Normalises a header for alias matching: lower case, umlauts transliterated, everything but a-z0-9 removed. */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

/** Strict calendar date check for `YYYY-MM-DD`. */
export function isRealIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Accepts `YYYY-MM-DD` and the German `D.M.YYYY`; returns the ISO date or null if it is not a real calendar date. */
export function parseFlexibleDate(value: string): string | null {
  const v = value.trim();
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v);
  const iso = de ? `${de[3]}-${de[2]!.padStart(2, "0")}-${de[1]!.padStart(2, "0")}` : v;
  return isRealIsoDate(iso) ? iso : null;
}
