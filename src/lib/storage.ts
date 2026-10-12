import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { isCleanText } from "./text-policy.js";

// Raw local-disk object storage, adapted from mycouple-backend's src/lib/storage.ts (no Cloudflare R2 yet).
// This is the LOWEST layer: nothing outside src/lib/media.ts (the central media security layer, Wave 7 B18) may call
// putObject/getObject/deleteObject -- a test enforces that. It returns only a `key`, never a URL.
export const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";

/** Strips path separators and control characters from a client-supplied filename before it touches the filesystem. */
export function sanitizeFilename(filename: string): string {
  const stripped = Array.from(filename.replace(/[/\\]/g, "_")).filter((ch) => isCleanText(ch)).join("");
  const trimmed = stripped.trim().slice(0, 150);
  return trimmed || "file";
}

export async function putObject({ prefix, extension, buffer }: { prefix: string; extension: string; buffer: Buffer }): Promise<{ key: string }> {
  const dir = path.join(UPLOADS_DIR, prefix);
  await mkdir(dir, { recursive: true });

  // The client filename never becomes part of the key (it lives in media_files.original_filename).
  const safeExtension = extension.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  const key = `${prefix}/${randomUUID()}${safeExtension ? `.${safeExtension}` : ""}`;
  await writeFile(path.join(UPLOADS_DIR, key), buffer);

  return { key };
}

/**
 * Reads a previously-uploaded file's raw bytes back off disk, keyed by the
 * same `key` `putObject` returned. `key` reaches here from a URL param, so a
 * caller could try `clubId/../../../etc/passwd` -- resolve and check the
 * result is still inside `UPLOADS_DIR` before touching the filesystem,
 * rather than trusting `path.join`'s own `..`-normalization.
 */
export async function getObject(key: string): Promise<Buffer> {
  const root = path.resolve(UPLOADS_DIR);
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Invalid object key");
  }
  return readFile(resolved);
}

/** Best-effort removal of a stored file (same traversal guard as getObject). A missing file is not an error. */
export async function deleteObject(key: string): Promise<void> {
  const root = path.resolve(UPLOADS_DIR);
  const resolved = path.resolve(root, key);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error("Invalid object key");
  }
  await rm(resolved, { force: true });
}

function resolveInside(key: string): string {
  const root = path.resolve(UPLOADS_DIR);
  const resolved = path.resolve(root, key);
  if (resolved === root || !resolved.startsWith(root + path.sep)) throw new Error("Invalid object key");
  return resolved;
}

/** Size in bytes of a stored file (same traversal guard), so callers can cap before reading it into memory. */
export async function objectSize(key: string): Promise<number> {
  return (await stat(resolveInside(key))).size;
}

/** Overwrites an existing stored file in place (same traversal guard). */
export async function writeObject(key: string, buffer: Buffer): Promise<void> {
  await writeFile(resolveInside(key), buffer);
}
