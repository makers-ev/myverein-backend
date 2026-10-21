import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, isNull, isNotNull, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { retentionRuns } from "../db/schema/privacy.js";
import { ValidationError } from "../lib/errors.js";
import { retentionDryRun } from "../lib/retention/sweep.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Platform-admin view of the retention sweeps (Wave 10 A3): counters per category and run, never personal data. By default the
 * platform-level categories (proof documents of founding applications, audit log); `scope=club` / `all` adds the club runs.
 */
export const adminRetentionRoutes = new Hono<SessionEnv>();

adminRetentionRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
adminRetentionRoutes.use("*", adminGuard);

const query = z.object({
  scope: z.enum(["platform", "club", "all"]).default("platform"),
  category: z.string().trim().min(1).max(60).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

adminRetentionRoutes.get("/", zValidator("query", query, (r) => {
  if (!r.success) throw new ValidationError("Invalid request", { details: r.error.issues });
}), async (c) => {
  const q = c.req.valid("query");
  const conditions: SQL[] = [];
  if (q.scope === "platform") conditions.push(isNull(retentionRuns.clubId));
  if (q.scope === "club") conditions.push(isNotNull(retentionRuns.clubId));
  if (q.category) conditions.push(eq(retentionRuns.category, q.category));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const [total] = await db.select({ n: count() }).from(retentionRuns).where(where);
  const rows = await db
    .select({ r: retentionRuns, clubName: organization.name })
    .from(retentionRuns)
    .leftJoin(organization, eq(organization.id, retentionRuns.clubId))
    .where(where)
    .orderBy(desc(retentionRuns.startedAt), desc(retentionRuns.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return c.json({
    data: rows.map(({ r, clubName }) => ({ id: r.id, clubId: r.clubId, clubName, category: r.category, dryRun: r.dryRun, notice: r.notice, scanned: r.scanned, affected: r.affected, errors: r.errors, errorCode: r.errorCode, startedAt: r.startedAt, finishedAt: r.finishedAt })),
    page: q.page,
    pageSize: q.pageSize,
    total: total?.n ?? 0,
    dryRun: retentionDryRun(),
  });
});
