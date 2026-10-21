import { and, asc, desc, eq, gt, sql } from "drizzle-orm";

import { organization } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { retentionRuns } from "../../db/schema/privacy.js";
import { roleTypesWithPermission } from "../club-permissions.js";
import { clubMailLanguage } from "../club-settings.js";
import { logger } from "../logger.js";
import { notify } from "../notify/dispatcher.js";
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

/**
 * The announcement that currently allows deleting in one club category, and whether a newer one is still waiting. A notice
 * covers the data that was due when it was given (the deletion is pinned to its `startedAt`); whatever becomes due later
 * needs a fresh notice.
 */
async function noticeState(clubId: string, category: string, now: Date): Promise<{ effective: Date | null; newerWaiting: boolean }> {
  const notices = await db
    .select({ startedAt: retentionRuns.startedAt })
    .from(retentionRuns)
    .where(and(eq(retentionRuns.clubId, clubId), eq(retentionRuns.category, category), eq(retentionRuns.notice, true), gt(retentionRuns.affected, 0)))
    .orderBy(desc(retentionRuns.startedAt))
    .limit(20);
  const ripe = now.getTime() - retentionNoticeDays() * 86_400_000;
  const effective = notices.find((n) => n.startedAt.getTime() <= ripe)?.startedAt ?? null;
  return { effective, newerWaiting: notices.some((n) => effective === null || n.startedAt.getTime() > effective.getTime()) };
}

async function announce(clubId: string, items: Array<{ rule: RetentionRule; count: number }>, now: Date): Promise<void> {
  const lang = await clubMailLanguage(db, clubId);
  const from = todayBerlin(new Date(now.getTime() + retentionNoticeDays() * 86_400_000));
  const lines = items.map((i) => `- ${i.rule.label}: ${i.count}`).join("\n");
  const sent = await notify({
    clubId,
    class: "optional",
    eventKey: "retention.notice",
    // One announcement per run: a second cohort on the same day is a new notice, not a duplicate.
    refId: `${clubId}#${now.toISOString()}`,
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
  // Nobody was told: deleting must not start (the next run tries again).
  if (sent.recipients === 0) throw new Error("retention notice reached nobody");
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
    const toAnnounce: Array<{ rule: RetentionRule; count: number; startedAt: Date }> = [];
    for (const { rule, effectiveDays } of await effectiveRules(club.id)) {
      if (rule.scope !== "club") continue;
      await attempt(rule, club.id, async () => {
        const ctx = { clubId: club.id, days: effectiveDays };
        if (globalDry) return { result: await rule.run({ ...ctx, now, dryRun: true }), dryRun: true };
        const startedAt = new Date();
        const state = await noticeState(club.id, rule.category, now);
        // Delete only what was due when the notice was given ...
        const deleted = state.effective ? await rule.run({ ...ctx, now: state.effective, dryRun: false }) : null;
        // ... and announce what became due since (a notice is written only after it was sent).
        if (!state.newerWaiting) {
          const counted = await rule.run({ ...ctx, now, dryRun: true });
          const covered = state.effective ? await rule.run({ ...ctx, now: state.effective, dryRun: true }) : { scanned: 0, affected: 0 };
          if (counted.scanned > covered.scanned) toAnnounce.push({ rule, count: counted.scanned, startedAt });
        }
        return deleted ? { result: deleted, dryRun: false } : null;
      });
    }
    if (toAnnounce.length > 0) {
      try {
        await announce(club.id, toAnnounce, now);
        for (const n of toAnnounce) {
          await logRun({ clubId: club.id, category: n.rule.category, dryRun: true, notice: true, result: { scanned: n.count, affected: 0 }, startedAt: n.startedAt });
          summary.runs += 1;
        }
      } catch (err) {
        logger.error({ errName: (err as Error)?.name, clubId: club.id }, "[retention] could not announce, trying again at the next run");
      }
    }
  }

  return summary;
}
