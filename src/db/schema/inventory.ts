import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, date, index } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";
import { locations } from "./locations.js";

/**
 * A physical item owned by a club (equipment, tools, furniture). Tracks
 * acquisition, upkeep, and where it's currently kept. See Data Model -
 * MyVerein Backend §3 "inventory_items".
 */
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category"),
    // Freitext-Beispiele: "gut" | "beschaedigt" | "defekt".
    condition: text("condition").notNull(),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    // Integer cents, never float -- repo money convention.
    acquisitionValueCents: integer("acquisition_value_cents"),
    acquiredAt: date("acquired_at", { mode: "string" }),
    maintenanceIntervalDays: integer("maintenance_interval_days"),
    lastMaintenanceAt: date("last_maintenance_at", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("inventory_items_club_id_idx").on(table.clubId)],
);

/**
 * A borrow record for an inventory item. `status` is free text -- "ueberfaellig"
 * is derived at read time from `dueAt` in a later task, never written here.
 */
export const inventoryLoans = pgTable(
  "inventory_loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    borrowedAt: timestamp("borrowed_at", { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    // Freitext-Beispiele: "ausgeliehen" | "zurueckgegeben".
    status: text("status").notNull().default("ausgeliehen"),
  },
  (table) => [index("inventory_loans_item_id_idx").on(table.itemId)],
);

/** A reported defect/damage for an inventory item. */
export const inventoryDamageReports = pgTable(
  "inventory_damage_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    reportedBy: text("reported_by")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    photoUrl: text("photo_url"),
    // Freitext-Beispiele: "gemeldet" | "in_bearbeitung" | "behoben".
    status: text("status").notNull().default("gemeldet"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [index("inventory_damage_reports_item_id_idx").on(table.itemId)],
);

export const inventoryItemsRelations = relations(inventoryItems, ({ one, many }) => ({
  club: one(organization, { fields: [inventoryItems.clubId], references: [organization.id] }),
  location: one(locations, { fields: [inventoryItems.locationId], references: [locations.id] }),
  loans: many(inventoryLoans),
  damageReports: many(inventoryDamageReports),
}));

export const inventoryLoansRelations = relations(inventoryLoans, ({ one }) => ({
  item: one(inventoryItems, { fields: [inventoryLoans.itemId], references: [inventoryItems.id] }),
  member: one(member, { fields: [inventoryLoans.memberId], references: [member.id] }),
}));

export const inventoryDamageReportsRelations = relations(inventoryDamageReports, ({ one }) => ({
  item: one(inventoryItems, { fields: [inventoryDamageReports.itemId], references: [inventoryItems.id] }),
  reporter: one(member, { fields: [inventoryDamageReports.reportedBy], references: [member.id] }),
}));

export type InventoryItemRow = typeof inventoryItems.$inferSelect;
export type NewInventoryItemRow = typeof inventoryItems.$inferInsert;
export type InventoryLoanRow = typeof inventoryLoans.$inferSelect;
export type NewInventoryLoanRow = typeof inventoryLoans.$inferInsert;
export type InventoryDamageReportRow = typeof inventoryDamageReports.$inferSelect;
export type NewInventoryDamageReportRow = typeof inventoryDamageReports.$inferInsert;
