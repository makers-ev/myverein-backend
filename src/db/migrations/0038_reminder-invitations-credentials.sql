ALTER TABLE "club_settings" ADD COLUMN "reminder_invitation_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_invitation_lead_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_credential_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "reminder_credential_lead_days" integer DEFAULT 30 NOT NULL;