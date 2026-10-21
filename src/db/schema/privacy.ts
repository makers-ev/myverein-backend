import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organization, user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";

/** The five system purposes every club gets (inactive until the board has published a text). */
export const SYSTEM_CONSENT_PURPOSES = [
  { key: "foto_video", name: "Fotos und Videos", description: "Fotos und Videos von Veranstaltungen und Training erstellen und im Verein verwenden.", sortOrder: 10 },
  { key: "veroeffentlichung", name: "Veröffentlichung", description: "Fotos, Namen und Ergebnisse auf Website, in sozialen Medien oder der Presse veröffentlichen.", sortOrder: 20 },
  { key: "messenger_verteiler", name: "Messenger- und Mailverteiler", description: "Kontaktdaten in Messenger-Gruppen und Verteilern des Vereins verwenden.", sortOrder: 30 },
  { key: "verbandsweitergabe", name: "Weitergabe an den Verband", description: "Daten für Meldungen, Lizenzen oder Wettkämpfe an den Verband weitergeben.", sortOrder: 40 },
  { key: "profilfoto_ausweis", name: "Profilfoto und Ausweis", description: "Profilfoto im Verein anzeigen und auf dem Mitgliedsausweis verwenden.", sortOrder: 50 },
] as const;

export const CONSENT_ACTIONS = ["granted", "revoked"] as const;
export type ConsentAction = (typeof CONSENT_ACTIONS)[number];
/** Who recorded the consent event: the person, a guardian, or the board from a paper proof. */
export const CONSENT_GIVEN_BY = ["self", "guardian", "board_paper"] as const;
export type ConsentGivenBy = (typeof CONSENT_GIVEN_BY)[number];

/**
 * Consent purpose of a club. A consent is ALWAYS voluntary (Art. 7(4) GDPR): `requested` only drives the "open" list and
 * reminders and never blocks anything. `active` stays false until a text is published.
 */
export const consentPurposes = pgTable(
  "consent_purposes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    system: boolean("system").notNull().default(false),
    requested: boolean("requested").notNull().default(false),
    active: boolean("active").notNull().default(false),
    // Purpose-specific minimum age for consenting alone; NULL = the club's `consent_age_limit`.
    minAge: integer("min_age"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("consent_purposes_club_key_uidx").on(table.clubId, table.key)],
);

/** Versioned purpose text; once `published_at` is set the text never changes (the hash ties records to it). */
export const consentTexts = pgTable(
  "consent_texts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purposeId: uuid("purpose_id")
      .notNull()
      .references(() => consentPurposes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    sha256: text("sha256").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("consent_texts_purpose_version_uidx").on(table.purposeId, table.version)],
);

/**
 * Append-only consent events. The current state of a member + purpose is the LATEST record. A paper proof recorded by the
 * board needs the date and the source of the proof.
 */
export const consentRecords = pgTable(
  "consent_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    purposeId: uuid("purpose_id")
      .notNull()
      .references(() => consentPurposes.id, { onDelete: "cascade" }),
    textVersionId: uuid("text_version_id")
      .notNull()
      .references(() => consentTexts.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    givenBy: text("given_by").notNull(),
    // The account that recorded the event (the person, the guardian or the board member).
    recordedByUserId: text("recorded_by_user_id").references(() => user.id, { onDelete: "set null" }),
    proofDate: date("proof_date", { mode: "string" }),
    proofSource: text("proof_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("consent_records_member_purpose_idx").on(table.clubMemberId, table.purposeId, table.createdAt),
    index("consent_records_club_purpose_idx").on(table.clubId, table.purposeId),
    check("consent_records_action_chk", sql`${table.action} IN ('granted', 'revoked')`),
    check("consent_records_given_by_chk", sql`${table.givenBy} IN ('self', 'guardian', 'board_paper')`),
    check("consent_records_paper_proof_chk", sql`${table.givenBy} <> 'board_paper' OR (${table.proofDate} IS NOT NULL AND ${table.proofSource} IS NOT NULL)`),
  ],
);

export const DSR_KINDS = ["access", "erasure", "rectification"] as const;
export const DSR_STATUSES = ["open", "in_progress", "done", "rejected"] as const;

/** Access / erasure / rectification requests with a deadline (1 month, Art. 12(3) GDPR). */
export const dataSubjectRequests = pgTable(
  "data_subject_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("open"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
    handledByUserId: text("handled_by_user_id").references(() => user.id, { onDelete: "set null" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Short outcome / reason text for the file; no personal data from the export itself.
    result: text("result"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("data_subject_requests_club_status_idx").on(table.clubId, table.status, table.dueAt),
    index("data_subject_requests_member_idx").on(table.clubMemberId),
    check("data_subject_requests_kind_chk", sql`${table.kind} IN ('access', 'erasure', 'rectification')`),
    check("data_subject_requests_status_chk", sql`${table.status} IN ('open', 'in_progress', 'done', 'rejected')`),
  ],
);

/** Club override of a retention default (defaults live in code, Wave 10 B9); `club_id` NULL = platform level. */
export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id").references(() => organization.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    retainDays: integer("retain_days").notNull(),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("retention_policies_club_category_uidx").on(table.clubId, table.category).where(sql`${table.clubId} IS NOT NULL`),
    uniqueIndex("retention_policies_platform_category_uidx").on(table.category).where(sql`${table.clubId} IS NULL`),
    check("retention_policies_days_chk", sql`${table.retainDays} >= 0`),
  ],
);

/** Log of retention sweeps: counters only, never personal data. */
export const retentionRuns = pgTable(
  "retention_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id").references(() => organization.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    dryRun: boolean("dry_run").notNull().default(true),
    // The announcement run before the first real deletion of a club category (`affected` = how many items it will concern).
    notice: boolean("notice").notNull().default(false),
    scanned: integer("scanned").notNull().default(0),
    affected: integer("affected").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    errorCode: text("error_code"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("retention_runs_started_idx").on(table.startedAt), index("retention_runs_club_idx").on(table.clubId, table.startedAt)],
);

/** Processor agreement (AV-Vertrag) versions, published by platform admins. */
export const dpaVersions = pgTable(
  "dpa_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    subprocessors: jsonb("subprocessors").$type<Array<{ name: string; purpose: string; location: string }>>().notNull().default([]),
    tomAnnex: text("tom_annex"),
    sha256: text("sha256").notNull(),
    // From this date the version is mandatory for write access (after the grace period, DPA_GRACE_DAYS).
    requiredFrom: date("required_from", { mode: "string" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: text("published_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("dpa_versions_version_uidx").on(table.version)],
);

export const dpaAcceptances = pgTable(
  "dpa_acceptances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    dpaVersionId: uuid("dpa_version_id")
      .notNull()
      .references(() => dpaVersions.id, { onDelete: "restrict" }),
    acceptedByUserId: text("accepted_by_user_id").references(() => user.id, { onDelete: "set null" }),
    signerName: text("signer_name").notNull(),
    authorizedConfirmed: boolean("authorized_confirmed").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("dpa_acceptances_club_version_uidx").on(table.clubId, table.dpaVersionId)],
);

export const VISIBILITY_FIELDS = ["phone", "email", "address", "photo"] as const;
export const VISIBILITY_LEVELS = ["nur_vorstand", "trainer", "mitglieder"] as const;

/** Per-member visibility of contact fields; no row = the restrictive default (`nur_vorstand`). */
export const memberFieldVisibility = pgTable(
  "member_field_visibility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    level: text("level").notNull().default("nur_vorstand"),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("member_field_visibility_member_field_uidx").on(table.clubMemberId, table.field),
    check("member_field_visibility_field_chk", sql`${table.field} IN ('phone', 'email', 'address', 'photo')`),
    check("member_field_visibility_level_chk", sql`${table.level} IN ('nur_vorstand', 'trainer', 'mitglieder')`),
  ],
);

export type ConsentPurposeRow = typeof consentPurposes.$inferSelect;
export type ConsentTextRow = typeof consentTexts.$inferSelect;
export type ConsentRecordRow = typeof consentRecords.$inferSelect;
export type DataSubjectRequestRow = typeof dataSubjectRequests.$inferSelect;
export type DpaVersionRow = typeof dpaVersions.$inferSelect;
