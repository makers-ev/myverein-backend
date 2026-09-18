-- Backfill: fold the fixed titleDe/titleEn/bodyDe/bodyEn columns into the new
-- `translations` JSONB column (ADR-009) before those columns get dropped.
UPDATE "notification"
SET "translations" = jsonb_strip_nulls(jsonb_build_object(
	'de', CASE WHEN "title_de" IS NOT NULL OR "body_de" IS NOT NULL
		THEN jsonb_build_object('title', "title_de", 'body', "body_de") END,
	'en', CASE WHEN "title_en" IS NOT NULL OR "body_en" IS NOT NULL
		THEN jsonb_build_object('title', "title_en", 'body', "body_en") END
))
WHERE "title_de" IS NOT NULL OR "title_en" IS NOT NULL OR "body_de" IS NOT NULL OR "body_en" IS NOT NULL;
--> statement-breakpoint

-- notification_template's four columns are all NOT NULL, so every row always
-- gets both keys.
UPDATE "notification_template"
SET "translations" = jsonb_build_object(
	'de', jsonb_build_object('title', "title_de", 'body', "body_de"),
	'en', jsonb_build_object('title', "title_en", 'body', "body_en")
);
