-- B7/B8/B17: wifi/link visibility levels, controlled meeting types, resolution corrections
ALTER TABLE "location_links" ADD COLUMN "visibility" text DEFAULT 'mitglied' NOT NULL;--> statement-breakpoint
ALTER TABLE "location_wifi_networks" ADD COLUMN "visibility" text DEFAULT 'mitglied' NOT NULL;--> statement-breakpoint
-- visible_to_guests = true -> 'gast'; false -> 'mitglied' (until now every member saw everything, so nothing becomes more restricted)
UPDATE "location_links" SET "visibility" = CASE WHEN "visible_to_guests" THEN 'gast' ELSE 'mitglied' END;--> statement-breakpoint
UPDATE "location_wifi_networks" SET "visibility" = CASE WHEN "visible_to_guests" THEN 'gast' ELSE 'mitglied' END;--> statement-breakpoint
ALTER TABLE "location_links" DROP COLUMN "visible_to_guests";--> statement-breakpoint
ALTER TABLE "location_wifi_networks" DROP COLUMN "visible_to_guests";--> statement-breakpoint
-- meetings.type: free text -> vorstandssitzung | mitgliederversammlung | sonstige (ambiguous legacy values land in the more restricted type)
UPDATE "meetings" SET "type" = CASE
	WHEN lower("type") LIKE '%vorstand%' OR lower("type") LIKE '%sitzung%' THEN 'vorstandssitzung'
	WHEN lower("type") LIKE '%versammlung%' THEN 'mitgliederversammlung'
	ELSE 'sonstige'
END;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD COLUMN "correction_note" text;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD COLUMN "corrected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD COLUMN "corrected_by" text;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD CONSTRAINT "meeting_resolutions_corrected_by_user_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
