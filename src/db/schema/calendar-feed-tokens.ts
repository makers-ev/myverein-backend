import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";
import { calendars } from "./calendars.js";

/**
 * Revocable subscription token of one member for the iCal feed (`GET /feeds/:token.ics`, Wave 12). Only the SHA-256
 * of the token is stored; the plain token is shown once. The feed resolves the member's rights at fetch time.
 */
export const calendarFeedTokens = pgTable(
  "calendar_feed_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => member.id, { onDelete: "cascade" }),
    // Optional restriction to one calendar; NULL = everything the member may see.
    calendarId: uuid("calendar_id").references(() => calendars.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("calendar_feed_tokens_hash_uidx").on(table.tokenHash), index("calendar_feed_tokens_member_idx").on(table.memberId)],
);

export type CalendarFeedTokenRow = typeof calendarFeedTokens.$inferSelect;
