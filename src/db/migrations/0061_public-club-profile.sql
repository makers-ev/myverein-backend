CREATE TABLE "club_public_profiles" (
	"club_id" text PRIMARY KEY NOT NULL,
	"tagline" text,
	"description" text,
	"city" text,
	"address" text,
	"contact_email" text,
	"contact_phone" text,
	"website" text,
	"logo_key" text,
	"cover_key" text,
	"gallery_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"department_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_calendar_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"show_sponsors" boolean DEFAULT false NOT NULL,
	"lead_form_enabled" boolean DEFAULT false NOT NULL,
	"trial_training_enabled" boolean DEFAULT false NOT NULL,
	"published" jsonb,
	"published_at" timestamp with time zone,
	"published_by" text,
	"contact_consent_at" timestamp with time zone,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "public_profile_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "discoverable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_public_profiles" ADD CONSTRAINT "club_public_profiles_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_public_profiles" ADD CONSTRAINT "club_public_profiles_published_by_member_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_public_profiles" ADD CONSTRAINT "club_public_profiles_updated_by_member_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;