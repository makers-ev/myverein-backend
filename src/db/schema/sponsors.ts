import { sql } from "drizzle-orm";
import { boolean, check, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";
import { mediaFiles } from "./media-files.js";

/** Where a sponsor may be shown: `intern` = only to the people with `sponsors:read`; `oeffentlich` = also on the public club page (Wave 15 B3, only while active). */
export const SPONSOR_VISIBILITIES = ["intern", "oeffentlich"] as const;
export type SponsorVisibility = (typeof SPONSOR_VISIBILITIES)[number];

/**
 * Sponsors and partners of a club (Wave 15 B1). No money is handled here: `consideration` is the free-text description of what
 * the club gives in return (banner, jersey print, ...); billing stays outside MyVerein. The status (planned / active / expired)
 * is derived at read time from `starts_on` / `ends_on` (Berlin calendar day), never stored. The logo is a registered media file
 * (`logo_key`, never a URL); it is served as a signed URL after the route's own permission check, and only while the sponsor is
 * active and `oeffentlich` (and the club page is public) it is opted in as `public_opt_in` (Wave 15 BM).
 * `linked_member_id` is the account membership of the sponsor's external login (Wave 15 B2), NULL without one.
 */
export const sponsors = pgTable(
  "sponsors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    logoKey: text("logo_key").references(() => mediaFiles.storageKey, { onDelete: "set null" }),
    // External link of the sponsor the board typed in (not a file).
    website: text("website"),
    description: text("description"),
    consideration: text("consideration"),
    startsOn: date("starts_on", { mode: "string" }),
    endsOn: date("ends_on", { mode: "string" }),
    visibility: text("visibility").notNull().default("intern"),
    // Internal notes of the board; never shown to the sponsor or the public.
    notes: text("notes"),
    linkedMemberId: text("linked_member_id").references(() => member.id, { onDelete: "set null" }),
    createdBy: text("created_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("sponsors_club_idx").on(table.clubId),
    index("sponsors_linked_member_idx").on(table.linkedMemberId),
    check("sponsors_visibility_chk", sql`${table.visibility} IN ('intern', 'oeffentlich')`),
    check("sponsors_period_chk", sql`${table.endsOn} IS NULL OR ${table.startsOn} IS NULL OR ${table.endsOn} >= ${table.startsOn}`),
  ],
);

/** Contact persons at the sponsor (optional, several per sponsor; one may be marked primary). Business contacts, internal only. */
export const sponsorContacts = pgTable(
  "sponsor_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sponsorId: uuid("sponsor_id")
      .notNull()
      .references(() => sponsors.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role"),
    email: text("email"),
    phone: text("phone"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("sponsor_contacts_sponsor_idx").on(table.sponsorId)],
);

export type SponsorRow = typeof sponsors.$inferSelect;
export type SponsorContactRow = typeof sponsorContacts.$inferSelect;
