ALTER TABLE "time_entries" ADD COLUMN "corrected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "auto_closed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "closed_by" text;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "closed_by_other" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "long_run_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_running_idx" ON "time_entries" USING btree ("started_at") WHERE "time_entries"."ended_at" IS NULL;