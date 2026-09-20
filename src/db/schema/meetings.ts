import { relations } from "drizzle-orm";
import { pgTable, text, timestamp, uuid, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";

import { member, user, organization } from "../../auth/auth-schema.js";
import { locations } from "./locations.js";

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
    // Freitext-Beispiele: "vorstandssitzung" | "mitgliederversammlung" |
    // "ausschusssitzung".
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
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("meetings_club_id_idx").on(table.clubId)],
);

/** A member invited to a meeting and their RSVP. */
export const meetingInvitees = pgTable(
  "meeting_invitees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    // Freitext-Beispiele: "ausstehend" | "zugesagt" | "abgesagt".
    response: text("response").notNull(),
  },
  (table) => [uniqueIndex("meeting_invitees_meeting_member_uidx").on(table.meetingId, table.memberId)],
);

/** Actual attendance and voting eligibility recorded for a meeting. */
export const meetingAttendance = pgTable(
  "meeting_attendance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    present: boolean("present").notNull().default(false),
    hasVotingRight: boolean("has_voting_right").notNull().default(true),
    proxyForMemberId: text("proxy_for_member_id").references(() => member.id, { onDelete: "set null" }),
  },
  (table) => [uniqueIndex("meeting_attendance_meeting_member_uidx").on(table.meetingId, table.memberId)],
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
  member: one(member, { fields: [meetingInvitees.memberId], references: [member.id] }),
}));

export const meetingAttendanceRelations = relations(meetingAttendance, ({ one }) => ({
  meeting: one(meetings, { fields: [meetingAttendance.meetingId], references: [meetings.id] }),
  member: one(member, { fields: [meetingAttendance.memberId], references: [member.id] }),
  proxyFor: one(member, { fields: [meetingAttendance.proxyForMemberId], references: [member.id] }),
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
