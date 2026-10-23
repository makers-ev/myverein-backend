import { relations, sql } from "drizzle-orm";
import { boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { member, organization } from "../../auth/auth-schema.js";
import { departments } from "./departments.js";
import { clubPrivacyNotices } from "./club-privacy-notices.js";
import { mediaFiles } from "./media-files.js";

/** Allowed values of `club_members.status` (free text in the DB, validated with Zod in the routes). */
export const MEMBER_STATUSES = ["interessent", "probe", "aktiv", "ruhend", "ausgetreten", "ausgeschlossen", "verstorben"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** Statuses that mean "no longer a member" (set by the exit workflow, never by a plain PATCH). */
export const LEFT_STATUSES: readonly MemberStatus[] = ["ausgetreten", "ausgeschlossen", "verstorben"];

/**
 * Per-club membership categories (Wave 7, B2). Replaces the free-text
 * `club_memberships.category`; the five legacy values are seeded for every
 * club (see `ensureDefaultCategories`). Categories are archived, never deleted.
 */
export const memberCategories = pgTable(
  "member_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    votingRight: boolean("voting_right").notNull().default(true),
    // Whether an applicant may pick this category in the application form (Wave 8). Default closed: the board opts in.
    applicantSelectable: boolean("applicant_selectable").notNull().default(false),
    minAge: integer("min_age"),
    maxAge: integer("max_age"),
    autoTransitionToKey: text("auto_transition_to_key"),
    sortOrder: integer("sort_order").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("member_categories_club_key_uidx").on(table.clubId, table.key)],
);

/**
 * The club-side identity of a person (ADR-003). `member_id` links the Better
 * Auth `member` (account membership) and is NULL for members without an
 * account (e.g. children). Master data lives here; everything that needs a
 * login (club_roles, loans, RSVP, ...) stays on `member.id`.
 *
 * `member_number` is deliberately NOT unique in the DB: legacy data may hold
 * duplicates, so uniqueness per club is enforced by the API (409).
 */
export const clubMembers = pgTable(
  "club_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => member.id, { onDelete: "set null" }),
    // The user whose account was linked last. Survives the removal of the account membership (member_id becomes NULL)
    // and lets a re-join of the same person reuse this row instead of creating a duplicate. NULL = never had an account.
    lastUserId: text("last_user_id"),
    displayName: text("display_name").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    birthDate: date("birth_date", { mode: "string" }),
    street: text("street"),
    postalCode: text("postal_code"),
    city: text("city"),
    phone: text("phone"),
    contactEmail: text("contact_email"),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    memberNumber: text("member_number"),
    categoryId: uuid("category_id").references(() => memberCategories.id, { onDelete: "set null" }),
    // One of MEMBER_STATUSES (validated via Zod, free text in the DB).
    status: text("status").notNull().default("aktiv"),
    joinedAt: date("joined_at", { mode: "string" }).notNull(),
    leftAt: date("left_at", { mode: "string" }),
    exitReason: text("exit_reason"),
    // Set when the board deliberately unlinked the account (POST /:id/unlink): the member stays as is (no exit) and the
    // row is not reused when the same person joins again. Cleared when an account is linked.
    accountUnlinkedAt: timestamp("account_unlinked_at", { withTimezone: true }),
    // Profile photo: storage key of a `media_files` row (never a URL; B13). NULL = no photo.
    photoKey: text("photo_key").references(() => mediaFiles.storageKey, { onDelete: "set null" }),
    // Art. 14 GDPR: when and which version of the privacy notice was handed to a member who has no account.
    privacyNoticeSentAt: timestamp("privacy_notice_sent_at", { withTimezone: true }),
    privacyNoticeVersionId: uuid("privacy_notice_version_id").references(() => clubPrivacyNotices.id, { onDelete: "set null" }),
    // Legal hold (Wave 10 B8): while set, erasure and anonymisation of this member are refused (409). Not shown to the member.
    legalHoldAt: timestamp("legal_hold_at", { withTimezone: true }),
    legalHoldReason: text("legal_hold_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("club_members_member_id_uidx").on(table.memberId),
    index("club_members_club_id_idx").on(table.clubId),
    index("club_members_club_last_user_idx").on(table.clubId, table.lastUserId),
    index("club_members_club_status_idx").on(table.clubId, table.status),
    index("club_members_club_member_number_idx").on(table.clubId, table.memberNumber),
    // Name sort/search of the member list (B9): ORDER BY lower(display_name), id within one club.
    index("club_members_club_name_idx").on(table.clubId, sql`lower(${table.displayName})`),
  ],
);

/** Member <-> department assignment with a validity period; at most one open (`until IS NULL`) entry per pair. */
export const clubMemberDepartments = pgTable(
  "club_member_departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    since: date("since", { mode: "string" }).notNull().default(sql`CURRENT_DATE`),
    until: date("until", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("club_member_departments_open_uidx")
      .on(table.clubMemberId, table.departmentId)
      .where(sql`${table.until} IS NULL`),
    index("club_member_departments_department_idx").on(table.departmentId),
  ],
);

/** Status/category change log (written by the status workflow, B5). */
export const clubMemberStatusHistory = pgTable(
  "club_member_status_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubMemberId: uuid("club_member_id")
      .notNull()
      .references(() => clubMembers.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    fromCategoryId: uuid("from_category_id").references(() => memberCategories.id, { onDelete: "set null" }),
    toCategoryId: uuid("to_category_id").references(() => memberCategories.id, { onDelete: "set null" }),
    effectiveOn: date("effective_on", { mode: "string" }).notNull(),
    reason: text("reason"),
    changedBy: text("changed_by").references(() => member.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("club_member_status_history_member_idx").on(table.clubMemberId)],
);

export const memberCategoriesRelations = relations(memberCategories, ({ one }) => ({
  club: one(organization, { fields: [memberCategories.clubId], references: [organization.id] }),
}));

export const clubMembersRelations = relations(clubMembers, ({ one, many }) => ({
  club: one(organization, { fields: [clubMembers.clubId], references: [organization.id] }),
  account: one(member, { fields: [clubMembers.memberId], references: [member.id] }),
  category: one(memberCategories, { fields: [clubMembers.categoryId], references: [memberCategories.id] }),
  departments: many(clubMemberDepartments),
}));

export const clubMemberDepartmentsRelations = relations(clubMemberDepartments, ({ one }) => ({
  clubMember: one(clubMembers, { fields: [clubMemberDepartments.clubMemberId], references: [clubMembers.id] }),
  department: one(departments, { fields: [clubMemberDepartments.departmentId], references: [departments.id] }),
}));

export type ClubMemberRow = typeof clubMembers.$inferSelect;
export type NewClubMemberRow = typeof clubMembers.$inferInsert;
export type MemberCategoryRow = typeof memberCategories.$inferSelect;
export type NewMemberCategoryRow = typeof memberCategories.$inferInsert;
export type ClubMemberDepartmentRow = typeof clubMemberDepartments.$inferSelect;
