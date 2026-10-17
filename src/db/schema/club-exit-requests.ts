import { sql } from "drizzle-orm";
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";
import { formSubmissions } from "./forms.js";

export const EXIT_KINDS = ["cancellation", "exclusion"] as const;
export const EXIT_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;

/** Cancellation by the member or exclusion by the board (routes: `routes/club-exit-requests.ts`, Wave 7 B6). At most one pending request per member. */
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
    // Wave 8: the filled-in exit form (NULL for requests without a form). Notice periods stay in club_settings.
    formSubmissionId: uuid("form_submission_id").references(() => formSubmissions.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("club_exit_requests_member_idx").on(table.clubMemberId),
    index("club_exit_requests_status_idx").on(table.status),
    uniqueIndex("club_exit_requests_pending_uidx")
      .on(table.clubMemberId)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type ClubExitRequestRow = typeof clubExitRequests.$inferSelect;
