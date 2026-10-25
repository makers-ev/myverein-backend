import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { events } from "./events.js";

export const ATTENDANCE_STATUSES = ["anwesend", "entschuldigt", "unentschuldigt"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
/** Where an entry came from: set by hand, taken from an RSVP, pre-filled from an absence report (status only, never the reason), self check-in. */
export const ATTENDANCE_SOURCES = ["manuell", "rsvp", "meldung", "checkin"] as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCES)[number];

/** Attendance list of one event (Wave 12). One sheet per event; closing it locks it (later changes need a reason and are logged). */
export const eventAttendanceSheets = pgTable(
  "event_attendance_sheets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by").references(() => user.id, { onDelete: "set null" }),
    // SHA-256 of the self check-in code (P2); NULL = no check-in.
    checkinCodeHash: text("checkin_code_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("event_attendance_sheets_event_uidx").on(table.eventId)],
);

/**
 * One person on the list: a club member (with or without account) or a manually added guest/trial member (`guest_name`).
 * Deliberately NO free-text reason (privacy); absence reasons of Wave 10 never flow in.
 */
export const eventAttendance = pgTable(
  "event_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sheetId: uuid("sheet_id")
      .notNull()
      .references(() => eventAttendanceSheets.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "cascade" }),
    guestName: text("guest_name"),
    // One of ATTENDANCE_STATUSES.
    status: text("status").notNull(),
    // One of ATTENDANCE_SOURCES.
    source: text("source").notNull().default("manuell"),
    recordedBy: text("recorded_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("event_attendance_sheet_club_member_uidx").on(table.sheetId, table.clubMemberId).where(sql`${table.clubMemberId} IS NOT NULL`),
    index("event_attendance_club_member_idx").on(table.clubMemberId),
    check("event_attendance_identity_chk", sql`(${table.clubMemberId} IS NOT NULL)::int + (${table.guestName} IS NOT NULL)::int = 1`),
  ],
);

/** Supervisors (Aufsichtspersonen) of an event's attendance list. */
export const eventAttendanceSupervisors = pgTable(
  "event_attendance_supervisors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sheetId: uuid("sheet_id")
      .notNull()
      .references(() => eventAttendanceSheets.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("event_attendance_supervisors_uidx").on(table.sheetId, table.clubMemberId)],
);

/** A change to a CLOSED list, with the required reason (organisational text, not health data). */
export const eventAttendanceCorrections = pgTable("event_attendance_corrections", {
  id: uuid("id").primaryKey().defaultRandom(),
  sheetId: uuid("sheet_id")
    .notNull()
    .references(() => eventAttendanceSheets.id, { onDelete: "cascade" }),
  clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
  oldStatus: text("old_status"),
  newStatus: text("new_status"),
  reason: text("reason").notNull(),
  changedBy: text("changed_by").references(() => user.id, { onDelete: "set null" }),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EventAttendanceSheetRow = typeof eventAttendanceSheets.$inferSelect;
export type EventAttendanceRow = typeof eventAttendance.$inferSelect;
