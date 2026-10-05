import { relations, sql } from "drizzle-orm";
import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organization, user } from "../../auth/auth-schema.js";

export const CLUB_LEGAL_FORMS = ["e_v", "nicht_eingetragen", "sonstige"] as const;
export type ClubLegalForm = (typeof CLUB_LEGAL_FORMS)[number];

/** Board roles an applicant may claim; all hold members:write + roles:write (see lib/club-permissions.ts). */
export const CLAIMABLE_ROLES = ["vorsitz", "stellv_vorsitz", "schriftfuehrer"] as const;
export type ClaimableRole = (typeof CLAIMABLE_ROLES)[number];

export const REGISTRATION_STATUSES = ["draft", "pending", "needs_info", "approved", "rejected"] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];
/** Statuses that count as an "open" application (at most one per user, partial unique index). */
export const OPEN_REGISTRATION_STATUSES = ["draft", "pending", "needs_info"] as const;

export const REGISTRATION_DOCUMENT_KINDS = ["registerauszug", "satzung", "freistellungsbescheid", "gruendungsprotokoll", "sonstiges"] as const;
export type RegistrationDocumentKind = (typeof REGISTRATION_DOCUMENT_KINDS)[number];

/**
 * Wave 6: "Verein gruenden" applications. A club (`organization`) only comes
 * into existence when a platform admin approves a registration
 * (POST /admin/club-registrations/:id/approve); `club_id` is set then.
 *
 * `status`/`legal_form`/`claimed_role` are free text validated in the routes
 * (same "no DB enums" principle as the rest of the schema). The partial unique
 * index allows only ONE open (draft/pending/needs_info) registration per user.
 */
export const clubRegistrations = pgTable(
  "club_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clubName: text("club_name").notNull(),
    legalForm: text("legal_form").notNull(),
    registerCourt: text("register_court"),
    registerNumber: text("register_number"),
    street: text("street").notNull(),
    postalCode: text("postal_code").notNull(),
    city: text("city").notNull(),
    websiteUrl: text("website_url"),
    claimedRole: text("claimed_role").notNull().default("vorsitz"),
    status: text("status").notNull().default("draft"),
    reviewNote: text("review_note"),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    clubId: text("club_id").references(() => organization.id, { onDelete: "set null" }),
    slugSuggestion: text("slug_suggestion"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("club_registrations_open_user_uidx")
      .on(table.userId)
      .where(sql`${table.status} IN ('draft', 'pending', 'needs_info')`),
    index("club_registrations_status_idx").on(table.status, table.submittedAt),
  ],
);

export const clubRegistrationDocuments = pgTable(
  "club_registration_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => clubRegistrations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("club_registration_documents_registration_idx").on(table.registrationId)],
);

export const clubRegistrationsRelations = relations(clubRegistrations, ({ one, many }) => ({
  applicant: one(user, { fields: [clubRegistrations.userId], references: [user.id], relationName: "registrationApplicant" }),
  reviewer: one(user, { fields: [clubRegistrations.reviewedBy], references: [user.id], relationName: "registrationReviewer" }),
  club: one(organization, { fields: [clubRegistrations.clubId], references: [organization.id] }),
  documents: many(clubRegistrationDocuments),
}));

export const clubRegistrationDocumentsRelations = relations(clubRegistrationDocuments, ({ one }) => ({
  registration: one(clubRegistrations, { fields: [clubRegistrationDocuments.registrationId], references: [clubRegistrations.id] }),
}));

export type ClubRegistrationRow = typeof clubRegistrations.$inferSelect;
export type NewClubRegistrationRow = typeof clubRegistrations.$inferInsert;
export type ClubRegistrationDocumentRow = typeof clubRegistrationDocuments.$inferSelect;
