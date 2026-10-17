ALTER TABLE "member_categories" ADD COLUMN "applicant_selectable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill: the standard categories an applicant may choose (ehrenmitglied and custom categories stay board-only).
UPDATE "member_categories" SET "applicant_selectable" = true WHERE "key" IN ('aktiv', 'passiv', 'foerdernd', 'jugend');
