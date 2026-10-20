import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organization, user } from "../../auth/auth-schema.js";
import { clubMembers } from "./club-members.js";

/** Delivery channels (ADR-006). `in_app` is always on for account members. */
export const COMMUNICATION_CHANNELS = ["in_app", "email", "push"] as const;
export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export const ANNOUNCEMENT_STATUSES = ["draft", "scheduled", "sending", "sent", "cancelled"] as const;
export type AnnouncementStatus = (typeof ANNOUNCEMENT_STATUSES)[number];

export const DELIVERY_STATUSES = ["queued", "sending", "sent", "failed", "skipped", "skipped_optout", "skipped_no_address", "bounced"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Audience definition stored with an announcement (resolved to a recipient snapshot at send time). */
export interface AnnouncementAudience {
  all?: boolean;
  departmentIds?: string[];
  roleTypes?: string[];
  categoryKeys?: string[];
  memberIds?: string[];
  includeGuardians?: boolean;
}

/** Club announcements / bulletin board (Wave 9, ADR-006). Plain text, no HTML. */
export const clubAnnouncements = pgTable(
  "club_announcements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // NULL once the author's club_members row is gone; the announcement belongs to the club.
    authorMemberId: uuid("author_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    audience: jsonb("audience").$type<AnnouncementAudience>().notNull().default({ all: true }),
    channels: jsonb("channels").$type<CommunicationChannel[]>().notNull().default(["in_app"]),
    urgent: boolean("urgent").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    publishAt: timestamp("publish_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // One of ANNOUNCEMENT_STATUSES (free text in the DB, validated with Zod).
    status: text("status").notNull().default("draft"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("club_announcements_club_status_idx").on(table.clubId, table.status),
    index("club_announcements_club_publish_idx").on(table.clubId, table.publishAt),
  ],
);

/**
 * One row per recipient and channel (proof of delivery + read state). Source is either an announcement or a system event
 * (`event_key` + `ref_id`). `club_id` is optional for platform-context mails (e.g. club registration). `address` is a
 * short-lived snapshot cleared by the retention job.
 */
export const messageDeliveries = pgTable(
  "message_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id").references(() => organization.id, { onDelete: "cascade" }),
    announcementId: uuid("announcement_id").references(() => clubAnnouncements.id, { onDelete: "cascade" }),
    eventKey: text("event_key"),
    refId: text("ref_id"),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    channel: text("channel").notNull(),
    // One of DELIVERY_STATUSES.
    status: text("status").notNull().default("queued"),
    errorCode: text("error_code"),
    attempts: integer("attempts").notNull().default(0),
    address: text("address"),
    // Message snapshot (title/body/template/category/class/...) rendered by the channel handlers; see src/lib/notify.
    content: jsonb("content").$type<Record<string, unknown>>(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("message_deliveries_club_announcement_idx").on(table.clubId, table.announcementId),
    index("message_deliveries_user_read_idx").on(table.userId, table.readAt),
    index("message_deliveries_event_ref_idx").on(table.eventKey, table.refId),
    uniqueIndex("message_deliveries_announcement_recipient_uidx")
      .on(table.announcementId, table.clubMemberId, table.channel)
      .where(sql`${table.announcementId} IS NOT NULL AND ${table.clubMemberId} IS NOT NULL`),
    // Idempotency for recipients without a club member row (account-only announcement recipients).
    uniqueIndex("message_deliveries_announcement_user_uidx")
      .on(table.announcementId, table.userId, table.channel)
      .where(sql`${table.announcementId} IS NOT NULL AND ${table.clubMemberId} IS NULL`),
    // Idempotency for system events: one delivery per event key, reference, channel and person. A reference that may
    // legitimately repeat (reminders per day, event changes per version) carries a `#discriminator` suffix in ref_id.
    uniqueIndex("message_deliveries_system_event_uidx")
      .on(table.eventKey, table.refId, table.channel, sql`coalesce(${table.clubMemberId}::text, ${table.userId})`)
      .where(sql`${table.announcementId} IS NULL`),
    // Recipients with neither account nor member row (e-mail addresses of the review team, ...): dedupe by address. Only new-style
    // references (`<id>#<transition>`) are covered, so rows written before this index cannot make the migration fail.
    uniqueIndex("message_deliveries_address_event_uidx")
      .on(table.eventKey, table.refId, table.channel, table.address)
      .where(sql`${table.announcementId} IS NULL AND ${table.clubMemberId} IS NULL AND ${table.userId} IS NULL AND ${table.address} IS NOT NULL AND ${table.refId} LIKE '%#%'`),
  ],
);

/** Expo push token per device. A token belongs to exactly one user at a time (takeover on re-login happens in the route). */
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique("push_tokens_token_uidx"),
    platform: text("platform").notNull(),
    appVersion: text("app_version"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("push_tokens_user_idx").on(table.userId)],
);

/**
 * Opt-in/opt-out per person x category x channel. Exactly one of `user_id` / `club_member_id` (account-less members).
 * `club_id` NULL = the global default of the person; a row with a `club_id` is the override for that club only and wins
 * over the global row (club-specific > global > enabled).
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    clubMemberId: uuid("club_member_id").references(() => clubMembers.id, { onDelete: "cascade" }),
    clubId: text("club_id").references(() => organization.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    channel: text("channel").notNull(),
    enabled: boolean("enabled").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("notification_preferences_subject_chk", sql`(${table.userId} IS NOT NULL) <> (${table.clubMemberId} IS NOT NULL)`),
    uniqueIndex("notification_preferences_user_uidx")
      .on(table.userId, table.category, table.channel)
      .where(sql`${table.userId} IS NOT NULL AND ${table.clubId} IS NULL`),
    uniqueIndex("notification_preferences_member_uidx")
      .on(table.clubMemberId, table.category, table.channel)
      .where(sql`${table.clubMemberId} IS NOT NULL AND ${table.clubId} IS NULL`),
    uniqueIndex("notification_preferences_user_club_uidx")
      .on(table.userId, table.clubId, table.category, table.channel)
      .where(sql`${table.userId} IS NOT NULL AND ${table.clubId} IS NOT NULL`),
    uniqueIndex("notification_preferences_member_club_uidx")
      .on(table.clubMemberId, table.clubId, table.category, table.channel)
      .where(sql`${table.clubMemberId} IS NOT NULL AND ${table.clubId} IS NOT NULL`),
  ],
);

export type ClubAnnouncementRow = typeof clubAnnouncements.$inferSelect;
export type MessageDeliveryRow = typeof messageDeliveries.$inferSelect;
export type PushTokenRow = typeof pushTokens.$inferSelect;
export type NotificationPreferenceRow = typeof notificationPreferences.$inferSelect;
