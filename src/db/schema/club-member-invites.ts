import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";

/**
 * E-mail invitation that links an account to a member without account (Wave 7 B4, ADR-003). Only the HMAC of the token
 * is stored (`token_hash`); the token itself exists only in the mail. At most one OPEN (not accepted) invite per member:
 * a new invite replaces the old one. An invite is single-use (`accepted_at`) and expires (`expires_at`, 14 days).
 */
export const clubMemberInvites = pgTable(
  "club_member_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    // The invited address (lower-cased); the accepting account's e-mail must match it.
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("club_member_invites_token_hash_uidx").on(table.tokenHash),
    uniqueIndex("club_member_invites_open_uidx")
      .on(table.clubMemberId)
      .where(sql`${table.acceptedAt} IS NULL`),
    index("club_member_invites_member_idx").on(table.clubMemberId),
  ],
);

export type ClubMemberInviteRow = typeof clubMemberInvites.$inferSelect;
