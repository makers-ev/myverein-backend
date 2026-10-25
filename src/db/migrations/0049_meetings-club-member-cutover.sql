ALTER TABLE "meeting_attendance" DROP CONSTRAINT "meeting_attendance_member_id_member_id_fk";
--> statement-breakpoint
ALTER TABLE "meeting_attendance" DROP CONSTRAINT "meeting_attendance_proxy_for_member_id_member_id_fk";
--> statement-breakpoint
ALTER TABLE "meeting_invitees" DROP CONSTRAINT "meeting_invitees_member_id_member_id_fk";
--> statement-breakpoint
DROP INDEX "meeting_attendance_meeting_member_uidx";--> statement-breakpoint
DROP INDEX "meeting_invitees_meeting_member_uidx";--> statement-breakpoint
ALTER TABLE "meeting_invitees" ALTER COLUMN "club_member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "meeting_attendance" DROP COLUMN "member_id";--> statement-breakpoint
ALTER TABLE "meeting_attendance" DROP COLUMN "proxy_for_member_id";--> statement-breakpoint
ALTER TABLE "meeting_invitees" DROP COLUMN "member_id";