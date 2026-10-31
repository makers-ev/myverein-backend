-- Data first: at most one default per club. Keep the most recently created default (the last one the board chose).
UPDATE "calendars" SET "is_default" = false
WHERE "is_default" AND "id" NOT IN (SELECT DISTINCT ON ("club_id") "id" FROM "calendars" WHERE "is_default" ORDER BY "club_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_one_default_per_club_uidx" ON "calendars" USING btree ("club_id") WHERE "calendars"."is_default";--> statement-breakpoint
-- Backfill 1: a club without a default but with a club-wide calendar named "Vereinskalender" promotes that one.
UPDATE "calendars" SET "is_default" = true
WHERE "id" IN (
  SELECT DISTINCT ON ("club_id") "id" FROM "calendars"
  WHERE "department_id" IS NULL AND lower("name") = 'vereinskalender'
    AND "club_id" NOT IN (SELECT "club_id" FROM "calendars" WHERE "is_default")
  ORDER BY "club_id", "created_at", "id"
);--> statement-breakpoint
-- Backfill 2: every other club without a default gets the standard calendar (club-wide, visible to the implicit role
-- `mitglied` only, so external guests stay excluded), created by its owner (else its earliest member). Idempotent: only
-- clubs WITHOUT a default are touched. A club without any member has no creator and gets its calendar lazily later.
WITH "founders" AS (
  SELECT DISTINCT ON (o."id") o."id" AS "club_id", m."user_id"
  FROM "organization" o JOIN "member" m ON m."organization_id" = o."id"
  WHERE NOT EXISTS (SELECT 1 FROM "calendars" c WHERE c."club_id" = o."id" AND c."is_default")
  ORDER BY o."id", (m."role" = 'owner') DESC, m."created_at", m."id"
), "created" AS (
  INSERT INTO "calendars" ("club_id", "name", "is_default", "created_by")
  SELECT "club_id", 'Vereinskalender', true, "user_id" FROM "founders"
  RETURNING "id", "club_id"
), "grants" AS (
  INSERT INTO "calendar_visibility" ("calendar_id", "role_type") SELECT "id", 'mitglied' FROM "created"
)
INSERT INTO "audit_log" ("event_type", "subject_id", "payload")
SELECT 'calendar.default_create', "id"::text, jsonb_build_object('clubId', "club_id", 'calendarId', "id", 'source', 'migration') FROM "created";
