import { zValidator } from "@hono/zod-validator";
import { count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { retentionRuns } from "../db/schema/privacy.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission, type ClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clearClubOverride, effectiveRules, setClubOverride } from "../lib/retention/policy.js";
import { ruleOf } from "../lib/retention/rules.js";
import { retentionDryRun, retentionNoticeDays } from "../lib/retention/sweep.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Retention rules of ONE club (Wave 10 B9): the periods in force, the club's overrides inside the limits of each rule, a preview
 * of what the next sweep would concern and the log of the sweeps. Reading needs `privacy:read`, changing `privacy:manage`.
 */
export const retentionPolicyRoutes = new Hono<ClubEnv>();

retentionPolicyRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
retentionPolicyRoutes.use("*", sessionGuard);
retentionPolicyRoutes.use("*", clubGuard);

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

function need(c: { get(k: "clubRoleTypes"): string[] }, permission: ClubPermission) {
  if (!hasClubPermission(c.get("clubRoleTypes"), permission)) throw new ForbiddenError(`Missing ${permission} permission`);
}

retentionPolicyRoutes.get("/", async (c) => {
  need(c, "privacy:read");
  const rules = await effectiveRules(c.get("clubId"));
  return c.json({
    data: {
      // While true nothing is deleted; the sweep only counts (switched by the operator after the legal review).
      dryRun: retentionDryRun(),
      noticeDays: retentionNoticeDays(),
      rules: rules.map(({ rule, effectiveDays, overridden }) => ({
        category: rule.category,
        scope: rule.scope,
        label: rule.label,
        description: rule.description,
        defaultDays: rule.defaultDays,
        minDays: rule.minDays,
        maxDays: rule.maxDays,
        effectiveDays,
        overridden,
        editable: rule.scope === "club",
      })),
    },
  });
});

/** What the next sweep would concern in this club (counts only). Runs the real selection in count mode. */
retentionPolicyRoutes.get("/preview", async (c) => {
  need(c, "privacy:read");
  const clubId = c.get("clubId");
  const now = new Date();
  const out: Array<{ category: string; label: string; due: number }> = [];
  for (const { rule, effectiveDays } of await effectiveRules(clubId)) {
    if (rule.scope !== "club") continue;
    const result = await rule.run({ clubId, days: effectiveDays, now, dryRun: true });
    out.push({ category: rule.category, label: rule.label, due: result.scanned });
  }
  return c.json({ data: out });
});

const runsQuery = z.object({ page: z.coerce.number().int().min(1).max(100_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) });

retentionPolicyRoutes.get("/runs", zValidator("query", runsQuery, validationHook), async (c) => {
  need(c, "privacy:read");
  const q = c.req.valid("query");
  const where = eq(retentionRuns.clubId, c.get("clubId"));
  const [total] = await db.select({ n: count() }).from(retentionRuns).where(where);
  const rows = await db.select().from(retentionRuns).where(where).orderBy(desc(retentionRuns.startedAt), desc(retentionRuns.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  return c.json({
    data: rows.map((r) => ({ id: r.id, category: r.category, dryRun: r.dryRun, notice: r.notice, scanned: r.scanned, affected: r.affected, errors: r.errors, startedAt: r.startedAt, finishedAt: r.finishedAt })),
    page: q.page,
    pageSize: q.pageSize,
    total: total?.n ?? 0,
  });
});

const putSchema = z.object({ retainDays: z.number().int().min(0).max(36_500) });

function clubRuleOf(category: string) {
  const rule = ruleOf(category);
  if (!rule) throw new NotFoundError("Retention rule not found");
  if (rule.scope !== "club") throw new ValidationError("This period is set by the platform", { details: { code: "not_editable" } });
  return rule;
}

retentionPolicyRoutes.put("/:category", zValidator("json", putSchema, validationHook), async (c) => {
  need(c, "privacy:manage");
  const rule = clubRuleOf(c.req.param("category"));
  const { retainDays } = c.req.valid("json");
  if (retainDays < rule.minDays || retainDays > rule.maxDays) {
    throw new ValidationError(`The period must be between ${rule.minDays} and ${rule.maxDays} days`, { details: { code: "out_of_bounds", minDays: rule.minDays, maxDays: rule.maxDays } });
  }
  const clubId = c.get("clubId");
  await db.transaction(async (tx) => {
    await setClubOverride(clubId, rule, retainDays, c.get("user").id, tx);
    await writeAudit(tx, { eventType: "retention_policy.update", subjectId: rule.category, payload: { clubId, category: rule.category, retainDays, changedBy: c.get("user").id } });
  });
  return c.json({ data: { category: rule.category, effectiveDays: retainDays, overridden: true } });
});

/** Back to the default period. */
retentionPolicyRoutes.delete("/:category", async (c) => {
  need(c, "privacy:manage");
  const rule = clubRuleOf(c.req.param("category"));
  const clubId = c.get("clubId");
  const removed = await db.transaction(async (tx) => {
    const done = await clearClubOverride(clubId, rule.category, tx);
    if (done) await writeAudit(tx, { eventType: "retention_policy.reset", subjectId: rule.category, payload: { clubId, category: rule.category, changedBy: c.get("user").id } });
    return done;
  });
  if (!removed) throw new NotFoundError("No override for this category");
  return c.body(null, 204);
});
