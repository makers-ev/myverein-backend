CREATE TABLE "club_plans" (
	"club_id" text PRIMARY KEY NOT NULL,
	"tier" text NOT NULL,
	"valid_from" date,
	"valid_until" date,
	"member_limit" integer,
	"note" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_plans_period_chk" CHECK ("club_plans"."valid_until" IS NULL OR "club_plans"."valid_from" IS NULL OR "club_plans"."valid_until" >= "club_plans"."valid_from"),
	CONSTRAINT "club_plans_limit_chk" CHECK ("club_plans"."member_limit" IS NULL OR "club_plans"."member_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "club_platform_status" (
	"club_id" text PRIMARY KEY NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_by" text,
	"suspension_reason" text,
	"suspension_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_status_history_action_chk" CHECK ("club_status_history"."action" IN ('suspend', 'unsuspend'))
);
--> statement-breakpoint
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_platform_status" ADD CONSTRAINT "club_platform_status_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_platform_status" ADD CONSTRAINT "club_platform_status_suspended_by_user_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_status_history" ADD CONSTRAINT "club_status_history_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_status_history" ADD CONSTRAINT "club_status_history_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_status_history_club_idx" ON "club_status_history" USING btree ("club_id","created_at");