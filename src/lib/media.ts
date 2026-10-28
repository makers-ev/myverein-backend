import { createHash } from "node:crypto";
import { Readable } from "node:stream";

import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "../db/client.js";
import {
  mediaFiles,
  UNATTACHED_OWNER,
  type MediaFileRow,
  type MediaKind,
  type MediaVisibility,
} from "../db/schema/media-files.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { MalformedImageError, stripImageMetadata } from "./image-sanitize.js";
import { logger } from "./logger.js";
import { buildMediaUrl } from "./media-url.js";
import { checkStorageThresholds, effectiveQuotaBytes, platformQuotaBytes, usedBytes } from "./media-quota.js";
import { deleteObject, getObject, listObjects, objectMtimeMs, objectSize, openObjectStream, putObject, sanitizeFilename, writeObject } from "./storage.js";
import { writeAudit } from "./audit.js";

/**
 * Central media security layer (Wave 7 B18). THE only module that touches stored user files: every upload, URL and
 * download of an image or document goes through here (a test greps for violations).
 *
 *   upload   storeUpload()          allowlist + magic bytes + size + EXIF/GPS strip + quota + registry row
 *   URLs     signedMediaUrls()      short-lived HMAC URL, call ONLY after the feature route's own permission check
 *   serve    GET /media/* (routes/media.ts) signature + registry only; sensitive files never
 *   stream   streamSensitiveMedia() authenticated stream + audit entry per retrieval (proof documents, ID checks)
 *   delete   deleteMedia()          file + registry tombstone
 */

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const DOCUMENT_TYPES = ["application/pdf", ...IMAGE_TYPES] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

/** Content type from the magic bytes -- the only thing we trust. `null` = not an allowed format. */
export function sniffMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 5 && buffer.toString("latin1", 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/** Platform default storage quota per club in bytes (`MEDIA_QUOTA_BYTES_PER_CLUB`, default 1 GiB); a club may carry its own (`club_settings.storage_quota_bytes`). */
export const clubQuotaBytes = platformQuotaBytes;

/** Generated PDFs are capped like the engine output (20 MiB). */
export const MAX_GENERATED_PDF_BYTES = 20 * 1024 * 1024;
/** Logo files of the branding (PNG/JPEG only, never SVG). */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;
/** `owner_type` values of the document area (Wave 13 BM). */
export const DOCUMENT_OWNER_TYPES = { archive: "document", personal: "member_document", branding: "branding", generated: "generated_pdf" } as const;

/** Optional antivirus hook: set it at startup, it rejects an upload by throwing. Unset (default) = no scan. */
export type UploadScanner = (buffer: Buffer, info: { mimeType: string; filename: string }) => Promise<void>;
let uploadScanner: UploadScanner | null = null;
export function setUploadScanner(scanner: UploadScanner | null): void {
  uploadScanner = scanner;
}

const TYPE_ALIASES: Record<string, string> = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };

/** Declared content type as browsers/clients send it: case, parameters and the usual aliases (image/jpg) normalised. */
export function normalizeContentType(type: string): string {
  const base = type.split(";")[0]!.trim().toLowerCase();
  return TYPE_ALIASES[base] ?? base;
}

/** Cap for files that no feature has claimed yet (`POST /media`): files and bytes per user (env-tunable). */
function unattachedLimits(): { files: number; bytes: number } {
  const files = Number(process.env.MEDIA_UNATTACHED_MAX_FILES_PER_USER);
  const bytes = Number(process.env.MEDIA_UNATTACHED_MAX_BYTES_PER_USER);
  return { files: Number.isFinite(files) && files > 0 ? Math.floor(files) : 25, bytes: Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 50 * 1024 * 1024 };
}

/** Hours after which an unclaimed upload is swept (`MEDIA_UNATTACHED_TTL_HOURS`, default 24). */
export function unattachedTtlMs(): number {
  const hours = Number(process.env.MEDIA_UNATTACHED_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;
}

/** Locks the club's quota (advisory lock per club, released with the transaction) and refuses a write that would exceed it. */
export async function assertQuota(tx: DbExecutor, clubId: string, addBytes: number): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`media-quota:${clubId}`}, 0))`);
  const [used, quota] = await Promise.all([usedBytes(tx, clubId), effectiveQuotaBytes(tx, clubId)]);
  if (used + addBytes > quota) {
    throw new ValidationError("The storage quota of this club is exhausted", { code: "QUOTA_EXCEEDED", details: { code: "club_quota", usedBytes: used, quotaBytes: quota } });
  }
}

export interface StoreUploadInput {
  file: File;
  /** Owning club (quota scope); null for platform-level files such as club registration proofs. */
  clubId: string | null;
  /** Storage directory; defaults to the club id. */
  storagePrefix?: string;
  kind: MediaKind;
  allowedTypes: readonly string[];
  maxBytes: number;
  visibility?: MediaVisibility;
  sensitive?: boolean;
  owner?: { type: string; id: string | null };
  uploadedBy: string | null;
  /** Pass a transaction to make the registry row part of the caller's transaction (then call `discardStoredFile` if the caller's transaction rolls back later). */
  executor?: DbExecutor;
}

/**
 * Validates and stores one uploaded file and registers it. Order: size -> magic bytes (must match the allowlist AND the
 * declared type) -> metadata strip (images) -> optional scanner -> file write -> quota check + registry row in one
 * transaction (per-club advisory lock, so parallel uploads cannot overshoot the quota).
 */
export async function storeUpload(input: StoreUploadInput): Promise<MediaFileRow> {
  const { file } = input;
  if (file.size === 0) throw new ValidationError("File is empty");
  if (file.size > input.maxBytes) throw new ValidationError(`File exceeds maximum size of ${input.maxBytes} bytes`);

  const raw = Buffer.from(await file.arrayBuffer());
  if (raw.length > input.maxBytes) throw new ValidationError(`File exceeds maximum size of ${input.maxBytes} bytes`);

  const sniffed = sniffMimeType(raw);
  if (!sniffed || !input.allowedTypes.includes(sniffed)) {
    throw new ValidationError(`Unsupported file type (allowed: ${input.allowedTypes.join(", ")})`);
  }
  // The declared type is client-controlled -- it has to agree with the content (an empty declaration is tolerated).
  if (file.type && normalizeContentType(file.type) !== sniffed) throw new ValidationError("File content does not match its declared content type");
  const isImage = sniffed.startsWith("image/");
  if (input.kind === "image" && !isImage) throw new ValidationError("Only images are accepted here");

  let buffer: Buffer = raw;
  if (isImage) {
    try {
      buffer = stripImageMetadata(raw, sniffed);
    } catch (err) {
      if (err instanceof MalformedImageError) throw new ValidationError(`Corrupt image: ${err.message}`);
      throw err;
    }
  }
  const filename = sanitizeFilename(file.name || "file");
  if (uploadScanner) await uploadScanner(buffer, { mimeType: sniffed, filename });

  const prefix = input.storagePrefix ?? input.clubId;
  if (!prefix) throw new Error("storeUpload needs a clubId or a storagePrefix");
  const { key } = await putObject({ prefix, extension: EXTENSION_BY_TYPE[sniffed] ?? "", buffer });

  const insert = async (tx: DbExecutor): Promise<MediaFileRow> => {
    if (input.clubId) await assertQuota(tx, input.clubId, buffer.length);
    // Unclaimed uploads are capped per user so POST /media cannot be used as free storage (they are swept after a TTL).
    if (!input.owner && input.uploadedBy) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`media-unattached:${input.uploadedBy}`}, 0))`);
      const [{ files, bytes }] = await tx
        .select({ files: sql<number>`count(*)::int`, bytes: sql<number>`coalesce(sum(${mediaFiles.sizeBytes}), 0)::bigint::float8` })
        .from(mediaFiles)
        .where(and(eq(mediaFiles.uploadedBy, input.uploadedBy), eq(mediaFiles.ownerType, UNATTACHED_OWNER), isNull(mediaFiles.deletedAt)));
      const limits = unattachedLimits();
      if (files + 1 > limits.files || Number(bytes) + buffer.length > limits.bytes) {
        throw new ValidationError("Too many unused uploads: attach or wait for the pending ones to expire", { code: "QUOTA_EXCEEDED", details: { code: "unattached_cap" } });
      }
    }
    const [row] = await tx
      .insert(mediaFiles)
      .values({
        clubId: input.clubId,
        storageKey: key,
        ownerType: input.owner?.type ?? UNATTACHED_OWNER,
        ownerId: input.owner?.id ?? null,
        kind: input.kind,
        mimeType: sniffed,
        sizeBytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        originalFilename: filename,
        sensitive: input.sensitive ?? false,
        visibility: input.visibility ?? "private",
        uploadedBy: input.uploadedBy,
      })
      .returning();
    return row!;
  };

  try {
    const row = input.executor ? await insert(input.executor) : await db.transaction(insert);
    // 80 / 100 % notices; with the caller's transaction still open the numbers are not final, so the caller does it after its commit.
    if (!input.executor && input.clubId) await checkStorageThresholds(input.clubId);
    return row;
  } catch (err) {
    await discardStoredFile(key);
    throw err;
  }
}

export interface StoreGeneratedPdfInput {
  buffer: Buffer;
  clubId: string;
  /** Storage directory below the club (default `generated`): the key becomes `<clubId>/<dir>/<uuid>.pdf`. */
  directory?: string;
  filename: string;
  owner: { type: string; id: string | null };
  /** Personal and evidence documents are streamed authenticated with an audit entry, never as a signed URL. */
  sensitive: boolean;
  uploadedBy: string | null;
  executor?: DbExecutor;
}

/**
 * Registers a PDF produced by the render pipeline (server-made, so no client content type to check): size cap, `%PDF-`
 * magic bytes, quota under the per-club lock, registry row. Same rules as an upload for everything else.
 */
export async function storeGeneratedPdf(input: StoreGeneratedPdfInput): Promise<MediaFileRow> {
  if (input.buffer.length === 0 || input.buffer.length > MAX_GENERATED_PDF_BYTES) throw new ValidationError("Generated file has an invalid size");
  if (sniffMimeType(input.buffer) !== "application/pdf") throw new ValidationError("Generated file is not a PDF");
  const { key } = await putObject({ prefix: `${input.clubId}/${input.directory ?? "generated"}`, extension: "pdf", buffer: input.buffer });
  const insert = async (tx: DbExecutor): Promise<MediaFileRow> => {
    await assertQuota(tx, input.clubId, input.buffer.length);
    const [row] = await tx
      .insert(mediaFiles)
      .values({
        clubId: input.clubId,
        storageKey: key,
        ownerType: input.owner.type,
        ownerId: input.owner.id,
        kind: "document",
        mimeType: "application/pdf",
        sizeBytes: input.buffer.length,
        sha256: createHash("sha256").update(input.buffer).digest("hex"),
        originalFilename: sanitizeFilename(input.filename),
        sensitive: input.sensitive,
        visibility: "private",
        uploadedBy: input.uploadedBy,
      })
      .returning();
    return row!;
  };
  try {
    const row = input.executor ? await insert(input.executor) : await db.transaction(insert);
    if (!input.executor) await checkStorageThresholds(input.clubId);
    return row;
  } catch (err) {
    await discardStoredFile(key);
    throw err;
  }
}

/** Best-effort removal of a file whose registry row never got committed (caller rolled back). */
export async function discardStoredFile(storageKey: string): Promise<void> {
  await deleteObject(storageKey).catch((err) => logger.error({ err, key: storageKey }, "[media] failed to remove orphaned upload"));
}

export async function findMediaByKey(storageKey: string, executor: DbExecutor = db): Promise<MediaFileRow | null> {
  const [row] = await executor.select().from(mediaFiles).where(and(eq(mediaFiles.storageKey, storageKey), isNull(mediaFiles.deletedAt))).limit(1);
  return row ?? null;
}

/**
 * Soft-deletes the registry row (tombstone, GET answers 404); `clubId` scopes it to one club. Returns whether a live row
 * was marked. Pass the caller's transaction to make it atomic with the feature row update, and call `purgeMediaFile`
 * after the commit -- only if this returned true, so a stale/foreign key never deletes someone else's file.
 */
export async function markMediaDeleted(storageKey: string, executor: DbExecutor = db, clubId?: string): Promise<boolean> {
  const rows = await executor
    .update(mediaFiles)
    .set({ deletedAt: new Date() })
    .where(and(eq(mediaFiles.storageKey, storageKey), isNull(mediaFiles.deletedAt), ...(clubId ? [eq(mediaFiles.clubId, clubId)] : [])))
    .returning({ id: mediaFiles.id });
  return rows.length > 0;
}

export async function purgeMediaFile(storageKey: string): Promise<void> {
  await deleteObject(storageKey).catch((err) => logger.error({ err, key: storageKey }, "[media] failed to remove deleted file"));
}

/** Delete = registry tombstone + file. */
export async function deleteMedia(storageKey: string, clubId?: string): Promise<void> {
  if (await markMediaDeleted(storageKey, db, clubId)) await purgeMediaFile(storageKey);
}

/**
 * Deletes uploads that no feature row claimed within the TTL (file + registry tombstone). Returns the number removed.
 * Runs at startup and periodically (`startMediaSweeper`).
 */
export async function sweepUnattachedUploads(now = Date.now()): Promise<number> {
  const cutoff = new Date(now - unattachedTtlMs());
  const stale = await db
    .update(mediaFiles)
    .set({ deletedAt: new Date(now) })
    .where(and(eq(mediaFiles.ownerType, UNATTACHED_OWNER), isNull(mediaFiles.deletedAt), lt(mediaFiles.createdAt, cutoff)))
    .returning({ storageKey: mediaFiles.storageKey });
  for (const { storageKey } of stale) await purgeMediaFile(storageKey);
  return stale.length;
}

/** Namespaces that exist only since the registry (Wave 13): a file there without a registry row is an orphan, never a legacy file. */
const REGISTRY_ONLY_DIRECTORIES = ["documents", "personal", "generated", "branding"] as const;
/** A file younger than this may belong to an upload whose registry row is about to be committed. */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Removes files of the registry-only namespaces (`<club>/documents|personal|generated|branding/...`) that have no registry
 * row (crash between file write and commit) and are older than an hour; also files whose row is a tombstone. Files of the
 * older namespaces are NOT touched (they are registered lazily on first use). Returns the number removed.
 */
export async function sweepOrphanFiles(clubIds: readonly string[], now = Date.now()): Promise<number> {
  let removed = 0;
  for (const clubId of clubIds) {
    for (const dir of REGISTRY_ONLY_DIRECTORIES) {
      const keys = await listObjects(`${clubId}/${dir}`);
      for (let i = 0; i < keys.length; i += 200) {
        const batch = keys.slice(i, i + 200);
        const live = new Set((await db.select({ key: mediaFiles.storageKey }).from(mediaFiles).where(and(inArray(mediaFiles.storageKey, batch), isNull(mediaFiles.deletedAt)))).map((r) => r.key));
        for (const key of batch) {
          if (live.has(key)) continue;
          try {
            if (now - (await objectMtimeMs(key)) < ORPHAN_MIN_AGE_MS) continue;
            await deleteObject(key);
            removed += 1;
          } catch (err) {
            logger.error({ err, key }, "[media] failed to remove orphan file");
          }
        }
      }
    }
  }
  return removed;
}

/** Starts the sweep now and then hourly; the timer does not keep the process alive. */
export function startMediaSweeper(intervalMs = 60 * 60 * 1000): () => void {
  const run = () => sweepUnattachedUploads().then((n) => (n > 0 ? logger.info({ removed: n }, "[media] swept unused uploads") : undefined)).catch((err) => logger.error({ err }, "[media] sweep failed"));
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The bytes of a registered file of this club (server-side consumers such as the PDF renderer reading the logo). `null` if the
 * key is unknown, deleted, foreign or larger than `maxBytes`.
 */
export async function readRegisteredFile(clubId: string, storageKey: string, maxBytes: number): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const row = await findMediaByKey(storageKey);
  if (!row || row.clubId !== clubId || row.sizeBytes > maxBytes) return null;
  try {
    return { buffer: await getObject(storageKey), mimeType: row.mimeType };
  } catch {
    return null;
  }
}

/** Opt a file into unauthenticated serving (`public_opt_in`). Sensitive files and files without a club can never be public. */
export async function setMediaVisibility(storageKey: string, visibility: MediaVisibility): Promise<void> {
  const row = await findMediaByKey(storageKey);
  if (!row) throw new NotFoundError("File not found");
  if (visibility === "public_opt_in" && (row.sensitive || !row.clubId || row.kind !== "image")) {
    throw new ValidationError("Only non-sensitive club images can be made public");
  }
  await db.update(mediaFiles).set({ visibility }).where(eq(mediaFiles.id, row.id));
}

/**
 * Files written before the registry existed (damage photos, wave 6 proofs) have no row. Registers such a file on first
 * use from what is on disk (content type from the magic bytes, never from the extension) -- "resign on read", no
 * backfill job. Returns null if the file is gone or not an allowed format.
 */
export async function registerLegacyFile(input: {
  storageKey: string;
  clubId: string | null;
  kind: MediaKind;
  owner: { type: string; id: string | null };
  sensitive?: boolean;
  filename?: string;
}): Promise<MediaFileRow | null> {
  let buffer: Buffer;
  try {
    // Cap BEFORE reading: a huge stray file must not be pulled into memory.
    if ((await objectSize(input.storageKey)) > MAX_DOCUMENT_BYTES) return null;
    buffer = await getObject(input.storageKey);
  } catch {
    return null;
  }
  const mimeType = sniffMimeType(buffer);
  if (!mimeType || (input.kind === "image" && !mimeType.startsWith("image/"))) return null;
  if (mimeType.startsWith("image/")) {
    // Old files were never sanitised: strip EXIF/GPS now and rewrite the file, so the registry describes what is served.
    try {
      const stripped = stripImageMetadata(buffer, mimeType);
      if (!stripped.equals(buffer)) await writeObject(input.storageKey, stripped);
      buffer = stripped;
    } catch {
      return null;
    }
  }
  await db
    .insert(mediaFiles)
    .values({
      clubId: input.clubId,
      storageKey: input.storageKey,
      ownerType: input.owner.type,
      ownerId: input.owner.id,
      kind: input.kind,
      mimeType,
      sizeBytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      originalFilename: sanitizeFilename(input.filename ?? input.storageKey.split("/").pop() ?? "file"),
      sensitive: input.sensitive ?? false,
      visibility: "private",
    })
    .onConflictDoNothing({ target: mediaFiles.storageKey });
  return findMediaByKey(input.storageKey);
}

/**
 * Signed URLs for storage keys of one club, to be called AFTER the route's own permission check. Keys that are unknown,
 * deleted, sensitive or belong to another club are simply missing from the result (the caller answers `null`).
 * A key of a pre-registry file is registered on the fly (see `registerLegacyFile`).
 */
export async function signedMediaUrls(clubId: string, keys: ReadonlyArray<string | null | undefined>, legacyOwner = "legacy"): Promise<Map<string, string>> {
  const wanted = [...new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))];
  const urls = new Map<string, string>();
  if (wanted.length === 0) return urls;

  const rows = await db
    .select()
    .from(mediaFiles)
    .where(and(inArray(mediaFiles.storageKey, wanted), eq(mediaFiles.clubId, clubId), isNull(mediaFiles.deletedAt)));
  const known = new Map(rows.map((r) => [r.storageKey, r]));

  for (const key of wanted) {
    let row = known.get(key) ?? null;
    if (!row && key.startsWith(`${clubId}/`) && !key.includes("..")) {
      // Only register if nobody else owns this key (a row of another club / a deleted row must not be resurrected).
      const [existing] = await db.select({ id: mediaFiles.id }).from(mediaFiles).where(eq(mediaFiles.storageKey, key)).limit(1);
      if (!existing) row = await registerLegacyFile({ storageKey: key, clubId, kind: "image", owner: { type: legacyOwner, id: null } });
    }
    if (row && !row.sensitive) urls.set(key, buildMediaUrl(key));
  }
  return urls;
}

export async function signedMediaUrl(clubId: string, key: string | null | undefined, legacyOwner?: string): Promise<string | null> {
  if (!key) return null;
  return (await signedMediaUrls(clubId, [key], legacyOwner)).get(key) ?? null;
}

/**
 * Marks a freshly uploaded, still unattached file as belonging to a feature row. The file must be an image of this club
 * uploaded by the caller; a file can be attached only once. Run inside the feature transaction.
 */
export async function attachUploadedImage(executor: DbExecutor, input: { clubId: string; storageKey: string; uploadedBy: string; owner: { type: string; id: string | null } }): Promise<MediaFileRow> {
  const [row] = await executor
    .update(mediaFiles)
    .set({ ownerType: input.owner.type, ownerId: input.owner.id })
    .where(
      and(
        eq(mediaFiles.storageKey, input.storageKey),
        eq(mediaFiles.clubId, input.clubId),
        eq(mediaFiles.ownerType, UNATTACHED_OWNER),
        eq(mediaFiles.uploadedBy, input.uploadedBy),
        eq(mediaFiles.kind, "image"),
        eq(mediaFiles.sensitive, false),
        isNull(mediaFiles.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new ValidationError("Unknown media key: upload the image via POST /media first (each upload can be used once)");
  return row;
}

/**
 * Hands a registered file over from one feature row to another WITHOUT copying it (e.g. the photo of an accepted
 * application becomes the member's profile photo): only the registry owner changes, the key stays. Applies only to a
 * live, non-sensitive file of this club of the expected kind that is currently owned by `from`; returns null otherwise
 * (the caller then keeps the file where it was). Run inside the feature transaction.
 */
export async function reassignMediaOwner(
  executor: DbExecutor,
  input: { storageKey: string; clubId: string; kind: MediaKind; from: { type: string; id: string }; to: { type: string; id: string } },
): Promise<MediaFileRow | null> {
  const [row] = await executor
    .update(mediaFiles)
    .set({ ownerType: input.to.type, ownerId: input.to.id })
    .where(
      and(
        eq(mediaFiles.storageKey, input.storageKey),
        eq(mediaFiles.clubId, input.clubId),
        eq(mediaFiles.ownerType, input.from.type),
        eq(mediaFiles.ownerId, input.from.id),
        eq(mediaFiles.kind, input.kind),
        eq(mediaFiles.sensitive, false),
        isNull(mediaFiles.deletedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** Headers every media response carries. */
function applyMediaHeaders(c: Context, row: MediaFileRow, cacheControl: string, disposition: "inline" | "attachment"): void {
  const asciiName = row.originalFilename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  c.header("Content-Type", row.mimeType);
  c.header("Content-Disposition", `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.originalFilename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  c.header("Cache-Control", cacheControl);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
  c.header("Content-Length", String(row.sizeBytes));
}

/** A web stream of the stored file (no full read into memory); a missing file is the same 404 as an unknown key. */
async function streamOrNotFound(row: MediaFileRow): Promise<ReadableStream<Uint8Array>> {
  try {
    await objectSize(row.storageKey);
    return Readable.toWeb(openObjectStream(row.storageKey) as Readable) as ReadableStream<Uint8Array>;
  } catch {
    throw new NotFoundError("File not found");
  }
}

/**
 * Serves a registered file after a valid signature (or `public_opt_in`) -- called by `GET /media/*` only. Sensitive
 * files are refused here no matter how valid the signature is: they exist only on the authenticated, audited path.
 */
export async function serveSignedMedia(c: Context, row: MediaFileRow, maxAgeSeconds: number): Promise<Response> {
  if (row.sensitive) throw new NotFoundError("File not found");
  const body = await streamOrNotFound(row);
  const isPublic = row.visibility === "public_opt_in";
  // `private`: a shared/CDN cache must never hand a signed response to someone else.
  applyMediaHeaders(c, row, isPublic ? "public, max-age=300" : `private, max-age=${Math.max(0, maxAgeSeconds)}`, row.kind === "document" ? "attachment" : "inline");
  return c.body(body);
}

/** Authenticated stream of a non-sensitive file (the caller's route did the permission check). No signature involved. */
export async function streamMedia(c: Context, row: MediaFileRow): Promise<Response> {
  const body = await streamOrNotFound(row);
  applyMediaHeaders(c, row, "private, no-store", row.kind === "document" ? "attachment" : "inline");
  return c.body(body);
}

/**
 * Authenticated stream of a SENSITIVE document (never a signed URL). The audit entry is written BEFORE the bytes are
 * read, so a failing audit write fails the request closed. `accessedBy` is the user id of the caller.
 */
export async function streamSensitiveMedia(c: Context, row: MediaFileRow, access: { accessedBy: string; subjectId?: string; reason?: string }): Promise<Response> {
  if (!row.sensitive) throw new ConflictError("Not a sensitive file");
  await writeAudit(db, {
    eventType: "media.sensitive_access",
    subjectId: access.subjectId ?? row.id,
    payload: { mediaId: row.id, ownerType: row.ownerType, ownerId: row.ownerId, accessedBy: access.accessedBy, ...(access.reason ? { reason: access.reason } : {}) },
  });
  const body = await streamOrNotFound(row);
  applyMediaHeaders(c, row, "private, no-store", "attachment");
  return c.body(body);
}
