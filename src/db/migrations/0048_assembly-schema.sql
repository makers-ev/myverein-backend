CREATE TABLE "ballot_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ballot_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"candidate_club_member_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ballot_voters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ballot_id" uuid NOT NULL,
	"club_member_id" uuid,
	"cast_by_club_member_id" uuid,
	"eligible" boolean DEFAULT true NOT NULL,
	"basis" text NOT NULL,
	"has_voted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ballot_votes_open" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ballot_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"club_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ballot_votes_secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ballot_id" uuid NOT NULL,
	"option_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ballots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"meeting_id" uuid,
	"agenda_item_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"mode" text DEFAULT 'in_session' NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"topic" text DEFAULT 'allgemein' NOT NULL,
	"majority" text,
	"max_choices" integer DEFAULT 1 NOT NULL,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"status" text DEFAULT 'draft' NOT NULL,
	"rules_snapshot" jsonb,
	"result" jsonb,
	"result_hash" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_role_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"club_member_id" uuid,
	"role_type" text NOT NULL,
	"department_id" uuid,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"election_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "election_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"election_id" uuid NOT NULL,
	"club_member_id" uuid,
	"proposed_by" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "elections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"meeting_id" uuid,
	"role_type" text NOT NULL,
	"department_id" uuid,
	"seats" integer DEFAULT 1 NOT NULL,
	"term_months" integer,
	"election_lead_club_member_id" uuid,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_agenda_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"vote_kind" text DEFAULT 'none' NOT NULL,
	"topic" text DEFAULT 'allgemein' NOT NULL,
	"announced_in_invitation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_invitation_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"club_member_id" uuid,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"status_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "meeting_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_by" text,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"rules_snapshot" jsonb NOT NULL,
	"period_check" jsonb NOT NULL,
	"exception_reason" text,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "meeting_invitations_meeting_version_uq" UNIQUE("meeting_id","version")
);
--> statement-breakpoint
CREATE TABLE "meeting_minutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'entwurf' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text NOT NULL,
	"approved_in_meeting_id" uuid,
	"approved_resolution_id" uuid,
	"approved_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_minutes_meeting_version_uq" UNIQUE("meeting_id","version")
);
--> statement-breakpoint
CREATE TABLE "meeting_minutes_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"minutes_id" uuid NOT NULL,
	"note" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_proxies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"grantor_club_member_id" uuid,
	"holder_club_member_id" uuid,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_voting_roll" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"club_member_id" uuid,
	"eligible" boolean NOT NULL,
	"basis" text NOT NULL,
	"override_reason" text,
	"overridden_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD COLUMN "club_member_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD COLUMN "left_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD COLUMN "check_in_method" text;--> statement-breakpoint
ALTER TABLE "meeting_invitees" ADD COLUMN "club_member_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD COLUMN "ballot_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD COLUMN "agenda_item_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "rules_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "participation_mode" text DEFAULT 'praesenz' NOT NULL;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "online_url" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "voting_roll_frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ballot_options" ADD CONSTRAINT "ballot_options_ballot_id_ballots_id_fk" FOREIGN KEY ("ballot_id") REFERENCES "public"."ballots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_options" ADD CONSTRAINT "ballot_options_candidate_club_member_id_club_members_id_fk" FOREIGN KEY ("candidate_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_voters" ADD CONSTRAINT "ballot_voters_ballot_id_ballots_id_fk" FOREIGN KEY ("ballot_id") REFERENCES "public"."ballots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_voters" ADD CONSTRAINT "ballot_voters_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_voters" ADD CONSTRAINT "ballot_voters_cast_by_club_member_id_club_members_id_fk" FOREIGN KEY ("cast_by_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_votes_open" ADD CONSTRAINT "ballot_votes_open_ballot_id_ballots_id_fk" FOREIGN KEY ("ballot_id") REFERENCES "public"."ballots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_votes_open" ADD CONSTRAINT "ballot_votes_open_option_id_ballot_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."ballot_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_votes_open" ADD CONSTRAINT "ballot_votes_open_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_votes_secret" ADD CONSTRAINT "ballot_votes_secret_ballot_id_ballots_id_fk" FOREIGN KEY ("ballot_id") REFERENCES "public"."ballots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_votes_secret" ADD CONSTRAINT "ballot_votes_secret_option_id_ballot_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."ballot_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_agenda_item_id_meeting_agenda_items_id_fk" FOREIGN KEY ("agenda_item_id") REFERENCES "public"."meeting_agenda_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballots" ADD CONSTRAINT "ballots_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_role_terms" ADD CONSTRAINT "club_role_terms_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_role_terms" ADD CONSTRAINT "club_role_terms_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_role_terms" ADD CONSTRAINT "club_role_terms_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_role_terms" ADD CONSTRAINT "club_role_terms_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_election_id_elections_id_fk" FOREIGN KEY ("election_id") REFERENCES "public"."elections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "election_candidates" ADD CONSTRAINT "election_candidates_proposed_by_club_members_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elections" ADD CONSTRAINT "elections_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elections" ADD CONSTRAINT "elections_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elections" ADD CONSTRAINT "elections_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elections" ADD CONSTRAINT "elections_election_lead_club_member_id_club_members_id_fk" FOREIGN KEY ("election_lead_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elections" ADD CONSTRAINT "elections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_agenda_items" ADD CONSTRAINT "meeting_agenda_items_announced_in_invitation_id_meeting_invitations_id_fk" FOREIGN KEY ("announced_in_invitation_id") REFERENCES "public"."meeting_invitations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitation_deliveries" ADD CONSTRAINT "meeting_invitation_deliveries_invitation_id_meeting_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."meeting_invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitation_deliveries" ADD CONSTRAINT "meeting_invitation_deliveries_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitations" ADD CONSTRAINT "meeting_invitations_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitations" ADD CONSTRAINT "meeting_invitations_sent_by_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_approved_in_meeting_id_meetings_id_fk" FOREIGN KEY ("approved_in_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes_amendments" ADD CONSTRAINT "meeting_minutes_amendments_minutes_id_meeting_minutes_id_fk" FOREIGN KEY ("minutes_id") REFERENCES "public"."meeting_minutes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes_amendments" ADD CONSTRAINT "meeting_minutes_amendments_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_proxies" ADD CONSTRAINT "meeting_proxies_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_proxies" ADD CONSTRAINT "meeting_proxies_grantor_club_member_id_club_members_id_fk" FOREIGN KEY ("grantor_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_proxies" ADD CONSTRAINT "meeting_proxies_holder_club_member_id_club_members_id_fk" FOREIGN KEY ("holder_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_proxies" ADD CONSTRAINT "meeting_proxies_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_voting_roll" ADD CONSTRAINT "meeting_voting_roll_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_voting_roll" ADD CONSTRAINT "meeting_voting_roll_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_voting_roll" ADD CONSTRAINT "meeting_voting_roll_overridden_by_user_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ballot_options_ballot_idx" ON "ballot_options" USING btree ("ballot_id","position");--> statement-breakpoint
CREATE INDEX "ballot_options_candidate_idx" ON "ballot_options" USING btree ("candidate_club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ballot_voters_ballot_member_uidx" ON "ballot_voters" USING btree ("ballot_id","club_member_id");--> statement-breakpoint
CREATE INDEX "ballot_voters_member_idx" ON "ballot_voters" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX "ballot_voters_cast_by_idx" ON "ballot_voters" USING btree ("cast_by_club_member_id");--> statement-breakpoint
CREATE INDEX "ballot_votes_open_ballot_idx" ON "ballot_votes_open" USING btree ("ballot_id");--> statement-breakpoint
CREATE INDEX "ballot_votes_open_member_idx" ON "ballot_votes_open" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX "ballot_votes_secret_ballot_idx" ON "ballot_votes_secret" USING btree ("ballot_id");--> statement-breakpoint
CREATE INDEX "ballots_club_status_idx" ON "ballots" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "ballots_meeting_idx" ON "ballots" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "club_role_terms_club_idx" ON "club_role_terms" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "club_role_terms_member_idx" ON "club_role_terms" USING btree ("club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "election_candidates_election_member_uidx" ON "election_candidates" USING btree ("election_id","club_member_id");--> statement-breakpoint
CREATE INDEX "election_candidates_member_idx" ON "election_candidates" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX "election_candidates_proposed_by_idx" ON "election_candidates" USING btree ("proposed_by");--> statement-breakpoint
CREATE INDEX "elections_club_idx" ON "elections" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "elections_lead_idx" ON "elections" USING btree ("election_lead_club_member_id");--> statement-breakpoint
CREATE INDEX "meeting_agenda_items_meeting_idx" ON "meeting_agenda_items" USING btree ("meeting_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_invitation_deliveries_uidx" ON "meeting_invitation_deliveries" USING btree ("invitation_id","club_member_id","channel");--> statement-breakpoint
CREATE INDEX "meeting_invitation_deliveries_member_idx" ON "meeting_invitation_deliveries" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX "meeting_minutes_approved_in_idx" ON "meeting_minutes" USING btree ("approved_in_meeting_id");--> statement-breakpoint
CREATE INDEX "meeting_minutes_amendments_minutes_idx" ON "meeting_minutes_amendments" USING btree ("minutes_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_proxies_meeting_grantor_uidx" ON "meeting_proxies" USING btree ("meeting_id","grantor_club_member_id");--> statement-breakpoint
CREATE INDEX "meeting_proxies_holder_idx" ON "meeting_proxies" USING btree ("meeting_id","holder_club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_voting_roll_meeting_member_uidx" ON "meeting_voting_roll" USING btree ("meeting_id","club_member_id");--> statement-breakpoint
CREATE INDEX "meeting_voting_roll_member_idx" ON "meeting_voting_roll" USING btree ("club_member_id");--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_invitees" ADD CONSTRAINT "meeting_invitees_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD CONSTRAINT "meeting_resolutions_ballot_id_ballots_id_fk" FOREIGN KEY ("ballot_id") REFERENCES "public"."ballots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_resolutions" ADD CONSTRAINT "meeting_resolutions_agenda_item_id_meeting_agenda_items_id_fk" FOREIGN KEY ("agenda_item_id") REFERENCES "public"."meeting_agenda_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_attendance_meeting_club_member_uidx" ON "meeting_attendance" USING btree ("meeting_id","club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_invitees_meeting_club_member_uidx" ON "meeting_invitees" USING btree ("meeting_id","club_member_id");--> statement-breakpoint
-- Wave 11 B2, stage 1: fill the club-member references from the account memberships (idempotent: only rows still NULL).
UPDATE "meeting_invitees" i SET "club_member_id" = cm."id" FROM "club_members" cm WHERE cm."member_id" = i."member_id" AND i."club_member_id" IS NULL;--> statement-breakpoint
UPDATE "meeting_attendance" a SET "club_member_id" = cm."id" FROM "club_members" cm WHERE cm."member_id" = a."member_id" AND a."club_member_id" IS NULL;--> statement-breakpoint
-- Count check: every row that still has an account reference must have found its club member. The migration fails (nothing is changed) otherwise.
DO $$
DECLARE missing_invitees integer; missing_attendance integer;
BEGIN
  SELECT count(*) INTO missing_invitees FROM "meeting_invitees" WHERE "club_member_id" IS NULL;
  SELECT count(*) INTO missing_attendance FROM "meeting_attendance" WHERE "club_member_id" IS NULL AND "member_id" IS NOT NULL;
  IF missing_invitees > 0 OR missing_attendance > 0 THEN
    RAISE EXCEPTION 'wave 11 migration: % invitee and % attendance rows without a club_members row (every member needs one, see ensureClubMember)', missing_invitees, missing_attendance;
  END IF;
END $$;--> statement-breakpoint
-- A legacy attendance row (holder, proxy_for) becomes one proxy (grantor = proxy_for, holder = the row's member). One holder per grantor and meeting.
INSERT INTO "meeting_proxies" ("meeting_id", "grantor_club_member_id", "holder_club_member_id")
SELECT a."meeting_id", g."id", a."club_member_id" FROM "meeting_attendance" a JOIN "club_members" g ON g."member_id" = a."proxy_for_member_id" WHERE a."club_member_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Free-text minutes become version 1 of the structured minutes: a meeting already marked as protocolled counts as approved, everything else is a draft.
INSERT INTO "meeting_minutes" ("meeting_id", "version", "status", "content", "content_hash", "approved_at")
SELECT m."id", 1, CASE WHEN m."status" = 'protokolliert' THEN 'genehmigt' ELSE 'entwurf' END, m."minutes", encode(sha256(convert_to(m."minutes", 'UTF8')), 'hex'), CASE WHEN m."status" = 'protokolliert' THEN m."updated_at" ELSE NULL END
FROM "meetings" m WHERE m."minutes" IS NOT NULL AND btrim(m."minutes") <> ''
ON CONFLICT ("meeting_id", "version") DO NOTHING;--> statement-breakpoint
-- Old attendance with a voting right and presence is already recorded; mark the check-in of present people as manual (no timestamp known).
UPDATE "meeting_attendance" SET "check_in_method" = 'schriftfuehrer' WHERE "present" = true AND "check_in_method" IS NULL;
