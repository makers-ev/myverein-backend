CREATE TABLE "absence_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"club_member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"note" text,
	"reported_by_user_id" text,
	"reported_by_kind" text DEFAULT 'self' NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "absence_reports_kind_chk" CHECK ("absence_reports"."kind" IN ('krank', 'abwesend')),
	CONSTRAINT "absence_reports_period_chk" CHECK ("absence_reports"."ends_on" >= "absence_reports"."starts_on"),
	CONSTRAINT "absence_reports_reported_by_chk" CHECK ("absence_reports"."reported_by_kind" IN ('self', 'guardian')),
	CONSTRAINT "absence_reports_note_len_chk" CHECK ("absence_reports"."note" IS NULL OR char_length("absence_reports"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "ward_event_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"ward_club_member_id" uuid NOT NULL,
	"status" text NOT NULL,
	"responded_by_user_id" text,
	"responded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_privacy_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"sha256" text NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_purposes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"system" boolean DEFAULT false NOT NULL,
	"requested" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"min_age" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"club_member_id" uuid NOT NULL,
	"purpose_id" uuid NOT NULL,
	"text_version_id" uuid NOT NULL,
	"action" text NOT NULL,
	"given_by" text NOT NULL,
	"recorded_by_user_id" text,
	"proof_date" date,
	"proof_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_records_action_chk" CHECK ("consent_records"."action" IN ('granted', 'revoked')),
	CONSTRAINT "consent_records_given_by_chk" CHECK ("consent_records"."given_by" IN ('self', 'guardian', 'board_paper')),
	CONSTRAINT "consent_records_paper_proof_chk" CHECK ("consent_records"."given_by" <> 'board_paper' OR ("consent_records"."proof_date" IS NOT NULL AND "consent_records"."proof_source" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "consent_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"sha256" text NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_subject_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"club_member_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"requested_by_user_id" text,
	"handled_by_user_id" text,
	"completed_at" timestamp with time zone,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_subject_requests_kind_chk" CHECK ("data_subject_requests"."kind" IN ('access', 'erasure', 'rectification')),
	CONSTRAINT "data_subject_requests_status_chk" CHECK ("data_subject_requests"."status" IN ('open', 'in_progress', 'done', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "dpa_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"dpa_version_id" uuid NOT NULL,
	"accepted_by_user_id" text,
	"signer_name" text NOT NULL,
	"authorized_confirmed" boolean NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dpa_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"subprocessors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tom_annex" text,
	"sha256" text NOT NULL,
	"required_from" date,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_field_visibility" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_member_id" uuid NOT NULL,
	"field" text NOT NULL,
	"level" text DEFAULT 'nur_vorstand' NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_field_visibility_field_chk" CHECK ("member_field_visibility"."field" IN ('phone', 'email', 'address', 'photo')),
	CONSTRAINT "member_field_visibility_level_chk" CHECK ("member_field_visibility"."level" IN ('nur_vorstand', 'trainer', 'mitglieder'))
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text,
	"category" text NOT NULL,
	"retain_days" integer NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policies_days_chk" CHECK ("retention_policies"."retain_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retention_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text,
	"category" text NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"scanned" integer DEFAULT 0 NOT NULL,
	"affected" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "club_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_user_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "subject_member_id" text;--> statement-breakpoint
ALTER TABLE "club_applications" ADD COLUMN "privacy_notice_version_id" uuid;--> statement-breakpoint
ALTER TABLE "club_applications" ADD COLUMN "privacy_notice_acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "privacy_notice_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "privacy_notice_version_id" uuid;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "consent_age_limit" integer DEFAULT 18 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "consent_both_guardians" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "privacy_contact" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "privacy_controller" text;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "relationship" text;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "has_custody" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "can_consent" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "can_report_absence" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "valid_from" date DEFAULT CURRENT_DATE NOT NULL;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "absence_reports" ADD CONSTRAINT "absence_reports_reported_by_user_id_user_id_fk" FOREIGN KEY ("reported_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ward_event_responses" ADD CONSTRAINT "ward_event_responses_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ward_event_responses" ADD CONSTRAINT "ward_event_responses_ward_club_member_id_club_members_id_fk" FOREIGN KEY ("ward_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ward_event_responses" ADD CONSTRAINT "ward_event_responses_responded_by_user_id_user_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_privacy_notices" ADD CONSTRAINT "club_privacy_notices_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_privacy_notices" ADD CONSTRAINT "club_privacy_notices_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_purposes" ADD CONSTRAINT "consent_purposes_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_purpose_id_consent_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."consent_purposes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_text_version_id_consent_texts_id_fk" FOREIGN KEY ("text_version_id") REFERENCES "public"."consent_texts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_recorded_by_user_id_user_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_texts" ADD CONSTRAINT "consent_texts_purpose_id_consent_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."consent_purposes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_texts" ADD CONSTRAINT "consent_texts_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_handled_by_user_id_user_id_fk" FOREIGN KEY ("handled_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpa_acceptances" ADD CONSTRAINT "dpa_acceptances_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpa_acceptances" ADD CONSTRAINT "dpa_acceptances_dpa_version_id_dpa_versions_id_fk" FOREIGN KEY ("dpa_version_id") REFERENCES "public"."dpa_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpa_acceptances" ADD CONSTRAINT "dpa_acceptances_accepted_by_user_id_user_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dpa_versions" ADD CONSTRAINT "dpa_versions_published_by_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_field_visibility" ADD CONSTRAINT "member_field_visibility_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_field_visibility" ADD CONSTRAINT "member_field_visibility_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_runs" ADD CONSTRAINT "retention_runs_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "absence_reports_club_period_idx" ON "absence_reports" USING btree ("club_id","starts_on","ends_on");--> statement-breakpoint
CREATE INDEX "absence_reports_member_idx" ON "absence_reports" USING btree ("club_member_id","starts_on");--> statement-breakpoint
CREATE UNIQUE INDEX "ward_event_responses_event_ward_uidx" ON "ward_event_responses" USING btree ("event_id","ward_club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "club_privacy_notices_club_version_uidx" ON "club_privacy_notices" USING btree ("club_id","version");--> statement-breakpoint
CREATE INDEX "club_privacy_notices_club_published_idx" ON "club_privacy_notices" USING btree ("club_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_purposes_club_key_uidx" ON "consent_purposes" USING btree ("club_id","key");--> statement-breakpoint
CREATE INDEX "consent_records_member_purpose_idx" ON "consent_records" USING btree ("club_member_id","purpose_id","created_at");--> statement-breakpoint
CREATE INDEX "consent_records_club_purpose_idx" ON "consent_records" USING btree ("club_id","purpose_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_texts_purpose_version_uidx" ON "consent_texts" USING btree ("purpose_id","version");--> statement-breakpoint
CREATE INDEX "data_subject_requests_club_status_idx" ON "data_subject_requests" USING btree ("club_id","status","due_at");--> statement-breakpoint
CREATE INDEX "data_subject_requests_member_idx" ON "data_subject_requests" USING btree ("club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dpa_acceptances_club_version_uidx" ON "dpa_acceptances" USING btree ("club_id","dpa_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dpa_versions_version_uidx" ON "dpa_versions" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "member_field_visibility_member_field_uidx" ON "member_field_visibility" USING btree ("club_member_id","field");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_club_category_uidx" ON "retention_policies" USING btree ("club_id","category") WHERE "retention_policies"."club_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_platform_category_uidx" ON "retention_policies" USING btree ("category") WHERE "retention_policies"."club_id" IS NULL;--> statement-breakpoint
CREATE INDEX "retention_runs_started_idx" ON "retention_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "retention_runs_club_idx" ON "retention_runs" USING btree ("club_id","started_at");--> statement-breakpoint
ALTER TABLE "club_applications" ADD CONSTRAINT "club_applications_privacy_notice_version_id_club_privacy_notices_id_fk" FOREIGN KEY ("privacy_notice_version_id") REFERENCES "public"."club_privacy_notices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_privacy_notice_version_id_club_privacy_notices_id_fk" FOREIGN KEY ("privacy_notice_version_id") REFERENCES "public"."club_privacy_notices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_confirmed_by_member_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_club_created_idx" ON "audit_log" USING btree ("club_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_club_member_idx" ON "audit_log" USING btree ("club_id","subject_member_id","created_at");--> statement-breakpoint
UPDATE "guardian_links" SET "valid_from" = "created_at"::date, "confirmed_at" = "created_at" WHERE "confirmed_at" IS NULL;--> statement-breakpoint
UPDATE "audit_log" SET "club_id" = "payload"->>'clubId' WHERE "club_id" IS NULL AND jsonb_typeof("payload") = 'object' AND jsonb_typeof("payload"->'clubId') = 'string';--> statement-breakpoint
UPDATE "audit_log" SET "actor_user_id" = "subject_id" WHERE "actor_user_id" IS NULL AND "event_type" = 'session.create';--> statement-breakpoint
UPDATE "audit_log" SET "subject_member_id" = "payload"->>'clubMemberId' WHERE "subject_member_id" IS NULL AND jsonb_typeof("payload") = 'object' AND jsonb_typeof("payload"->'clubMemberId') = 'string';--> statement-breakpoint
INSERT INTO "consent_purposes" ("club_id", "key", "name", "description", "system", "sort_order")
SELECT o."id", p."key", p."name", p."description", true, p."sort_order"
FROM "organization" o
CROSS JOIN (VALUES
  ('foto_video', 'Fotos und Videos', 'Fotos und Videos von Veranstaltungen und Training erstellen und im Verein verwenden.', 10),
  ('veroeffentlichung', 'Veröffentlichung', 'Fotos, Namen und Ergebnisse auf Website, in sozialen Medien oder der Presse veröffentlichen.', 20),
  ('messenger_verteiler', 'Messenger- und Mailverteiler', 'Kontaktdaten in Messenger-Gruppen und Verteilern des Vereins verwenden.', 30),
  ('verbandsweitergabe', 'Weitergabe an den Verband', 'Daten für Meldungen, Lizenzen oder Wettkämpfe an den Verband weitergeben.', 40),
  ('profilfoto_ausweis', 'Profilfoto und Ausweis', 'Profilfoto im Verein anzeigen und auf dem Mitgliedsausweis verwenden.', 50)
) AS p("key", "name", "description", "sort_order")
ON CONFLICT ("club_id", "key") DO NOTHING;
