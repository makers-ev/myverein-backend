import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, boolean, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";

import { user, organization } from "../../auth/auth-schema.js";
import { ballots, meetingAgendaItems } from "./assembly.js";
import { clubMembers } from "./club-members.js";
import { locations } from "./locations.js";

/** Controlled meeting types (validated via Zod, text in the DB). Only `vorstandssitzung` is read-scoped. */
export const MEETING_TYPES = ["vorstandssitzung", "mitgliederversammlung", "sonstige"] as const;
export type MeetingType = (typeof MEETING_TYPES)[number];

/**
 * A club meeting (board meeting, general assembly, committee session). See
 * Data Model - MyVerein Backend §7 "meetings".
 */
export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // One of MEETING_TYPES (Zod-validated; migration 0016 mapped the old free text).
    type: text("type").notNull(),
    title: text("title").notNull(),
    // Null while still scheduling (Terminfindung).
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    agenda: text("agenda"),
    minutes: text("minutes"),
    // Freitext-Beispiele: "terminfindung" | "geplant" | "abgehalten" |
    // "protokolliert".
    status: text("status").notNull(),
    // Statute parameters as they were when the invitation went out (Wave 11): the meeting is judged by these, not by later changes.
    rulesSnapshot: jsonb("rules_snapshot").$type<Record<string, unknown>>(),
    // `praesenz` | `hybrid` | `virtual` (only usable when the club allows online participation).
    participationMode: text("participation_mode").notNull().default("praesenz"),
    // Join link of a hybrid / virtual meeting; only shown to invited people.
    onlineUrl: text("online_url"),
    // Date changes after the invitation that missed the statute period, each with the reason of `assembly:manage`.
    scheduleExceptions: jsonb("schedule_exceptions").$type<Array<Record<string, unknown>>>().notNull().default([]),
    // Set once the voting roll (Stimmberechtigtenverzeichnis) is frozen.
    votingRollFrozenAt: timestamp("voting_roll_frozen_at", { withTimezone: true }),
    // The creating account; NULL once it is deleted (the meeting, its resolutions and attendance belong to the club).
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("meetings_club_id_idx").on(table.clubId)],
);

/**
 * A member invited to a meeting and their RSVP. References the club-side identity (`club_members`), so members without an
 * account can be invited too (Wave 11).
 */
export const meetingInvitees = pgTable(
  "meeting_invitees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    // Freitext-Beispiele: "ausstehend" | "zugesagt" | "abgesagt".
    response: text("response").notNull(),
  },
  (table) => [uniqueIndex("meeting_invitees_meeting_club_member_uidx").on(table.meetingId, table.clubMemberId)],
);

/**
 * Actual attendance and voting eligibility recorded for a meeting. Kept for the minutes when the person is erased
 * (Wave 10 B8): `club_member_id` becomes NULL (pseudonymised), present / voting right stay so quorum and votes remain verifiable.
 * Proxies live in `meeting_proxies`.
 */
export const meetingAttendance = pgTable(
  "meeting_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    present: boolean("present").notNull().default(false),
    hasVotingRight: boolean("has_voting_right").notNull().default(true),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    // One of CHECK_IN_METHODS (assembly.ts).
    checkInMethod: text("check_in_method"),
  },
  (table) => [uniqueIndex("meeting_attendance_meeting_club_member_uidx").on(table.meetingId, table.clubMemberId)],
);

/** A vote result recorded for a meeting (Beschluss). */
export const meetingResolutions = pgTable(
  "meeting_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    votesFor: integer("votes_for").notNull().default(0),
    votesAgainst: integer("votes_against").notNull().default(0),
    votesAbstain: integer("votes_abstain").notNull().default(0),
    // Freitext-Beispiele: "angenommen" | "abgelehnt".
    result: text("result").notNull(),
    // Digital votes (Wave 11): the ballot the counts come from; `source` = `manual` (hand count) | `digital`.
    ballotId: uuid("ballot_id").references(() => ballots.id, { onDelete: "set null" }),
    agendaItemId: uuid("agenda_item_id").references(() => meetingAgendaItems.id, { onDelete: "set null" }),
    source: text("source").notNull().default("manual"),
    // Berichtigungsvermerk: set when a resolution is corrected (PATCH) instead of silently overwritten.
    correctionNote: text("correction_note"),
    correctedAt: timestamp("corrected_at", { withTimezone: true }),
    correctedBy: text("corrected_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("meeting_resolutions_meeting_id_idx").on(table.meetingId)],
);

export const meetingsRelations = relations(meetings, ({ one, many }) => ({
  club: one(organization, { fields: [meetings.clubId], references: [organization.id] }),
  creator: one(user, { fields: [meetings.createdBy], references: [user.id] }),
  location: one(locations, { fields: [meetings.locationId], references: [locations.id] }),
  invitees: many(meetingInvitees),
  attendance: many(meetingAttendance),
  resolutions: many(meetingResolutions),
}));

export const meetingInviteesRelations = relations(meetingInvitees, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingInvitees.meetingId], references: [meetings.id] }),
  clubMember: one(clubMembers, { fields: [meetingInvitees.clubMemberId], references: [clubMembers.id] }),
}));

export const meetingAttendanceRelations = relations(meetingAttendance, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingAttendance.meetingId], references: [meetings.id] }),
  clubMember: one(clubMembers, { fields: [meetingAttendance.clubMemberId], references: [clubMembers.id] }),
}));

export const meetingResolutionsRelations = relations(meetingResolutions, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingResolutions.meetingId], references: [meetings.id] }),
}));

export type MeetingRow = typeof meetings.$inferSelect;
export type NewMeetingRow = typeof meetings.$inferInsert;
export type MeetingInviteeRow = typeof meetingInvitees.$inferSelect;
export type NewMeetingInviteeRow = typeof meetingInvitees.$inferInsert;
export type MeetingAttendanceRow = typeof meetingAttendance.$inferSelect;
export type NewMeetingAttendanceRow = typeof meetingAttendance.$inferInsert;
export type MeetingResolutionRow = typeof meetingResolutions.$inferSelect;
export type NewMeetingResolutionRow = typeof meetingResolutions.$inferInsert;
