import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import { organization } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { retentionRuns } from "../../db/schema/privacy.js";
import { roleTypesWithPermission } from "../club-permissions.js";
import { clubMailLanguage } from "../club-settings.js";
import { logger } from "../logger.js";
import { notifySafely } from "../notify/dispatcher.js";
import { formatIsoDay, tr } from "../notify/i18n.js";
import { BOARD_CATEGORY } from "../notify/types.js";
import { todayBerlin } from "../member-lifecycle.js";
import type { CategoryResult } from "./categories.js";
import { effectiveRules } from "./policy.js";
import type { RetentionRule } from "./rules.js";

/**
 * Daily retention sweep (Wave 10 B9). `RETENTION_DRY_RUN` defaults to TRUE: every category is only counted and logged in
 * `retention_runs` (counters, never personal data). Switching it to `false` is a deliberate decision (release gate K4). Even
 * then a club category deletes only after the club was told: the first real run that finds something writes a notice run and
 * notifies `privacy:manage` roles; deleting starts `RETENTION_NOTICE_DAYS` (default 7) later. Platform categories (proof
 * documents of founding applications, audit log) have no club to tell. Errors are isolated per category and club.
 */

export function retentionDryRun(): boolean {
  return process.env.RETENTION_DRY_RUN !== "false";
}

export function retentionNoticeDays(): number {
  const n = Number(process.env.RETENTION_NOTICE_DAYS);
  return Number.isFinite(n) && n >= 1 && n <= 90 ? Math.floor(n) : 7;
}

export interface SweepOptions {
  /** Override of the environment (tests). */
  dryRun?: boolean;
  /** Only this club's categories (and no platform categories). */
  clubId?: string;
}

export interface SweepSummary {
  runs: number;
  affected: number;
  failed: string[];
}

async function logRun(entry: { clubId: string | null; category: string; dryRun: boolean; notice?: boolean; result: CategoryResult; errorCode?: string; startedAt: Date }): Promise<void> {
  await db.insert(retentionRuns).values({
    clubId: entry.clubId,
    category: entry.category,
    dryRun: entry.dryRun,
    notice: entry.notice ?? false,
    scanned: entry.result.scanned,
    affected: entry.notice ? entry.result.scanned : entry.result.affected,
    errors: entry.errorCode ? 1 : 0,
    errorCode: entry.errorCode ?? null,
    startedAt: entry.startedAt,
    finishedAt: new Date(),
  });
}

/** The state of the announcement for one club category. */
async function noticeState(clubId: string, category: string, now: Date): Promise<"given" | "waiting" | "none"> {
  const [given] = await db
    .select({ id: retentionRuns.id })
    .from(retentionRuns)
    .where(and(eq(retentionRuns.clubId, clubId), eq(retentionRuns.category, category), eq(retentionRuns.notice, true), gt(retentionRuns.affected, 0), lte(retentionRuns.startedAt, new Date(now.getTime() - retentionNoticeDays() * 86_400_000))))
    .limit(1);
  if (given) return "given";
  const [any] = await db.select({ id: retentionRuns.id }).from(retentionRuns).where(and(eq(retentionRuns.clubId, clubId), eq(retentionRuns.category, category), eq(retentionRuns.notice, true))).limit(1);
  return any ? "waiting" : "none";
}

async function announce(clubId: string, items: Array<{ rule: RetentionRule; count: number }>, now: Date): Promise<void> {
  const lang = await clubMailLanguage(db, clubId);
  const from = todayBerlin(new Date(now.getTime() + retentionNoticeDays() * 86_400_000));
  const lines = items.map((i) => `- ${i.rule.label}: ${i.count}`).join("\n");
  await notifySafely({
    clubId,
    class: "optional",
    eventKey: "retention.notice",
    refId: `${clubId}#${todayBerlin(now)}`,
    audience: { roleTypes: roleTypesWithPermission("privacy:manage"), includeGuardians: false },
    content: {
      title: tr(lang, "Aufbewahrungsfristen: Daten werden bald gelöscht", "Retention periods: data will be deleted soon"),
      body: tr(
        lang,
        `Ab dem ${formatIsoDay(from)} löscht MyVerein Daten, deren Aufbewahrungsfrist abgelaufen ist. Betroffen sind (Anzahl):\n${lines}\nDie Fristen können unter Datenschutz > Aufbewahrung geprüft und innerhalb der Grenzen angepasst werden.`,
        `From ${formatIsoDay(from, "en")} MyVerein deletes data whose retention period has expired. Affected (count):\n${lines}\nThe periods can be reviewed and adjusted within limits under Privacy > Retention.`,
      ),
      template: "reminder",
      category: BOARD_CATEGORY,
      lang,
    },
    channels: ["in_app", "email"],
  });
}

export async function runRetentionRules(now: Date = new Date(), options: SweepOptions = {}): Promise<SweepSummary> {
  const globalDry = options.dryRun ?? retentionDryRun();
  const summary: SweepSummary = { runs: 0, affected: 0, failed: [] };

  const attempt = async (rule: RetentionRule, clubId: string | null, run: () => Promise<{ result: CategoryResult; dryRun: boolean; notice?: boolean } | null>) => {
    const startedAt = new Date();
    try {
      const out = await run();
      if (!out) return;
      // Platform categories always leave a row (the platform view shows that the sweep ran); club categories only when something was found.
      if (clubId === null || out.result.scanned > 0 || out.result.affected > 0) {
        await logRun({ clubId, category: rule.category, dryRun: out.dryRun, notice: out.notice ?? false, result: out.result, startedAt });
        summary.runs += 1;
      }
      summary.affected += out.result.affected;
    } catch (err) {
      const errorCode = (err as Error)?.name ?? "Error";
      logger.error({ category: rule.category, errName: errorCode }, "[retention] category failed");
      summary.failed.push(rule.category);
      await logRun({ clubId, category: rule.category, dryRun: globalDry, result: { scanned: 0, affected: 0 }, errorCode, startedAt }).catch(() => undefined);
    }
  };

  if (!options.clubId) {
    for (const { rule, effectiveDays } of await effectiveRules(null)) {
      if (rule.scope !== "platform") continue;
      await attempt(rule, null, async () => ({ result: await rule.run({ clubId: null, days: effectiveDays, now, dryRun: globalDry }), dryRun: globalDry }));
    }
  }

  const clubs = await db.select({ id: organization.id }).from(organization).where(options.clubId ? eq(organization.id, options.clubId) : sql`true`).orderBy(asc(organization.id));
  for (const club of clubs) {
    const toAnnounce: Array<{ rule: RetentionRule; count: number }> = [];
    for (const { rule, effectiveDays } of await effectiveRules(club.id)) {
      if (rule.scope !== "club") continue;
      await attempt(rule, club.id, async () => {
        const ctx = { clubId: club.id, days: effectiveDays, now };
        if (globalDry) return { result: await rule.run({ ...ctx, dryRun: true }), dryRun: true };
        const state = await noticeState(club.id, rule.category, now);
        if (state === "given") return { result: await rule.run({ ...ctx, dryRun: false }), dryRun: false };
        if (state === "waiting") return null;
        // No announcement yet: count only, and tell the club when there is something to delete.
        const counted = await rule.run({ ...ctx, dryRun: true });
        if (counted.scanned === 0) return null;
        toAnnounce.push({ rule, count: counted.scanned });
        return { result: counted, dryRun: true, notice: true };
      });
    }
    if (toAnnounce.length > 0) await announce(club.id, toAnnounce, now).catch((err) => logger.error({ errName: (err as Error)?.name, clubId: club.id }, "[retention] could not announce"));
  }

  return summary;
}
