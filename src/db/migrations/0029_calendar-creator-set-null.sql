ALTER TABLE "calendars" DROP CONSTRAINT "calendars_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "calendars" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendars" ADD CONSTRAINT "calendars_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;