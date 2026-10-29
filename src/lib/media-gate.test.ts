import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Grep gate of the central media security layer (Wave 7 B18): no feature code may bypass it. A new upload/download
 * feature that reads/writes user files, serves them statically, stores a URL or mints its own link fails here and has to
 * go through `src/lib/media.ts` (and extend its tests) instead.
 */

const SRC = path.resolve("src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "migrations" ? [] : sourceFiles(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") && !full.endsWith("media-fixtures.ts") && !full.endsWith("scratch-db.ts") ? [full] : [];
  });
}

/** Source with comments removed, so explanations in comments do not trip the gate. */
function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const files = sourceFiles(SRC).map((f) => ({ file: rel(f), source: code(f) }));
const violations = (pattern: RegExp, allowed: string[]) => files.filter((f) => pattern.test(f.source) && !allowed.includes(f.file)).map((f) => f.file);

/** Any way to pull in a module whose path ends in `storage` (with/without .js/.ts, static, `import * as`, dynamic, require, export-from). */
const STORAGE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`][^"'`]*\/storage(?:\.(?:js|ts))?["'`]/;
/** Any way to reach the filesystem: node:fs and fs (+ /promises), dynamic import/require, Bun/Deno file APIs, stream helpers. */
const FS_ACCESS = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`](?:node:)?fs(?:\/promises)?["'`]|\bBun\.(?:file|write)\b|\bDeno\.(?:readFile|readTextFile|open|writeFile)\b|\bcreate(?:Read|Write)Stream\b|\b(?:readFile|writeFile|readFileSync|writeFileSync|appendFile|unlink|rm|rmSync)\s*\(/;

describe("media layer grep gate", () => {
  it("the gate patterns catch every import/access variant they are meant to", () => {
    for (const sample of [
      'import { putObject } from "./storage.js";',
      'import { putObject } from "../lib/storage";',
      'import * as storage from "../lib/storage.js";',
      'const s = await import("./storage.js");',
      'const s = require("../lib/storage");',
      'export { getObject } from "./storage.js";',
    ]) expect(STORAGE_IMPORT.test(sample), sample).toBe(true);
    for (const sample of [
      'import { readFile } from "node:fs/promises";',
      'import fs from "fs";',
      'import * as fs from "node:fs";',
      'const fs = await import("fs/promises");',
      'const fs = require("node:fs");',
      "const f = Bun.file(path);",
      "createReadStream(p)",
      "await readFile(p)",
    ]) expect(FS_ACCESS.test(sample), sample).toBe(true);
    expect(STORAGE_IMPORT.test('import { x } from "./club-storage-thing.js";')).toBe(false);
  });

  it("only the media layer touches the raw object storage", () => {
    expect(violations(STORAGE_IMPORT, ["lib/media.ts"])).toEqual([]);
    expect(violations(/\b(putObject|getObject|deleteObject|writeObject|objectSize|openObjectStream|objectMtimeMs|listObjects)\s*\(/, ["lib/media.ts", "lib/storage.ts"])).toEqual([]);
    expect(violations(/\bUPLOADS_DIR\b/, ["lib/storage.ts"])).toEqual([]);
  });

  it("nothing serves user files statically or reads/writes the filesystem outside the storage layer", () => {
    expect(violations(/serveStatic/, [])).toEqual([]);
    expect(violations(FS_ACCESS, ["lib/storage.ts"])).toEqual([]);
  });

  it("only the media layer mints media URLs; no route hard-codes a /media/ link", () => {
    expect(violations(/\bbuildMediaUrl\s*\(/, ["lib/media.ts", "lib/media-url.ts", "routes/media.ts"])).toEqual([]);
    // index.ts only routes /media/* to the cross-origin variant of secureHeaders
    expect(violations(/["'`]\/media\//, ["index.ts"])).toEqual([]);
    expect(violations(/\bsignMediaKey\s*\(/, ["lib/media-url.ts"])).toEqual([]);
  });

  it("feature tables hold keys, never URLs of files (no photo_url/image_url/... columns)", () => {
    const schemaFiles = files.filter((f) => f.file.startsWith("db/schema/"));
    expect(schemaFiles.length).toBeGreaterThan(10);
    const offenders = schemaFiles.filter((f) => /["'`][a-z_]*(photo|image|img|avatar|logo|file|media|document|picture)[a-z_]*_url["'`]/i.test(f.source)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("uploads parse multipart bodies only in routes that hand the file to the media layer", () => {
    const parsers = files.filter((f) => /parseBody\(/.test(f.source));
    expect(parsers.length).toBeGreaterThan(0);
    for (const f of parsers) expect(f.source, f.file).toMatch(/storeUpload|replaceMemberPhoto|readPhotoFile|createUploadedDocument|addUploadedVersion/);
  });
});
