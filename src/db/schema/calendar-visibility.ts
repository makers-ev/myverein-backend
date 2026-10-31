import { relations } from "drizzle-orm";
import { pgTable, text, uuid, index } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";
import { calendars } from "./calendars.js";
import { departments } from "./departments.js";

/**
 * Who can see a calendar, one row per grant. Exactly one of
 * memberId/roleType/departmentId is set per row -- validated in the route
 * via Zod, not a DB constraint (see Data Model - MyVerein Backend §2
 * "Design Principles"). A calendar with zero visibility rows is club-wide
 * visible by default -- no explicit "everyone" row needed.
 */
export const calendarVisibility = pgTable(
  "calendar_visibility",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    calendarId: uuid("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => member.id, { onDelete: "cascade" }),
    // Freitext, matches club_roles.roleType -- e.g. "trainer" | "abteilungsleitung".
    roleType: text("role_type"),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "cascade" }),
  },
  (table) => [index("calendar_visibility_calendar_id_idx").on(table.calendarId)],
);

export const calendarVisibilityRelations = relations(calendarVisibility, ({ one }) => ({
  calendar: one(calendars, { fields: [calendarVisibility.calendarId], references: [calendars.id] }),
  member: one(member, { fields: [calendarVisibility.memberId], references: [member.id] }),
  department: one(departments, { fields: [calendarVisibility.departmentId], references: [departments.id] }),
}));

export type CalendarVisibilityRow = typeof calendarVisibility.$inferSelect;
export type NewCalendarVisibilityRow = typeof calendarVisibility.$inferInsert;
