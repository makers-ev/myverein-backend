import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, HMAC-signed media URLs (Wave 7 B18, modelled on MyCouple's media-url.ts).
 *
 * The authorization decision is NOT made when the file is fetched but where it already happens anyway: a feature route
 * (member list, damage reports, ...) checks its own permission and only then mints a URL with `buildMediaUrl`.
 * `GET /media/*` merely verifies the signature and the registry row, so a plain website `<img src>` and the native app
 * `Image` work without cookies. The signature covers key + expiry (`media-url:<key>:<exp>`, namespaced so the same
 * secret can be reused for nothing else), is compared in constant time and expires after `MEDIA_URL_TTL_SECONDS`.
 */

const DEFAULT_TTL_SECONDS = 30 * 60;

function secret(): string {
  const value = process.env.MEDIA_URL_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("MEDIA_URL_SECRET or BETTER_AUTH_SECRET must be set to sign media URLs");
  return value;
}

/** Validity of a signed URL in milliseconds (`MEDIA_URL_TTL_SECONDS`, default 1800, clamped to 30 s .. 24 h). */
export function mediaUrlTtlMs(): number {
  const parsed = Number(process.env.MEDIA_URL_TTL_SECONDS);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(Math.floor(seconds), 30), 24 * 60 * 60) * 1000;
}

export function signMediaKey(key: string, expiresAtMs: number): string {
  return createHmac("sha256", secret()).update(`media-url:${key}:${expiresAtMs}`).digest("hex");
}

/** True if `sig` is the valid signature of key + expiry and the expiry has not passed. Never throws on garbage input. */
export function verifyMediaSignature(key: string, exp: string | undefined, sig: string | undefined, now = Date.now()): boolean {
  if (!exp || !sig || !/^\d{1,16}$/.test(exp)) return false;
  const expiresAt = Number(exp);
  if (!Number.isSafeInteger(expiresAt) || now > expiresAt) return false;
  if (!/^[0-9a-f]{64}$/.test(sig)) return false; // also guards the length for timingSafeEqual
  const expected = Buffer.from(signMediaKey(key, expiresAt), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function backendBase(): string {
  return (process.env.BACKEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** Absolute, signed URL for a storage key. Only call this AFTER the route's own permission check. */
export function buildMediaUrl(key: string, ttlMs = mediaUrlTtlMs(), now = Date.now()): string {
  const exp = now + ttlMs;
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${backendBase()}/media/${path}?exp=${exp}&sig=${signMediaKey(key, exp)}`;
}
