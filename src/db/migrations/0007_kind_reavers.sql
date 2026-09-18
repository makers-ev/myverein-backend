CREATE TABLE "club_info_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"content_markdown" text,
	"external_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" text NOT NULL,
	"member_number" text,
	"category" text DEFAULT 'aktiv' NOT NULL,
	"joined_at" date NOT NULL,
	"left_at" date,
	"birth_date" date,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" text NOT NULL,
	"role_type" text NOT NULL,
	"department_id" uuid,
	"term_ends_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"name" text NOT NULL,
	"lead_member_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardian_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guardian_member_id" text NOT NULL,
	"ward_member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_info_pages" ADD CONSTRAINT "club_info_pages_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_roles" ADD CONSTRAINT "club_roles_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_roles" ADD CONSTRAINT "club_roles_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_lead_member_id_member_id_fk" FOREIGN KEY ("lead_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_guardian_member_id_member_id_fk" FOREIGN KEY ("guardian_member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_ward_member_id_member_id_fk" FOREIGN KEY ("ward_member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_info_pages_club_slug_uidx" ON "club_info_pages" USING btree ("club_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "club_memberships_member_id_uidx" ON "club_memberships" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "club_roles_member_id_idx" ON "club_roles" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "club_roles_department_id_idx" ON "club_roles" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "departments_club_id_idx" ON "departments" USING btree ("club_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_links_pair_uidx" ON "guardian_links" USING btree ("guardian_member_id","ward_member_id");--> statement-breakpoint
CREATE INDEX "guardian_links_ward_id_idx" ON "guardian_links" USING btree ("ward_member_id");