import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, boolean, index } from "drizzle-orm/pg-core";

import { locations } from "./locations.js";

/**
 * WiFi credentials for a location, shown to members (and optionally guests)
 * via the location detail page. Stored as plain text deliberately -- an
 * extra encryption layer was considered and rejected, see Data Model -
 * MyVerein Backend §5 "Alternatives Considered": these are venue-shared
 * network passwords, not a secret worth the added key-management
 * complexity, and access is already gated by club/location permissions.
 */
export const locationWifiNetworks = pgTable(
  "location_wifi_networks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    ssid: text("ssid").notNull(),
    password: text("password").notNull(),
    visibleToGuests: boolean("visible_to_guests").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("location_wifi_networks_location_id_idx").on(table.locationId)],
);

export const locationWifiNetworksRelations = relations(locationWifiNetworks, ({ one }) => ({
  location: one(locations, { fields: [locationWifiNetworks.locationId], references: [locations.id] }),
}));

export type LocationWifiNetworkRow = typeof locationWifiNetworks.$inferSelect;
export type NewLocationWifiNetworkRow = typeof locationWifiNetworks.$inferInsert;
