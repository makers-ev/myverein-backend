CREATE TABLE "calendar_feed_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"member_id" text NOT NULL,
	"calendar_id" uuid,
	"token_hash" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"club_member_id" uuid,
	"guest_name" text,
	"status" text NOT NULL,
	"source" text DEFAULT 'manuell' NOT NULL,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_attendance_identity_chk" CHECK (("event_attendance"."club_member_id" IS NOT NULL)::int + ("event_attendance"."guest_name" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "event_attendance_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"club_member_id" uuid,
	"old_status" text,
	"new_status" text,
	"reason" text NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_attendance_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"checkin_code_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_attendance_supervisors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sheet_id" uuid NOT NULL,
	"club_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_registration_settings" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"form_version_id" uuid,
	"deadline_at" timestamp with time zone,
	"allow_guests" boolean DEFAULT false NOT NULL,
	"max_companions" integer DEFAULT 0 NOT NULL,
	"guest_retention_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_ride_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ride_id" uuid NOT NULL,
	"passenger_club_member_id" uuid NOT NULL,
	"status" text DEFAULT 'angefragt' NOT NULL,
	"requested_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_rides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"driver_club_member_id" uuid NOT NULL,
	"seats" integer NOT NULL,
	"departure_place" text NOT NULL,
	"departure_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_rides_seats_chk" CHECK ("event_rides"."seats" >= 1)
);
--> statement-breakpoint
CREATE TABLE "location_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"event_id" uuid,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"booked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_bookings_time_chk" CHECK ("location_bookings"."ends_at" > "location_bookings"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "rate_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"club_member_id" uuid,
	"role_type" text,
	"hourly_rate_cents" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_until" date,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_cards_target_chk" CHECK (("rate_cards"."club_member_id" IS NOT NULL)::int + ("rate_cards"."role_type" IS NOT NULL)::int = 1),
	CONSTRAINT "rate_cards_rate_chk" CHECK ("rate_cards"."hourly_rate_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"club_member_id" uuid NOT NULL,
	"event_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"source" text NOT NULL,
	"status" text DEFAULT 'offen' NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helper_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"min_staff" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "helper_shifts_time_chk" CHECK ("helper_shifts"."ends_at" > "helper_shifts"."starts_at"),
	CONSTRAINT "helper_shifts_capacity_chk" CHECK ("helper_shifts"."capacity" >= 1 AND "helper_shifts"."min_staff" >= 0 AND "helper_shifts"."min_staff" <= "helper_shifts"."capacity")
);
--> statement-breakpoint
CREATE TABLE "helper_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shift_id" uuid NOT NULL,
	"club_member_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helper_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "helper_swap_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signup_id" uuid NOT NULL,
	"to_club_member_id" uuid,
	"status" text DEFAULT 'offen' NOT NULL,
	"resolved_by_club_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_series_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"series_id" uuid NOT NULL,
	"original_starts_at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"calendar_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text,
	"capacity" integer,
	"location_id" uuid,
	"all_day" boolean DEFAULT false NOT NULL,
	"start_date" date NOT NULL,
	"start_time" time,
	"duration_minutes" integer,
	"duration_days" integer DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'Europe/Berlin' NOT NULL,
	"freq" text NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"by_day" text[],
	"by_set_pos" integer,
	"until_date" date,
	"count" integer,
	"skip_holidays" boolean DEFAULT false NOT NULL,
	"horizon_until" timestamp with time zone DEFAULT now() NOT NULL,
	"split_from_series_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_series_end_chk" CHECK ("event_series"."until_date" IS NULL OR "event_series"."count" IS NULL),
	CONSTRAINT "event_series_interval_chk" CHECK ("event_series"."interval_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "event_attendees" ALTER COLUMN "member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "club_settings" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "club_member_id" uuid;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "party_size" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "form_submission_id" uuid;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "registered_by_member_id" text;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "guest_name" text;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "guest_email" text;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "guest_token_hash" text;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "guest_confirm_token_hash" text;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "guest_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "guest_delete_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "original_starts_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "is_override" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "cost_note" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "cost_cents" integer;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "attendance_tracking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "public_registration_token_hash" text;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "bookable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_sheet_id_event_attendance_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."event_attendance_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance" ADD CONSTRAINT "event_attendance_recorded_by_user_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance_corrections" ADD CONSTRAINT "event_attendance_corrections_sheet_id_event_attendance_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."event_attendance_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance_corrections" ADD CONSTRAINT "event_attendance_corrections_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance_corrections" ADD CONSTRAINT "event_attendance_corrections_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance_sheets" ADD CONSTRAINT "event_attendance_sheets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance_sheets" ADD CONSTRAINT "event_attendance_sheets_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance_supervisors" ADD CONSTRAINT "event_attendance_supervisors_sheet_id_event_attendance_sheets_id_fk" FOREIGN KEY ("sheet_id") REFERENCES "public"."event_attendance_sheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendance_supervisors" ADD CONSTRAINT "event_attendance_supervisors_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registration_settings" ADD CONSTRAINT "event_registration_settings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registration_settings" ADD CONSTRAINT "event_registration_settings_form_version_id_form_versions_id_fk" FOREIGN KEY ("form_version_id") REFERENCES "public"."form_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ride_requests" ADD CONSTRAINT "event_ride_requests_ride_id_event_rides_id_fk" FOREIGN KEY ("ride_id") REFERENCES "public"."event_rides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ride_requests" ADD CONSTRAINT "event_ride_requests_passenger_club_member_id_club_members_id_fk" FOREIGN KEY ("passenger_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ride_requests" ADD CONSTRAINT "event_ride_requests_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_rides" ADD CONSTRAINT "event_rides_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_rides" ADD CONSTRAINT "event_rides_driver_club_member_id_club_members_id_fk" FOREIGN KEY ("driver_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_bookings" ADD CONSTRAINT "location_bookings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_bookings" ADD CONSTRAINT "location_bookings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_bookings" ADD CONSTRAINT "location_bookings_booked_by_user_id_fk" FOREIGN KEY ("booked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_cards" ADD CONSTRAINT "rate_cards_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_confirmed_by_user_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_shifts" ADD CONSTRAINT "helper_shifts_station_id_helper_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "public"."helper_stations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_signups" ADD CONSTRAINT "helper_signups_shift_id_helper_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."helper_shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_signups" ADD CONSTRAINT "helper_signups_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_signups" ADD CONSTRAINT "helper_signups_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_stations" ADD CONSTRAINT "helper_stations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_swap_requests" ADD CONSTRAINT "helper_swap_requests_signup_id_helper_signups_id_fk" FOREIGN KEY ("signup_id") REFERENCES "public"."helper_signups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_swap_requests" ADD CONSTRAINT "helper_swap_requests_to_club_member_id_club_members_id_fk" FOREIGN KEY ("to_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helper_swap_requests" ADD CONSTRAINT "helper_swap_requests_resolved_by_club_member_id_club_members_id_fk" FOREIGN KEY ("resolved_by_club_member_id") REFERENCES "public"."club_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_series_exceptions" ADD CONSTRAINT "event_series_exceptions_series_id_event_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."event_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_series_exceptions" ADD CONSTRAINT "event_series_exceptions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_series" ADD CONSTRAINT "event_series_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_series" ADD CONSTRAINT "event_series_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_series" ADD CONSTRAINT "event_series_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_feed_tokens_hash_uidx" ON "calendar_feed_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "calendar_feed_tokens_member_idx" ON "calendar_feed_tokens" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendance_sheet_club_member_uidx" ON "event_attendance" USING btree ("sheet_id","club_member_id") WHERE "event_attendance"."club_member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_attendance_club_member_idx" ON "event_attendance" USING btree ("club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendance_sheets_event_uidx" ON "event_attendance_sheets" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendance_supervisors_uidx" ON "event_attendance_supervisors" USING btree ("sheet_id","club_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_ride_requests_ride_passenger_uidx" ON "event_ride_requests" USING btree ("ride_id","passenger_club_member_id");--> statement-breakpoint
CREATE INDEX "event_rides_event_idx" ON "event_rides" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "location_bookings_location_time_idx" ON "location_bookings" USING btree ("location_id","starts_at");--> statement-breakpoint
CREATE INDEX "rate_cards_club_idx" ON "rate_cards" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "time_entries_member_started_idx" ON "time_entries" USING btree ("club_member_id","started_at");--> statement-breakpoint
CREATE INDEX "time_entries_club_idx" ON "time_entries" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "helper_shifts_station_idx" ON "helper_shifts" USING btree ("station_id");--> statement-breakpoint
CREATE UNIQUE INDEX "helper_signups_shift_member_uidx" ON "helper_signups" USING btree ("shift_id","club_member_id");--> statement-breakpoint
CREATE INDEX "helper_signups_member_idx" ON "helper_signups" USING btree ("club_member_id");--> statement-breakpoint
CREATE INDEX "helper_stations_event_idx" ON "helper_stations" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "helper_swap_requests_signup_idx" ON "helper_swap_requests" USING btree ("signup_id");--> statement-breakpoint
CREATE UNIQUE INDEX "helper_swap_requests_one_open_uidx" ON "helper_swap_requests" USING btree ("signup_id") WHERE "helper_swap_requests"."status" = 'offen';--> statement-breakpoint
CREATE UNIQUE INDEX "event_series_exceptions_series_original_uidx" ON "event_series_exceptions" USING btree ("series_id","original_starts_at");--> statement-breakpoint
CREATE INDEX "event_series_exceptions_event_id_idx" ON "event_series_exceptions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_series_calendar_id_idx" ON "event_series" USING btree ("calendar_id");--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_club_member_id_club_members_id_fk" FOREIGN KEY ("club_member_id") REFERENCES "public"."club_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_form_submission_id_form_submissions_id_fk" FOREIGN KEY ("form_submission_id") REFERENCES "public"."form_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_registered_by_member_id_member_id_fk" FOREIGN KEY ("registered_by_member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_series_id_event_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."event_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_event_club_member_uidx" ON "event_attendees" USING btree ("event_id","club_member_id") WHERE "event_attendees"."club_member_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_event_guest_email_uidx" ON "event_attendees" USING btree ("event_id",lower("guest_email")) WHERE "event_attendees"."guest_email" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_guest_token_uidx" ON "event_attendees" USING btree ("guest_token_hash") WHERE "event_attendees"."guest_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_guest_confirm_token_uidx" ON "event_attendees" USING btree ("guest_confirm_token_hash") WHERE "event_attendees"."guest_confirm_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "event_attendees_guest_delete_after_idx" ON "event_attendees" USING btree ("guest_delete_after") WHERE "event_attendees"."guest_delete_after" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_series_original_uidx" ON "events" USING btree ("series_id","original_starts_at") WHERE "events"."series_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_public_registration_token_uidx" ON "events" USING btree ("public_registration_token_hash") WHERE "events"."public_registration_token_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_identity_chk" CHECK (("event_attendees"."member_id" IS NOT NULL)::int + ("event_attendees"."club_member_id" IS NOT NULL)::int + ("event_attendees"."guest_email" IS NOT NULL)::int = 1);--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_party_size_chk" CHECK ("event_attendees"."party_size" >= 1);