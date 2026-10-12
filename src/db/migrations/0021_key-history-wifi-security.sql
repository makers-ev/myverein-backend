CREATE TABLE "location_key_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"action" text NOT NULL,
	"member_id" text,
	"member_name" text NOT NULL,
	"key_label" text,
	"note" text,
	"recorded_by" text,
	"recorded_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "location_wifi_networks" ADD COLUMN "security" text DEFAULT 'wpa' NOT NULL;--> statement-breakpoint
ALTER TABLE "location_key_holders" ADD COLUMN "key_label" text;--> statement-breakpoint
ALTER TABLE "location_key_history" ADD CONSTRAINT "location_key_history_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_key_history" ADD CONSTRAINT "location_key_history_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_key_history" ADD CONSTRAINT "location_key_history_recorded_by_member_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_key_history_location_idx" ON "location_key_history" USING btree ("location_id","created_at");--> statement-breakpoint
-- Existing password-less networks were already treated as open by the QR code (T:nopass); everything else stays WPA/WPA2.
UPDATE "location_wifi_networks" SET "security" = 'open' WHERE "password" = '';--> statement-breakpoint
-- Current key holders get one 'issued' entry so the history starts consistent with the list (date unknown -> migration time).
INSERT INTO "location_key_history" ("location_id", "action", "member_id", "member_name", "note")
SELECT kh."location_id", 'issued', kh."member_id", coalesce(u."name", ''), 'Bestand bei Einführung der Schlüsselhistorie'
FROM "location_key_holders" kh
LEFT JOIN "member" m ON m."id" = kh."member_id"
LEFT JOIN "user" u ON u."id" = m."user_id";
