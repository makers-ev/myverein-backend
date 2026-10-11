import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";

/** Visibility level of a wifi network / link: gast < mitglied < vorstand (see routes/locations.ts). */
export const LOCATION_VISIBILITIES = ["gast", "mitglied", "vorstand"] as const;
export type LocationVisibility = (typeof LOCATION_VISIBILITIES)[number];

/**
 * A physical venue owned/used by a club (clubhouse, sports field, storage
 * shed). See Data Model - MyVerein Backend §3 "locations".
 */
export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    address: text("address"),
    latitude: numeric("latitude"),
    longitude: numeric("longitude"),
    openingHours: text("opening_hours"),
    // Storage key of a `media_files` row, never a URL (B18).
    photoKey: text("photo_key"),
    contactPerson: text("contact_person"),
    accessNote: text("access_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("locations_club_id_idx").on(table.clubId)],
);

/** A member entrusted with a key/access code for a location. */
export const locationKeyHolders = pgTable(
  "location_key_holders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    // Which key/code the member holds ("Schluessel Nr. 3", "Zahlenschloss"); copied into location_key_history on return.
    keyLabel: text("key_label"),
  },
  (table) => [uniqueIndex("location_key_holders_location_member_uidx").on(table.locationId, table.memberId)],
);

/** Actions recorded in `location_key_history`. */
export const KEY_HISTORY_ACTIONS = ["issued", "returned"] as const;
export type KeyHistoryAction = (typeof KEY_HISTORY_ACTIONS)[number];

/**
 * Append-only log of key handovers (Wave 7 B14): who received / returned which key when, with a note. Written by the
 * key-holder routes (`locations:write`) in the same transaction as the change. Names are snapshots so the log stays
 * readable after the account or the club membership is gone (member ids are then NULL).
 */
export const locationKeyHistory = pgTable(
  "location_key_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    // One of KEY_HISTORY_ACTIONS (validated in code).
    action: text("action").notNull(),
    memberId: text("member_id").references(() => member.id, { onDelete: "set null" }),
    memberName: text("member_name").notNull(),
    keyLabel: text("key_label"),
    note: text("note"),
    recordedBy: text("recorded_by").references(() => member.id, { onDelete: "set null" }),
    recordedByName: text("recorded_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("location_key_history_location_idx").on(table.locationId, table.createdAt)],
);

export const locationsRelations = relations(locations, ({ one, many }) => ({
  club: one(organization, { fields: [locations.clubId], references: [organization.id] }),
  keyHolders: many(locationKeyHolders),
}));

export const locationKeyHoldersRelations = relations(locationKeyHolders, ({ one }) => ({
  location: one(locations, { fields: [locationKeyHolders.locationId], references: [locations.id] }),
  member: one(member, { fields: [locationKeyHolders.memberId], references: [member.id] }),
}));

export type LocationRow = typeof locations.$inferSelect;
export type NewLocationRow = typeof locations.$inferInsert;
export type LocationKeyHolderRow = typeof locationKeyHolders.$inferSelect;
export type NewLocationKeyHolderRow = typeof locationKeyHolders.$inferInsert;

export type LocationKeyHistoryRow = typeof locationKeyHistory.$inferSelect;
