import { date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";

export const EXIT_KINDS = ["cancellation", "exclusion"] as const;
export const EXIT_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;

/** Cancellation by the member or exclusion by the board (routes follow in Wave 7 B6; schema only for now). */
export const clubExitRequests = pgTable(
  "club_exit_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    // One of EXIT_KINDS.
    kind: text("kind").notNull(),
    requestedBy: text("requested_by").references(() => member.id, { onDelete: "set null" }),
    requestedOn: date("requested_on", { mode: "string" }).notNull(),
    desiredEffectiveOn: date("desired_effective_on", { mode: "string" }),
    effectiveOn: date("effective_on", { mode: "string" }),
    reason: text("reason"),
    // One of EXIT_STATUSES.
    status: text("status").notNull().default("pending"),
    decidedBy: text("decided_by").references(() => member.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("club_exit_requests_member_idx").on(table.clubMemberId), index("club_exit_requests_status_idx").on(table.status)],
);

export type ClubExitRequestRow = typeof clubExitRequests.$inferSelect;
