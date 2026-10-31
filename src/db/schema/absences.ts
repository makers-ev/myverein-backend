import { sql } from "drizzle-orm";
import { check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organization, user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { events } from "./events.js";

export const ABSENCE_KINDS = ["krank", "abwesend"] as const;
export const ABSENCE_NOTE_MAX = 200;

/**
 * Absence / sick note of a club member (Wave 10 B5). Deliberately NO diagnosis field: only the kind, the period and an
 * optional short note (clients warn "no diagnoses"). Never part of a push or mail text.
 */
export const absenceReports = pgTable(
  "absence_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    note: text("note"),
    reportedByUserId: text("reported_by_user_id").references(() => user.id, { onDelete: "set null" }),
    // `self` (the member's own account) or `guardian` (reported through guardian_links).
    reportedByKind: text("reported_by_kind").notNull().default("self"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("absence_reports_club_period_idx").on(table.clubId, table.startsOn, table.endsOn),
    index("absence_reports_member_idx").on(table.clubMemberId, table.startsOn),
    check("absence_reports_kind_chk", sql`${table.kind} IN ('krank', 'abwesend')`),
    check("absence_reports_period_chk", sql`${table.endsOn} >= ${table.startsOn}`),
    check("absence_reports_reported_by_chk", sql`${table.reportedByKind} IN ('self', 'guardian')`),
    check("absence_reports_note_len_chk", sql`${table.note} IS NULL OR char_length(${table.note}) <= ${sql.raw(String(ABSENCE_NOTE_MAX))}`),
  ],
);

/** RSVP of a guardian for a ward WITHOUT account (accounts keep `event_attendees`). Same status values. */
export const wardEventResponses = pgTable(
  "ward_event_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    wardClubMemberId: uuid("ward_club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    // "angemeldet" | "abgesagt" | "warteliste" (as event_attendees.status).
    status: text("status").notNull(),
    respondedByUserId: text("responded_by_user_id").references(() => user.id, { onDelete: "set null" }),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ward_event_responses_event_ward_uidx").on(table.eventId, table.wardClubMemberId)],
);

export type AbsenceReportRow = typeof absenceReports.$inferSelect;
export type WardEventResponseRow = typeof wardEventResponses.$inferSelect;
