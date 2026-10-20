-- In-app/push rows no longer carry the recipient name (only the e-mail salutation needs it).
UPDATE "message_deliveries" SET "content" = "content" - 'recipientName' WHERE "channel" IN ('in_app', 'push') AND "content" ? 'recipientName';--> statement-breakpoint
-- Existing rows may already contain repeats (no idempotency before this migration). Keep them: repeated system rows get
-- a unique ref_id suffix, repeated account-only announcement rows (never legitimate) are dropped.
UPDATE "message_deliveries" d SET "ref_id" = coalesce(d."ref_id", '') || '#dup-' || d."id"::text
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "event_key", "ref_id", "channel", coalesce("club_member_id"::text, "user_id") ORDER BY "created_at", "id") AS rn
  FROM "message_deliveries" WHERE "announcement_id" IS NULL AND "event_key" IS NOT NULL AND "ref_id" IS NOT NULL
) x WHERE d."id" = x."id" AND x.rn > 1;--> statement-breakpoint
DELETE FROM "message_deliveries" d USING (
  SELECT "id", row_number() OVER (PARTITION BY "announcement_id", "user_id", "channel" ORDER BY "created_at", "id") AS rn
  FROM "message_deliveries" WHERE "announcement_id" IS NOT NULL AND "club_member_id" IS NULL
) x WHERE d."id" = x."id" AND x.rn > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "message_deliveries_announcement_user_uidx" ON "message_deliveries" USING btree ("announcement_id","user_id","channel") WHERE "message_deliveries"."announcement_id" IS NOT NULL AND "message_deliveries"."club_member_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "message_deliveries_system_event_uidx" ON "message_deliveries" USING btree ("event_key","ref_id","channel",coalesce("club_member_id"::text, "user_id")) WHERE "message_deliveries"."announcement_id" IS NULL;
