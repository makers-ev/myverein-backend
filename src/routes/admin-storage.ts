import { zValidator } from "@hono/zod-validator";
import { and, asc, count, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { writeAudit } from "../lib/audit.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { platformQuotaBytes } from "../lib/media-quota.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Platform admin view of the storage per club (Wave 13 A1): usage and quota only, never file names or contents.
 * The quota can be changed per club; `null` returns the club to the platform default.
 */
export const adminStorageRoutes = new Hono<SessionEnv>();

adminStorageRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
adminStorageRoutes.use("*", adminGuard);

const MAX_QUOTA_BYTES = 1024 ** 4; // 1 TiB

const listQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  // Search in name and slug of the club.
  q: z.string().trim().min(1).max(100).optional(),
});

adminStorageRoutes.get(
  "/club-storage",
  zValidator("query", listQuery, (r) => {
    if (!r.success) throw new ValidationError("Invalid request", { details: r.error.issues });
  }),
  async (c) => {
    const q = c.req.valid("query");
    const escaped = q.q?.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const filter = escaped ? or(ilike(organization.name, `%${escaped}%`), ilike(organization.slug, `%${escaped}%`)) : undefined;
    const [total] = await db.select({ n: count() }).from(organization).where(filter);
    const clubs = await db
      .select({ clubId: organization.id, name: organization.name, slug: organization.slug, quota: clubSettings.storageQuotaBytes })
      .from(organization)
      .leftJoin(clubSettings, eq(clubSettings.clubId, organization.id))
      .where(filter)
      .orderBy(asc(organization.name), asc(organization.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const used = clubs.length
      ? await db
          .select({ clubId: mediaFiles.clubId, bytes: sql<number>`coalesce(sum(${mediaFiles.sizeBytes}), 0)::bigint::float8` })
          .from(mediaFiles)
          .where(and(inArray(mediaFiles.clubId, clubs.map((x) => x.clubId)), isNull(mediaFiles.deletedAt)))
          .groupBy(mediaFiles.clubId)
      : [];
    const usedByClub = new Map(used.map((r) => [r.clubId, Number(r.bytes)]));
    const fallback = platformQuotaBytes();
    return c.json({
      data: clubs.map((club) => {
        const quotaBytes = club.quota != null && club.quota > 0 ? club.quota : fallback;
        const usedBytes = usedByClub.get(club.clubId) ?? 0;
        return { clubId: club.clubId, name: club.name, slug: club.slug, usedBytes, quotaBytes, customQuota: club.quota != null && club.quota > 0, percent: Math.round((usedBytes / quotaBytes) * 1000) / 10, overQuota: usedBytes > quotaBytes };
      }),
      page: q.page,
      pageSize: q.pageSize,
      total: total?.n ?? 0,
      defaultQuotaBytes: fallback,
    });
  },
);

const patchBody = z.object({ quotaBytes: z.number().int().min(1).max(MAX_QUOTA_BYTES).nullable() });

adminStorageRoutes.patch(
  "/club-storage/:clubId",
  zValidator("json", patchBody, (r) => {
    if (!r.success) throw new ValidationError("Invalid request body", { details: r.error.issues });
  }),
  async (c) => {
    const clubId = c.req.param("clubId");
    const { quotaBytes } = c.req.valid("json");
    const [club] = await db.select({ id: organization.id }).from(organization).where(eq(organization.id, clubId)).limit(1);
    if (!club) throw new NotFoundError("Club not found");
    await db
      .insert(clubSettings)
      .values({ clubId, storageQuotaBytes: quotaBytes })
      .onConflictDoUpdate({ target: clubSettings.clubId, set: { storageQuotaBytes: quotaBytes, updatedAt: new Date() } });
    await writeAudit(db, { eventType: "club_storage.quota_update", subjectId: clubId, payload: { actor: c.get("user").id, clubId, quotaBytes } });
    return c.json({ data: { clubId, quotaBytes, effectiveQuotaBytes: quotaBytes ?? platformQuotaBytes() } });
  },
);
