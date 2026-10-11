CREATE TABLE "club_exit_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"requested_by" text,
	"requested_on" date NOT NULL,
	"desired_effective_on" date,
	"effective_on" date,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_member_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_member_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"since" date DEFAULT CURRENT_DATE NOT NULL,
	"until" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_member_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_member_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text,
	"from_category_id" uuid,
	"to_category_id" uuid,
	"effective_on" date NOT NULL,
	"reason" text,
	"changed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"member_id" text,
	"display_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"birth_date" date,
	"street" text,
	"postal_code" text,
	"city" text,
	"phone" text,
	"contact_email" text,
	"emergency_contact_name" text,
	"emergency_contact_phone" text,
	"member_number" text,
	"category_id" uuid,
	"status" text DEFAULT 'aktiv' NOT NULL,
	"joined_at" date NOT NULL,
	"left_at" date,
	"exit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"voting_right" boolean DEFAULT true NOT NULL,
	"min_age" integer,
	"max_age" integer,
	"auto_transition_to_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_settings" (
	"club_id" text PRIMARY KEY NOT NULL,
	"notice_period_days" integer,
	"notice_mode" text,
	"member_number_prefix" text,
	"allow_self_loans" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "guardian_links_pair_uidx";--> statement-breakpoint
DROP INDEX "guardian_links_ward_id_idx";--> statement-breakpoint
ALTER TABLE "guardian_links" ADD COLUMN "ward_club_member_id" uuid;--> statement-breakpoint
ALTER TABLE "club_exit_requests" ADD CONSTRAINT "club_exit_requests_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_exit_requests" ADD CONSTRAINT "club_exit_requests_requested_by_member_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_exit_requests" ADD CONSTRAINT "club_exit_requests_decided_by_member_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_departments" ADD CONSTRAINT "club_member_departments_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_departments" ADD CONSTRAINT "club_member_departments_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_status_history" ADD CONSTRAINT "club_member_status_history_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_status_history" ADD CONSTRAINT "club_member_status_history_from_category_id_member_categories_id_fk" FOREIGN KEY ("from_category_id") REFERENCES "public"."member_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_status_history" ADD CONSTRAINT "club_member_status_history_to_category_id_member_categories_id_fk" FOREIGN KEY ("to_category_id") REFERENCES "public"."member_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_status_history" ADD CONSTRAINT "club_member_status_history_changed_by_member_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_category_id_member_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."member_categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_categories" ADD CONSTRAINT "member_categories_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_settings" ADD CONSTRAINT "club_settings_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_exit_requests_member_idx" ON "club_exit_requests" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX "club_exit_requests_status_idx" ON "club_exit_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "club_member_departments_open_uidx" ON "club_member_departments" USING btree ("club_member_id","department_id") WHERE "club_member_departments"."until" IS NULL;--> statement-breakpoint
CREATE INDEX "club_member_departments_department_idx" ON "club_member_departments" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "club_member_status_history_member_idx" ON "club_member_status_history" USING btree ("club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "club_members_member_id_uidx" ON "club_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "club_members_club_id_idx" ON "club_members" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "club_members_club_status_idx" ON "club_members" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "club_members_club_member_number_idx" ON "club_members" USING btree ("club_id","member_number");--> statement-breakpoint
CREATE UNIQUE INDEX "member_categories_club_key_uidx" ON "member_categories" USING btree ("club_id","key");--> statement-breakpoint
-- >>> backfill:club_members (idempotent; the Wave 7 B2 data migration, ADR-003). Re-runnable: it only inserts what is missing.
-- (a) default categories for every club
INSERT INTO "member_categories" ("club_id", "key", "name", "voting_right", "sort_order")
SELECT o."id", d."key", d."name", d."voting_right", d."sort_order"
FROM "organization" o
CROSS JOIN (VALUES
	('aktiv', 'Aktiv', true, 0),
	('passiv', 'Passiv', true, 1),
	('foerdernd', 'Fördernd', false, 2),
	('ehrenmitglied', 'Ehrenmitglied', true, 3),
	('jugend', 'Jugend', false, 4)
) AS d("key", "name", "voting_right", "sort_order")
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- (a) unknown free-text categories from club_memberships become categories of their club (key = lower-cased text)
INSERT INTO "member_categories" ("club_id", "key", "name", "voting_right", "sort_order")
SELECT m."organization_id", lower(btrim(cm."category")), min(btrim(cm."category")), true, 100
FROM "club_memberships" cm
INNER JOIN "member" m ON m."id" = cm."member_id"
WHERE btrim(cm."category") <> ''
GROUP BY m."organization_id", lower(btrim(cm."category"))
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- (b) every account member gets exactly one club_members row
INSERT INTO "club_members" ("club_id", "member_id", "display_name", "contact_email", "birth_date", "emergency_contact_name", "emergency_contact_phone", "member_number", "category_id", "status", "joined_at", "left_at", "created_at", "updated_at")
SELECT m."organization_id", m."id", u."name", u."email", cm."birth_date", cm."emergency_contact_name", cm."emergency_contact_phone", cm."member_number", mc."id",
	CASE WHEN cm."left_at" IS NOT NULL AND cm."left_at" <= CURRENT_DATE THEN 'ausgetreten' ELSE 'aktiv' END,
	COALESCE(cm."joined_at", m."created_at"::date), cm."left_at", COALESCE(cm."created_at", now()), COALESCE(cm."updated_at", now())
FROM "member" m
INNER JOIN "user" u ON u."id" = m."user_id"
LEFT JOIN "club_memberships" cm ON cm."member_id" = m."id"
LEFT JOIN "member_categories" mc ON mc."club_id" = m."organization_id" AND mc."key" = COALESCE(NULLIF(lower(btrim(cm."category")), ''), 'aktiv')
WHERE NOT EXISTS (SELECT 1 FROM "club_members" x WHERE x."member_id" = m."id")
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- count check: every member row must have its club_members row, otherwise the whole migration aborts
DO $$
DECLARE
	member_count bigint;
	linked_count bigint;
BEGIN
	SELECT count(*) INTO member_count FROM "member";
	SELECT count(*) INTO linked_count FROM "club_members" WHERE "member_id" IS NOT NULL;
	IF member_count <> linked_count THEN
		RAISE EXCEPTION 'club_members backfill count mismatch: % member rows vs % club_members rows linked to an account', member_count, linked_count;
	END IF;
END $$;--> statement-breakpoint
-- <<< backfill:club_members
-- (c) guardian_links: ward side moves from member.id to club_members.id
UPDATE "guardian_links" gl SET "ward_club_member_id" = cm."id" FROM "club_members" cm WHERE cm."member_id" = gl."ward_member_id" AND gl."ward_club_member_id" IS NULL;--> statement-breakpoint
DO $$
DECLARE
	unmapped bigint;
BEGIN
	SELECT count(*) INTO unmapped FROM "guardian_links" WHERE "ward_club_member_id" IS NULL;
	IF unmapped <> 0 THEN
		RAISE EXCEPTION 'guardian_links backfill failed: % rows without a club_members ward', unmapped;
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "guardian_links" ALTER COLUMN "ward_club_member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "guardian_links" DROP CONSTRAINT "guardian_links_ward_member_id_member_id_fk";--> statement-breakpoint
ALTER TABLE "guardian_links" DROP COLUMN "ward_member_id";--> statement-breakpoint
ALTER TABLE "guardian_links" ADD CONSTRAINT "guardian_links_ward_club_member_id_club_members_id_fk" FOREIGN KEY ("ward_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_links_pair_uidx" ON "guardian_links" USING btree ("guardian_member_id","ward_club_member_id");--> statement-breakpoint
CREATE INDEX "guardian_links_ward_id_idx" ON "guardian_links" USING btree ("ward_club_member_id");