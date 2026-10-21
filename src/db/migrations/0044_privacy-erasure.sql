ALTER TABLE "meeting_attendance" DROP CONSTRAINT "meeting_attendance_member_id_member_id_fk";
--> statement-breakpoint
ALTER TABLE "meeting_attendance" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "legal_hold_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "legal_hold_reason" text;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;