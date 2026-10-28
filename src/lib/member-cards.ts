import { createHmac, timingSafeEqual } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMembers, memberCategories, type ClubMemberRow } from "../db/schema/club-members.js";
import { memberCards, type MemberCardRow } from "../db/schema/documents.js";
import { consentPurposes, consentRecords } from "../db/schema/privacy.js";
import type { DbExecutor } from "./club-members.js";
import { PHOTO_PURPOSE_KEY } from "./consent.js";
import { logger } from "./logger.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Digital membership card (Wave 13 B12/B13).
 *
 * The QR code holds ONE signed opaque token and nothing else: no name, no number, no link to a file. The card (row in
 * `member_cards`) is looked up by the opaque id; whether it is valid is derived LIVE from the member (status, exit date,
 * revocation), never read from the token. A re-issue bumps `token_version`, which makes every earlier token worthless.
 *
 * Token: `mc1.<card id, 16 bytes base64url>.<token version>.<expiry, unix seconds, base36>.<signature>`, the signature being
 * the first 16 bytes of HMAC-SHA256 over `member-card:v1:<id>:<version>:<expiry>` (128 bits: not guessable, constant-time
 * compared). The expiry bounds how long a leaked token can be replayed at all; the app fetches a fresh token whenever it has network.
 */

export const CARD_TOKEN_PREFIX = "mc1";
/** Lifetime of a freshly signed token; the card itself may end earlier (`valid_until`, exit, revocation). */
export const CARD_TOKEN_TTL_DAYS = 400;

let warned = false;

/** `MEMBER_CARD_SECRET`; falls back to `BETTER_AUTH_SECRET` (domain-separated HMAC), with a warning in production. */
function secret(): string {
  const dedicated = process.env.MEMBER_CARD_SECRET;
  if (dedicated) return dedicated;
  const fallback = process.env.BETTER_AUTH_SECRET;
  if (!fallback) throw new Error("MEMBER_CARD_SECRET or BETTER_AUTH_SECRET must be set to sign membership cards");
  if (process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    logger.warn("[member-cards] MEMBER_CARD_SECRET is not set, membership cards are signed with BETTER_AUTH_SECRET; set a dedicated key (changing it invalidates all issued cards)");
  }
  return fallback;
}

/** Fail fast at startup if no key at all is available. */
export function assertCardSecret(): void {
  secret();
}

const sign = (cardId: string, version: number, exp: number): Buffer => createHmac("sha256", secret()).update(`member-card:v1:${cardId}:${version}:${exp}`).digest().subarray(0, 16);

const uuidToB64 = (uuid: string): string => Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
function b64ToUuid(value: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(value)) return null;
  const hex = Buffer.from(value, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function signCardToken(card: Pick<MemberCardRow, "id" | "tokenVersion" | "validUntil">, now: Date = new Date()): { token: string; expiresAt: Date } {
  let expMs = now.getTime() + CARD_TOKEN_TTL_DAYS * 86_400_000;
  // A card with an end date never gets a token that outlives it (the end of that day, UTC; the live check decides the exact day).
  if (card.validUntil) expMs = Math.min(expMs, Date.parse(`${card.validUntil}T23:59:59Z`) + 86_400_000);
  const exp = Math.floor(expMs / 1000);
  const token = `${CARD_TOKEN_PREFIX}.${uuidToB64(card.id)}.${card.tokenVersion}.${exp.toString(36)}.${sign(card.id, card.tokenVersion, exp).toString("base64url")}`;
  return { token, expiresAt: new Date(exp * 1000) };
}

export interface ParsedCardToken {
  cardId: string;
  version: number;
  expiresAt: Date;
}

/** `null` for anything that is not a well-formed token with a correct signature. Never throws; the expiry is checked by the caller. */
export function parseCardToken(raw: unknown): ParsedCardToken | null {
  if (typeof raw !== "string" || raw.length > 120) return null;
  const parts = raw.trim().split(".");
  if (parts.length !== 5 || parts[0] !== CARD_TOKEN_PREFIX) return null;
  const [, idPart, versionPart, expPart, sigPart] = parts as [string, string, string, string, string];
  const cardId = b64ToUuid(idPart);
  if (!cardId || !/^[1-9][0-9]{0,8}$/.test(versionPart) || !/^[0-9a-z]{1,10}$/.test(expPart) || !/^[A-Za-z0-9_-]{22}$/.test(sigPart)) return null;
  const version = Number(versionPart);
  const exp = parseInt(expPart, 36);
  if (!Number.isSafeInteger(exp)) return null;
  const given = Buffer.from(sigPart, "base64url");
  const expected = sign(cardId, version, exp);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return { cardId, version, expiresAt: new Date(exp * 1000) };
}

export type CardState = "gueltig" | "abgelaufen" | "ausgetreten" | "ungueltig";

/**
 * The live state of a card. `ausgetreten` for every kind of leaving (exit, exclusion, death: the checker does not need to know
 * which), `abgelaufen` after `valid_until`, `ungueltig` for a card that was revoked for another reason, a person who is not
 * (yet) a full member (interessent) or whose membership rests. `hint` helps the board, never the checker of a foreign card.
 */
export function cardState(card: Pick<MemberCardRow, "status" | "revokedReason" | "validUntil">, person: Pick<ClubMemberRow, "status" | "leftAt">, today: string = todayBerlin()): { state: CardState; hint: string | null } {
  const status = effectiveStatus(person, today);
  if (isLeftStatus(status)) return { state: "ausgetreten", hint: null };
  if (card.status === "widerrufen") return card.revokedReason === "austritt" ? { state: "ausgetreten", hint: null } : { state: "ungueltig", hint: "widerrufen" };
  if (status !== "aktiv" && status !== "probe") return { state: "ungueltig", hint: status === "ruhend" ? "ruhend" : "keine_mitgliedschaft" };
  if (card.validUntil !== null && card.validUntil < today) return { state: "abgelaufen", hint: null };
  return { state: "gueltig", hint: null };
}

export async function findCardOf(clubMemberId: string, executor: DbExecutor = db): Promise<MemberCardRow | null> {
  const [row] = await executor.select().from(memberCards).where(eq(memberCards.clubMemberId, clubMemberId)).limit(1);
  return row ?? null;
}

/** Issues the card of a member if there is none (idempotent: the unique key wins a race). */
export async function ensureCard(executor: DbExecutor, clubId: string, clubMemberId: string, issuedBy: string | null, validUntil: string | null = null): Promise<MemberCardRow> {
  await executor.insert(memberCards).values({ clubId, clubMemberId, issuedBy, validUntil }).onConflictDoNothing();
  const card = await findCardOf(clubMemberId, executor);
  return card!;
}

/** New token version, active again: every earlier token (and QR on paper) stops working. */
export async function reissueCard(executor: DbExecutor, card: MemberCardRow, issuedBy: string | null, validUntil: string | null | undefined): Promise<MemberCardRow> {
  const [row] = await executor
    .update(memberCards)
    .set({ tokenVersion: card.tokenVersion + 1, status: "aktiv", revokedAt: null, revokedReason: null, issuedAt: new Date(), issuedBy, ...(validUntil !== undefined ? { validUntil } : {}) })
    .where(eq(memberCards.id, card.id))
    .returning();
  return row!;
}

export async function revokeCard(executor: DbExecutor, clubMemberId: string, reason: "austritt" | "manuell"): Promise<boolean> {
  const rows = await executor.update(memberCards).set({ status: "widerrufen", revokedAt: new Date(), revokedReason: reason }).where(and(eq(memberCards.clubMemberId, clubMemberId), eq(memberCards.status, "aktiv"))).returning({ id: memberCards.id });
  return rows.length > 0;
}

/** Called by the lifecycle inside its transaction: leaving revokes the card, coming back re-issues it (new token version). */
export async function syncCardWithStatus(tx: DbExecutor, clubMemberId: string, change: { wasLeft: boolean; nowLeft: boolean }): Promise<void> {
  if (change.nowLeft && !change.wasLeft) await revokeCard(tx, clubMemberId, "austritt");
  else if (change.wasLeft && !change.nowLeft) {
    const card = await findCardOf(clubMemberId, tx);
    if (card && card.status === "widerrufen" && card.revokedReason === "austritt") await reissueCard(tx, card, null, undefined);
  }
}

/** The person agreed to the profile photo being used for the card (purpose `profilfoto_ausweis`, latest event = granted). */
export async function photoConsentGranted(clubId: string, clubMemberId: string, executor: DbExecutor = db): Promise<boolean> {
  const [latest] = await executor
    .select({ action: consentRecords.action })
    .from(consentRecords)
    .innerJoin(consentPurposes, eq(consentPurposes.id, consentRecords.purposeId))
    .where(and(eq(consentRecords.clubMemberId, clubMemberId), eq(consentPurposes.clubId, clubId), eq(consentPurposes.key, PHOTO_PURPOSE_KEY)))
    .orderBy(desc(consentRecords.createdAt), desc(consentRecords.id))
    .limit(1);
  return latest?.action === "granted";
}

export async function categoryNameOf(categoryId: string | null, executor: DbExecutor = db): Promise<string | null> {
  if (!categoryId) return null;
  const [row] = await executor.select({ name: memberCategories.name }).from(memberCategories).where(eq(memberCategories.id, categoryId)).limit(1);
  return row?.name ?? null;
}

export const initialsOf = (displayName: string): string =>
  displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => Array.from(p)[0] ?? "")
    .join("")
    .toUpperCase();

export async function loadMemberRow(clubId: string, clubMemberId: string, executor: DbExecutor = db): Promise<ClubMemberRow | null> {
  const [row] = await executor.select().from(clubMembers).where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId))).limit(1);
  return row ?? null;
}
