CREATE TABLE "club_external_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"email" text NOT NULL,
	"role_type" text NOT NULL,
	"display_name" text NOT NULL,
	"sponsor_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_member_id" text,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_external_invites_role_chk" CHECK ("club_external_invites"."role_type" IN ('sponsor', 'dienstleister'))
);
--> statement-breakpoint
CREATE TABLE "external_access_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"member_id" text NOT NULL,
	"location_id" uuid,
	"title" text NOT NULL,
	"note" text,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_access_assignments_window_chk" CHECK ("external_access_assignments"."valid_until" > "external_access_assignments"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "club_external_invites" ADD CONSTRAINT "club_external_invites_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_external_invites" ADD CONSTRAINT "club_external_invites_sponsor_id_sponsors_id_fk" FOREIGN KEY ("sponsor_id") REFERENCES "public"."sponsors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_external_invites" ADD CONSTRAINT "club_external_invites_accepted_member_id_member_id_fk" FOREIGN KEY ("accepted_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_external_invites" ADD CONSTRAINT "club_external_invites_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_access_assignments" ADD CONSTRAINT "external_access_assignments_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_access_assignments" ADD CONSTRAINT "external_access_assignments_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_access_assignments" ADD CONSTRAINT "external_access_assignments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_access_assignments" ADD CONSTRAINT "external_access_assignments_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_external_invites_token_hash_uidx" ON "club_external_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "club_external_invites_club_idx" ON "club_external_invites" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "external_access_assignments_member_idx" ON "external_access_assignments" USING btree ("member_id","valid_until");--> statement-breakpoint
CREATE INDEX "external_access_assignments_club_idx" ON "external_access_assignments" USING btree ("club_id");