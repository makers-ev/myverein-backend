import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, boolean, index } from "drizzle-orm/pg-core";

import { locations } from "./locations.js";

/**
 * A useful link for a location (e.g. venue website, booking calendar, live
 * webcam). See Data Model - MyVerein Backend §3 "location_links".
 */
export const locationLinks = pgTable(
  "location_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url").notNull(),
    icon: text("icon"),
    visibleToGuests: boolean("visible_to_guests").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("location_links_location_id_idx").on(table.locationId)],
);

export const locationLinksRelations = relations(locationLinks, ({ one }) => ({
  location: one(locations, { fields: [locationLinks.locationId], references: [locations.id] }),
}));

export type LocationLinkRow = typeof locationLinks.$inferSelect;
export type NewLocationLinkRow = typeof locationLinks.$inferInsert;
