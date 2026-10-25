import { relations, sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { events } from "./events.js";
import { formSubmissions } from "./forms.js";

/**
 * RSVP / registration for an event. See Data Model - MyVerein Backend §7 "event_attendees". Exactly ONE identity
 * (`event_attendees_identity_chk`): an account (`member_id`, own RSVP), a club member without account answered by a
 * guardian or the board (`club_member_id`), or a guest without any membership (`guest_email`, public link, Wave 12).
 */
export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => member.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "cascade" }),
    // Freitext-Beispiele: "angemeldet" | "abgesagt" | "warteliste".
    status: text("status").notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
    // Seats taken by this registration (the person plus companions), counted against the capacity.
    partySize: integer("party_size").notNull().default(1),
    // Answers to the registration form (Wave 8 submission), SET NULL when the submission is erased.
    formSubmissionId: uuid("form_submission_id").references(() => formSubmissions.id, { onDelete: "set null" }),
    // Who registered the person (a guardian / the board on behalf of someone else); NULL for own registrations.
    registeredByMemberId: text("registered_by_member_id").references(() => member.id, { onDelete: "set null" }),
    // Guest without account (public link): name + e-mail, double opt-in, management link. Only hashes of the tokens are stored.
    guestName: text("guest_name"),
    guestEmail: text("guest_email"),
    guestTokenHash: text("guest_token_hash"),
    guestConfirmTokenHash: text("guest_confirm_token_hash"),
    guestConfirmedAt: timestamp("guest_confirmed_at", { withTimezone: true }),
    // Guest data is deleted once this instant has passed (retention task).
    guestDeleteAfter: timestamp("guest_delete_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique per account (NULLs are distinct, so the other identities do not collide); `ON CONFLICT (event_id, member_id)` keeps working.
    uniqueIndex("event_attendees_event_member_uidx").on(table.eventId, table.memberId),
    uniqueIndex("event_attendees_event_club_member_uidx").on(table.eventId, table.clubMemberId).where(sql`${table.clubMemberId} IS NOT NULL`),
    uniqueIndex("event_attendees_event_guest_email_uidx").on(table.eventId, sql`lower(${table.guestEmail})`).where(sql`${table.guestEmail} IS NOT NULL`),
    uniqueIndex("event_attendees_guest_token_uidx").on(table.guestTokenHash).where(sql`${table.guestTokenHash} IS NOT NULL`),
    uniqueIndex("event_attendees_guest_confirm_token_uidx").on(table.guestConfirmTokenHash).where(sql`${table.guestConfirmTokenHash} IS NOT NULL`),
    index("event_attendees_guest_delete_after_idx").on(table.guestDeleteAfter).where(sql`${table.guestDeleteAfter} IS NOT NULL`),
    check(
      "event_attendees_identity_chk",
      sql`(${table.memberId} IS NOT NULL)::int + (${table.clubMemberId} IS NOT NULL)::int + (${table.guestEmail} IS NOT NULL)::int = 1`,
    ),
    check("event_attendees_party_size_chk", sql`${table.partySize} >= 1`),
  ],
);

export const eventAttendeesRelations = relations(eventAttendees, ({ one }) => ({
  event: one(events, { fields: [eventAttendees.eventId], references: [events.id] }),
  member: one(member, { fields: [eventAttendees.memberId], references: [member.id] }),
}));

export type EventAttendeeRow = typeof eventAttendees.$inferSelect;
export type NewEventAttendeeRow = typeof eventAttendees.$inferInsert;
