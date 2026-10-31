CREATE TABLE "meeting_minutes_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"minutes_id" uuid NOT NULL,
	"role" text NOT NULL,
	"confirmed_by" text,
	"content_hash" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_minutes_confirmations_role_uq" UNIQUE("minutes_id","role")
);
--> statement-breakpoint
ALTER TABLE "meeting_minutes_confirmations" ADD CONSTRAINT "meeting_minutes_confirmations_minutes_id_meeting_minutes_id_fk" FOREIGN KEY ("minutes_id") REFERENCES "public"."meeting_minutes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes_confirmations" ADD CONSTRAINT "meeting_minutes_confirmations_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Approved minutes are immutable (Wave 11 B9): text, hash, version, approval link and date cannot change, the only status move is genehmigt -> archiviert,
-- and a version only becomes genehmigt from zur_genehmigung with the resolution that approved it. Setting approved_in_meeting_id to NULL stays possible
-- (the approving meeting was deleted, FK set null) and so does created_by (account erased). Deleting is only possible together with the meeting itself.
CREATE FUNCTION meeting_minutes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
      OR NEW.approved_resolution_id IS DISTINCT FROM OLD.approved_resolution_id
      OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
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
CREATE TRIGGER meeting_minutes_guard BEFORE UPDATE OR DELETE ON "meeting_minutes" FOR EACH ROW EXECUTE FUNCTION meeting_minutes_guard();
--> statement-breakpoint
-- Berichtigungsvermerke are append-only (the account reference may be cleared when the account is erased).
CREATE FUNCTION meeting_minutes_amendments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM meeting_minutes WHERE id = OLD.minutes_id) THEN
      RAISE EXCEPTION 'amendments cannot be deleted' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.minutes_id IS DISTINCT FROM OLD.minutes_id OR NEW.note IS DISTINCT FROM OLD.note OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'amendments cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER meeting_minutes_amendments_guard BEFORE UPDATE OR DELETE ON "meeting_minutes_amendments" FOR EACH ROW EXECUTE FUNCTION meeting_minutes_amendments_guard();
