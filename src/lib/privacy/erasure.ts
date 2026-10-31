import { createHash } from "node:crypto";

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { member, session } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { clubApplications } from "../../db/schema/club-applications.js";
import { clubExitRequests } from "../../db/schema/club-exit-requests.js";
import { clubMembers, type ClubMemberRow } from "../../db/schema/club-members.js";
import { clubRoles } from "../../db/schema/club-roles.js";
import { formSubmissions } from "../../db/schema/forms.js";
import { inventoryLoans } from "../../db/schema/inventory.js";
import { writeAudit } from "../audit.js";
import { BOARD_ROLE_TYPES } from "../club-permissions.js";
import type { DbExecutor } from "../club-members.js";
import { ConflictError } from "../errors.js";
import { sweepStaleFormDrafts } from "../form-sweeper.js";
import { recordKeyReturnsForRemovedAccount } from "../key-returns.js";
import { purgeMediaFile } from "../media.js";
import { isOwnerRole } from "../member-protection.js";
import { contributors } from "./index.js";
import { completeRequests, openRequest } from "./requests.js";
import { loadSubject } from "./subject.js";
import type { PrivacySubject } from "./registry.js";

/**
 * Erasure / anonymisation of ONE club member (Wave 10 B8, Art. 17 GDPR), shared by the board (`POST /club-members/:id/erasure/*`)
 * and the account deletion hook of Better Auth. The member row stays as an anonymised record (join date, category, status for the
 * club's statistics; meeting attendance stays pseudonymised); everything else is deleted, anonymised or kept with a reason by
 * the registered contributors (`lib/privacy/registry.ts`). Not reversible.
 */

export type ErasureBlockerCode = "legal_hold" | "exit_pending" | "open_loans" | "board_role" | "sole_owner" | "application_pending";

export interface ErasureBlocker {
  code: ErasureBlockerCode;
  message: string;
}

export interface ErasureStep {
  key: string;
  deleted: number;
  anonymized: number;
  kept: number;
  keptReason?: string;
}

export interface ErasurePlan {
  clubMemberId: string;
  /** Anything in here makes `execute` answer 409 with the same list. */
  blockers: ErasureBlocker[];
  steps: ErasureStep[];
  /** Hash of the plan: `execute` must send it back, so the board confirms exactly what it saw. */
  planDigest: string;
}

class Rollback extends Error {
  constructor(readonly result: { steps: ErasureStep[] }) {
    super("rollback");
  }
}

export async function blockersOf(tx: DbExecutor, row: ClubMemberRow, subject: PrivacySubject): Promise<ErasureBlocker[]> {
  const out: ErasureBlocker[] = [];
  if (row.legalHoldAt !== null) out.push({ code: "legal_hold", message: "A legal hold prevents the erasure of this member" });
  const [pending] = await tx.select({ id: clubExitRequests.id }).from(clubExitRequests).where(and(eq(clubExitRequests.clubMemberId, row.id), eq(clubExitRequests.status, "pending"))).limit(1);
  if (pending) out.push({ code: "exit_pending", message: "A cancellation or exclusion is still pending: decide it first" });
  if (subject.accountMemberId) {
    const [loan] = await tx.select({ id: inventoryLoans.id }).from(inventoryLoans).where(and(eq(inventoryLoans.memberId, subject.accountMemberId), isNull(inventoryLoans.returnedAt))).limit(1);
    if (loan) out.push({ code: "open_loans", message: "The member still has borrowed items: have them returned first" });
    const roles = await tx.select({ roleType: clubRoles.roleType }).from(clubRoles).where(eq(clubRoles.memberId, subject.accountMemberId));
    if (roles.some((r) => (BOARD_ROLE_TYPES as readonly string[]).includes(r.roleType))) out.push({ code: "board_role", message: "The member holds a board role: hand it over first" });
    const [account] = await tx.select({ role: member.role, organizationId: member.organizationId }).from(member).where(eq(member.id, subject.accountMemberId));
    if (account && isOwnerRole(account.role)) {
      const [other] = await tx
        .select({ id: member.id })
        .from(member)
        .where(and(eq(member.organizationId, account.organizationId), ne(member.id, subject.accountMemberId), sql`',' || replace(${member.role}, ' ', '') || ',' LIKE '%,owner,%'`))
        .limit(1);
      if (!other) out.push({ code: "sole_owner", message: "This is the only owner of the club: transfer the ownership first" });
    }
  }
  return out;
}

/** The changing part: key returns, every contributor, then the account membership goes. */
async function runSteps(tx: DbExecutor, subject: PrivacySubject): Promise<{ steps: ErasureStep[]; purge: string[] }> {
  // The key log needs the holder rows, so it is written before the contributors delete them.
  if (subject.accountMemberId) await recordKeyReturnsForRemovedAccount(tx, subject.accountMemberId, null);
  const steps: ErasureStep[] = [];
  const purge: string[] = [];
  for (const c of contributors()) {
    const r = await c.eraseSubject(tx, subject);
    steps.push({ key: c.key, deleted: r.deleted, anonymized: r.anonymized, kept: r.kept, ...(r.keptReason ? { keptReason: r.keptReason } : {}) });
    purge.push(...(r.purge ?? []));
  }
  if (subject.accountMemberId) {
    await tx.delete(member).where(eq(member.id, subject.accountMemberId));
    if (subject.userId) await tx.update(session).set({ activeOrganizationId: null }).where(and(eq(session.userId, subject.userId), eq(session.activeOrganizationId, subject.clubId)));
  }
  return { steps, purge };
}

async function simulate(tx: DbExecutor, subject: PrivacySubject): Promise<ErasureStep[]> {
  try {
    // A savepoint: everything the dry run touched is rolled back, the outer transaction goes on.
    await (tx as typeof db).transaction(async (sp) => {
      throw new Rollback({ steps: (await runSteps(sp, subject)).steps });
    });
  } catch (err) {
    if (err instanceof Rollback) return err.result.steps;
    throw err;
  }
  return [];
}

const digestOf = (clubMemberId: string, steps: ErasureStep[], blockers: ErasureBlocker[]): string =>
  createHash("sha256")
    .update(JSON.stringify({ clubMemberId, steps: steps.map((s) => [s.key, s.deleted, s.anonymized, s.kept]), blockers: blockers.map((b) => b.code) }))
    .digest("hex");

/** Dry run: what would be deleted, anonymised and kept, and what blocks it. Changes nothing. */
export async function planErasure(clubId: string, clubMemberId: string): Promise<ErasurePlan> {
  return db.transaction(async (tx) => {
    const { row, subject } = await loadSubject(clubId, clubMemberId, tx);
    const blockers = await blockersOf(tx, row, subject);
    const steps = blockers.length > 0 ? [] : await simulate(tx, subject);
    return { clubMemberId: row.id, blockers, steps, planDigest: digestOf(row.id, steps, blockers) };
  });
}

export interface ExecuteInput {
  clubId: string;
  clubMemberId: string;
  actorUserId: string | null;
  via: "board" | "account_deletion" | "retention";
  /** Required for the board path: the digest of the plan the board confirmed. */
  planDigest?: string;
}

async function lockFormsOf(tx: DbExecutor, clubId: string, clubMemberId: string): Promise<void> {
  const viaApplication = await tx.select({ id: clubApplications.formSubmissionId }).from(clubApplications).where(and(eq(clubApplications.clubId, clubId), eq(clubApplications.clubMemberId, clubMemberId)));
  const linked = viaApplication.map((r) => r.id).filter((id): id is string => id !== null);
  await tx
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.clubId, clubId), or(eq(formSubmissions.subjectClubMemberId, clubMemberId), linked.length > 0 ? inArray(formSubmissions.id, linked) : undefined)))
    .orderBy(formSubmissions.id)
    .for("update");
}

export async function executeErasure(input: ExecuteInput): Promise<{ steps: ErasureStep[] }> {
  const { steps, purge } = await db.transaction(async (tx) => {
    // Lock order (see form-retention.ts): submissions first, then the member row, which stays locked while the blockers are checked.
    await lockFormsOf(tx, input.clubId, input.clubMemberId);
    const { row, subject } = await loadSubject(input.clubId, input.clubMemberId, tx, { lock: true });
    const blockers = await blockersOf(tx, row, subject);
    if (blockers.length > 0) throw new ConflictError(blockers[0]!.message, { details: { code: blockers[0]!.code, blockers } });
    if (input.planDigest !== undefined) {
      const current = digestOf(row.id, await simulate(tx, subject), blockers);
      if (current !== input.planDigest) throw new ConflictError("The data of this member changed since the plan was made: run the plan again", { details: { code: "plan_outdated" } });
    }
    const ran = await runSteps(tx, subject);
    const total = ran.steps.reduce((a, s) => ({ deleted: a.deleted + s.deleted, anonymized: a.anonymized + s.anonymized, kept: a.kept + s.kept }), { deleted: 0, anonymized: 0, kept: 0 });
    // The request that led here (or a fresh one, for the record) is closed in the same transaction.
    await openRequest(tx, { clubId: input.clubId, clubMemberId: row.id, kind: "erasure", requestedByUserId: input.actorUserId });
    await completeRequests(tx, { clubId: input.clubId, clubMemberId: row.id, kind: "erasure", handledByUserId: input.actorUserId, result: "Erased and anonymised" });
    await writeAudit(tx, { eventType: "member_erasure.execute", subjectId: row.id, clubId: input.clubId, actorUserId: input.actorUserId, payload: { clubId: input.clubId, via: input.via, ...total } });
    return { steps: ran.steps, purge: ran.purge };
  });
  for (const key of purge) await purgeMediaFile(key);
  return { steps };
}

/**
 * Account deletion (Better Auth `deleteUser.beforeDelete`): the person is erased from every club they belong to or belonged to
 * before the user row goes. Everything is checked first, so a blocker in one club stops the whole deletion with nothing changed.
 */
export async function eraseAccountMemberships(userId: string): Promise<void> {
  const rows = await db
    .select({ id: clubMembers.id, clubId: clubMembers.clubId })
    .from(clubMembers)
    .leftJoin(member, eq(member.id, clubMembers.memberId))
    .where(or(eq(member.userId, userId), and(isNull(clubMembers.memberId), eq(clubMembers.lastUserId, userId))));
  const blocked: Array<{ clubId: string; blockers: ErasureBlocker[] }> = [];
  for (const r of rows) {
    const plan = await planErasure(r.clubId, r.id);
    if (plan.blockers.length > 0) blocked.push({ clubId: r.clubId, blockers: plan.blockers });
  }
  if (blocked.length > 0) throw new ConflictError(blocked[0]!.blockers[0]!.message, { details: { code: blocked[0]!.blockers[0]!.code, blocked } });
  // An application that is still under review (a child's included) would lose its applicant with the account: withdraw it first.
  const [open] = await db.select({ id: formSubmissions.id }).from(formSubmissions).where(and(eq(formSubmissions.submittedByUserId, userId), eq(formSubmissions.status, "submitted"))).limit(1);
  if (open) throw new ConflictError("An application is still under review: withdraw it first", { details: { code: "application_pending" } });
  for (const r of rows) await executeErasure({ clubId: r.clubId, clubMemberId: r.id, actorUserId: userId, via: "account_deletion" });
  // Decided submissions stay as the record of the decision (`submitted_by_user_id` becomes NULL); abandoned drafts and their files go now.
  await sweepStaleFormDrafts(Date.now() + 366 * 24 * 60 * 60 * 1000, { userId });
}
