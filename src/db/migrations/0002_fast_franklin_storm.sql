CREATE TABLE "notification_template" (
	"translation_key" text PRIMARY KEY NOT NULL,
	"title_de" text NOT NULL,
	"title_en" text NOT NULL,
	"body_de" text NOT NULL,
	"body_en" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" text
);
--> statement-breakpoint
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_updated_by_admin_id_user_id_fk" FOREIGN KEY ("updated_by_admin_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;