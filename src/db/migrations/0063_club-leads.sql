CREATE TABLE "club_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"department_id" uuid,
	"message" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'neu' NOT NULL,
	"trial_requested" boolean DEFAULT false NOT NULL,
	"trial_on" date,
	"waitlisted_at" timestamp with time zone,
	"notes" text,
	"privacy_accepted_at" timestamp with time zone,
	"request_count" integer DEFAULT 1 NOT NULL,
	"last_request_at" timestamp with time zone DEFAULT now() NOT NULL,
	"converted_club_member_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_leads_status_chk" CHECK ("club_leads"."status" IN ('neu', 'kontaktiert', 'probetraining', 'mitglied', 'abgelehnt')),
	CONSTRAINT "club_leads_source_chk" CHECK ("club_leads"."source" IN ('oeffentliche_seite', 'manuell'))
);
--> statement-breakpoint
ALTER TABLE "club_leads" ADD CONSTRAINT "club_leads_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_leads" ADD CONSTRAINT "club_leads_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_leads" ADD CONSTRAINT "club_leads_converted_club_member_id_club_members_id_fk" FOREIGN KEY ("converted_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_leads" ADD CONSTRAINT "club_leads_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_leads_club_status_idx" ON "club_leads" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "club_leads_club_email_idx" ON "club_leads" USING btree ("club_id","email");--> statement-breakpoint
CREATE INDEX "club_leads_waitlist_idx" ON "club_leads" USING btree ("club_id","department_id","waitlisted_at");