import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "./error-codes.js";
import { AppError, type ErrorCode } from "./errors.js";
import { BEGIN, END, renderErrorCodeBlock, scanDetailCodes } from "../scripts/error-codes.js";

/** Wave 14 DS2: the README "Error codes" tables are generated; this guard fails when a thrown code is missing there. */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(srcRoot, "..", "README.md"), "utf8");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("error codes", () => {
  it("README tables are up to date (run `npm run docs:error-codes` if this fails)", () => {
    const block = readme.slice(readme.indexOf(BEGIN), readme.indexOf(END) + END.length);
    expect(block).toBe(renderErrorCodeBlock());
  });

  it("every thrown top-level and details code appears in the README", () => {
    for (const code of Object.keys(ERROR_CODES)) expect(readme, code).toContain(`| \`${code}\` |`);
    const detail = scanDetailCodes();
    expect(detail.length).toBeGreaterThan(100);
    for (const { code } of detail) expect(readme, code).toContain(`| \`${code}\` |`);
  });

  it("every top-level code used in the source (code: \"UPPER\") is registered", () => {
    const used = new Set<string>();
    for (const file of ["routes", "lib", "middleware"].flatMap((d) => sources(join(srcRoot, d)))) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bcode:\s*"([A-Z][A-Z_]+)"/g)) used.add(m[1]!);
    }
    for (const code of used) expect(Object.keys(ERROR_CODES), code).toContain(code);
  });

  it("details codes are snake_case and every body has the {error:{code,message}} shape", () => {
    for (const { code } of scanDetailCodes()) expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    for (const [code, meta] of Object.entries(ERROR_CODES)) {
      const body = new AppError(code as ErrorCode, meta.status, "msg").toJSON();
      expect(body).toEqual({ error: { code, message: "msg" } });
      expect(meta.meaning.length).toBeGreaterThan(10);
    }
  });
});
