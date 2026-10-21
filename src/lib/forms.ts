import { and, asc, eq, isNull } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { forms, formSubmissionFiles, formSubmissions, formVersions, memberFieldDefinitions, type FormPurpose, type FormRow, type FormVersionRow, type SubmissionOnBehalfOf } from "../db/schema/forms.js";
import { IMPLICIT_ROLE_TYPE } from "./club-permissions.js";
import type { DbExecutor } from "./club-members.js";
import { ConflictError, ValidationError, type AppErrorOptions } from "./errors.js";
import { ensureClubFormDefaults } from "./form-defaults.js";
import { supportsChildApplication } from "./form-children.js";
import { isNeverMandatoryKey } from "./profile-modules.js";
import { FIELD_KEY_RE, type FieldErrorCode, type FormField, resolveFieldOptions } from "./form-schema.js";
import { markMediaDeleted } from "./media.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Shared helpers of the form routes (Wave 8 B4/B5): response shapes, "which version is current", the publish checks
 * and the preconditions of an application. The routes are `routes/forms.ts` (editor), `routes/club-forms.ts`
 * (applicant reads the form) and `routes/form-submissions.ts` (applicant fills it in).
 */

export const MAX_FILES_PER_SUBMISSION = 5;
export const MAX_DRAFTS_PER_CLUB = 3;
/** Open drafts of one user over ALL clubs. */
export const MAX_DRAFTS_PER_USER = 10;
/** Files over all open drafts of one user in one club. */
export const MAX_DRAFT_FILES_PER_USER_CLUB = 10;
/** Editor caps: active forms per club and versions per form. */
export const MAX_ACTIVE_FORMS_PER_CLUB = 50;
export const MAX_VERSIONS_PER_FORM = 200;
/** JSON bodies of answers (60 fields x up to 5000 characters) and of field definitions. */
export const ANSWERS_BODY_LIMIT = 512 * 1024;
export const DEFINITION_BODY_LIMIT = 1024 * 1024;

/** Environment-tunable per-user hourly limits (clamped), read once at start-up. */
function hourlyLimit(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), 10_000) : fallback;
}
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= min ? Math.min(Math.floor(parsed), max) : fallback;
}
/** Bytes over all open drafts of one user in one club (`FORM_DRAFT_MAX_BYTES_PER_USER`, default 25 MiB). */
export const draftMaxBytesPerUser = () => intEnv("FORM_DRAFT_MAX_BYTES_PER_USER", 25 * 1024 * 1024, 1024, 1024 * 1024 * 1024);
/** Idle days after which a draft (and its files) is swept (`FORM_DRAFT_TTL_DAYS`, default 30). */
export const draftTtlDays = () => intEnv("FORM_DRAFT_TTL_DAYS", 30, 1, 365);
/** Days after the rejection of an application until its uploaded files are deleted (`FORM_REJECTED_FILE_TTL_DAYS`, default 30). */
export const rejectedFileTtlDays = () => intEnv("FORM_REJECTED_FILE_TTL_DAYS", 30, 1, 3650);
export const uploadsPerHour = () => hourlyLimit("FORM_UPLOADS_PER_HOUR", 30);
export const submissionsPerHour = () => hourlyLimit("FORM_SUBMISSIONS_PER_HOUR", 20);

/** Club slugs and ids are plain ASCII tokens; anything else cannot exist (and must not reach the database, e.g. NUL). */
export const SLUG_RE = /^[A-Za-z0-9_-]{1,100}$/;

export { isUuid } from "./club-members.js";

export function fieldErrorDetails(errors: Record<string, FieldErrorCode>): { fields: Record<string, FieldErrorCode> } {
  // Keys are client input: anything that is not a well-formed field key is reported under a fixed placeholder.
  return { fields: Object.fromEntries(Object.entries(errors).map(([key, code]) => [FIELD_KEY_RE.test(key) || key === "_" ? key : "_invalid_key", code])) };
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

/**
 * Categories an applicant may choose (active AND `applicant_selectable`): what `optionsSource: "member_categories"`
 * resolves to in the applicant form and what answers are validated against.
 */
export async function applicantCategories(clubId: string, executor: DbExecutor = db): Promise<Array<{ key: string; name: string }>> {
  return executor
    .select({ key: memberCategories.key, name: memberCategories.name })
    .from(memberCategories)
    .where(and(eq(memberCategories.clubId, clubId), isNull(memberCategories.archivedAt), eq(memberCategories.applicantSelectable, true)))
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
 * Makes sure the club has its standard forms and categories, WITHOUT writing when everything is there: the applicant
 * routes call this, so reading a form does not turn into a write on every request. Seeding happens on the first access
 * that finds something missing (atomic and idempotent, see `ensureClubFormDefaults`).
 */
export async function ensureFormBasics(clubId: string): Promise<void> {
  if ((await findCurrentForm(clubId, "aufnahme")) && (await applicantCategories(clubId)).length > 0) return;
  await ensureClubFormDefaults(clubId);
}

/** Removes file rows and tombstones their registry entries; returns the keys to `purgeMediaFile` AFTER the commit. */
export async function removeFiles(tx: DbExecutor, rows: ReadonlyArray<{ id: string; storageKey: string }>): Promise<string[]> {
  const purge: string[] = [];
  for (const row of rows) {
    await tx.delete(formSubmissionFiles).where(eq(formSubmissionFiles.id, row.id));
    if (await markMediaDeleted(row.storageKey, tx)) purge.push(row.storageKey);
  }
  return purge;
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
  // `childApplication`: a parent may apply for a child with this form (it asks for first and last name). Says nothing else about the mapping.
  return { formId: form.id, formVersionId: version.id, version: version.version, purpose: form.purpose, name: form.name, privacyNotice: version.privacyNotice, childApplication: supportsChildApplication(version.fields as FormField[]), fields };
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
export async function assertMayApply(executor: DbExecutor, clubId: string, userId: string, onBehalfOf: SubmissionOnBehalfOf = "self"): Promise<void> {
  // A parent applying for a child (B8) is not the applicant: being a member (even a guest guardian) or having applied for
  // oneself or another child is no obstacle. Their account must merely not be a former one (checked by the caller).
  if (onBehalfOf === "guardian") return;
  const existing = await executor.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, userId)) });
  if (existing) {
    const own = await executor.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, existing.id) });
    const state = own ? effectiveStatus(own, todayBerlin()) : null;
    if (state === "ausgeschlossen" || state === "verstorben") {
      throw new ConflictError("This person was excluded from the club or is marked deceased; the member must be reopened by the board before re-joining", {
        details: { code: "member_rejoin_blocked", clubMemberId: own!.id, status: state },
      });
    }
    // An external guest (a guardian, `member.role = guest`) is not a member: applying for oneself is allowed and, once accepted,
    // promotes the guest to a regular member (`POST /club-applications/:id/approve`).
    if (existing.role !== "guest" && state !== "ausgetreten") throw new ConflictError("Already a member of this club", { code: "ALREADY_MEMBER", details: { clubId, ...(own ? { clubMemberId: own.id } : {}) } });
  }
  const pending = await executor.query.clubApplications.findFirst({ where: and(eq(clubApplications.userId, userId), eq(clubApplications.clubId, clubId), eq(clubApplications.status, "pending"), eq(clubApplications.onBehalfOf, "self")) });
  if (pending) throw new ConflictError("An application for this club is already pending", { code: "APPLICATION_PENDING", details: { clubId, applicationId: pending.id, submittedAt: pending.createdAt } });
  const submitted = await executor.query.formSubmissions.findFirst({
    where: and(eq(formSubmissions.submittedByUserId, userId), eq(formSubmissions.clubId, clubId), eq(formSubmissions.status, "submitted"), eq(formSubmissions.onBehalfOf, "self")),
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

/** Exit forms (`austritt`) cannot take uploads (`POST /club-exit-requests` accepts plain answers only). */
export function fileFieldProblems(purpose: string, fields: readonly FormField[]): PublishProblem[] {
  if (purpose !== "austritt") return [];
  return fields.filter((f) => f.type === "file" || f.type === "image").map((f) => ({ code: "file_not_supported", fieldKey: f.key }));
}

/**
 * `credential` (holds it + level + valid until) is a member custom field type only; forms have no renderer contract for it
 * (clients render the profile modules from `/club-members/:id/custom-fields`). Refused when saving and publishing.
 */
export function credentialFieldProblems(fields: readonly FormField[]): PublishProblem[] {
  return fields.filter((f) => f.type === "credential").map((f) => ({ code: "credential_not_supported", fieldKey: f.key }));
}

const CUSTOM_FIELD_TYPE: Record<string, string> = { consent: "checkbox" };

/**
 * Checks a draft must pass to be published (the shape itself was validated by `formFieldsSchema`):
 * - `aufnahme`: a privacy notice block with text. NO consent is required (Wave 10 B11, Art. 7(4) GDPR: consent is voluntary and never
 *   a condition of an application); consent fields stay possible but optional;
 * - mapping to club master data / custom fields only on `aufnahme` (only acceptance writes them);
 * - `austritt` forms must not contain `file`/`image` fields (`file_not_supported`);
 * - every `customField` key refers to a non-archived definition of the club with a matching type.
 */
export async function publishProblems(input: { clubId: string; purpose: string; fields: readonly FormField[]; privacyNotice: string | null }, executor: DbExecutor = db): Promise<PublishProblem[]> {
  const problems: PublishProblem[] = [];
  const { fields, purpose } = input;
  problems.push(...fileFieldProblems(purpose, fields), ...credentialFieldProblems(fields));
  // A consent is voluntary (Art. 7(4) GDPR): no form may make it a condition of submitting.
  for (const f of fields) if (f.type === "consent" && f.required === true) problems.push({ code: "required_consent_not_allowed", fieldKey: f.key });

  if (purpose === "aufnahme") {
    const notice = fields.find((f) => f.type === "info" && f.infoKind === "privacy_notice");
    if (!notice) problems.push({ code: "privacy_notice_missing" });
    else if (!(input.privacyNotice?.trim() || notice.text?.trim())) problems.push({ code: "privacy_notice_text_missing", fieldKey: notice.key });
  }

  for (const f of fields) if (f.sensitive && f.mapsTo !== undefined) problems.push({ code: "sensitive_mapping_not_allowed", fieldKey: f.key });
  if (purpose === "aufnahme" && fields.some((f) => f.optionsSource === "member_categories") && (await applicantCategories(input.clubId, executor)).length === 0) {
    problems.push({ code: "no_selectable_category" });
  }

  const mapped = fields.filter((f) => f.mapsTo !== undefined || f.customField !== undefined);
  if (purpose !== "aufnahme") {
    for (const f of mapped) problems.push({ code: "mapping_not_allowed", fieldKey: f.key });
    return problems;
  }

  const wanted = fields.filter((f) => f.customField !== undefined);
  if (wanted.length > 0) {
    const defs = await executor
      .select({ key: memberFieldDefinitions.key, fieldType: memberFieldDefinitions.fieldType, sensitive: memberFieldDefinitions.sensitive, archivedAt: memberFieldDefinitions.archivedAt })
      .from(memberFieldDefinitions)
      .where(eq(memberFieldDefinitions.clubId, input.clubId));
    const byKey = new Map(defs.map((d) => [d.key, d]));
    for (const f of wanted) {
      const def = byKey.get(f.customField!);
      // Driving licence / qualification / Kinderschutz modules are never mandatory, not even through an application form.
      if (f.required === true && isNeverMandatoryKey(f.customField!)) problems.push({ code: "module_never_mandatory", fieldKey: f.key });
      if (!def || def.archivedAt) problems.push({ code: "custom_field_unknown", fieldKey: f.key });
      else if (def.fieldType !== (CUSTOM_FIELD_TYPE[f.type] ?? f.type)) problems.push({ code: "custom_field_type_mismatch", fieldKey: f.key });
      // Sensitive answers may only flow into custom fields that are protected (members:read_sensitive + audit) as well.
      else if (f.sensitive && !def.sensitive) problems.push({ code: "custom_field_not_sensitive", fieldKey: f.key });
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
