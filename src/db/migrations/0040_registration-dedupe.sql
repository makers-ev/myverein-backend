-- Insurance (like 0035): rows written before this migration may already repeat a (event, reference, channel, address) key that
-- the new index covers. Keep them all, give the later repeats a unique reference suffix so the index can be built.
UPDATE "message_deliveries" d SET "ref_id" = d."ref_id" || '#dup-' || d."id"::text
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "event_key", "ref_id", "channel", "address" ORDER BY "created_at", "id") AS rn
  FROM "message_deliveries"
  WHERE "announcement_id" IS NULL AND "club_member_id" IS NULL AND "user_id" IS NULL AND "address" IS NOT NULL AND "ref_id" LIKE '%#%'
) x WHERE d."id" = x."id" AND x.rn > 1;--> statement-breakpoint
ALTER TABLE "notification" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "message_deliveries_address_event_uidx" ON "message_deliveries" USING btree ("event_key","ref_id","channel","address") WHERE "message_deliveries"."announcement_id" IS NULL AND "message_deliveries"."club_member_id" IS NULL AND "message_deliveries"."user_id" IS NULL AND "message_deliveries"."address" IS NOT NULL AND "message_deliveries"."ref_id" LIKE '%#%';--> statement-breakpoint
CREATE UNIQUE INDEX "notification_target_dedupe_uidx" ON "notification" USING btree ("target_user_id","dedupe_key") WHERE "notification"."dedupe_key" IS NOT NULL;