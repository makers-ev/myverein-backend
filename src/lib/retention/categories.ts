import { and, eq, inArray, isNotNull, isNull, lt, ne, notExists, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { absenceReports } from "../../db/schema/absences.js";
import { auditLog } from "../../db/schema/audit-log.js";
import { clubApplications } from "../../db/schema/club-applications.js";
import { clubRegistrationDocuments, clubRegistrations } from "../../db/schema/club-registrations.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { formSubmissions } from "../../db/schema/forms.js";
import { writeAudit } from "../audit.js";
import { scrubApplicationCopies } from "../form-retention.js";
import { logger } from "../logger.js";
import { markMediaDeleted, purgeMediaFile } from "../media.js";
import { todayBerlin } from "../member-lifecycle.js";
import { ERASED_NAME } from "../privacy/contributors.js";
import { executeErasure } from "../privacy/erasure.js";

/** Rows handled per category and club per run (the job runs daily and is idempotent, a backlog drains over a few days). */
export const BATCH = 200;
/** Batches per run for the platform-wide bulk deletes (audit log). */
const MAX_BULK_BATCHES = 20;

export interface CategoryContext {
  /** NULL for platform categories. */
  clubId: string | null;
  days: number;
  now: Date;
  /** Count only, change nothing. */
  dryRun: boolean;
}

export interface CategoryResult {
  scanned: number;
  affected: number;
}

const cutoffDate = (ctx: CategoryContext): string => todayBerlin(new Date(ctx.now.getTime() - ctx.days * 86_400_000));
const cutoffTime = (ctx: CategoryContext): Date => new Date(ctx.now.getTime() - ctx.days * 86_400_000);

/** A member under legal hold keeps everything: no retention category may touch their data. */
const heldMember = (memberId: ReturnType<typeof sql>) => sql`EXISTS (SELECT 1 FROM club_members hm WHERE hm.id = ${memberId} AND hm.legal_hold_at IS NOT NULL)`;

// --- registration proofs (platform) -------------------------------------------------------------------------------------------

/**
 * Proof documents of founding applications (object storage `registrations/<id>/` + `club_registration_documents`), by outcome:
 * approved / rejected (counted from the decision) and never submitted (draft or "needs info", counted from the last change).
 * The application row and its master data stay (they are the club's founding record); only the evidence goes.
 */
function registrationProofs(kind: "approved" | "rejected" | "stale") {
  return async (ctx: CategoryContext): Promise<CategoryResult> => {
    const cutoff = cutoffTime(ctx);
    const condition =
      kind === "stale"
        ? and(inArray(clubRegistrations.status, ["draft", "needs_info"]), lt(clubRegistrations.updatedAt, cutoff))
        : and(eq(clubRegistrations.status, kind), isNotNull(clubRegistrations.reviewedAt), lt(clubRegistrations.reviewedAt, cutoff));
    const base = db.select({ id: clubRegistrationDocuments.id, storageKey: clubRegistrationDocuments.storageKey }).from(clubRegistrationDocuments).innerJoin(clubRegistrations, eq(clubRegistrations.id, clubRegistrationDocuments.registrationId)).where(condition);
    if (ctx.dryRun) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(clubRegistrationDocuments).innerJoin(clubRegistrations, eq(clubRegistrations.id, clubRegistrationDocuments.registrationId)).where(condition);
      return { scanned: row?.n ?? 0, affected: 0 };
    }
    const docs = await base.limit(BATCH);
    let affected = 0;
    for (const doc of docs) {
      // The key comes from our own row; also pre-registry documents without a media row are purged (as the delete route does).
      await db.transaction(async (tx) => {
        await tx.delete(clubRegistrationDocuments).where(eq(clubRegistrationDocuments.id, doc.id));
        await markMediaDeleted(doc.storageKey, tx);
      });
      await purgeMediaFile(doc.storageKey);
      affected += 1;
    }
    return { scanned: docs.length, affected };
  };
}

// --- audit log (platform) -----------------------------------------------------------------------------------------------------

function auditRows(auth: boolean) {
  return async (ctx: CategoryContext): Promise<CategoryResult> => {
    const cutoff = cutoffTime(ctx);
    const condition = auth ? and(eq(auditLog.eventType, "session.create"), lt(auditLog.createdAt, cutoff)) : and(ne(auditLog.eventType, "session.create"), lt(auditLog.createdAt, cutoff));
    if (ctx.dryRun) {
      const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(condition);
      return { scanned: row?.n ?? 0, affected: 0 };
    }
    let affected = 0;
    for (let i = 0; i < MAX_BULK_BATCHES; i += 1) {
      const result = await db.execute(sql`
        DELETE FROM audit_log WHERE id IN (
          SELECT id FROM audit_log
          WHERE created_at < ${cutoff} AND (event_type = 'session.create') = ${auth}
          LIMIT ${BATCH * 5})`);
      const n = result.rowCount ?? 0;
      affected += n;
      if (n < BATCH * 5) break;
    }
    return { scanned: affected, affected };
  };
}

// --- club categories ------------------------------------------------------------------------------------------------------------

/**
 * Rejected and withdrawn applications of adults: answers, decision notes and the list copies (birth date, category) are erased
 * `days` after the decision; id, status and timestamps stay as the record that an application existed. Applications for children
 * keep their shorter, existing schedule (`lib/form-sweeper.ts`, `FORM_REJECTED_FILE_TTL_DAYS`).
 */
export async function applicationsRejected(ctx: CategoryContext): Promise<CategoryResult> {
  const clubId = ctx.clubId!;
  const cutoff = cutoffTime(ctx);
  const due = and(
    eq(clubApplications.clubId, clubId),
    eq(formSubmissions.onBehalfOf, "self"),
    sql`NOT ${heldMember(sql`${clubApplications.clubMemberId}`)} AND NOT ${heldMember(sql`${formSubmissions.subjectClubMemberId}`)}`,
    sql`(${clubApplications.status} = 'rejected' AND ${clubApplications.decidedAt} < ${cutoff}) OR (${formSubmissions.status} = 'withdrawn' AND ${formSubmissions.updatedAt} < ${cutoff})`,
  );
  const withAnswers = and(due, sql`${formSubmissions.answers} <> '{}'::jsonb`);
  const rows = await db.select({ id: formSubmissions.id }).from(clubApplications).innerJoin(formSubmissions, eq(formSubmissions.id, clubApplications.formSubmissionId)).where(withAnswers).limit(ctx.dryRun ? 100_000 : BATCH);
  // Legacy applications (no form) only keep the copies.
  const legacy = await db
    .select({ id: clubApplications.id })
    .from(clubApplications)
    .where(and(eq(clubApplications.clubId, clubId), eq(clubApplications.status, "rejected"), lt(clubApplications.decidedAt, cutoff), sql`NOT ${heldMember(sql`${clubApplications.clubMemberId}`)}`, notExists(db.select({ one: sql`1` }).from(formSubmissions).where(eq(formSubmissions.id, clubApplications.formSubmissionId))), isNotNull(clubApplications.birthDate)))
    .limit(ctx.dryRun ? 100_000 : BATCH);
  if (ctx.dryRun) return { scanned: rows.length + legacy.length, affected: 0 };
  let affected = 0;
  for (const { id } of rows) {
    await db.transaction(async (tx) => {
      await tx.update(formSubmissions).set({ answers: {}, decisionNote: null, decisionInternalNote: null, updatedAt: new Date() }).where(eq(formSubmissions.id, id));
      await scrubApplicationCopies(tx, eq(clubApplications.formSubmissionId, id));
      await writeAudit(tx, { eventType: "form_submission.answers_erased", subjectId: id, clubId, actorUserId: null, payload: { clubId, reason: "retention" } });
    });
    affected += 1;
  }
  for (const { id } of legacy) {
    await scrubApplicationCopies(db, eq(clubApplications.id, id));
    affected += 1;
  }
  return { scanned: rows.length + legacy.length, affected };
}

/** Erases members through the normal erasure process; a member that is blocked (legal hold, open loans, ...) is skipped and tried again tomorrow. */
async function eraseMembers(ctx: CategoryContext, ids: string[]): Promise<CategoryResult> {
  if (ctx.dryRun) return { scanned: ids.length, affected: 0 };
  let affected = 0;
  for (const id of ids) {
    try {
      await executeErasure({ clubId: ctx.clubId!, clubMemberId: id, actorUserId: null, via: "retention" });
      affected += 1;
    } catch (err) {
      // Blockers are expected (409); anything else is logged without data and the loop goes on.
      if ((err as { status?: number }).status !== 409) logger.error({ errName: (err as Error)?.name, clubId: ctx.clubId }, "[retention] could not erase a member");
    }
  }
  return { scanned: ids.length, affected };
}

/** People who showed interest but never joined (no account, no open application), untouched for `days`. */
export async function interestedWithoutJoin(ctx: CategoryContext): Promise<CategoryResult> {
  const rows = await db
    .select({ id: clubMembers.id })
    .from(clubMembers)
    .where(
      and(
        eq(clubMembers.clubId, ctx.clubId!),
        eq(clubMembers.status, "interessent"),
        sql`${clubMembers.memberId} IS NULL`,
        sql`${clubMembers.displayName} <> ${ERASED_NAME}`,
        lt(clubMembers.updatedAt, cutoffTime(ctx)),
        notExists(db.select({ one: sql`1` }).from(clubApplications).where(and(eq(clubApplications.clubMemberId, clubMembers.id), eq(clubApplications.status, "pending")))),
      ),
    )
    .limit(ctx.dryRun ? 100_000 : BATCH);
  return eraseMembers(ctx, rows.map((r) => r.id));
}

/** Former members: anonymised `days` after the end of the membership. */
export async function formerMembers(ctx: CategoryContext): Promise<CategoryResult> {
  const rows = await db
    .select({ id: clubMembers.id })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, ctx.clubId!), isNotNull(clubMembers.leftAt), lt(clubMembers.leftAt, cutoffDate(ctx)), sql`${clubMembers.displayName} <> ${ERASED_NAME}`, sql`${clubMembers.status} IN ('ausgetreten', 'ausgeschlossen', 'verstorben')`))
    .limit(ctx.dryRun ? 100_000 : BATCH);
  return eraseMembers(ctx, rows.map((r) => r.id));
}

/** The emergency contact of somebody who left is not needed any more after a short while. */
export async function emergencyContactsLeft(ctx: CategoryContext): Promise<CategoryResult> {
  const where = and(
    eq(clubMembers.clubId, ctx.clubId!),
    isNotNull(clubMembers.leftAt),
    isNull(clubMembers.legalHoldAt),
    lt(clubMembers.leftAt, cutoffDate(ctx)),
    sql`${clubMembers.status} IN ('ausgetreten', 'ausgeschlossen', 'verstorben')`,
    sql`(${clubMembers.emergencyContactName} IS NOT NULL OR ${clubMembers.emergencyContactPhone} IS NOT NULL)`,
  );
  if (ctx.dryRun) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(clubMembers).where(where);
    return { scanned: row?.n ?? 0, affected: 0 };
  }
  const ids = await db.select({ id: clubMembers.id }).from(clubMembers).where(where).limit(BATCH);
  if (ids.length > 0) await db.update(clubMembers).set({ emergencyContactName: null, emergencyContactPhone: null, updatedAt: new Date() }).where(inArray(clubMembers.id, ids.map((r) => r.id)));
  return { scanned: ids.length, affected: ids.length };
}

/** Absence reports `days` after the absence ended. */
export async function absenceReportsOld(ctx: CategoryContext): Promise<CategoryResult> {
  const where = and(eq(absenceReports.clubId, ctx.clubId!), lt(absenceReports.endsOn, cutoffDate(ctx)), sql`NOT ${heldMember(sql`${absenceReports.clubMemberId}`)}`);
  if (ctx.dryRun) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(absenceReports).where(where);
    return { scanned: row?.n ?? 0, affected: 0 };
  }
  const ids = await db.select({ id: absenceReports.id }).from(absenceReports).where(where).limit(BATCH);
  if (ids.length > 0) await db.delete(absenceReports).where(inArray(absenceReports.id, ids.map((r) => r.id)));
  return { scanned: ids.length, affected: ids.length };
}

/**
 * Consent proofs: all events of a member + purpose once the LATEST one is a revocation older than `days`, and all events of
 * members whose membership ended more than `days` ago. (A purpose that is `requested` asks again afterwards: no record = open.)
 */
export async function consentProofs(ctx: CategoryContext): Promise<CategoryResult> {
  const cutoff = cutoffTime(ctx);
  const cutoffD = cutoffDate(ctx);
  const dueIds = sql`
    SELECT r.id FROM consent_records r
    WHERE r.club_id = ${ctx.clubId}
      AND NOT ${heldMember(sql`r.club_member_id`)}
      AND (
        EXISTS (SELECT 1 FROM club_members m WHERE m.id = r.club_member_id AND m.left_at IS NOT NULL AND m.left_at < ${cutoffD})
        OR EXISTS (
          SELECT 1 FROM consent_records l
          WHERE l.club_member_id = r.club_member_id AND l.purpose_id = r.purpose_id AND l.action = 'revoked' AND l.created_at < ${cutoff}
            AND NOT EXISTS (SELECT 1 FROM consent_records n WHERE n.club_member_id = l.club_member_id AND n.purpose_id = l.purpose_id AND n.created_at > l.created_at)
        )
      )`;
  if (ctx.dryRun) {
    const result = await db.execute(sql`SELECT count(*)::int AS n FROM (${dueIds}) due`);
    return { scanned: Number((result.rows[0] as { n: number } | undefined)?.n ?? 0), affected: 0 };
  }
  const result = await db.execute(sql`DELETE FROM consent_records WHERE id IN (${dueIds} LIMIT ${BATCH})`);
  const n = result.rowCount ?? 0;
  return { scanned: n, affected: n };
}

export const categoryRunners = {
  registration_proofs_approved: registrationProofs("approved"),
  registration_proofs_rejected: registrationProofs("rejected"),
  registration_proofs_stale: registrationProofs("stale"),
  audit_log_auth: auditRows(true),
  audit_log: auditRows(false),
  applications_rejected: applicationsRejected,
  interested_without_join: interestedWithoutJoin,
  former_members: formerMembers,
  emergency_contacts_left: emergencyContactsLeft,
  absence_reports: absenceReportsOld,
  consent_proofs: consentProofs,
} as const satisfies Record<string, (ctx: CategoryContext) => Promise<CategoryResult>>;
