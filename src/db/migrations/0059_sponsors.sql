CREATE TABLE "sponsor_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sponsor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text,
	"email" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"name" text NOT NULL,
	"logo_key" text,
	"website" text,
	"description" text,
	"consideration" text,
	"starts_on" date,
	"ends_on" date,
	"visibility" text DEFAULT 'intern' NOT NULL,
	"notes" text,
	"linked_member_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sponsors_visibility_chk" CHECK ("sponsors"."visibility" IN ('intern', 'oeffentlich')),
	CONSTRAINT "sponsors_period_chk" CHECK ("sponsors"."ends_on" IS NULL OR "sponsors"."starts_on" IS NULL OR "sponsors"."ends_on" >= "sponsors"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "sponsor_contacts" ADD CONSTRAINT "sponsor_contacts_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_logo_key_media_files_storage_key_fk" FOREIGN KEY ("logo_key") REFERENCES "public"."media_files"("storage_key") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_linked_member_id_member_id_fk" FOREIGN KEY ("linked_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sponsor_contacts_sponsor_idx" ON "sponsor_contacts" USING btree ("sponsor_id");--> statement-breakpoint
CREATE INDEX "sponsors_club_idx" ON "sponsors" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "sponsors_linked_member_idx" ON "sponsors" USING btree ("linked_member_id");