ALTER TABLE "events" ADD COLUMN "all_day" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "events_ends_at_idx" ON "events" USING btree ("ends_at");