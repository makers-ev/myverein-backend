import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { events } from "./events.js";

export const SWAP_STATUSES = ["offen", "angenommen", "abgelehnt", "zurueckgezogen"] as const;
export type SwapStatus = (typeof SWAP_STATUSES)[number];

/** A station of a helper plan (e.g. "Kuchenstand") belonging to one event. */
export const helperStations = pgTable(
  "helper_stations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("helper_stations_event_idx").on(table.eventId)],
);

/** A time slot of a station with a capacity and a minimum staffing. */
export const helperShifts = pgTable(
  "helper_shifts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stationId: uuid("station_id")
      .notNull()
      .references(() => helperStations.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    capacity: integer("capacity").notNull(),
    minStaff: integer("min_staff").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("helper_shifts_station_idx").on(table.stationId),
    check("helper_shifts_time_chk", sql`${table.endsAt} > ${table.startsAt}`),
    check("helper_shifts_capacity_chk", sql`${table.capacity} >= 1 AND ${table.minStaff} >= 0 AND ${table.minStaff} <= ${table.capacity}`),
  ],
);

/** A person signed up for a shift (club member, with or without account). */
export const helperSignups = pgTable(
  "helper_signups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shiftId: uuid("shift_id")
      .notNull()
      .references(() => helperShifts.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    // Who entered the person (the person themself or the organiser).
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("helper_signups_shift_member_uidx").on(table.shiftId, table.clubMemberId), index("helper_signups_member_idx").on(table.clubMemberId)],
);

/** Swap / hand-over request for a signup: to a named person, or open (`to_club_member_id` NULL = "who can take over?"). */
export const helperSwapRequests = pgTable(
  "helper_swap_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signupId: uuid("signup_id")
      .notNull()
      .references(() => helperSignups.id, { onDelete: "cascade" }),
    toClubMemberId: uuid("to_club_member_id").references(() => clubMembers.id, { onDelete: "cascade" }),
    // One of SWAP_STATUSES.
    status: text("status").notNull().default("offen"),
    resolvedByClubMemberId: uuid("resolved_by_club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    index("helper_swap_requests_signup_idx").on(table.signupId),
    uniqueIndex("helper_swap_requests_one_open_uidx").on(table.signupId).where(sql`${table.status} = 'offen'`),
  ],
);
