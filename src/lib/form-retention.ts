import { and, eq, inArray, or } from "drizzle-orm";

import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { formSubmissionFiles, formSubmissions } from "../db/schema/forms.js";
import type { DbExecutor } from "./club-members.js";
import { removeFiles } from "./forms.js";

/**
 * The list-friendly COPIES of answers on `club_applications` (`birth_date`, `category`) are personal data of the person the
 * answers describe: every erasure path (the retention sweeper for rejected / withdrawn child applications and the member
 * anonymisation hook) clears them with the answers, through this one function. `category` is NOT NULL, so it returns to its
 * neutral default `aktiv`.
 */
export async function scrubApplicationCopies(tx: DbExecutor, where: ReturnType<typeof and>): Promise<void> {
  await tx.update(clubApplications).set({ birthDate: null, category: "aktiv" }).where(where);
}

/**
 * Hook for the anonymisation of a club member (prepared for Wave 10, deliberately NOT wired into any route yet: there is no
 * anonymisation flow before the data protection concept). Call it inside the transaction that anonymises / erases the
 * member and `purgeMediaFile` the returned keys AFTER the commit.
 *
 * What it erases of the form builder's records about the member (`clubId` is part of every condition, another club's rows
 * are unreachable):
 * - the answers of every submission ABOUT the member (`subject_club_member_id`, or the submission of their application):
 *   `answers` become `{}`, the decision notes are cleared; id, status, version and timestamps stay as proof that a
 *   submission existed;
 * - the uploaded files of those submissions (registry tombstone, bytes deleted by the caller);
 * - the copies on their application rows (`birth_date`, `category`, see `scrubApplicationCopies`).
 *
 * LOCK ORDER: submission rows (id order) -> `form_submission_files` / `media_files`. The caller must NOT hold a lock on the
 * member's `club_members` row when it calls this (the decision paths lock submission -> application -> ... -> club_members), so
 * call it first in the anonymisation transaction and lock/modify the member row afterwards.
 *
 * Not covered here (Wave 10 decides): custom field values (`member_field_values`), the consent evidence in audit entries (ids
 * and a hash only, no personal data), submissions the person merely SUBMITTED for someone else.
 * Audit entries written: `form_submission.erased` (ids and counts, never values).
 */
export async function eraseFormDataOfMember(tx: DbExecutor, input: { clubId: string; clubMemberId: string; erasedBy: string | null }): Promise<{ submissions: number; files: number; purge: string[] }> {
  const { clubId, clubMemberId } = input;
  const viaApplication = await tx
    .select({ id: clubApplications.formSubmissionId })
    .from(clubApplications)
    .where(and(eq(clubApplications.clubId, clubId), eq(clubApplications.clubMemberId, clubMemberId)));
  const applicationSubmissionIds = viaApplication.map((r) => r.id).filter((id): id is string => id !== null);

  const subs = await tx
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.clubId, clubId), or(eq(formSubmissions.subjectClubMemberId, clubMemberId), applicationSubmissionIds.length > 0 ? inArray(formSubmissions.id, applicationSubmissionIds) : undefined)))
    .orderBy(formSubmissions.id)
    .for("update");
  const purge: string[] = [];
  let files = 0;
  for (const { id } of subs) {
    const rows = await tx.select().from(formSubmissionFiles).where(eq(formSubmissionFiles.submissionId, id));
    purge.push(...(await removeFiles(tx, rows)));
    files += rows.length;
    await tx.update(formSubmissions).set({ answers: {}, decisionNote: null, decisionInternalNote: null, updatedAt: new Date() }).where(eq(formSubmissions.id, id));
    await tx.insert(auditLog).values({ eventType: "form_submission.erased", subjectId: id, payload: { clubId, clubMemberId, fileCount: rows.length, erasedBy: input.erasedBy, reason: "member_anonymisation" } });
  }
  await scrubApplicationCopies(tx, and(eq(clubApplications.clubId, clubId), eq(clubApplications.clubMemberId, clubMemberId)));
  if (applicationSubmissionIds.length > 0) await scrubApplicationCopies(tx, inArray(clubApplications.formSubmissionId, applicationSubmissionIds));
  return { submissions: subs.length, files, purge };
}
