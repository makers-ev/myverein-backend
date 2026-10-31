import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import type { DbExecutor } from "../club-members.js";
import { retentionPolicies } from "../../db/schema/privacy.js";
import { clamp, RETENTION_RULES, type RetentionRule } from "./rules.js";

export interface EffectiveRule {
  rule: RetentionRule;
  effectiveDays: number;
  /** A club (or, for platform rules, platform) override is in force. */
  overridden: boolean;
}

/** Effective periods of a club: club override > platform override > default, always clamped to the rule's limits. */
export async function effectiveRules(clubId: string | null): Promise<EffectiveRule[]> {
  const platform = await db.select().from(retentionPolicies).where(isNull(retentionPolicies.clubId));
  const own = clubId ? await db.select().from(retentionPolicies).where(eq(retentionPolicies.clubId, clubId)) : [];
  return RETENTION_RULES.map((rule) => {
    const club = rule.scope === "club" ? own.find((p) => p.category === rule.category) : undefined;
    const plat = platform.find((p) => p.category === rule.category);
    const days = club?.retainDays ?? plat?.retainDays;
    return { rule, effectiveDays: days === undefined ? rule.defaultDays : clamp(rule, days), overridden: days !== undefined };
  });
}

export async function setClubOverride(clubId: string, rule: RetentionRule, retainDays: number, userId: string, executor: DbExecutor = db): Promise<void> {
  await executor
    .insert(retentionPolicies)
    .values({ clubId, category: rule.category, retainDays, updatedBy: userId })
    .onConflictDoUpdate({ target: [retentionPolicies.clubId, retentionPolicies.category], targetWhere: sql`${retentionPolicies.clubId} IS NOT NULL`, set: { retainDays, updatedBy: userId, updatedAt: new Date() } });
}

export async function clearClubOverride(clubId: string, category: string, executor: DbExecutor = db): Promise<boolean> {
  const rows = await executor.delete(retentionPolicies).where(and(eq(retentionPolicies.clubId, clubId), eq(retentionPolicies.category, category))).returning({ id: retentionPolicies.id });
  return rows.length > 0;
}

