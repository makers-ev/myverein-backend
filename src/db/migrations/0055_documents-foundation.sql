CREATE TABLE "club_info_page_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"club_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"title" text NOT NULL,
	"content_markdown" text,
	"external_url" text,
	"valid_from" date,
	"document_id" uuid,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_acknowledgements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"club_member_id" uuid NOT NULL,
	"status" text DEFAULT 'offen' NOT NULL,
	"wording" text NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"acted_by_user_id" text,
	"acted_by_club_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"system_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"folder_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"role_type" text,
	"department_id" uuid,
	"club_member_id" uuid,
	"level" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_permissions_subject_chk" CHECK (("document_permissions"."subject_type" = 'rolle' AND "document_permissions"."role_type" IS NOT NULL AND "document_permissions"."department_id" IS NULL AND "document_permissions"."club_member_id" IS NULL)
        OR ("document_permissions"."subject_type" = 'abteilung' AND "document_permissions"."department_id" IS NOT NULL AND "document_permissions"."role_type" IS NULL AND "document_permissions"."club_member_id" IS NULL)
        OR ("document_permissions"."subject_type" = 'mitglied' AND "document_permissions"."club_member_id" IS NOT NULL AND "document_permissions"."role_type" IS NULL AND "document_permissions"."department_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"club_id" text NOT NULL,
	"version_no" integer NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text NOT NULL,
	"note" text,
	"template_id" text,
	"template_version" integer,
	"input_hash" text,
	"engine_version" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"scope" text NOT NULL,
	"folder_id" uuid,
	"owner_club_member_id" uuid,
	"kind" text NOT NULL,
	"doc_type" text DEFAULT 'upload' NOT NULL,
	"title" text NOT NULL,
	"current_version_id" uuid,
	"status" text DEFAULT 'aktiv' NOT NULL,
	"hidden_by_owner" boolean DEFAULT false NOT NULL,
	"trashed_at" timestamp with time zone,
	"trashed_by" text,
	"retention_until" date,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_scope_chk" CHECK (("documents"."scope" = 'verein' AND "documents"."owner_club_member_id" IS NULL) OR ("documents"."scope" = 'person' AND "documents"."owner_club_member_id" IS NOT NULL AND "documents"."folder_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "member_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"club_member_id" uuid NOT NULL,
	"status" text DEFAULT 'aktiv' NOT NULL,
	"token_version" integer DEFAULT 1 NOT NULL,
	"valid_until" date,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "render_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"template_id" text NOT NULL,
	"template_version" integer NOT NULL,
	"status" text DEFAULT 'wartet' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" text,
	"subject_club_member_id" uuid,
	"document_id" uuid,
	"version_id" uuid,
	"input_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_info_pages" ADD COLUMN "current_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_info_pages" ADD COLUMN "updated_by" text;--> statement-breakpoint
ALTER TABLE "club_info_pages" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "club_info_pages" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "brand_logo_key" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "brand_primary_color" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "brand_accent_color" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "letterhead_address" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "letterhead_register" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "letterhead_representatives" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "letterhead_contact" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "letterhead_footer" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "storage_quota_bytes" bigint;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "storage_notice_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_info_page_versions" ADD CONSTRAINT "club_info_page_versions_page_id_club_info_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."club_info_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_info_page_versions" ADD CONSTRAINT "club_info_page_versions_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_info_page_versions" ADD CONSTRAINT "club_info_page_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_info_page_versions" ADD CONSTRAINT "club_info_page_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_acted_by_user_id_user_id_fk" FOREIGN KEY ("acted_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_acknowledgements" ADD CONSTRAINT "document_acknowledgements_acted_by_club_member_id_club_members_id_fk" FOREIGN KEY ("acted_by_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_parent_id_document_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."document_folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_folders" ADD CONSTRAINT "document_folders_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_permissions" ADD CONSTRAINT "document_permissions_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_permissions" ADD CONSTRAINT "document_permissions_folder_id_document_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."document_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_permissions" ADD CONSTRAINT "document_permissions_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_permissions" ADD CONSTRAINT "document_permissions_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_permissions" ADD CONSTRAINT "document_permissions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_document_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."document_folders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_club_member_id_club_members_id_fk" FOREIGN KEY ("owner_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_document_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_trashed_by_user_id_fk" FOREIGN KEY ("trashed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_cards" ADD CONSTRAINT "member_cards_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_cards" ADD CONSTRAINT "member_cards_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_cards" ADD CONSTRAINT "member_cards_issued_by_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_requested_by_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_subject_club_member_id_club_members_id_fk" FOREIGN KEY ("subject_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "render_jobs" ADD CONSTRAINT "render_jobs_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_info_page_versions_page_no_uidx" ON "club_info_page_versions" USING btree ("page_id","version_no");--> statement-breakpoint
CREATE INDEX "club_info_page_versions_club_idx" ON "club_info_page_versions" USING btree ("club_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_ack_version_member_uidx" ON "document_acknowledgements" USING btree ("version_id","club_member_id");--> statement-breakpoint
CREATE INDEX "document_ack_club_status_idx" ON "document_acknowledgements" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "document_ack_member_idx" ON "document_acknowledgements" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX "document_folders_club_parent_idx" ON "document_folders" USING btree ("club_id","parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_folders_system_key_uidx" ON "document_folders" USING btree ("club_id","system_key") WHERE "document_folders"."system_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "document_permissions_folder_idx" ON "document_permissions" USING btree ("folder_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_permissions_role_uidx" ON "document_permissions" USING btree ("folder_id","role_type") WHERE "document_permissions"."subject_type" = 'rolle';--> statement-breakpoint
CREATE UNIQUE INDEX "document_permissions_department_uidx" ON "document_permissions" USING btree ("folder_id","department_id") WHERE "document_permissions"."subject_type" = 'abteilung';--> statement-breakpoint
CREATE UNIQUE INDEX "document_permissions_member_uidx" ON "document_permissions" USING btree ("folder_id","club_member_id") WHERE "document_permissions"."subject_type" = 'mitglied';--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_doc_no_uidx" ON "document_versions" USING btree ("document_id","version_no");--> statement-breakpoint
CREATE INDEX "document_versions_club_idx" ON "document_versions" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "documents_club_folder_idx" ON "documents" USING btree ("club_id","folder_id");--> statement-breakpoint
CREATE INDEX "documents_owner_idx" ON "documents" USING btree ("owner_club_member_id");--> statement-breakpoint
CREATE INDEX "documents_retention_idx" ON "documents" USING btree ("retention_until") WHERE "documents"."retention_until" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_club_status_idx" ON "documents" USING btree ("club_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "member_cards_club_member_uidx" ON "member_cards" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX "member_cards_club_idx" ON "member_cards" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "render_jobs_club_status_idx" ON "render_jobs" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "render_jobs_subject_idx" ON "render_jobs" USING btree ("subject_club_member_id");--> statement-breakpoint
ALTER TABLE "club_info_pages" ADD CONSTRAINT "club_info_pages_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_info_pages" ADD CONSTRAINT "club_info_pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
-- Existing info pages become version 1 of their history (lossless: same title, content, link, timestamp).
INSERT INTO "club_info_page_versions" ("page_id", "club_id", "version_no", "title", "content_markdown", "external_url", "note", "created_at")
SELECT "id", "club_id", 1, "title", "content_markdown", "external_url", 'Migrated from the single-version page', "updated_at" FROM "club_info_pages"
ON CONFLICT DO NOTHING;
