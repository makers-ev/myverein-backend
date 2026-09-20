import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Adapted from mycouple-backend's src/lib/storage.ts (local-disk object
// storage, no Cloudflare R2 yet). Simplified for this repo: no quota system
// (no media_uploads table -- not in this backend's Data Model doc), and
// files are served back through an authenticated route (see
// routes/media.ts) instead of a public URL, so putObject() returns only a
// `key`, never a URL.
export const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "./uploads";

/** Strips path separators and control characters from a client-supplied filename before it touches the filesystem. */
export function sanitizeFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = filename.replace(/[/\\]/g, "_").replace(/[\x00-\x1f]/g, "");
  const trimmed = stripped.trim().slice(0, 150);
  return trimmed || "file";
}

export async function putObject({
  clubId,
  filename,
  buffer,
}: {
  clubId: string;
  filename: string;
  buffer: Buffer;
}): Promise<{ key: string }> {
  const clubDir = path.join(UPLOADS_DIR, clubId);
  await mkdir(clubDir, { recursive: true });

  const key = `${clubId}/${randomUUID()}-${sanitizeFilename(filename)}`;
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
