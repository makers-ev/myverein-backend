-- B18 follow-up: photo_key columns hold storage keys of the form '<clubId>/<file>' only. Values written before the media
-- layer (free-text photo_url strings: external URLs, '/media/...' paths, other clubs' keys, traversal attempts) are
-- cleared. Idempotent: a second run finds nothing to change.
UPDATE "locations"
SET "photo_key" = NULL
WHERE "photo_key" IS NOT NULL
  AND (left("photo_key", length("club_id") + 1) <> "club_id" || '/' OR "photo_key" LIKE '%..%' OR length("photo_key") <= length("club_id") + 1);--> statement-breakpoint
UPDATE "inventory_damage_reports" AS r
SET "photo_key" = NULL
FROM "inventory_items" AS i
WHERE r."item_id" = i."id"
  AND r."photo_key" IS NOT NULL
  AND (left(r."photo_key", length(i."club_id") + 1) <> i."club_id" || '/' OR r."photo_key" LIKE '%..%' OR length(r."photo_key") <= length(i."club_id") + 1);
