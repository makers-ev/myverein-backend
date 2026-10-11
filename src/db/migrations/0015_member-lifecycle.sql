ALTER TABLE "club_members" ADD COLUMN "last_user_id" text;--> statement-breakpoint
CREATE INDEX "club_members_club_last_user_idx" ON "club_members" USING btree ("club_id","last_user_id");--> statement-breakpoint
-- remember the account of every linked member so a later removal/re-join can be matched to the same club_members row
UPDATE "club_members" cm SET "last_user_id" = m."user_id" FROM "member" m WHERE m."id" = cm."member_id" AND cm."last_user_id" IS NULL;--> statement-breakpoint
-- 0014 created a separate category for legacy spellings such as 'Fördernd'; fold those into the existing key ('foerdernd')
UPDATE "club_members" cm SET "category_id" = t."id"
FROM "member_categories" c
INNER JOIN "member_categories" t ON t."club_id" = c."club_id" AND t."key" = replace(replace(replace(replace(lower(btrim(c."key")), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss')
WHERE cm."category_id" = c."id" AND c."key" <> t."key";--> statement-breakpoint
UPDATE "club_member_status_history" h SET "from_category_id" = t."id"
FROM "member_categories" c
INNER JOIN "member_categories" t ON t."club_id" = c."club_id" AND t."key" = replace(replace(replace(replace(lower(btrim(c."key")), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss')
WHERE h."from_category_id" = c."id" AND c."key" <> t."key";--> statement-breakpoint
UPDATE "club_member_status_history" h SET "to_category_id" = t."id"
FROM "member_categories" c
INNER JOIN "member_categories" t ON t."club_id" = c."club_id" AND t."key" = replace(replace(replace(replace(lower(btrim(c."key")), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss')
WHERE h."to_category_id" = c."id" AND c."key" <> t."key";--> statement-breakpoint
DELETE FROM "member_categories" c
USING "member_categories" t
WHERE t."club_id" = c."club_id" AND c."key" <> t."key"
	AND t."key" = replace(replace(replace(replace(lower(btrim(c."key")), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss');--> statement-breakpoint
-- guardian links across club borders are kept (no data loss) but reported: guardian and ward belong to different clubs
DO $$
DECLARE
	cross_club bigint;
BEGIN
	SELECT count(*) INTO cross_club
	FROM "guardian_links" gl
	INNER JOIN "member" g ON g."id" = gl."guardian_member_id"
	INNER JOIN "club_members" w ON w."id" = gl."ward_club_member_id"
	WHERE g."organization_id" <> w."club_id";
	IF cross_club > 0 THEN
		RAISE WARNING 'guardian_links: % link(s) connect a guardian and a ward of different clubs; kept, please review', cross_club;
	END IF;
END $$;
