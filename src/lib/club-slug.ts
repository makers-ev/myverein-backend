import { like, or, eq } from "drizzle-orm";

import { organization } from "../auth/auth-schema.js";
import type { db } from "../db/client.js";
import { ValidationError } from "./errors.js";
import type { DbTransaction } from "./member-number.js";

/**
 * Club slug rules (Wave 6, E5): generated automatically from the club name,
 * `a-z0-9-` only, 3-50 chars, legal-form suffixes ("e.V.") removed, reserved
 * words blocked, collisions resolved with `-2`, `-3`, ... The slug is the
 * public join key (Aufnahmeantrag) and is immutable once assigned (see the
 * `beforeUpdateOrganization` hook in auth/auth.ts).
 */

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 50;
const SLUG_FALLBACK = "verein";
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugs that must never be handed out (routes, infrastructure, demo data, brand). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "api",
  "app",
  "auth",
  "www",
  "demo",
  "login",
  "logout",
  "signup",
  "register",
  "settings",
  "support",
  "help",
  "mail",
  "smtp",
  "static",
  "assets",
  "media",
  "uploads",
  "internal",
  "health",
  "ready",
  "status",
  "myverein",
  "vereine",
  "join",
  "dashboard",
  "mobile",
  "web",
  "docs",
  "blog",
  "news",
  "billing",
  "security",
  "privacy",
  "impressum",
  "datenschutz",
  "agb",
  "contact",
  "imprint",
  "me",
  "root",
  "system",
  "test",
  "null",
  "undefined",
  "club",
  "clubs",
]);

type SlugExecutor = typeof db | DbTransaction;

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/** Trims to SLUG_MAX_LENGTH (leaving `reserve` chars free for a suffix) without leaving a trailing dash. */
function truncateSlug(slug: string, reserve = 0): string {
  return slug.slice(0, SLUG_MAX_LENGTH - reserve).replace(/-+$/g, "");
}

/**
 * "TV Bad Orb 1899 e.V." -> "tv-bad-orb-1899". Always returns a valid,
 * non-reserved slug of 3-50 chars (falls back to "verein" for names without
 * any usable character, e.g. only emoji/punctuation).
 */
export function slugifyClubName(name: string): string {
  let s = name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    // Letters that do not decompose under NFD.
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .replace(/þ/g, "th")
    // Remaining accents (é -> e, ñ -> n): decompose and drop the combining marks.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

  // Legal-form additions carry no identifying information.
  s = s
    .replace(/eingetragener\s+verein/g, " ")
    .replace(/(^|[^a-z0-9])e\s*\.\s*v\b\.?/g, "$1 ")
    .replace(/\s+ev\s*$/g, " ");

  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  s = truncateSlug(s);

  if (s.length === 0) return SLUG_FALLBACK;
  if (s.length < SLUG_MIN_LENGTH || isReservedSlug(s)) {
    s = `${truncateSlug(s, "-verein".length)}-verein`;
  }
  return s;
}

/** Validates an admin-supplied slug override. Does not touch the DB. */
export function assertValidClubSlug(slug: string): void {
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
    throw new ValidationError(`Slug must be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters`);
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new ValidationError("Slug may only contain lowercase letters, digits and single dashes");
  }
  if (isReservedSlug(slug)) {
    throw new ValidationError("This slug is reserved");
  }
}

/** Pure collision resolution: `base`, else `base-2`, `base-3`, ... (never exceeding SLUG_MAX_LENGTH). */
export function pickFreeSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${truncateSlug(base, suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * First free slug for `base` against `organization.slug`. This is a
 * best-effort read: two concurrent callers can still pick the same value, so
 * the caller must treat `organization_slug_uidx` as the final arbiter and
 * retry (see the approve route) when creating the organization fails.
 */
export async function uniqueClubSlug(executor: SlugExecutor, base: string): Promise<string> {
  const prefix = truncateSlug(base, 5); // leave room for "-9999"-style suffixes in the LIKE scan
  const rows = await executor
    .select({ slug: organization.slug })
    .from(organization)
    .where(or(eq(organization.slug, base), like(organization.slug, `${prefix.replace(/[%_\\]/g, "\\$&")}-%`)));
  return pickFreeSlug(base, new Set(rows.map((r) => r.slug)));
}
