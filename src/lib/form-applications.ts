import { createHash } from "node:crypto";

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { clubApplications, type ClubApplicationRow } from "../db/schema/club-applications.js";
import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers, clubMemberStatusHistory, type ClubMemberRow } from "../db/schema/club-members.js";
import { forms, formSubmissionFiles, formSubmissions, formVersions, memberFieldDefinitions, type FormRow, type FormSubmissionRow, type FormVersionRow } from "../db/schema/forms.js";
import { auditLog } from "../db/schema/audit-log.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { accountLinkLockKey, type DbExecutor } from "./club-members.js";
import { checkCustomAssignment, writeValues } from "./custom-fields.js";
import { ConflictError, isUniqueViolation, NotFoundError } from "./errors.js";
import { MASTER_TARGETS, planAcceptance } from "./form-acceptance.js";
import type { FormField } from "./form-schema.js";
import { markMediaDeleted, reassignMediaOwner } from "./media.js";

/**
 * Link between an application (`club_applications`) and its form submission, and the acceptance step (Wave 8 B6).
 *
 * LOCK ORDER of everything that decides, withdraws or merges an application (documented in the README):
 *   submission row  ->  application row  ->  category (share)  ->  club_members row  ->  media_files row  ->  custom field
 *   definitions (share)  ->  member_field_values
 * The per-(user, club) advisory lock `form-submission:<user>:<club>` is taken by submit/apply only, AFTER the submission
 * row (submit) or before any row exists (apply of new answers); a decision never takes it. The account-link merge
 * (Wave 7, `merge_busy`) keeps its own order (club_members rows first) and its 5 s lock timeout; a decision that meets
 * it answers `409 decision_busy` and can simply be repeated.
 */

/** Value of `club_applications.status` after the applicant withdrew (free text like the other statuses). */
export const APPLICATION_WITHDRAWN = "withdrawn";

export const applicationPendingError = (details: { clubId: string; applicationId?: string; submissionId?: string; submittedAt?: Date | null }) =>
  new ConflictError("An application for this club is already pending", { code: "APPLICATION_PENDING", details });

/**
 * The application row of a submitted `aufnahme` submission. `category`/`birth_date` are filled from the mapped answers
 * (only so lists and legacy readers keep working; the answers stay the source of truth). Must run in the transaction
 * that moved the submission to `submitted`.
 */
export async function createApplicationForSubmission(tx: DbExecutor, sub: FormSubmissionRow, fields: readonly FormField[]): Promise<ClubApplicationRow> {
  const plan = planAcceptance(fields, sub.answers);
  try {
    const [row] = await tx
      .insert(clubApplications)
      .values({ userId: sub.submittedByUserId, clubId: sub.clubId, category: plan.categoryKey ?? "aktiv", birthDate: plan.master.birthDate ?? null, formSubmissionId: sub.id, onBehalfOf: sub.onBehalfOf === "guardian" ? "guardian" : "self" })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err)) throw applicationPendingError({ clubId: sub.clubId, submissionId: sub.id });
    throw err;
  }
}

/** The applicant withdrew: the linked pending application is closed (the partial unique index frees up). */
export async function closeApplicationOfSubmission(tx: DbExecutor, submissionId: string): Promise<void> {
  await tx
    .update(clubApplications)
    .set({ status: APPLICATION_WITHDRAWN, decidedAt: new Date() })
    .where(and(eq(clubApplications.formSubmissionId, submissionId), eq(clubApplications.status, "pending")));
}

export interface DecisionContext {
  sub: FormSubmissionRow;
  form: FormRow;
  version: FormVersionRow;
}

/** Cheap pre-flight (no lock) so a withdrawn application does not even create an account membership. */
export async function assertSubmissionDecidable(executor: DbExecutor, application: ClubApplicationRow): Promise<void> {
  if (!application.formSubmissionId) return;
  const [sub] = await executor.select({ status: formSubmissions.status, decidedAt: formSubmissions.decidedAt }).from(formSubmissions).where(eq(formSubmissions.id, application.formSubmissionId)).limit(1);
  if (!sub) throw new NotFoundError("The application form of this application no longer exists");
  assertStatusDecidable(sub);
}

function assertStatusDecidable(sub: Pick<FormSubmissionRow, "status" | "decidedAt">): void {
  if (sub.status === "withdrawn") throw new ConflictError("The applicant withdrew this application", { details: { code: "application_withdrawn" } });
  if (sub.status !== "submitted" || sub.decidedAt !== null) throw new ConflictError("Application has already been decided");
}

/**
 * Locks the submission row of an application (FIRST lock of a decision, see the lock order above) and re-checks it
 * under the lock: a withdraw that won the race is a `409 application_withdrawn`. `null` for a legacy application.
 */
export async function lockDecisionSubmission(tx: DbExecutor, application: ClubApplicationRow): Promise<DecisionContext | null> {
  if (!application.formSubmissionId) return null;
  const [sub] = await tx.select().from(formSubmissions).where(eq(formSubmissions.id, application.formSubmissionId)).for("update");
  if (!sub || sub.clubId !== application.clubId || sub.submittedByUserId !== application.userId) throw new ConflictError("Application has already been decided");
  assertStatusDecidable(sub);
  const [pinned] = await tx.select({ form: forms, version: formVersions }).from(formVersions).innerJoin(forms, eq(forms.id, formVersions.formId)).where(eq(formVersions.id, sub.formVersionId)).limit(1);
  if (!pinned) throw new NotFoundError("The application form of this application no longer exists");
  return { sub, form: pinned.form, version: pinned.version };
}

export interface MappingReport {
  /** Allowlisted targets that were written (`firstName`, `birthDate`, `photo`, ...), plus `customFields: n`. */
  applied: string[];
  customFields: number;
  /** Fields that could not be applied, with a reason; field KEYS only, never values. */
  skipped: Array<{ fieldKey: string; reason: string }>;
}

/**
 * Applies the mapping allowlist of an accepted application to the (already locked) `club_members` row: master data
 * columns, the photo (handed over in the media register, not copied) and custom field values. The category is decided by
 * the caller (the board may override it). The submission becomes `accepted`, the application points at the member.
 * Returns the keys of replaced files to `purgeMediaFile` AFTER the commit.
 */
export async function applyAcceptance(
  tx: DbExecutor,
  input: { clubId: string; context: DecisionContext; clubMemberId: string; decidedBy: string },
): Promise<{ clubMember: ClubMemberRow; mapping: MappingReport; purge: string[] }> {
  const { clubId, context, clubMemberId, decidedBy } = input;
  const { sub, version } = context;
  const plan = planAcceptance(version.fields as FormField[], sub.answers);
  const mapping: MappingReport = { applied: [], customFields: 0, skipped: [...plan.skipped] };
  const purge: string[] = [];

  const [current] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId))).for("update");
  if (!current) throw new ConflictError("The member record changed while the application was being decided; try again", { details: { code: "decision_busy" } });

  const set: Partial<typeof clubMembers.$inferInsert> = {};
  for (const target of MASTER_TARGETS) {
    const value = plan.master[target];
    if (value === undefined) continue;
    set[target] = value;
    mapping.applied.push(target);
  }
  const first = plan.master.firstName ?? null;
  const last = plan.master.lastName ?? null;
  if (first && last) set.displayName = `${first} ${last}`.slice(0, 200);

  if (plan.photoFieldKey) {
    const [file] = await tx
      .select()
      .from(formSubmissionFiles)
      .where(and(eq(formSubmissionFiles.submissionId, sub.id), eq(formSubmissionFiles.fieldKey, plan.photoFieldKey)))
      .limit(1);
    if (file) {
      // The media layer re-owns the registered file; no bytes are copied and no URL is stored.
      const moved = await reassignMediaOwner(tx, { storageKey: file.storageKey, clubId, kind: "image", from: { type: "form_submission", id: sub.id }, to: { type: "club_member", id: clubMemberId } });
      if (moved) {
        await tx.delete(formSubmissionFiles).where(eq(formSubmissionFiles.id, file.id));
        if (current.photoKey && current.photoKey !== file.storageKey && (await markMediaDeleted(current.photoKey, tx, clubId))) purge.push(current.photoKey);
        set.photoKey = file.storageKey;
        mapping.applied.push("photo");
      } else {
        mapping.skipped.push({ fieldKey: plan.photoFieldKey, reason: "photo_unavailable" });
      }
    }
  }

  const [clubMember] = Object.keys(set).length > 0 ? await tx.update(clubMembers).set({ ...set, updatedAt: new Date() }).where(eq(clubMembers.id, clubMemberId)).returning() : [current];

  if (plan.custom.length > 0) {
    // Definitions archived (or deleted) after the form was published are tolerated: the value is skipped, never an error.
    const defs = await tx
      .select()
      .from(memberFieldDefinitions)
      .where(and(eq(memberFieldDefinitions.clubId, clubId), inArray(memberFieldDefinitions.key, [...new Set(plan.custom.map((c) => c.customKey))])))
      .orderBy(memberFieldDefinitions.id)
      .for("share");
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const changes: Array<{ fieldId: string; value: unknown }> = [];
    for (const assignment of plan.custom) {
      const checked = checkCustomAssignment(byKey.get(assignment.customKey), assignment);
      if (!checked.ok) mapping.skipped.push({ fieldKey: assignment.fieldKey, reason: checked.reason });
      else if (checked.value !== undefined) changes.push({ fieldId: byKey.get(assignment.customKey)!.id, value: checked.value });
    }
    await writeValues(tx, clubMemberId, decidedBy, changes);
    mapping.customFields = changes.length;
    if (changes.length > 0) {
      // Same trail as a board write: definition ids only, never values.
      await tx.insert(auditLog).values({ eventType: "member_field.write", subjectId: clubMemberId, payload: { clubId, clubMemberId, fieldIds: changes.map((x) => x.fieldId), changedBy: decidedBy, via: "application" } });
    }
  }

  const now = new Date();
  await tx
    .update(formSubmissions)
    .set({ status: "accepted", decidedAt: now, decidedBy, decisionNote: null, subjectClubMemberId: clubMemberId, updatedAt: now })
    .where(eq(formSubmissions.id, sub.id));

  return { clubMember: clubMember!, mapping, purge };
}

/** The board rejected the application: the submission keeps its answers (record), its files stay for the retention window. */
export async function rejectSubmission(tx: DbExecutor, context: DecisionContext, decidedBy: string, notes: { applicantMessage: string | null; internalNote: string | null }): Promise<void> {
  const now = new Date();
  // `decision_note` is what the applicant sees; the internal note stays with the board.
  await tx.update(formSubmissions).set({ status: "rejected", decidedAt: now, decidedBy, decisionNote: notes.applicantMessage, decisionInternalNote: notes.internalNote, updatedAt: now }).where(eq(formSubmissions.id, context.sub.id));
}

/**
 * Evidence of what the applicant consented to, derived from the PINNED version (ids and a text hash, never answer
 * values): which consent fields were given, in which version, with which text -- and WHO consented and WHEN: the
 * submitter (for a child application the guardian, `onBehalfOf: "guardian"`) at the submission time. Structured so that the
 * consent management of Wave 10 can take it over as is.
 */
export interface ConsentEvidence {
  formVersionId: string;
  consentFieldKeys: string[];
  textSha256: string;
  /** Hash scheme of `textSha256` (see `consentTextSha256`); absent in older audit entries = scheme 1. */
  textHashScheme: number;
  /** User id of the person who gave the consent (the guardian for a child application). */
  consentedBy: string;
  onBehalfOf: string;
  /** ISO time the application was submitted (= when the consent was given); null for a record without it. */
  consentedAt: string | null;
  /** The club member the consent is about (the child), once accepted. */
  subjectClubMemberId?: string;
}

/** Current hash scheme of `textSha256`; entries without `textHashScheme` (written before the marker existed) use scheme 1. */
export const CONSENT_HASH_SCHEME = 2;

/**
 * Scheme 2: SHA-256 over the canonical JSON (`JSON.stringify` of literal-ordered arrays/objects, no whitespace, UTF-8) of
 * `[2, privacyNotice ?? "", blocks]`, `blocks` = every field of the pinned version in field order that is displayed in
 * the consent/privacy area: `["consent", key, label, helpText ?? ""]` for consent fields and
 * `["privacy_notice", key, label, text ?? ""]` for info fields with `infoKind: "privacy_notice"`.
 */
export function consentTextSha256(version: Pick<FormVersionRow, "privacyNotice" | "fields">): string {
  const blocks: string[][] = [];
  for (const f of version.fields as FormField[]) {
    if (f.type === "consent") blocks.push(["consent", f.key, f.label, f.helpText ?? ""]);
    else if (f.type === "info" && f.infoKind === "privacy_notice") blocks.push(["privacy_notice", f.key, f.label, f.text ?? ""]);
  }
  return createHash("sha256").update(JSON.stringify([CONSENT_HASH_SCHEME, version.privacyNotice ?? "", blocks])).digest("hex");
}

/** Scheme 1 (privacy notice + consent labels only); kept to re-verify audit entries that carry no `textHashScheme`. */
export function legacyConsentTextSha256(version: Pick<FormVersionRow, "privacyNotice" | "fields">): string {
  const consents = (version.fields as FormField[]).filter((f) => f.type === "consent");
  return createHash("sha256").update([version.privacyNotice ?? "", ...consents.map((f) => f.label)].join("\n")).digest("hex");
}

export function consentEvidence(context: Pick<DecisionContext, "sub" | "version">, subjectClubMemberId?: string): ConsentEvidence {
  const fields = context.version.fields as FormField[];
  const answers = (context.sub.answers ?? {}) as Record<string, unknown>;
  const consents = fields.filter((f) => f.type === "consent");
  const given = consents.filter((f) => Object.hasOwn(answers, f.key) && answers[f.key] === true).map((f) => f.key);
  return {
    formVersionId: context.version.id,
    consentFieldKeys: given,
    textSha256: consentTextSha256(context.version),
    textHashScheme: CONSENT_HASH_SCHEME,
    consentedBy: context.sub.submittedByUserId,
    onBehalfOf: context.sub.onBehalfOf,
    consentedAt: context.sub.submittedAt?.toISOString() ?? null,
    ...(subjectClubMemberId ? { subjectClubMemberId } : {}),
  };
}

/** Postgres lock timeout / deadlock while deciding (a concurrent account merge): retryable instead of a 500. */
export function asDecisionBusy(err: unknown): unknown {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  if (code === "55P03" || code === "40P01") return new ConflictError("The member record is being changed by someone else; try again in a moment", { details: { code: "decision_busy" } });
  return err;
}

/**
 * Undoes the account membership that an aborted approval created OUTSIDE its transaction -- but only when that is
 * provably still our own, untouched creation: under the (club, account) advisory lock (try-lock: if somebody holds it, e.g.
 * an invitation merge, nothing is deleted), the `club_members` row must still be linked to exactly this membership and have
 * no history beyond its creation (a link or merge entry has a `from_status`). In any other case the rows stay and the
 * caller logs it -- a half-finished approval is recoverable, a deleted merged member is not. Returns whether it removed them.
 */
export async function compensateAbortedApproval(created: { id: string; organizationId: string; userId: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [lock] = (await tx.execute<{ ok: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${accountLinkLockKey(created.organizationId, created.userId)}, 0)) AS ok`)).rows;
    if (!lock?.ok) return false;
    // The account row is locked FOR UPDATE first: a child acceptance that is inserting a guardian link (key-share lock on this
    // row) finishes before we look, and one that comes later waits and then fails on the FK (409 decision_busy). Without this a
    // delete would cascade away a link that another application relies on.
    const [account] = await tx.select({ id: member.id }).from(member).where(eq(member.id, created.id)).for("update");
    if (!account) return false;
    const [{ n: links }] = await tx.select({ n: sql<number>`count(*)::int` }).from(guardianLinks).where(eq(guardianLinks.guardianMemberId, created.id));
    const [{ n: roles }] = await tx.select({ n: sql<number>`count(*)::int` }).from(clubRoles).where(eq(clubRoles.memberId, created.id));
    // A guest that is somebody's guardian, or holds any club role (e.g. from another application), is never removed.
    if (links > 0 || roles > 0) return false;
    const rows = await tx.select().from(clubMembers).where(eq(clubMembers.memberId, created.id)).for("update");
    if (rows.length > 1) return false;
    const row = rows[0];
    if (row) {
      const [touched] = await tx
        .select({ id: clubMemberStatusHistory.id })
        .from(clubMemberStatusHistory)
        .where(and(eq(clubMemberStatusHistory.clubMemberId, row.id), isNotNull(clubMemberStatusHistory.fromStatus)))
        .limit(1);
      if (touched || row.lastUserId !== created.userId) return false;
      // The club_members row goes first: its member_id FK is ON DELETE SET NULL and would leave an account-less ghost behind.
      await tx.delete(clubMembers).where(eq(clubMembers.id, row.id));
    }
    await tx.delete(member).where(eq(member.id, created.id));
    return true;
  });
}
