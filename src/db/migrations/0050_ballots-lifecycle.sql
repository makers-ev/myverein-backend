ALTER TABLE "ballot_options" ADD COLUMN "kind" text DEFAULT 'choice' NOT NULL;--> statement-breakpoint
ALTER TABLE "ballots" ADD COLUMN "kind" text DEFAULT 'resolution' NOT NULL;--> statement-breakpoint
ALTER TABLE "ballots" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "ballots" ADD COLUMN "election_id" uuid;--> statement-breakpoint
ALTER TABLE "ballots" ADD COLUMN "round" integer;--> statement-breakpoint
ALTER TABLE "ballots" ADD COLUMN "opening" jsonb;--> statement-breakpoint
ALTER TABLE "ballots" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ballots" ADD COLUMN "counted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ballots" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "elections" ADD COLUMN "decision" jsonb;--> statement-breakpoint
ALTER TABLE "elections" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ballots_election_idx" ON "ballots" USING btree ("election_id");