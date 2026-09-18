ALTER TABLE "notification_template" ALTER COLUMN "translations" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notification" DROP COLUMN "title_de";--> statement-breakpoint
ALTER TABLE "notification" DROP COLUMN "title_en";--> statement-breakpoint
ALTER TABLE "notification" DROP COLUMN "body_de";--> statement-breakpoint
ALTER TABLE "notification" DROP COLUMN "body_en";--> statement-breakpoint
ALTER TABLE "notification_template" DROP COLUMN "title_de";--> statement-breakpoint
ALTER TABLE "notification_template" DROP COLUMN "title_en";--> statement-breakpoint
ALTER TABLE "notification_template" DROP COLUMN "body_de";--> statement-breakpoint
ALTER TABLE "notification_template" DROP COLUMN "body_en";