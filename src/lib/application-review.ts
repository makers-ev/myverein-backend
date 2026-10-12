import { and, eq, inArray, ne, or, sql } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import type { ClubApplicationRow } from "../db/schema/club-applications.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { forms, formSubmissionFiles, formSubmissions, formVersions, memberFieldDefinitions, type FormSubmissionRow, type FormVersionRow } from "../db/schema/forms.js";
import { mediaFiles } from "../db/schema/media-files.js";
import type { DbExecutor } from "./club-members.js";
import { checkCustomAssignment } from "./custom-fields.js";
import { childWarnings, childDisplayName, type ChildWarning } from "./form-children.js";
import { isMasterTarget, planAcceptance } from "./form-acceptance.js";
import { consentEvidence, type ConsentEvidence } from "./form-applications.js";
import { isMappingTarget, type MappingTarget } from "./form-mapping.js";
import { renderAnswers, summarizeAnswers, type AnswerSummaryItem, type RenderedAnswer } from "./form-review.js";
import { visibleFieldKeys, type FormField } from "./form-schema.js";
import { ageOn, todayBerlin } from "./member-lifecycle.js";

/**
 * Board review of an application (Wave 8 B10): everything `GET /club-applications` and `GET /club-applications/:id` show,
 * assembled from the submission and the version it is PINNED to. Answers are rendered with that version's labels and
 * options, never the current form. Values never reach a log or an audit entry (the route audits field KEYS of sensitive
 * reads); duplicates reveal only an id, a display name and the kind of match.
 */

/** German labels of the mapping allowlist ("wird übernommen als …"). Exhaustive on purpose: a new target needs a label. */
export const MAPPING_TARGET_LABELS: Record<MappingTarget, string> = {
  firstName: "Vorname",
  lastName: "Nachname",
  birthDate: "Geburtsdatum",
  street: "Straße",
  postalCode: "Postleitzahl",
  city: "Ort",
  phone: "Telefon",
  contactEmail: "Kontakt-E-Mail",
  emergencyContactName: "Notfallkontakt (Name)",
  emergencyContactPhone: "Notfallkontakt (Telefon)",
  category: "Kategorie",
  photo: "Profilfoto",
};

export interface MappingPreviewEntry {
  fieldKey: string;
  fieldLabel: string;
  kind: "master" | "category" | "photo" | "custom" | "none";
  /** Allowlist target (`firstName`, ...) or null (custom field / not mappable). Never a free column name. */
  target: MappingTarget | null;
  customFieldKey: string | null;
  /** "Vorname", "Zusatzfeld „Trikotgröße“", ... */
  targetLabel: string | null;
  /** "wird übernommen als Vorname" */
  text: string | null;
  /** The value fits and would be written if the application were accepted now. */
  willApply: boolean;
  /** Why not: `not_answered`, `no_file`, `unknown_target`, `type_mismatch`, `not_a_text`, `invalid_value`, `custom_field_*`. */
  reason?: string;
}

type DefinitionLookup = ReadonlyMap<string, Pick<typeof memberFieldDefinitions.$inferSelect, "key" | "label" | "fieldType" | "options" | "sensitive" | "archivedAt">>;

/** Preview of the acceptance mapping: pure; the same decisions `applyAcceptance` takes, without writing anything. */
export function mappingPreview(fields: readonly FormField[], answers: unknown, input: { definitions: DefinitionLookup; photoFileFieldKeys: ReadonlySet<string> }): MappingPreviewEntry[] {
  const plan = planAcceptance(fields, answers);
  const skipped = new Map(plan.skipped.map((s) => [s.fieldKey, s.reason]));
  const visible = visibleFieldKeys(fields, answers);
  const out: MappingPreviewEntry[] = [];
  for (const field of fields) {
    if (field.type === "info" || !visible.has(field.key)) continue;
    const base = { fieldKey: field.key, fieldLabel: field.label };
    if (field.mapsTo !== undefined) {
      const raw: unknown = field.mapsTo;
      const target = isMappingTarget(raw) ? raw : null;
      const skip = skipped.get(field.key);
      if (target === null || skip === "unknown_target") {
        out.push({ ...base, kind: "none", target: null, customFieldKey: null, targetLabel: null, text: null, willApply: false, reason: "unknown_target" });
        continue;
      }
      const label = MAPPING_TARGET_LABELS[target];
      const common = { ...base, target, customFieldKey: null, targetLabel: label, text: `wird übernommen als ${label}` };
      if (skip) {
        out.push({ ...common, kind: target === "category" ? "category" : target === "photo" ? "photo" : "master", willApply: false, reason: skip });
      } else if (target === "photo") {
        const has = input.photoFileFieldKeys.has(field.key);
        out.push({ ...common, kind: "photo", willApply: has, ...(has ? {} : { reason: "no_file" }) });
      } else if (target === "category") {
        const answered = plan.categoryKey !== null;
        out.push({ ...common, kind: "category", willApply: answered, ...(answered ? {} : { reason: "not_answered" }) });
      } else {
        const applies = isMasterTarget(target) && plan.master[target] !== undefined;
        out.push({ ...common, kind: "master", willApply: applies, ...(applies ? {} : { reason: "not_answered" }) });
      }
      continue;
    }
    if (field.customField !== undefined && field.type !== "file" && field.type !== "image") {
      const assignment = plan.custom.find((c) => c.fieldKey === field.key);
      const def = input.definitions.get(field.customField);
      const label = def ? `Zusatzfeld „${def.label}“` : "Zusatzfeld";
      const common = { ...base, kind: "custom" as const, target: null, customFieldKey: field.customField, targetLabel: label, text: `wird übernommen als ${label}` };
      if (!assignment) out.push({ ...common, willApply: false, reason: "not_answered" });
      else {
        const checked = checkCustomAssignment(def as never, assignment);
        out.push(checked.ok ? { ...common, willApply: checked.value !== undefined } : { ...common, willApply: false, reason: checked.reason });
      }
    }
  }
  return out;
}

export interface DuplicateHint {
  clubMemberId: string;
  displayName: string;
  /** `name_birth_date` (same name and birth date) and/or `email` (same contact or account e-mail). */
  matches: Array<"name_birth_date" | "email">;
}

/**
 * Existing members of the club that look like the applicant (never blocking): same name AND birth date, or -- for an
 * application of oneself -- the same e-mail address (contact or account). A child application is matched by name and birth
 * date only: the e-mail in it is typically the parent's. Returns at most 5 and nothing but id, display name and the kind of match.
 */
export async function duplicateHints(input: { clubId: string; self: boolean; names: readonly string[]; birthDate: string | null; emails: readonly string[]; excludeClubMemberId: string | null }, executor: DbExecutor = db): Promise<DuplicateHint[]> {
  const names = [...new Set(input.names.map((n) => n.trim().toLowerCase()).filter(Boolean))];
  const emails = input.self ? [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))] : [];
  const conditions = [];
  if (names.length > 0 && input.birthDate) conditions.push(and(inArray(sql`lower(${clubMembers.displayName})`, names), eq(clubMembers.birthDate, input.birthDate)));
  if (emails.length > 0) conditions.push(inArray(sql`lower(${clubMembers.contactEmail})`, emails), inArray(sql`lower(${user.email})`, emails));
  if (conditions.length === 0) return [];

  const rows = await executor
    .select({ id: clubMembers.id, displayName: clubMembers.displayName, birthDate: clubMembers.birthDate, contactEmail: clubMembers.contactEmail, accountEmail: user.email })
    .from(clubMembers)
    .leftJoin(member, eq(member.id, clubMembers.memberId))
    .leftJoin(user, eq(user.id, member.userId))
    .where(and(eq(clubMembers.clubId, input.clubId), input.excludeClubMemberId ? ne(clubMembers.id, input.excludeClubMemberId) : undefined, or(...conditions)))
    .orderBy(clubMembers.displayName, clubMembers.id)
    .limit(5);
  return rows.map((r) => {
    const matches: DuplicateHint["matches"] = [];
    if (input.birthDate && r.birthDate === input.birthDate && names.includes(r.displayName.trim().toLowerCase())) matches.push("name_birth_date");
    if (emails.includes((r.contactEmail ?? "").toLowerCase()) || emails.includes((r.accountEmail ?? "").toLowerCase())) matches.push("email");
    return { clubMemberId: r.id, displayName: r.displayName, matches };
  });
}

/** All categories of the club for labelling (`member_categories` options), archived ones included: an old answer keeps its name. */
async function clubCategories(clubId: string, executor: DbExecutor): Promise<Array<{ key: string; name: string }>> {
  return executor.select({ key: memberCategories.key, name: memberCategories.name }).from(memberCategories).where(eq(memberCategories.clubId, clubId));
}

export interface ApplicationListExtras {
  onBehalfOf: string;
  /** Name of the person the application is for: the child (child application) or the applicant. */
  subjectName: string | null;
  summary: AnswerSummaryItem[];
  fileCount: number;
  consentGiven: boolean | null;
}

/**
 * Short answer summary for the board's list, batch-loaded (no query per row). A legacy application (no form) has an empty
 * summary. Sensitive fields never appear in a summary.
 */
export async function listExtras(clubId: string, applications: ReadonlyArray<Pick<ClubApplicationRow, "id" | "formSubmissionId" | "onBehalfOf">>, applicantNames: ReadonlyMap<string, string>, executor: DbExecutor = db): Promise<Map<string, ApplicationListExtras>> {
  const ids = applications.map((a) => a.formSubmissionId).filter((x): x is string => x !== null);
  const result = new Map<string, ApplicationListExtras>();
  const subs = ids.length === 0 ? [] : await executor.select({ sub: formSubmissions, version: formVersions }).from(formSubmissions).innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId)).where(and(inArray(formSubmissions.id, ids), eq(formSubmissions.clubId, clubId)));
  const bySubmission = new Map(subs.map((s) => [s.sub.id, s]));
  const fileCounts = new Map<string, number>();
  if (ids.length > 0) {
    for (const row of await executor.select({ submissionId: formSubmissionFiles.submissionId, n: sql<number>`count(*)::int` }).from(formSubmissionFiles).where(inArray(formSubmissionFiles.submissionId, ids)).groupBy(formSubmissionFiles.submissionId)) {
      fileCounts.set(row.submissionId, row.n);
    }
  }
  const categories = subs.length > 0 ? await clubCategories(clubId, executor) : [];
  for (const application of applications) {
    const found = application.formSubmissionId ? bySubmission.get(application.formSubmissionId) : undefined;
    if (!found) {
      result.set(application.id, { onBehalfOf: application.onBehalfOf, subjectName: applicantNames.get(application.id) ?? null, summary: [], fileCount: 0, consentGiven: null });
      continue;
    }
    const fields = found.version.fields as FormField[];
    const rendered = renderAnswers(fields, found.sub.answers, { categories, canReadSensitive: false });
    const plan = planAcceptance(fields, found.sub.answers);
    const evidence = consentEvidenceOf(found.sub, found.version);
    result.set(application.id, {
      onBehalfOf: application.onBehalfOf,
      subjectName: childDisplayName(plan) ?? applicantNames.get(application.id) ?? null,
      summary: summarizeAnswers(rendered),
      fileCount: fileCounts.get(found.sub.id) ?? 0,
      consentGiven: evidence.consentFieldKeys.length > 0,
    });
  }
  return result;
}

function consentEvidenceOf(sub: FormSubmissionRow, version: FormVersionRow): ConsentEvidence {
  return consentEvidence({ sub, version });
}

export interface ApplicationReview {
  application: { id: string; status: string; onBehalfOf: string; legacy: boolean; createdAt: Date; decidedAt: Date | null; decidedBy: string | null; clubMemberId: string | null; category: string; birthDate: string | null };
  applicant: { userId: string; name: string; email: string };
  /** The person the application is for. */
  subject: { displayName: string | null; birthDate: string | null; ageYears: number | null; isMinor: boolean | null; clubMemberId: string | null };
  form: { formId: string; formVersionId: string; version: number; name: string; purpose: string; privacyNotice: string | null; publishedAt: Date | null } | null;
  answers: RenderedAnswer[];
  /** `false` if the answers were erased by the retention rules (child application rejected / withdrawn long ago). */
  answersRetained: boolean;
  mapping: { preview: boolean; entries: MappingPreviewEntry[] };
  files: Array<{
    id: string;
    fieldKey: string;
    fieldLabel: string | null;
    kind: string;
    sensitive: boolean;
    redacted: boolean;
    filename: string | null;
    mimeType: string | null;
    sizeBytes: number | null;
    /** Authenticated retrieval (session + `members:write`, audited); never a public or signed-in-advance URL. */
    path: string | null;
    createdAt: Date;
  }>;
  consent: (ConsentEvidence & { givenBy: { userId: string; name: string }; role: "self" | "guardian"; fields: Array<{ key: string; label: string; given: boolean }>; privacyNoticeShown: boolean }) | null;
  duplicates: DuplicateHint[];
  warnings: ChildWarning[];
  decision: { decidedAt: Date | null; decidedBy: string | null; decisionNote: string | null; internalNote: string | null } | null;
  /** Field keys of sensitive answers that were delivered (for the route's audit entry). */
  sensitiveKeysRead: string[];
}

/** The review of one application of `clubId` (the caller has already scoped the application to the club). */
export async function buildApplicationReview(application: ClubApplicationRow, input: { clubId: string; canReadSensitive: boolean }, executor: DbExecutor = db): Promise<ApplicationReview> {
  const { clubId, canReadSensitive } = input;
  const [account] = await executor.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, application.userId)).limit(1);
  const applicant = { userId: application.userId, name: account?.name ?? "", email: account?.email ?? "" };
  const self = application.onBehalfOf !== "guardian";

  const [found] = application.formSubmissionId
    ? await executor
        .select({ sub: formSubmissions, version: formVersions, form: forms })
        .from(formSubmissions)
        .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
        .innerJoin(forms, eq(forms.id, formSubmissions.formId))
        .where(and(eq(formSubmissions.id, application.formSubmissionId), eq(formSubmissions.clubId, clubId)))
        .limit(1)
    : [];

  const base = {
    application: { id: application.id, status: application.status, onBehalfOf: application.onBehalfOf, legacy: application.formSubmissionId === null, createdAt: application.createdAt, decidedAt: application.decidedAt, decidedBy: application.decidedBy, clubMemberId: application.clubMemberId, category: application.category, birthDate: application.birthDate },
    applicant,
  };
  const pending = application.status === "pending";
  const today = todayBerlin();

  if (!found) {
    // Legacy application (before the form builder): category and birth date only.
    const duplicates = pending ? await duplicateHints({ clubId, self, names: [applicant.name], birthDate: application.birthDate, emails: [applicant.email], excludeClubMemberId: application.clubMemberId }, executor) : [];
    return {
      ...base,
      subject: { displayName: self ? applicant.name : null, birthDate: application.birthDate, ageYears: application.birthDate ? ageOn(application.birthDate, today) : null, isMinor: application.birthDate ? ageOn(application.birthDate, today) < 18 : null, clubMemberId: application.clubMemberId },
      form: null,
      answers: [],
      answersRetained: true,
      mapping: { preview: pending, entries: [] },
      files: [],
      consent: null,
      duplicates,
      warnings: [],
      decision: application.decidedAt ? { decidedAt: application.decidedAt, decidedBy: application.decidedBy, decisionNote: null, internalNote: null } : null,
      sensitiveKeysRead: [],
    };
  }

  const { sub, version, form } = found;
  const fields = version.fields as FormField[];
  const categories = await clubCategories(clubId, executor);
  const answers = renderAnswers(fields, sub.answers, { categories, canReadSensitive });
  const plan = planAcceptance(fields, sub.answers);
  const sensitiveByKey = new Map(fields.map((f) => [f.key, f.sensitive === true]));
  const labelByKey = new Map(fields.map((f) => [f.key, f.label]));

  const fileRows = await executor
    .select({ file: formSubmissionFiles, kind: mediaFiles.kind, sensitive: mediaFiles.sensitive })
    .from(formSubmissionFiles)
    .leftJoin(mediaFiles, eq(mediaFiles.storageKey, formSubmissionFiles.storageKey))
    .where(eq(formSubmissionFiles.submissionId, sub.id))
    .orderBy(formSubmissionFiles.createdAt, formSubmissionFiles.id);
  const files = fileRows.map(({ file, kind, sensitive }) => {
    const redacted = sensitiveByKey.get(file.fieldKey) === true && !canReadSensitive;
    return {
      id: file.id,
      fieldKey: file.fieldKey,
      fieldLabel: labelByKey.get(file.fieldKey) ?? null,
      kind: kind ?? "document",
      sensitive: sensitive ?? true,
      redacted,
      filename: redacted ? null : file.filename,
      mimeType: redacted ? null : file.mimeType,
      sizeBytes: redacted ? null : file.sizeBytes,
      path: redacted ? null : `/form-submissions/${sub.id}/files/${file.id}`,
      createdAt: file.createdAt,
    };
  });

  const customKeys = [...new Set(fields.map((f) => f.customField).filter((k): k is string => k !== undefined))];
  const definitions = customKeys.length === 0 ? [] : await executor.select().from(memberFieldDefinitions).where(and(eq(memberFieldDefinitions.clubId, clubId), inArray(memberFieldDefinitions.key, customKeys)));
  const entries = mappingPreview(fields, sub.answers, {
    definitions: new Map(definitions.map((d) => [d.key, d])),
    photoFileFieldKeys: new Set(fileRows.filter((r) => r.kind === "image").map((r) => r.file.fieldKey)),
  });

  const [submitter] = await executor.select({ name: user.name }).from(user).where(eq(user.id, sub.submittedByUserId)).limit(1);
  const evidence = consentEvidence({ sub, version }, application.clubMemberId ?? sub.subjectClubMemberId ?? undefined);
  const consentFields = fields.filter((f) => f.type === "consent").map((f) => ({ key: f.key, label: f.label, given: evidence.consentFieldKeys.includes(f.key) }));

  const subjectBirth = plan.master.birthDate ?? application.birthDate ?? null;
  const composedName = childDisplayName(plan);
  const names = [composedName, ...(self ? [applicant.name] : [])].filter((n): n is string => Boolean(n));
  const emails = [plan.master.contactEmail, applicant.email].filter((e): e is string => Boolean(e));
  const duplicates = pending ? await duplicateHints({ clubId, self, names, birthDate: subjectBirth, emails, excludeClubMemberId: application.clubMemberId }, executor) : [];

  const guardian = sub.onBehalfOf === "guardian";
  const age = subjectBirth ? ageOn(subjectBirth, today) : null;
  const erased = guardian && (sub.status === "rejected" || sub.status === "withdrawn") && Object.keys((sub.answers ?? {}) as object).length === 0;

  return {
    ...base,
    subject: { displayName: composedName ?? (self ? applicant.name : null), birthDate: subjectBirth, ageYears: age, isMinor: age === null ? null : age < 18, clubMemberId: application.clubMemberId ?? sub.subjectClubMemberId },
    form: { formId: form.id, formVersionId: version.id, version: version.version, name: form.name, purpose: form.purpose, privacyNotice: version.privacyNotice, publishedAt: version.publishedAt },
    answers,
    answersRetained: !erased,
    mapping: { preview: pending, entries },
    files,
    consent: { ...evidence, givenBy: { userId: sub.submittedByUserId, name: submitter?.name ?? "" }, role: guardian ? "guardian" : "self", fields: consentFields, privacyNoticeShown: Boolean(version.privacyNotice?.trim() || fields.some((f) => f.type === "info" && f.infoKind === "privacy_notice")) },
    duplicates,
    warnings: guardian ? childWarnings(plan.master.birthDate, today) : [],
    decision: sub.decidedAt || application.decidedAt ? { decidedAt: application.decidedAt ?? sub.decidedAt, decidedBy: application.decidedBy ?? sub.decidedBy, decisionNote: sub.decisionNote, internalNote: sub.decisionInternalNote } : null,
    sensitiveKeysRead: canReadSensitive ? answers.filter((a) => a.sensitive && a.answered).map((a) => a.key) : [],
  };
}

