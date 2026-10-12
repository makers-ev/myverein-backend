import { and, asc, eq, isNull } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { forms, formSubmissions, formVersions, memberFieldDefinitions, type FormPurpose, type FormRow, type FormVersionRow } from "../db/schema/forms.js";
import { IMPLICIT_ROLE_TYPE } from "./club-permissions.js";
import type { DbExecutor } from "./club-members.js";
import { ConflictError, ValidationError, type AppErrorOptions } from "./errors.js";
import { type FieldErrorCode, type FormField, resolveFieldOptions } from "./form-schema.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Shared helpers of the form routes (Wave 8 B4/B5): response shapes, "which version is current", the publish checks
 * and the preconditions of an application. The routes are `routes/forms.ts` (editor), `routes/club-forms.ts`
 * (applicant reads the form) and `routes/form-submissions.ts` (applicant fills it in).
 */

export const MAX_FILES_PER_SUBMISSION = 5;
export const MAX_DRAFTS_PER_CLUB = 3;
/** JSON bodies of answers (60 fields x up to 5000 characters) and of field definitions. */
export const ANSWERS_BODY_LIMIT = 512 * 1024;
export const DEFINITION_BODY_LIMIT = 1024 * 1024;

/** Environment-tunable per-user hourly limits (clamped), read once at start-up. */
function hourlyLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), 10_000) : fallback;
}
export const uploadsPerHour = () => hourlyLimit("FORM_UPLOADS_PER_HOUR", 30);
export const submissionsPerHour = () => hourlyLimit("FORM_SUBMISSIONS_PER_HOUR", 20);

export { isUuid } from "./club-members.js";

export function fieldErrorDetails(errors: Record<string, FieldErrorCode>): { fields: Record<string, FieldErrorCode> } {
  return { fields: Object.fromEntries(Object.entries(errors)) };
}

export function invalidAnswers(errors: Record<string, FieldErrorCode>): ValidationError {
  return new ValidationError("Answers do not match the form", { details: fieldErrorDetails(errors) });
}

export const versionDto = (v: FormVersionRow) => ({
  id: v.id,
  version: v.version,
  status: v.status,
  fields: v.fields as FormField[],
  privacyNotice: v.privacyNotice,
  publishedAt: v.publishedAt,
  publishedBy: v.publishedBy,
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
});

export const versionSummaryDto = (v: FormVersionRow) => ({
  id: v.id,
  version: v.version,
  status: v.status,
  fieldCount: Array.isArray(v.fields) ? v.fields.length : 0,
  publishedAt: v.publishedAt,
  createdAt: v.createdAt,
  updatedAt: v.updatedAt,
});

export const formDto = (f: FormRow) => ({ id: f.id, purpose: f.purpose, name: f.name, archivedAt: f.archivedAt, createdAt: f.createdAt, updatedAt: f.updatedAt });

/** Active categories of a club (what `optionsSource: "member_categories"` resolves to). */
export async function activeCategories(clubId: string, executor: DbExecutor = db): Promise<Array<{ key: string; name: string }>> {
  return executor
    .select({ key: memberCategories.key, name: memberCategories.name })
    .from(memberCategories)
    .where(and(eq(memberCategories.clubId, clubId), isNull(memberCategories.archivedAt)))
    .orderBy(asc(memberCategories.sortOrder), asc(memberCategories.name));
}

/** The published version of the club's active form of `purpose` (aufnahme/austritt: at most one by unique index). */
export async function findCurrentForm(clubId: string, purpose: FormPurpose, executor: DbExecutor = db): Promise<{ form: FormRow; version: FormVersionRow } | null> {
  const [row] = await executor
    .select({ form: forms, version: formVersions })
    .from(forms)
    .innerJoin(formVersions, eq(formVersions.formId, forms.id))
    .where(and(eq(forms.clubId, clubId), eq(forms.purpose, purpose), isNull(forms.archivedAt), eq(formVersions.status, "published")))
    .limit(1);
  return row ?? null;
}

/**
 * What an applicant gets to see: the field definitions and the privacy notice, options resolved. Deliberately NO
 * admin data: no mapping targets (`mapsTo`/`customField`), no editor metadata, no club data.
 */
export function applicantDefinition(form: FormRow, version: FormVersionRow, categories: ReadonlyArray<{ key: string; name: string }>) {
  const fields = (version.fields as FormField[]).map((field) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- stripped on purpose
    const { mapsTo, customField, ...visible } = field;
    const options = field.type === "select" || field.type === "multiselect" ? resolveFieldOptions(field, categories) : undefined;
    return options ? { ...visible, options } : visible;
  });
  return { formId: form.id, formVersionId: version.id, version: version.version, purpose: form.purpose, name: form.name, privacyNotice: version.privacyNotice, fields };
}

/** `409 FORM_VERSION_OUTDATED` carrying the definition the client has to re-render (null: the club currently has no such form). */
export function outdatedError(current: ReturnType<typeof applicantDefinition> | null, submissionId?: string): ConflictError {
  const options: AppErrorOptions = { code: "FORM_VERSION_OUTDATED", details: { ...(submissionId ? { submissionId } : {}), currentVersion: current } };
  return new ConflictError("The form was changed in the meantime", options);
}

/**
 * Caller's club role types for `clubId` -- the same resolution as `clubGuard` (account membership, left members
 * excluded, implicit `mitglied` except for external guests) for routes that have no club context in the URL.
 * `null` = not a (current) member.
 */
export async function clubRoleTypesOf(userId: string, clubId: string, executor: DbExecutor = db): Promise<string[] | null> {
  const membership = await executor.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, userId)) });
  if (!membership) return null;
  const clubMember = await executor.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, membership.id), columns: { status: true, leftAt: true } });
  if (clubMember && isLeftStatus(effectiveStatus(clubMember, todayBerlin()))) return null;
  const rows = await executor.query.clubRoles.findMany({ where: eq(clubRoles.memberId, membership.id) });
  const roleTypes = new Set(rows.map((r) => r.roleType));
  roleTypes.delete(IMPLICIT_ROLE_TYPE);
  const effective = [...roleTypes];
  if (membership.role !== "guest") effective.unshift(IMPLICIT_ROLE_TYPE);
  return effective;
}

/**
 * Preconditions of an application (same rules as `POST /club-members/apply`): not already a member, not excluded /
 * deceased, no pending application and no other submitted application form of this user for the club.
 */
export async function assertMayApply(executor: DbExecutor, clubId: string, userId: string): Promise<void> {
  const existing = await executor.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, userId)) });
  if (existing) {
    const own = await executor.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, existing.id) });
    const state = own ? effectiveStatus(own, todayBerlin()) : null;
    if (state === "ausgeschlossen" || state === "verstorben") {
      throw new ConflictError("This person was excluded from the club or is marked deceased; the member must be reopened by the board before re-joining", {
        details: { code: "member_rejoin_blocked", clubMemberId: own!.id, status: state },
      });
    }
    if (state !== "ausgetreten") throw new ConflictError("Already a member of this club", { code: "ALREADY_MEMBER", details: { clubId, ...(own ? { clubMemberId: own.id } : {}) } });
  }
  const pending = await executor.query.clubApplications.findFirst({ where: and(eq(clubApplications.userId, userId), eq(clubApplications.clubId, clubId), eq(clubApplications.status, "pending")) });
  if (pending) throw new ConflictError("An application for this club is already pending", { code: "APPLICATION_PENDING", details: { clubId, applicationId: pending.id, submittedAt: pending.createdAt } });
  const submitted = await executor.query.formSubmissions.findFirst({
    where: and(eq(formSubmissions.submittedByUserId, userId), eq(formSubmissions.clubId, clubId), eq(formSubmissions.status, "submitted")),
    with: { form: { columns: { purpose: true } } },
  });
  if (submitted && submitted.form.purpose === "aufnahme") {
    throw new ConflictError("An application for this club is already pending", { code: "APPLICATION_PENDING", details: { clubId, submissionId: submitted.id, submittedAt: submitted.submittedAt } });
  }
}

export interface PublishProblem {
  code: string;
  fieldKey?: string;
}

const CUSTOM_FIELD_TYPE: Record<string, string> = { consent: "checkbox" };

/**
 * Checks a draft must pass to be published (the shape itself was validated by `formFieldsSchema`):
 * - `aufnahme`: a privacy notice block with text and a mandatory, unconditional consent;
 * - mapping to club master data / custom fields only on `aufnahme` (only acceptance writes them);
 * - every `customField` key refers to a non-archived definition of the club with a matching type.
 */
export async function publishProblems(input: { clubId: string; purpose: string; fields: readonly FormField[]; privacyNotice: string | null }, executor: DbExecutor = db): Promise<PublishProblem[]> {
  const problems: PublishProblem[] = [];
  const { fields, purpose } = input;

  if (purpose === "aufnahme") {
    const notice = fields.find((f) => f.type === "info" && f.infoKind === "privacy_notice");
    if (!notice) problems.push({ code: "privacy_notice_missing" });
    else if (!(input.privacyNotice?.trim() || notice.text?.trim())) problems.push({ code: "privacy_notice_text_missing", fieldKey: notice.key });
    if (!fields.some((f) => f.type === "consent" && f.required === true && f.visibleIf === undefined)) problems.push({ code: "required_consent_missing" });
  }

  const mapped = fields.filter((f) => f.mapsTo !== undefined || f.customField !== undefined);
  if (purpose !== "aufnahme") {
    for (const f of mapped) problems.push({ code: "mapping_not_allowed", fieldKey: f.key });
    return problems;
  }

  const wanted = fields.filter((f) => f.customField !== undefined);
  if (wanted.length > 0) {
    const defs = await executor
      .select({ key: memberFieldDefinitions.key, fieldType: memberFieldDefinitions.fieldType, archivedAt: memberFieldDefinitions.archivedAt })
      .from(memberFieldDefinitions)
      .where(eq(memberFieldDefinitions.clubId, input.clubId));
    const byKey = new Map(defs.map((d) => [d.key, d]));
    for (const f of wanted) {
      const def = byKey.get(f.customField!);
      if (!def || def.archivedAt) problems.push({ code: "custom_field_unknown", fieldKey: f.key });
      else if (def.fieldType !== (CUSTOM_FIELD_TYPE[f.type] ?? f.type)) problems.push({ code: "custom_field_type_mismatch", fieldKey: f.key });
    }
  }
  return problems;
}

/**
 * A key that was part of a published (now published or archived) version keeps its type forever: its answers in old
 * submissions and its mapping stay meaningful. Removing a field (omitting it in a new version) is always allowed.
 */
export async function keyTypeProblems(formId: string, fields: readonly FormField[], executor: DbExecutor = db): Promise<PublishProblem[]> {
  const history = await executor.select({ fields: formVersions.fields, status: formVersions.status }).from(formVersions).where(eq(formVersions.formId, formId));
  const knownTypes = new Map<string, string>();
  for (const row of history) {
    if (row.status === "draft") continue;
    for (const f of row.fields as FormField[]) if (!knownTypes.has(f.key)) knownTypes.set(f.key, f.type);
  }
  return fields.filter((f) => knownTypes.has(f.key) && knownTypes.get(f.key) !== f.type).map((f) => ({ code: "key_type_immutable", fieldKey: f.key }));
}
