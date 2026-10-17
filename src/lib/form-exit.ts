import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { formSubmissions, formVersions, forms, type FormRow, type FormSubmissionRow, type FormVersionRow } from "../db/schema/forms.js";
import { ensureClubFormDefaults } from "./form-defaults.js";
import { applicantDefinition, findCurrentForm, invalidAnswers, outdatedError } from "./forms.js";
import { NotFoundError, ValidationError } from "./errors.js";
import { validateAnswers, type FormField } from "./form-schema.js";
import type { DbExecutor } from "./club-members.js";

/**
 * Exit form (`austritt`) of a cancellation (Wave 8 B9). The form only collects what the member says (an optional reason,
 * free text, a confirmation); **when** the exit takes effect stays exclusively with `club_settings` (notice period and mode,
 * `lib/exit-notice.ts`) -- no field of the form can change a date, a status or a member. The answers become a
 * `form_submissions` row linked from `club_exit_requests.form_submission_id`; their lifecycle follows the request
 * (approved -> accepted, rejected -> rejected, withdrawn -> withdrawn).
 *
 * Lock order in `routes/club-exit-requests.ts` stays: member row -> exit request row -> (this) submission row.
 */

const isUpload = (f: { type: string }) => f.type === "file" || f.type === "image";

/**
 * Legacy tolerance: exit forms cannot take uploads. A published version that still holds `file`/`image` fields (from before
 * `file_not_supported` was enforced) is treated as if those fields did not exist: never shown, never required, answers ignored.
 */
function withoutUploads<T extends { fields: unknown }>(def: T): T {
  return { ...def, fields: (def.fields as FormField[]).filter((f) => !isUpload(f)) };
}

export interface PreparedExitAnswers {
  form: FormRow;
  version: FormVersionRow;
  answers: Record<string, unknown>;
}

/** Makes sure the club has its standard forms WITHOUT writing when the exit form is there (reading does not write). */
export async function ensureExitForm(clubId: string): Promise<void> {
  if (!(await findCurrentForm(clubId, "austritt"))) await ensureClubFormDefaults(clubId);
}

/** The published exit form as the member sees it (field definitions only, no admin data). */
export async function currentExitDefinition(clubId: string) {
  await ensureExitForm(clubId);
  const current = await findCurrentForm(clubId, "austritt");
  if (!current) throw new NotFoundError("This club has no exit form");
  return withoutUploads(applicantDefinition(current.form, current.version, []));
}

/**
 * Validates the answers of a cancellation against the club's published exit form (engine of B3, submit mode: a required
 * confirmation must be given). A `formVersionId` that is not the published version is `409 FORM_VERSION_OUTDATED` with the
 * current definition. Runs before any lock is taken.
 */
export async function prepareExitAnswers(clubId: string, answers: unknown, formVersionId?: string): Promise<PreparedExitAnswers> {
  await ensureExitForm(clubId);
  const current = await findCurrentForm(clubId, "austritt");
  if (!current) throw new NotFoundError("This club has no exit form");
  if (formVersionId !== undefined && formVersionId !== current.version.id) throw outdatedError(withoutUploads(applicantDefinition(current.form, current.version, [])));
  const all = current.version.fields as FormField[];
  const uploadKeys = new Set(all.filter(isUpload).map((f) => f.key));
  const given = typeof answers === "object" && answers !== null && !Array.isArray(answers) ? Object.fromEntries(Object.entries(answers).filter(([k]) => !uploadKeys.has(k))) : answers;
  const result = validateAnswers(all.filter((f) => !isUpload(f)), given, { mode: "submit", categoryKeys: [] });
  if (!result.ok) throw invalidAnswers(result.errors);
  return { form: current.form, version: current.version, answers: result.answers };
}

/** Inserts the (already `submitted`) submission of a cancellation. */
export async function insertExitSubmission(tx: DbExecutor, prepared: PreparedExitAnswers, input: { clubId: string; submittedByUserId: string; subjectClubMemberId: string }): Promise<FormSubmissionRow> {
  const now = new Date();
  const [row] = await tx
    .insert(formSubmissions)
    .values({
      formId: prepared.form.id,
      formVersionId: prepared.version.id,
      clubId: input.clubId,
      submittedByUserId: input.submittedByUserId,
      subjectClubMemberId: input.subjectClubMemberId,
      onBehalfOf: "self",
      answers: prepared.answers,
      status: "submitted",
      submittedAt: now,
    })
    .returning();
  if (!row) throw new ValidationError("Could not store the exit form");
  return row;
}

/** The exit request was decided or withdrawn: the submission follows (`accepted` | `rejected` | `withdrawn`). No-op without a submission. */
export async function closeExitSubmission(tx: DbExecutor, submissionId: string | null, status: "accepted" | "rejected" | "withdrawn", decidedBy: string | null): Promise<void> {
  if (!submissionId) return;
  const now = new Date();
  await tx
    .update(formSubmissions)
    .set(status === "withdrawn" ? { status, updatedAt: now } : { status, decidedAt: now, decidedBy, updatedAt: now })
    .where(eq(formSubmissions.id, submissionId));
}

/** The submission with the version it was filled in (for the review rendering); `null` if it does not exist or is another club's. */
export async function loadExitSubmission(clubId: string, submissionId: string | null) {
  if (!submissionId) return null;
  const [row] = await db
    .select({ sub: formSubmissions, version: formVersions, purpose: forms.purpose })
    .from(formSubmissions)
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .innerJoin(forms, eq(forms.id, formSubmissions.formId))
    .where(eq(formSubmissions.id, submissionId))
    .limit(1);
  return row && row.sub.clubId === clubId && row.purpose === "austritt" ? row : null;
}
