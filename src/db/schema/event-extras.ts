import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member, organization, user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { events } from "./events.js";
import { formVersions } from "./forms.js";
import { locations } from "./locations.js";

/** Registration settings of an event (Wave 12): form (fixed version), deadline, guests, companions. Cost is display only. */
export const eventRegistrationSettings = pgTable("event_registration_settings", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  // The version is pinned when the settings are saved; later form edits do not change running registrations.
  formVersionId: uuid("form_version_id").references(() => formVersions.id, { onDelete: "set null" }),
  deadlineAt: timestamp("deadline_at", { withTimezone: true }),
  allowGuests: boolean("allow_guests").notNull().default(false),
  maxCompanions: integer("max_companions").notNull().default(0),
  // Days after the event after which guest data is deleted.
  guestRetentionDays: integer("guest_retention_days").notNull().default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** P2: a ride offer for an event. */
export const eventRides = pgTable(
  "event_rides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    driverClubMemberId: uuid("driver_club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    seats: integer("seats").notNull(),
    departurePlace: text("departure_place").notNull(),
    departureAt: timestamp("departure_at", { withTimezone: true }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("event_rides_event_idx").on(table.eventId), check("event_rides_seats_chk", sql`${table.seats} >= 1`)],
);

/** P2: a request / confirmation to ride along. */
export const eventRideRequests = pgTable(
  "event_ride_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rideId: uuid("ride_id")
      .notNull()
      .references(() => eventRides.id, { onDelete: "cascade" }),
    passengerClubMemberId: uuid("passenger_club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    // "angefragt" | "zugesagt" | "abgelehnt".
    status: text("status").notNull().default("angefragt"),
    requestedByUserId: text("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("event_ride_requests_ride_passenger_uidx").on(table.rideId, table.passengerClubMemberId)],
);

/** P2: a booking of a bookable location (room / pitch), optionally linked to an event. */
export const locationBookings = pgTable(
  "location_bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    bookedBy: text("booked_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("location_bookings_location_time_idx").on(table.locationId, table.startsAt), check("location_bookings_time_chk", sql`${table.endsAt} > ${table.startsAt}`)],
);

/** P2: worked time of one person (report only: no payout, no booking, no payment status). */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    // NULL while the clock is running.
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // "stempeln" | "aus_termin" | "manuell".
    source: text("source").notNull(),
    // "offen" | "bestaetigt" | "abgelehnt".
    status: text("status").notNull().default("offen"),
    confirmedBy: text("confirmed_by").references(() => user.id, { onDelete: "set null" }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("time_entries_member_started_idx").on(table.clubMemberId, table.startedAt), index("time_entries_club_idx").on(table.clubId)],
);

/** P2: hourly rate of a person or role for a period (confidential, `time:read_rates`). */
export const rateCards = pgTable(
  "rate_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "cascade" }),
    roleType: text("role_type"),
    hourlyRateCents: integer("hourly_rate_cents").notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validUntil: date("valid_until", { mode: "string" }),
    createdBy: text("created_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rate_cards_club_idx").on(table.clubId),
    check("rate_cards_target_chk", sql`(${table.clubMemberId} IS NOT NULL)::int + (${table.roleType} IS NOT NULL)::int = 1`),
    check("rate_cards_rate_chk", sql`${table.hourlyRateCents} >= 0`),
  ],
);
