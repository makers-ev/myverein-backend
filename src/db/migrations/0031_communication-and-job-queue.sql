CREATE TABLE "club_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"author_member_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"audience" jsonb DEFAULT '{"all":true}'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '["in_app"]'::jsonb NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"publish_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text,
	"announcement_id" uuid,
	"event_key" text,
	"ref_id" text,
	"club_member_id" uuid,
	"user_id" text,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_code" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"address" text,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"club_member_id" uuid,
	"category" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_subject_chk" CHECK (("notification_preferences"."user_id" IS NOT NULL) <> ("notification_preferences"."club_member_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_token_uidx" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_dedupe_key_uidx" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "sender_name" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reply_to" text;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "timezone" text DEFAULT 'Europe/Berlin' NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_event_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_event_lead_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_loan_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_loan_lead_days" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_maintenance_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_maintenance_lead_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_rsvp_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_rsvp_lead_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "age_transition_auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "club_announcements" ADD CONSTRAINT "club_announcements_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_announcements" ADD CONSTRAINT "club_announcements_author_member_id_club_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_announcement_id_club_announcements_id_fk" FOREIGN KEY ("announcement_id") REFERENCES "public"."club_announcements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_announcements_club_status_idx" ON "club_announcements" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "club_announcements_club_publish_idx" ON "club_announcements" USING btree ("club_id","publish_at");--> statement-breakpoint
CREATE INDEX "message_deliveries_club_announcement_idx" ON "message_deliveries" USING btree ("club_id","announcement_id");--> statement-breakpoint
CREATE INDEX "message_deliveries_user_read_idx" ON "message_deliveries" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE INDEX "message_deliveries_event_ref_idx" ON "message_deliveries" USING btree ("event_key","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_deliveries_announcement_recipient_uidx" ON "message_deliveries" USING btree ("announcement_id","club_member_id","channel") WHERE "message_deliveries"."announcement_id" IS NOT NULL AND "message_deliveries"."club_member_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_uidx" ON "notification_preferences" USING btree ("user_id","category","channel") WHERE "notification_preferences"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_member_uidx" ON "notification_preferences" USING btree ("club_member_id","category","channel") WHERE "notification_preferences"."club_member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "push_tokens_user_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "jobs_status_run_at_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "jobs_type_status_idx" ON "jobs" USING btree ("type","status");