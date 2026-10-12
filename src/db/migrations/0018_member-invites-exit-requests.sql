CREATE TABLE "club_member_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_member_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "account_unlinked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_member_invites" ADD CONSTRAINT "club_member_invites_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_invites" ADD CONSTRAINT "club_member_invites_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_member_invites_token_hash_uidx" ON "club_member_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "club_member_invites_open_uidx" ON "club_member_invites" USING btree ("club_member_id") WHERE "club_member_invites"."accepted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "club_member_invites_member_idx" ON "club_member_invites" USING btree ("club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "club_exit_requests_pending_uidx" ON "club_exit_requests" USING btree ("club_member_id") WHERE "club_exit_requests"."status" = 'pending';