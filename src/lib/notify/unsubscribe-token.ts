import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "./types.js";
import { setUnsubscribeUrlProvider, type UnsubscribeSubject } from "./unsubscribe.js";

/**
 * Signed unsubscribe tokens (Wave 9 B9, ADR-006). A token is `base64url(json).base64url(hmac)`; the HMAC-SHA256 covers the
 * payload (person + category + club + expiry) under a namespace prefix, is compared in constant time and the token stops
 * working at its expiry. Since G12 a token unsubscribes for the club of the mail only (`v: 2`); tokens without `v` (issued earlier)
 * still switch the category off globally. The subject is the account (`u`, `notification_preferences.user_id`) or, for members without an
 * account, the `club_members` row (`m`). Tokens can be used several times: unsubscribing is idempotent, so a reuse changes nothing.
 * The key is `UNSUBSCRIBE_SECRET` (outside production it falls back to `BETTER_AUTH_SECRET`; production refuses to start without it).
 */

const DEFAULT_TTL_DAYS = 180;
const MAX_TOKEN_LENGTH = 700;

/** Production needs a dedicated key (no sharing with session signing); elsewhere `BETTER_AUTH_SECRET` is a convenient fallback. */
function secret(): string {
  const dedicated = process.env.UNSUBSCRIBE_SECRET;
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV === "production") throw new Error("UNSUBSCRIBE_SECRET must be set in production");
  const value = process.env.BETTER_AUTH_SECRET;
  if (!value) throw new Error("UNSUBSCRIBE_SECRET or BETTER_AUTH_SECRET must be set to sign unsubscribe tokens");
  return value;
}

/** Token validity in milliseconds (`UNSUBSCRIBE_TOKEN_TTL_DAYS`, default 180, clamped to 1..730 days). */
export function unsubscribeTtlMs(): number {
  const n = Number(process.env.UNSUBSCRIBE_TOKEN_TTL_DAYS);
  const days = Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_DAYS;
  return Math.min(Math.max(days, 1), 730) * 24 * 60 * 60 * 1000;
}

export interface UnsubscribePayload {
  /** `u` = `user.id`, `m` = `club_members.id`. */
  s: "u" | "m";
  /** Subject id. */
  p: string;
  c: NotificationCategory;
  /** Club the mail came from (NULL: platform context). */
  k: string | null;
  /**
   * Scope marker. `2` (every token since G12): the unsubscribe applies to the club `k` only. Absent (tokens issued before):
   * the old behaviour, the category is switched off globally -- those links keep working and keep doing what they promised.
   */
  v?: 2;
  /** Expiry, epoch milliseconds. */
  e: number;
}

const payloadSchema = z.object({
  s: z.enum(["u", "m"]),
  p: z.string().min(1).max(100),
  c: z.enum(NOTIFICATION_CATEGORIES),
  k: z.string().min(1).max(100).nullable(),
  v: z.literal(2).optional(),
  e: z.number().int().positive(),
});

const sign = (encoded: string): Buffer => createHmac("sha256", secret()).update(`unsubscribe:v1:${encoded}`).digest();

export function createUnsubscribeToken(subject: UnsubscribeSubject, now = Date.now(), ttlMs = unsubscribeTtlMs()): string | null {
  if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(subject.category)) return null; // mandatory classes have no link
  const kind = subject.userId ? "u" : subject.clubMemberId ? "m" : null;
  if (!kind) return null;
  const payload: UnsubscribePayload = { s: kind, p: (kind === "u" ? subject.userId : subject.clubMemberId)!, c: subject.category as NotificationCategory, k: subject.clubId, v: 2, e: now + ttlMs };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded).toString("base64url")}`;
}

/** The payload of a genuine, unexpired token, else NULL. Callers must not tell the reasons apart (no oracle). Never throws on garbage. */
export function verifyUnsubscribeToken(token: string, now = Date.now()): UnsubscribePayload | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;
  const expected = sign(encoded);
  const given = Buffer.from(sig, "base64url");
  // The last base64url char of a 32-byte MAC carries only 4 bits, so sibling spellings decode to the same bytes: accept the canonical form only.
  if (given.length !== expected.length || given.toString("base64url") !== sig || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.e <= now) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Base of the real links (`BACKEND_URL`); the mail preview uses the same base so it shows what recipients get. */
export function unsubscribeBaseUrl(): string {
  return (process.env.BACKEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** `https://<BACKEND_URL>/unsubscribe/<token>`: POST = RFC 8058 one-click, GET = confirmation. NULL if the subject cannot unsubscribe. */
export function unsubscribeUrlForSubject(subject: UnsubscribeSubject): string | null {
  const token = createUnsubscribeToken(subject);
  return token ? `${unsubscribeBaseUrl()}/unsubscribe/${token}` : null;
}

/** Wires the token links into `notify` (called by `registerAllJobs`, i.e. by both entry points). */
export function installUnsubscribeProvider(): void {
  secret(); // fail fast at startup (production without UNSUBSCRIBE_SECRET) instead of silently sending mails without links
  setUnsubscribeUrlProvider(unsubscribeUrlForSubject);
}
