import { relations, sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member, organization, user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { mediaFiles } from "./media-files.js";

/** `forms.purpose`. Wave 8 only surfaces `aufnahme` and `austritt`; the others exist for later waves (ADR-005). */
export const FORM_PURPOSES = ["aufnahme", "austritt", "veranstaltungsanmeldung", "einwilligung", "umfrage"] as const;
export type FormPurpose = (typeof FORM_PURPOSES)[number];

/** Purposes of which a club has at most ONE active form. */
export const SINGLETON_FORM_PURPOSES = ["aufnahme", "austritt"] as const;

export const FORM_VERSION_STATUSES = ["draft", "published", "archived"] as const;
export type FormVersionStatus = (typeof FORM_VERSION_STATUSES)[number];

export const SUBMISSION_STATUSES = ["draft", "submitted", "accepted", "rejected", "withdrawn"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const SUBMISSION_ON_BEHALF_OF = ["self", "guardian"] as const;
export type SubmissionOnBehalfOf = (typeof SUBMISSION_ON_BEHALF_OF)[number];

export const FIELD_VISIBLE_TO = ["vorstand", "funktionstraeger", "mitglied"] as const;
export type FieldVisibleTo = (typeof FIELD_VISIBLE_TO)[number];

export const FIELD_EDITABLE_BY = ["vorstand", "self"] as const;
export type FieldEditableBy = (typeof FIELD_EDITABLE_BY)[number];

/**
 * A form of a club (Wave 8, ADR-005). The content lives in immutable `form_versions`; this row only carries identity,
 * purpose and archiving. Free-text enums (no DB enums), validated in the routes/`src/lib/form-schema.ts`.
 */
export const forms = pgTable(
  "forms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // One of FORM_PURPOSES.
    purpose: text("purpose").notNull(),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("forms_club_purpose_idx").on(table.clubId, table.purpose),
    // At most one active aufnahme / austritt form per club.
    uniqueIndex("forms_club_singleton_purpose_uidx")
      .on(table.clubId, table.purpose)
      .where(sql`${table.purpose} IN ('aufnahme', 'austritt') AND ${table.archivedAt} IS NULL`),
  ],
);

/**
 * Immutable form versions: `draft` -> `published` -> `archived`. At most one draft per form. A `published`/`archived`
 * row is never edited (enforced in the routes, 409); a submission keeps pointing at the version it was filled in.
 * `fields` is the validated field definition (`src/lib/form-schema.ts`).
 */
export const formVersions = pgTable(
  "form_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // One of FORM_VERSION_STATUSES.
    status: text("status").notNull().default("draft"),
    fields: jsonb("fields").notNull().default(sql`'[]'::jsonb`),
    privacyNotice: text("privacy_notice"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("form_versions_form_version_uidx").on(table.formId, table.version),
    uniqueIndex("form_versions_one_draft_uidx")
      .on(table.formId)
      .where(sql`${table.status} = 'draft'`),
    // At most one published version per form: publishing archives the old row BEFORE the draft becomes published.
    uniqueIndex("form_versions_one_published_uidx")
      .on(table.formId)
      .where(sql`${table.status} = 'published'`),
  ],
);

/** One filled-in form (application, cancellation, ...). `answers` is keyed by field key. */
export const formSubmissions = pgTable(
  "form_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formId: uuid("form_id")
      .notNull()
      .references(() => forms.id, { onDelete: "cascade" }),
    formVersionId: uuid("form_version_id")
      .notNull()
      .references(() => formVersions.id, { onDelete: "restrict" }),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // NULL once the submitting account is deleted: decided submissions are the record of the decision (consent evidence).
    submittedByUserId: text("submitted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    // The person the answers describe, once known (a child's club_members row after acceptance).
    subjectClubMemberId: uuid("subject_club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    // One of SUBMISSION_ON_BEHALF_OF.
    onBehalfOf: text("on_behalf_of").notNull().default("self"),
    answers: jsonb("answers").notNull().default(sql`'{}'::jsonb`),
    // One of SUBMISSION_STATUSES.
    status: text("status").notNull().default("draft"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").references(() => member.id, { onDelete: "set null" }),
    // Message of the board TO the applicant (shown in the applicant's own submission view).
    decisionNote: text("decision_note"),
    // Internal note of the board; never part of an applicant-facing response.
    decisionInternalNote: text("decision_internal_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("form_submissions_club_status_idx").on(table.clubId, table.status),
    index("form_submissions_submitter_idx").on(table.submittedByUserId, table.status),
    index("form_submissions_form_idx").on(table.formId),
  ],
);

/** File / photo answers. `storage_key` points at the `media_files` register (never a URL, ADR-004). */
export const formSubmissionFiles = pgTable(
  "form_submission_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => formSubmissions.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(),
    storageKey: text("storage_key")
      .notNull()
      .references(() => mediaFiles.storageKey, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("form_submission_files_submission_idx").on(table.submissionId)],
);

/** Custom field definitions per club (extra member data such as shirt size). Archived, never deleted, once values exist. */
export const memberFieldDefinitions = pgTable(
  "member_field_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    // text | textarea | number | date | select | multiselect | checkbox | credential (validated in `src/lib/form-schema.ts`).
    fieldType: text("field_type").notNull(),
    // select/multiselect: the choices; credential: the optional levels ("Stufe").
    options: jsonb("options"),
    // Form-engine limits of the definition (text length, number range, free-text level length of a credential); NULL = defaults.
    validation: jsonb("validation"),
    // Short explanation shown next to the field (profile modules carry one; NULL = none).
    helpText: text("help_text"),
    // One of FIELD_VISIBLE_TO / FIELD_EDITABLE_BY.
    visibleTo: text("visible_to").notNull().default("vorstand"),
    editableBy: text("editable_by").notNull().default("vorstand"),
    sensitive: boolean("sensitive").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("member_field_definitions_club_key_uidx").on(table.clubId, table.key)],
);

/** Value of one custom field for one club member (JSONB, shape per field type). */
export const memberFieldValues = pgTable(
  "member_field_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => memberFieldDefinitions.id, { onDelete: "cascade" }),
    value: jsonb("value"),
    updatedBy: text("updated_by").references(() => member.id, { onDelete: "set null" }),
    // `guardian` when a guardian (Erziehungsberechtigte) of the child recorded the value; null otherwise (self / board decided by updated_by).
    enteredVia: text("entered_via"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("member_field_values_member_field_uidx").on(table.clubMemberId, table.fieldId),
    index("member_field_values_field_idx").on(table.fieldId),
  ],
);

export const formsRelations = relations(forms, ({ one, many }) => ({
  club: one(organization, { fields: [forms.clubId], references: [organization.id] }),
  versions: many(formVersions),
}));

export const formVersionsRelations = relations(formVersions, ({ one }) => ({
  form: one(forms, { fields: [formVersions.formId], references: [forms.id] }),
}));

export const formSubmissionsRelations = relations(formSubmissions, ({ one, many }) => ({
  form: one(forms, { fields: [formSubmissions.formId], references: [forms.id] }),
  version: one(formVersions, { fields: [formSubmissions.formVersionId], references: [formVersions.id] }),
  files: many(formSubmissionFiles),
}));

export const formSubmissionFilesRelations = relations(formSubmissionFiles, ({ one }) => ({
  submission: one(formSubmissions, { fields: [formSubmissionFiles.submissionId], references: [formSubmissions.id] }),
}));

export type FormRow = typeof forms.$inferSelect;
export type FormVersionRow = typeof formVersions.$inferSelect;
export type FormSubmissionRow = typeof formSubmissions.$inferSelect;
export type FormSubmissionFileRow = typeof formSubmissionFiles.$inferSelect;
export type MemberFieldDefinitionRow = typeof memberFieldDefinitions.$inferSelect;
export type MemberFieldValueRow = typeof memberFieldValues.$inferSelect;
