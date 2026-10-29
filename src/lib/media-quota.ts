import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { documents, documentVersions } from "../db/schema/documents.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { logger } from "./logger.js";
import { notifySafely } from "./notify/dispatcher.js";

/**
 * Storage quota of a club (Wave 13 B3). The used amount is ALWAYS the sum of the live `media_files` of the club (one source
 * of truth, read under the per-club advisory lock `media-quota:<clubId>` by `storeUpload`/`storeGeneratedPdf`, so parallel
 * uploads cannot overshoot). The limit is `club_settings.storage_quota_bytes`, else the platform default.
 * Files in the document trash still count; the quota blocks writing, it never deletes anything.
 */

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Platform default per club in bytes (`MEDIA_QUOTA_BYTES_PER_CLUB`, default 1 GiB). */
export function platformQuotaBytes(): number {
  const parsed = Number(process.env.MEDIA_QUOTA_BYTES_PER_CLUB);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1024 * 1024 * 1024;
}

/** The limit that applies to the club: its own `storage_quota_bytes` or the platform default. */
export async function effectiveQuotaBytes(executor: DbExecutor, clubId: string): Promise<number> {
  const [row] = await executor.select({ quota: clubSettings.storageQuotaBytes }).from(clubSettings).where(eq(clubSettings.clubId, clubId)).limit(1);
  return row?.quota != null && row.quota > 0 ? row.quota : platformQuotaBytes();
}

/** Bytes of all live files of the club. */
export async function usedBytes(executor: DbExecutor, clubId: string): Promise<number> {
  const [row] = await executor
    .select({ used: sql<number>`coalesce(sum(${mediaFiles.sizeBytes}), 0)::bigint::float8` })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.clubId, clubId), isNull(mediaFiles.deletedAt)));
  return Number(row?.used ?? 0);
}

/** Which area an `owner_type` of the registry belongs to in the usage overview. */
export const STORAGE_AREAS = ["documents", "personal", "generated", "branding", "other"] as const;
export type StorageArea = (typeof STORAGE_AREAS)[number];

const AREA_BY_OWNER: Record<string, StorageArea> = { document: "documents", member_document: "personal", generated_pdf: "generated", branding: "branding" };

export interface StorageUsage {
  usedBytes: number;
  quotaBytes: number;
  /** Used share of the quota in percent (0-100+, one decimal). */
  percent: number;
  /** Bytes per area; `trashBytes` is the part of the document areas that sits in the trash (already included). */
  areas: Record<StorageArea, number>;
  trashBytes: number;
}

export async function storageUsage(clubId: string, executor: DbExecutor = db): Promise<StorageUsage> {
  const rows = await executor
    .select({ ownerType: mediaFiles.ownerType, bytes: sql<number>`coalesce(sum(${mediaFiles.sizeBytes}), 0)::bigint::float8` })
    .from(mediaFiles)
    .where(and(eq(mediaFiles.clubId, clubId), isNull(mediaFiles.deletedAt)))
    .groupBy(mediaFiles.ownerType);
  const areas: Record<StorageArea, number> = { documents: 0, personal: 0, generated: 0, branding: 0, other: 0 };
  for (const r of rows) areas[AREA_BY_OWNER[r.ownerType] ?? "other"] += Number(r.bytes);
  const used = Object.values(areas).reduce((a, b) => a + b, 0);
  const quota = await effectiveQuotaBytes(executor, clubId);
  const [trash] = await executor
    .select({ bytes: sql<number>`coalesce(sum(${mediaFiles.sizeBytes}), 0)::bigint::float8` })
    .from(mediaFiles)
    .where(
      and(
        eq(mediaFiles.clubId, clubId),
        isNull(mediaFiles.deletedAt),
        inArray(
          mediaFiles.storageKey,
          executor
            .select({ key: documentVersions.storageKey })
            .from(documentVersions)
            .innerJoin(documents, eq(documents.id, documentVersions.documentId))
            .where(and(eq(documents.clubId, clubId), inArray(documents.status, ["im_papierkorb", "zur_loeschung"]))),
        ),
      ),
    );
  return { usedBytes: used, quotaBytes: quota, percent: quota > 0 ? Math.round((used / quota) * 1000) / 10 : 0, areas, trashBytes: Number(trash?.bytes ?? 0) };
}

/** 80 / 100 % thresholds: the highest one crossed (0 = none). */
export function noticeLevelFor(percent: number): 0 | 80 | 100 {
  return percent >= 100 ? 100 : percent >= 80 ? 80 : 0;
}

/**
 * Tells the people with `storage:read` once per threshold (80 %, 100 %) that the storage is filling up. The reported level is
 * kept in `club_settings.storage_notice_level` and moved with a conditional UPDATE, so parallel callers send one message;
 * it is reset when usage falls below 80 %. Best effort: never throws into the upload path.
 */
export async function checkStorageThresholds(clubId: string): Promise<void> {
  try {
    const usage = await storageUsage(clubId);
    const level = noticeLevelFor(usage.percent);
    await db.insert(clubSettings).values({ clubId }).onConflictDoNothing();
    if (level === 0) {
      await db.update(clubSettings).set({ storageNoticeLevel: 0 }).where(and(eq(clubSettings.clubId, clubId), sql`${clubSettings.storageNoticeLevel} > 0`));
      return;
    }
    const moved = await db
      .update(clubSettings)
      .set({ storageNoticeLevel: level })
      .where(and(eq(clubSettings.clubId, clubId), sql`${clubSettings.storageNoticeLevel} < ${level}`))
      .returning({ clubId: clubSettings.clubId });
    if (moved.length === 0) return;
    const full = level === 100;
    await notifySafely({
      clubId,
      class: "optional",
      eventKey: `storage.threshold_${level}`,
      refId: `${clubId}:${level}`,
      audience: { roleTypes: roleTypesWithPermission("storage:read") },
      content: {
        title: full ? "Speicher des Vereins ist voll" : "Speicher des Vereins zu 80 % belegt",
        body: full
          ? "Das Speicher-Kontingent ist ausgeschöpft: neue Dokumente und Uploads werden abgelehnt, bis Platz geschaffen wird (Papierkorb leeren, nicht mehr benötigte Dateien löschen) oder das Kontingent erhöht wird. Es wird nichts automatisch gelöscht."
          : "Mindestens 80 % des Speicher-Kontingents sind belegt. Bitte rechtzeitig Platz schaffen (Papierkorb leeren, nicht mehr benötigte Dateien löschen).",
        template: "notice",
        category: "board",
      },
      channels: ["in_app", "email"],
    });
  } catch (err) {
    logger.error({ err, clubId }, "[media] storage threshold check failed");
  }
}
