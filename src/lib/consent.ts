import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { consentPurposes, consentRecords, consentTexts, type ConsentAction, type ConsentGivenBy, type ConsentPurposeRow, type ConsentRecordRow, type ConsentTextRow } from "../db/schema/privacy.js";
import { writeAudit } from "./audit.js";
import { isUuid, type DbExecutor } from "./club-members.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";
import { ageOn, todayBerlin } from "./member-lifecycle.js";
import { removeMemberPhoto } from "./member-photos.js";

/**
 * Consent service (Wave 10 B3) -- the ONE place that records consent events. The consent route, the guardian route and the
 * form builder's consent block (`applyAcceptance`) all call `recordConsent`.
 *
 * A consent is ALWAYS voluntary (Art. 7(4) GDPR): nothing in the product ever checks a consent to grant or deny access,
 * membership or a feature. `requested` on a purpose only feeds the "open" list and reminders.
 *
 * Current state of a member + purpose = the LATEST `consent_records` event; the table is append-only.
 */

/** Purpose key whose revocation removes the profile photo (and its media registry row). */
export const PHOTO_PURPOSE_KEY = "profilfoto_ausweis";
export const PROOF_SOURCE_MAX = 200;

export type ConsentState = "granted" | "revoked" | "none";

/** Age from which somebody consents alone: the purpose's own `min_age`, else the club's `consent_age_limit` (default 18). */
export async function consentAgeLimitOf(clubId: string, purpose: Pick<ConsentPurposeRow, "minAge">, executor: DbExecutor = db): Promise<number> {
  if (purpose.minAge !== null) return purpose.minAge;
  const [row] = await executor.select({ limit: clubSettings.consentAgeLimit }).from(clubSettings).where(eq(clubSettings.clubId, clubId));
  return row?.limit ?? 18;
}

/** Unknown birth date counts as adult (cannot be decided), like `isMinor` of the photo rules. */
export function isUnderConsentAge(birthDate: string | null, limit: number, today = todayBerlin()): boolean {
  return birthDate !== null && ageOn(birthDate, today) < limit;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Newest published text of each purpose, keyed by purpose id. */
export async function currentTexts(purposeIds: string[], executor: DbExecutor = db): Promise<Map<string, ConsentTextRow>> {
  const out = new Map<string, ConsentTextRow>();
  if (purposeIds.length === 0) return out;
  const rows = await executor
    .select()
    .from(consentTexts)
    .where(and(inArray(consentTexts.purposeId, purposeIds), isNotNull(consentTexts.publishedAt)))
    .orderBy(desc(consentTexts.version));
  for (const row of rows) if (!out.has(row.purposeId)) out.set(row.purposeId, row);
  return out;
}

/** Latest event per purpose of one member (purposes without any event are absent). */
export async function latestRecords(clubMemberId: string, executor: DbExecutor = db): Promise<Map<string, ConsentRecordRow>> {
  const rows = await executor
    .selectDistinctOn([consentRecords.purposeId])
    .from(consentRecords)
    .where(eq(consentRecords.clubMemberId, clubMemberId))
    .orderBy(consentRecords.purposeId, desc(consentRecords.createdAt), desc(consentRecords.id));
  return new Map(rows.map((r) => [r.purposeId, r]));
}

/** Purposes a member can be asked about: active, not archived, with a published text. */
export async function askablePurposes(clubId: string, executor: DbExecutor = db): Promise<Array<{ purpose: ConsentPurposeRow; text: ConsentTextRow }>> {
  const purposes = await executor
    .select()
    .from(consentPurposes)
    .where(and(eq(consentPurposes.clubId, clubId), eq(consentPurposes.active, true), isNull(consentPurposes.archivedAt)))
    .orderBy(asc(consentPurposes.sortOrder), asc(consentPurposes.name));
  const texts = await currentTexts(purposes.map((p) => p.id), executor);
  return purposes.flatMap((purpose) => {
    const text = texts.get(purpose.id);
    return text ? [{ purpose, text }] : [];
  });
}

export interface MemberConsentView {
  purposeId: string;
  key: string;
  name: string;
  description: string | null;
  requested: boolean;
  state: ConsentState;
  /** `requested` and no decision yet: appears in the "open" list. Granting is voluntary, declining has no consequence. */
  open: boolean;
  text: { id: string; version: number; body: string };
  /** The text version the latest event refers to (null without an event). */
  recordedTextVersion: number | null;
  /** The person decided against an older text: the member may be asked again, but nothing is blocked. */
  outdated: boolean;
  givenBy: ConsentGivenBy | null;
  decidedAt: Date | null;
  /**
   * Wave 10 B6: a consent a guardian (or the board on paper) gave while the person was a minor asks the now adult person to
   * confirm it. Information only: the consent stays as it is until the person grants again or revokes; nothing is blocked.
   */
  confirmation: { pending: boolean; due: string | null; overdue: boolean };
}

/** Days after the 18th birthday in which the person is asked to confirm (see `lib/majority.ts`). */
export const CONFIRM_DAYS = 90;

/** Current state of every askable purpose for one member, in the order of the purposes. */
export async function memberConsentViews(clubId: string, clubMemberId: string, executor: DbExecutor = db): Promise<MemberConsentView[]> {
  const [askable, latest] = await Promise.all([askablePurposes(clubId, executor), latestRecords(clubMemberId, executor)]);
  const [person] = await executor.select({ birthDate: clubMembers.birthDate }).from(clubMembers).where(eq(clubMembers.id, clubMemberId));
  const clubLimit = await consentAgeLimitOf(clubId, { minAge: null }, executor);
  const today = todayBerlin();
  const versionIds = [...latest.values()].map((r) => r.textVersionId);
  const versions = versionIds.length > 0 ? await executor.select({ id: consentTexts.id, version: consentTexts.version }).from(consentTexts).where(inArray(consentTexts.id, versionIds)) : [];
  const versionOf = new Map(versions.map((v) => [v.id, v.version]));
  return askable.map(({ purpose, text }) => {
    const record = latest.get(purpose.id);
    const state: ConsentState = record ? (record.action === "granted" ? "granted" : "revoked") : "none";
    return {
      purposeId: purpose.id,
      key: purpose.key,
      name: purpose.name,
      description: purpose.description,
      requested: purpose.requested,
      state,
      open: purpose.requested && state === "none",
      text: { id: text.id, version: text.version, body: text.body },
      recordedTextVersion: record ? (versionOf.get(record.textVersionId) ?? null) : null,
      outdated: record !== undefined && record.textVersionId !== text.id,
      givenBy: (record?.givenBy as ConsentGivenBy | undefined) ?? null,
      decidedAt: record?.createdAt ?? null,
      confirmation: confirmationOf(record, person?.birthDate ?? null, purpose.minAge ?? clubLimit, today),
    };
  });
}

/** "Confirmation pending" of a granted consent that somebody else gave while the person was a minor (derived at read time). */
export function confirmationOf(record: Pick<ConsentRecordRow, "action" | "givenBy" | "createdAt"> | undefined, birthDate: string | null, limit: number, today: string): MemberConsentView["confirmation"] {
  const none = { pending: false, due: null, overdue: false };
  if (!record || record.action !== "granted" || record.givenBy === "self" || birthDate === null) return none;
  const wasMinor = ageOn(birthDate, todayBerlin(record.createdAt)) < limit;
  if (!wasMinor || ageOn(birthDate, today) < limit) return none;
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  const leap = (y + limit) % 4 === 0 && ((y + limit) % 100 !== 0 || (y + limit) % 400 === 0);
  const birthday = m === 2 && d === 29 && !leap ? `${y + limit}-03-01` : `${y + limit}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const due = new Date(`${birthday}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + CONFIRM_DAYS);
  const dueDay = due.toISOString().slice(0, 10);
  return { pending: true, due: dueDay, overdue: dueDay < today };
}

export interface RecordConsentInput {
  clubId: string;
  clubMemberId: string;
  purposeId: string;
  action: ConsentAction;
  givenBy: ConsentGivenBy;
  recordedByUserId: string | null;
  /** Grant: the text version the person saw; must be the currently published one (409 otherwise). Omitted: the current one (form builder). */
  textVersionId?: string;
  /** Paper proof of the board: date and source are mandatory for `board_paper`. */
  proofDate?: string | null;
  proofSource?: string | null;
  /** Where the event came from, for the audit trail. */
  via: "member" | "guardian" | "board" | "application";
  /** When the person decided (the submission time of an application); default now. */
  at?: Date;
}

export interface RecordConsentResult {
  record: ConsentRecordRow;
  /** False for an idempotent repeat: nothing new was written. */
  changed: boolean;
  purpose: ConsentPurposeRow;
}

/**
 * Appends a consent event inside `tx`. Rules: the purpose must belong to the club and be askable (active, published
 * text); a grant refers to the currently published text version (409 `consent_text_outdated`); a revoke is allowed any
 * time (it refers to the version of the last event, else the current one); repeating the current state writes nothing.
 * Who may record for whom is decided by the callers.
 */
export async function recordConsent(tx: DbExecutor, input: RecordConsentInput): Promise<RecordConsentResult> {
  const [purpose] = await tx.select().from(consentPurposes).where(and(eq(consentPurposes.id, input.purposeId), eq(consentPurposes.clubId, input.clubId)));
  if (!purpose || purpose.archivedAt !== null) throw new NotFoundError("Consent purpose not found");
  if (input.givenBy === "board_paper" && (!input.proofDate || !input.proofSource?.trim())) {
    throw new ValidationError("A paper proof needs the date and the source", { details: { code: "proof_required" } });
  }
  // Serialise parallel events of the same member + purpose so "latest wins" and the idempotency check cannot race.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`consent:${input.clubMemberId}:${input.purposeId}`}, 0))`);

  const current = (await currentTexts([purpose.id], tx)).get(purpose.id);
  const [last] = await tx
    .select()
    .from(consentRecords)
    .where(and(eq(consentRecords.clubMemberId, input.clubMemberId), eq(consentRecords.purposeId, purpose.id)))
    .orderBy(desc(consentRecords.createdAt), desc(consentRecords.id))
    .limit(1);

  let textVersionId: string;
  if (input.action === "granted") {
    if (!purpose.active || !current) throw new ConflictError("This consent has no published text", { details: { code: "consent_not_available" } });
    if (input.textVersionId !== undefined && input.textVersionId !== current.id) {
      throw new ConflictError("The consent text changed; show the current text and ask again", { details: { code: "consent_text_outdated", currentTextVersionId: current.id } });
    }
    textVersionId = current.id;
    // Repeating the current grant writes nothing -- except the person confirming what somebody else gave for them (B6).
    const confirms = input.givenBy === "self" && last?.givenBy !== "self";
    if (last?.action === "granted" && last.textVersionId === textVersionId && !confirms) return { record: last, changed: false, purpose };
  } else {
    const fallback = last?.textVersionId ?? current?.id;
    if (!fallback) throw new ConflictError("This consent has no published text", { details: { code: "consent_not_available" } });
    textVersionId = fallback;
    if (last?.action === "revoked") return { record: last, changed: false, purpose };
  }

  const [record] = await tx
    .insert(consentRecords)
    .values({
      clubId: input.clubId,
      clubMemberId: input.clubMemberId,
      purposeId: purpose.id,
      textVersionId,
      action: input.action,
      givenBy: input.givenBy,
      recordedByUserId: input.recordedByUserId,
      proofDate: input.givenBy === "board_paper" ? input.proofDate! : null,
      proofSource: input.givenBy === "board_paper" ? input.proofSource!.trim().slice(0, PROOF_SOURCE_MAX) : null,
      // Dated with the decision, but never before the member's newest event (latest wins).
      ...(input.at && (!last || input.at > last.createdAt) ? { createdAt: input.at } : {}),
    })
    .returning();
  await writeAudit(tx, {
    eventType: input.action === "granted" ? "consent.grant" : "consent.revoke",
    subjectId: input.clubMemberId,
    payload: { clubId: input.clubId, clubMemberId: input.clubMemberId, purposeId: purpose.id, textVersionId, givenBy: input.givenBy, via: input.via },
  });
  return { record: record!, changed: true, purpose };
}

/**
 * Side effect of a revoked consent, run AFTER the commit: `profilfoto_ausweis` removes the profile photo through the media
 * layer (file AND `media_files` row, so an old signed URL stops working). Safe to repeat; never throws into the caller.
 */
export async function afterConsentRevoked(purpose: Pick<ConsentPurposeRow, "key">, member: ClubMemberRow, changedBy: string): Promise<void> {
  if (purpose.key !== PHOTO_PURPOSE_KEY) return;
  try {
    await removeMemberPhoto({ row: member, changedBy });
  } catch (err) {
    logger.error({ err, clubMemberId: member.id }, "[consent] could not remove the profile photo after the revocation");
  }
}

/** Club member of a club, 404 otherwise (club scoping of every consent route). */
export async function clubMemberOf(clubId: string, clubMemberId: string, executor: DbExecutor = db): Promise<ClubMemberRow> {
  if (!isUuid(clubMemberId)) throw new NotFoundError("Member not found");
  const [row] = await executor.select().from(clubMembers).where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId)));
  if (!row) throw new NotFoundError("Member not found");
  return row;
}
