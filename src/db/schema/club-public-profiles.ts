import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";

/** The fields of the public club page that the board edits and publishes (Wave 15 B3). Keys are media storage keys, never URLs. */
export interface PublicProfileContent {
  tagline: string | null;
  description: string | null;
  city: string | null;
  address: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  website: string | null;
  logoKey: string | null;
  coverKey: string | null;
  galleryKeys: string[];
  /** Explicit whitelist of departments shown on the page. */
  departmentIds: string[];
  /** Calendars whose upcoming events are shown. */
  eventCalendarIds: string[];
  showSponsors: boolean;
  leadFormEnabled: boolean;
  trialTrainingEnabled: boolean;
}

/**
 * Public club page (Wave 15 B3, E1: strictly opt-in, default off). One row per club: the DRAFT the board edits (columns) and the
 * PUBLISHED snapshot (`published`, set by an explicit publish step). The public endpoint only ever reads `published`, and only
 * while `club_settings.public_profile_enabled` is true and the club is not suspended. Images are registered media files of the
 * club (owner `public_profile`); they are opted in as `public_opt_in` only while they are part of the live published page.
 */
export const clubPublicProfiles = pgTable("club_public_profiles", {
  clubId: text("club_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  tagline: text("tagline"),
  description: text("description"),
  city: text("city"),
  address: text("address"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  // External link the board typed in (not a file).
  website: text("website"),
  logoKey: text("logo_key"),
  coverKey: text("cover_key"),
  galleryKeys: jsonb("gallery_keys").$type<string[]>().notNull().default([]),
  departmentIds: jsonb("department_ids").$type<string[]>().notNull().default([]),
  eventCalendarIds: jsonb("event_calendar_ids").$type<string[]>().notNull().default([]),
  showSponsors: boolean("show_sponsors").notNull().default(false),
  leadFormEnabled: boolean("lead_form_enabled").notNull().default(false),
  trialTrainingEnabled: boolean("trial_training_enabled").notNull().default(false),
  published: jsonb("published").$type<PublicProfileContent>(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedBy: text("published_by").references(() => member.id, { onDelete: "set null" }),
  // When the board last confirmed that the published contact (e-mail/phone) is a club address or the person agreed.
  contactConsentAt: timestamp("contact_consent_at", { withTimezone: true }),
  updatedBy: text("updated_by").references(() => member.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ClubPublicProfileRow = typeof clubPublicProfiles.$inferSelect;
