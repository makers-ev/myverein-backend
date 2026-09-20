import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, numeric, index, uniqueIndex } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";

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
    photoUrl: text("photo_url"),
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
  },
  (table) => [uniqueIndex("location_key_holders_location_member_uidx").on(table.locationId, table.memberId)],
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
