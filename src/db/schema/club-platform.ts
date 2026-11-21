import { sql } from "drizzle-orm";
import { check, date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { organization, user } from "../../auth/auth-schema.js";

/**
 * Platform state of a club (Wave 15 B7), 1:1 with `organization`; a missing row means "active". A suspended club
 * (`suspended_at` set) is locked for every route behind `clubGuard` (`403 CLUB_SUSPENDED`) and disappears from the public
 * page, the lead form and the club search. `suspension_reason` is internal (platform admins only); `suspension_note` is the
 * text members see.
 */
export const clubPlatformStatus = pgTable("club_platform_status", {
  clubId: text("club_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedBy: text("suspended_by").references(() => user.id, { onDelete: "set null" }),
  suspensionReason: text("suspension_reason"),
  suspensionNote: text("suspension_note"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Every suspend / unsuspend with its mandatory reason (the audit log holds no free text, this table does). */
export const clubStatusHistory = pgTable(
  "club_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("club_status_history_club_idx").on(table.clubId, table.createdAt), check("club_status_history_action_chk", sql`${table.action} IN ('suspend', 'unsuspend')`)],
);

/**
 * Plan hook (Wave 15 B7, E3): tier, validity and member limit of a club as DATA ONLY. Nothing is billed, charged or enforced;
 * the admin list merely flags `overMemberLimit`.
 */
export const clubPlans = pgTable(
  "club_plans",
  {
    clubId: text("club_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    tier: text("tier").notNull(),
    validFrom: date("valid_from", { mode: "string" }),
    validUntil: date("valid_until", { mode: "string" }),
    memberLimit: integer("member_limit"),
    note: text("note"),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("club_plans_period_chk", sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`),
    check("club_plans_limit_chk", sql`${table.memberLimit} IS NULL OR ${table.memberLimit} > 0`),
  ],
);

export type ClubPlatformStatusRow = typeof clubPlatformStatus.$inferSelect;
export type ClubPlanRow = typeof clubPlans.$inferSelect;
