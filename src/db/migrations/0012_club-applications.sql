CREATE TABLE "club_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"club_id" text NOT NULL,
	"category" text DEFAULT 'aktiv' NOT NULL,
	"birth_date" date,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text
);
--> statement-breakpoint
ALTER TABLE "club_applications" ADD CONSTRAINT "club_applications_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_applications" ADD CONSTRAINT "club_applications_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_applications" ADD CONSTRAINT "club_applications_decided_by_member_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_applications_pending_user_club_uidx" ON "club_applications" USING btree ("user_id","club_id") WHERE "club_applications"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "club_applications_club_status_idx" ON "club_applications" USING btree ("club_id","status");