import { index, integer, pgTable, text, boolean, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { organization, user } from "../../auth/auth-schema.js";

/** Who may fetch a file without a feature route in between. Free text in the DB, validated in `src/lib/media.ts`. */
export const MEDIA_VISIBILITIES = ["private", "club", "public_opt_in"] as const;
export type MediaVisibility = (typeof MEDIA_VISIBILITIES)[number];

export const MEDIA_KINDS = ["image", "document"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** `owner_type` of a freshly uploaded file that no feature row references yet. */
export const UNATTACHED_OWNER = "unattached";

/**
 * Central upload registry (Wave 7 B18). EVERY stored user file has a row here; the row -- never the file extension --
 * is the source of truth for the content type, size, owner and visibility. Feature tables reference a file only by its
 * `storage_key` (never by URL); URLs are minted at response time (`src/lib/media.ts`, `src/lib/media-url.ts`).
 *
 * - `club_id` is NULL for platform-level files that belong to no club (club registration proofs).
 * - `sensitive` files (proof documents, ID verification, ...) are never handed out as signed URLs, only streamed to an
 *   authenticated caller with an audit entry per retrieval.
 * - `visibility`: `private` / `club` are reachable only through signed URLs a feature route issued after its own
 *   permission check; `public_opt_in` (explicit opt-in, never sensitive) may be fetched without a signature.
 * - Deleting sets `deleted_at` and removes the file; the row stays as a tombstone (GET answers 404).
 */
export const mediaFiles = pgTable(
  "media_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clubId: text("club_id").references(() => organization.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    ownerType: text("owner_type").notNull().default(UNATTACHED_OWNER),
    ownerId: text("owner_id"),
    kind: text("kind").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    originalFilename: text("original_filename").notNull(),
    sensitive: boolean("sensitive").notNull().default(false),
    visibility: text("visibility").notNull().default("private"),
    uploadedBy: text("uploaded_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("media_files_storage_key_uidx").on(table.storageKey),
    // Quota sum per club over live files.
    index("media_files_club_live_idx").on(table.clubId).where(sql`${table.deletedAt} IS NULL`),
    index("media_files_owner_idx").on(table.ownerType, table.ownerId),
  ],
);

export type MediaFileRow = typeof mediaFiles.$inferSelect;
export type NewMediaFileRow = typeof mediaFiles.$inferInsert;
