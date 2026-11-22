import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";
import { locations } from "./locations.js";
import { sponsors } from "./sponsors.js";

/**
 * E-mail invitation to an external login of a club (Wave 15 B2, same pattern as the member invitation of Wave 7 B4): only the
 * HMAC of the token is stored, single use (`accepted_at`), expiring (`expires_at`), revocable (`revoked_at`). Accepting creates
 * an account membership with `member.role = guest`, the club role `role_type` and -- for a sponsor -- links `sponsor_id`.
 */
export const clubExternalInvites = pgTable(
  "club_external_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Lower-cased invited address; the accepting account's verified e-mail must match it.
    email: text("email").notNull(),
    // One of EXTERNAL_ROLE_TYPES (src/lib/club-permissions.ts).
    roleType: text("role_type").notNull(),
    displayName: text("display_name").notNull(),
    sponsorId: uuid("sponsor_id").references(() => sponsors.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedMemberId: text("accepted_member_id").references(() => member.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("club_external_invites_token_hash_uidx").on(table.tokenHash),
    index("club_external_invites_club_idx").on(table.clubId),
    check("club_external_invites_role_chk", sql`${table.roleType} IN ('sponsor', 'dienstleister')`),
  ],
);

/**
 * What a service provider (`dienstleister`) may see (Wave 15 B2): a location (optional) with a note written for them, inside a
 * time window. Outside the window the assignment is not shown; nothing else of the club is reachable for the account.
 */
export const externalAccessAssignments = pgTable(
  "external_access_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    note: text("note"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }).notNull(),
    createdBy: text("created_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("external_access_assignments_member_idx").on(table.memberId, table.validUntil),
    index("external_access_assignments_club_idx").on(table.clubId),
    check("external_access_assignments_window_chk", sql`${table.validUntil} > ${table.validFrom}`),
  ],
);

export type ClubExternalInviteRow = typeof clubExternalInvites.$inferSelect;
export type ExternalAccessAssignmentRow = typeof externalAccessAssignments.$inferSelect;
