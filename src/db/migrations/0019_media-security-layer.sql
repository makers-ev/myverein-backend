CREATE TABLE "media_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" text,
	"storage_key" text NOT NULL,
	"owner_type" text DEFAULT 'unattached' NOT NULL,
	"owner_id" text,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"original_filename" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "inventory_damage_reports" RENAME COLUMN "photo_url" TO "photo_key";--> statement-breakpoint
ALTER TABLE "locations" RENAME COLUMN "photo_url" TO "photo_key";--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "photo_key" text;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_club_id_organization_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_files_storage_key_uidx" ON "media_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_files_club_live_idx" ON "media_files" USING btree ("club_id") WHERE "media_files"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "media_files_owner_idx" ON "media_files" USING btree ("owner_type","owner_id");--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_photo_key_media_files_storage_key_fk" FOREIGN KEY ("photo_key") REFERENCES "public"."media_files"("storage_key") ON DELETE set null ON UPDATE no action;