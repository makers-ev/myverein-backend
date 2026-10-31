ALTER TABLE "ballots" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD COLUMN "attendance_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "meeting_proxies" ADD COLUMN "proof_source" text;--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "schedule_exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ballot_options" ADD CONSTRAINT "ballot_options_ballot_id_uq" UNIQUE("ballot_id","id");--> statement-breakpoint
ALTER TABLE "ballot_votes_open" ADD CONSTRAINT "ballot_votes_open_option_in_ballot_fk" FOREIGN KEY ("ballot_id","option_id") REFERENCES "public"."ballot_options"("ballot_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ballot_votes_secret" ADD CONSTRAINT "ballot_votes_secret_option_in_ballot_fk" FOREIGN KEY ("ballot_id","option_id") REFERENCES "public"."ballot_options"("ballot_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" DISABLE TRIGGER meeting_minutes_guard;--> statement-breakpoint
UPDATE "meeting_minutes" SET "approved_resolution_id" = NULL WHERE "approved_resolution_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "meeting_resolutions" r WHERE r."id" = "meeting_minutes"."approved_resolution_id");--> statement-breakpoint
ALTER TABLE "meeting_minutes" ENABLE TRIGGER meeting_minutes_guard;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_approved_resolution_id_meeting_resolutions_id_fk" FOREIGN KEY ("approved_resolution_id") REFERENCES "public"."meeting_resolutions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- The guard of 0051, now also freezing the attendance snapshot and tolerating the FK set null of the approving resolution.
CREATE OR REPLACE FUNCTION meeting_minutes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('genehmigt', 'archiviert') AND EXISTS (SELECT 1 FROM meetings WHERE id = OLD.meeting_id) THEN
      RAISE EXCEPTION 'approved minutes cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('genehmigt', 'archiviert') THEN
    IF NEW.meeting_id IS DISTINCT FROM OLD.meeting_id
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.content IS DISTINCT FROM OLD.content
      OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
      OR NEW.attendance_snapshot IS DISTINCT FROM OLD.attendance_snapshot
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
      OR (NEW.approved_resolution_id IS DISTINCT FROM OLD.approved_resolution_id AND NEW.approved_resolution_id IS NOT NULL)
      OR (NEW.approved_in_meeting_id IS DISTINCT FROM OLD.approved_in_meeting_id AND NEW.approved_in_meeting_id IS NOT NULL)
      OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'genehmigt' AND NEW.status = 'archiviert')) THEN
      RAISE EXCEPTION 'approved minutes are immutable' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.status = 'genehmigt' AND (OLD.status <> 'zur_genehmigung' OR NEW.approved_resolution_id IS NULL OR NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'minutes are approved by a resolution only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- New versions start as a draft; the only other way in is the decision record of a circular resolution (archiviert with an approval date).
CREATE FUNCTION meeting_minutes_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('genehmigt', 'zur_genehmigung') OR (NEW.status = 'archiviert' AND NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'minutes start as a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER meeting_minutes_insert_guard BEFORE INSERT ON "meeting_minutes" FOR EACH ROW EXECUTE FUNCTION meeting_minutes_insert_guard();
