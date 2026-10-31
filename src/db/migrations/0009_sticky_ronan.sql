CREATE TABLE "inventory_damage_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"reported_by" text NOT NULL,
	"description" text NOT NULL,
	"photo_url" text,
	"status" text DEFAULT 'gemeldet' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"condition" text NOT NULL,
	"location_id" uuid,
	"acquisition_value_cents" integer,
	"acquired_at" date,
	"maintenance_interval_days" integer,
	"last_maintenance_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"member_id" text NOT NULL,
	"borrowed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"status" text DEFAULT 'ausgeliehen' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"icon" text,
	"visible_to_guests" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_wifi_networks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"label" text NOT NULL,
	"ssid" text NOT NULL,
	"password" text NOT NULL,
	"visible_to_guests" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_key_holders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"location_id" uuid NOT NULL,
	"member_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"latitude" numeric,
	"longitude" numeric,
	"opening_hours" text,
	"photo_url" text,
	"contact_person" text,
	"access_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_damage_reports" ADD CONSTRAINT "inventory_damage_reports_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_damage_reports" ADD CONSTRAINT "inventory_damage_reports_reported_by_member_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_loans" ADD CONSTRAINT "inventory_loans_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_loans" ADD CONSTRAINT "inventory_loans_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_links" ADD CONSTRAINT "location_links_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_wifi_networks" ADD CONSTRAINT "location_wifi_networks_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_key_holders" ADD CONSTRAINT "location_key_holders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_key_holders" ADD CONSTRAINT "location_key_holders_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_damage_reports_item_id_idx" ON "inventory_damage_reports" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "inventory_items_club_id_idx" ON "inventory_items" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "inventory_loans_item_id_idx" ON "inventory_loans" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "location_links_location_id_idx" ON "location_links" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "location_wifi_networks_location_id_idx" ON "location_wifi_networks" USING btree ("location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "location_key_holders_location_member_uidx" ON "location_key_holders" USING btree ("location_id","member_id");--> statement-breakpoint
CREATE INDEX "locations_club_id_idx" ON "locations" USING btree ("club_id");