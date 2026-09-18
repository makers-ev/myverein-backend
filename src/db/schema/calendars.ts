import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, boolean, index } from "drizzle-orm/pg-core";

import { user, organization } from "../../auth/auth-schema.js";
import { departments } from "./departments.js";

/**
 * A calendar owned by a club or one of its departments. `departmentId` null
 * means club-wide. See Data Model - MyVerein Backend §7 "calendars".
 */
export const calendars = pgTable(
  "calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    icalImportUrl: text("ical_import_url"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("calendars_club_id_idx").on(table.clubId)],
);

export const calendarsRelations = relations(calendars, ({ one }) => ({
  club: one(organization, { fields: [calendars.clubId], references: [organization.id] }),
  department: one(departments, { fields: [calendars.departmentId], references: [departments.id] }),
  creator: one(user, { fields: [calendars.createdBy], references: [user.id] }),
}));

export type CalendarRow = typeof calendars.$inferSelect;
export type NewCalendarRow = typeof calendars.$inferInsert;
