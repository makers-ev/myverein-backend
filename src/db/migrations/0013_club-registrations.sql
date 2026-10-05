CREATE TABLE "club_registration_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"club_name" text NOT NULL,
	"legal_form" text NOT NULL,
	"register_court" text,
	"register_number" text,
	"street" text NOT NULL,
	"postal_code" text NOT NULL,
	"city" text NOT NULL,
	"website_url" text,
	"claimed_role" text DEFAULT 'vorsitz' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"review_note" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"club_id" text,
	"slug_suggestion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "club_registration_documents" ADD CONSTRAINT "club_registration_documents_registration_id_club_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."club_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_registrations" ADD CONSTRAINT "club_registrations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_registrations" ADD CONSTRAINT "club_registrations_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_registrations" ADD CONSTRAINT "club_registrations_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_registration_documents_registration_idx" ON "club_registration_documents" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "club_registrations_open_user_uidx" ON "club_registrations" USING btree ("user_id") WHERE "club_registrations"."status" IN ('draft', 'pending', 'needs_info');--> statement-breakpoint
CREATE INDEX "club_registrations_status_idx" ON "club_registrations" USING btree ("status","submitted_at");