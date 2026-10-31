CREATE TABLE "form_submission_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version_id" uuid NOT NULL,
	"club_id" text NOT NULL,
	"submitted_by_user_id" text NOT NULL,
	"subject_club_member_id" uuid,
	"on_behalf_of" text DEFAULT 'self' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"privacy_notice" text,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"purpose" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"options" jsonb,
	"visible_to" text DEFAULT 'vorstand' NOT NULL,
	"editable_by" text DEFAULT 'vorstand' NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_member_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"value" jsonb,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_applications" ADD COLUMN "form_submission_id" uuid;--> statement-breakpoint
ALTER TABLE "club_applications" ADD COLUMN "club_member_id" uuid;--> statement-breakpoint
ALTER TABLE "club_exit_requests" ADD COLUMN "form_submission_id" uuid;--> statement-breakpoint
ALTER TABLE "form_submission_files" ADD CONSTRAINT "form_submission_files_submission_id_form_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission_files" ADD CONSTRAINT "form_submission_files_storage_key_media_files_storage_key_fk" FOREIGN KEY ("storage_key") REFERENCES "public"."media_files"("storage_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_submitted_by_user_id_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_subject_club_member_id_club_members_id_fk" FOREIGN KEY ("subject_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_decided_by_member_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_published_by_member_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forms" ADD CONSTRAINT "forms_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_field_definitions" ADD CONSTRAINT "member_field_definitions_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_field_values" ADD CONSTRAINT "member_field_values_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_field_values" ADD CONSTRAINT "member_field_values_field_id_member_field_definitions_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."member_field_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_field_values" ADD CONSTRAINT "member_field_values_updated_by_member_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_submission_files_submission_idx" ON "form_submission_files" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "form_submissions_club_status_idx" ON "form_submissions" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "form_submissions_submitter_idx" ON "form_submissions" USING btree ("submitted_by_user_id","status");--> statement-breakpoint
CREATE INDEX "form_submissions_form_idx" ON "form_submissions" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_form_version_uidx" ON "form_versions" USING btree ("form_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "form_versions_one_draft_uidx" ON "form_versions" USING btree ("form_id") WHERE "form_versions"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "forms_club_purpose_idx" ON "forms" USING btree ("club_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_club_singleton_purpose_uidx" ON "forms" USING btree ("club_id","purpose") WHERE "forms"."purpose" IN ('aufnahme', 'austritt') AND "forms"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "member_field_definitions_club_key_uidx" ON "member_field_definitions" USING btree ("club_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "member_field_values_member_field_uidx" ON "member_field_values" USING btree ("club_member_id","field_id");--> statement-breakpoint
CREATE INDEX "member_field_values_field_idx" ON "member_field_values" USING btree ("field_id");--> statement-breakpoint
ALTER TABLE "club_applications" ADD CONSTRAINT "club_applications_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_applications" ADD CONSTRAINT "club_applications_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_exit_requests" ADD CONSTRAINT "club_exit_requests_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- >>> seed: standard forms v1 for every club (idempotent; mirrors src/lib/form-defaults.ts, keep in sync -- form-defaults.test.ts)
INSERT INTO "forms" ("club_id", "purpose", "name")
SELECT o."id", 'aufnahme', 'Aufnahmeantrag' FROM "organization" o
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "form_versions" ("form_id", "version", "status", "fields", "privacy_notice", "published_at")
SELECT f."id", 1, 'published', '[{"key":"category","type":"select","label":"Mitgliedschaft","required":true,"optionsSource":"member_categories","mapsTo":"category"},{"key":"birth_date","type":"date","label":"Geburtsdatum","required":false,"mapsTo":"birthDate"},{"key":"photo","type":"image","label":"Profilfoto (optional)","required":false,"mapsTo":"photo"},{"key":"privacy_notice","type":"info","infoKind":"privacy_notice","label":"Datenschutzhinweis","required":false},{"key":"privacy_consent","type":"consent","label":"Ich habe den Datenschutzhinweis gelesen und willige in die Verarbeitung meiner Angaben ein.","required":true}]'::jsonb, 'Wir verarbeiten deine Angaben, um über deinen Aufnahmeantrag zu entscheiden und dich als Mitglied des Vereins zu verwalten. Verantwortlich ist der Verein. Deine Daten sind nur für die zuständigen Vorstandsmitglieder sichtbar. Auskunft, Berichtigung und Löschung kannst du beim Vorstand verlangen.', now()
FROM "forms" f
WHERE f."purpose" = 'aufnahme' AND f."archived_at" IS NULL
	AND NOT EXISTS (SELECT 1 FROM "form_versions" v WHERE v."form_id" = f."id");--> statement-breakpoint
INSERT INTO "forms" ("club_id", "purpose", "name")
SELECT o."id", 'austritt', 'Austritt' FROM "organization" o
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "form_versions" ("form_id", "version", "status", "fields", "privacy_notice", "published_at")
SELECT f."id", 1, 'published', '[{"key":"reason","type":"textarea","label":"Grund (optional)","required":false,"validation":{"maxLength":1000}},{"key":"confirm","type":"checkbox","label":"Ich möchte meine Mitgliedschaft beenden.","required":true}]'::jsonb, NULL, now()
FROM "forms" f
WHERE f."purpose" = 'austritt' AND f."archived_at" IS NULL
	AND NOT EXISTS (SELECT 1 FROM "form_versions" v WHERE v."form_id" = f."id");

