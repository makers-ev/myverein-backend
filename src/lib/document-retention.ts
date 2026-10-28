import { and, eq, inArray, lt } from "drizzle-orm";

import { db } from "../db/client.js";
import { documents } from "../db/schema/documents.js";
import { writeAudit } from "./audit.js";
import type { DbExecutor } from "./club-members.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { purgeDocuments } from "./documents.js";
import { logger } from "./logger.js";
import { notifySafely } from "./notify/dispatcher.js";
import { BOARD_CATEGORY } from "./notify/types.js";
import { todayBerlin } from "./member-lifecycle.js";
import { DOCUMENT_RETENTION_CLASSES, addYears } from "./retention/document-classes.js";
import { retentionDryRun, retentionNoticeDays } from "./retention/sweep.js";

/**
 * Retention of documents (Wave 13 B14), a task of the daily `retention_sweep` (Wave 9 hook, Wave 10 dry-run rules):
 *  1. documents past `retention_until` without legal hold are marked `zur_loeschung` (invisible for readers, still counted in the quota)
 *     and the roles with `privacy:manage` are told;
 *  2. `RETENTION_NOTICE_DAYS` later (default 7) they are deleted for good: file, registry row and document row, the quota shrinks;
 *     the audit log keeps ids, the doc type and a count, never a title or content.
 * A legal hold set in between brings the document back to `aktiv`. With `RETENTION_DRY_RUN` (default true) only counting happens.
 * Deletion requests of a person (Wave 10 erasure) keep locked documents and report them; once the date has passed this sweep removes them.
 */

export interface DocumentRetentionResult {
  marked: number;
  deleted: number;
  dryRun: boolean;
}

/** Sets `retention_until` for the exit-based documents of a person once the exit is booked, clears it when the person returns. */
export async function syncExitRetention(tx: DbExecutor, clubMemberId: string, leftAt: string | null): Promise<void> {
  const exitClasses = DOCUMENT_RETENTION_CLASSES.filter((c) => c.startsOn === "exit");
  for (const cls of exitClasses) {
    await tx
      .update(documents)
      .set({ retentionUntil: leftAt ? addYears(leftAt, cls.years) : null })
      .where(and(eq(documents.ownerClubMemberId, clubMemberId), eq(documents.scope, "person"), eq(documents.docType, cls.docType)));
  }
}

export async function runDocumentRetention(now: Date = new Date(), options: { dryRun?: boolean; clubId?: string } = {}): Promise<DocumentRetentionResult> {
  const dryRun = options.dryRun ?? retentionDryRun();
  const today = todayBerlin(now);
  const classed = DOCUMENT_RETENTION_CLASSES.map((c) => c.docType);
  const due = and(options.clubId ? eq(documents.clubId, options.clubId) : undefined, inArray(documents.docType, classed), eq(documents.legalHold, false), lt(documents.retentionUntil, today));

  const toMark = await db.select({ id: documents.id, clubId: documents.clubId }).from(documents).where(and(due, inArray(documents.status, ["aktiv", "im_papierkorb"]))).limit(2000);
  const noticeCutoff = new Date(now.getTime() - retentionNoticeDays() * 86_400_000);
  const toDelete = await db.select({ id: documents.id, clubId: documents.clubId, docType: documents.docType }).from(documents).where(and(due, eq(documents.status, "zur_loeschung"), lt(documents.updatedAt, noticeCutoff))).limit(500);
  if (dryRun) return { marked: toMark.length, deleted: toDelete.length, dryRun };

  // Documents that got a legal hold while waiting come back.
  await db.update(documents).set({ status: "aktiv", updatedAt: now }).where(and(options.clubId ? eq(documents.clubId, options.clubId) : undefined, eq(documents.status, "zur_loeschung"), eq(documents.legalHold, true)));

  let marked = 0;
  if (toMark.length > 0) {
    await db.update(documents).set({ status: "zur_loeschung", updatedAt: now }).where(inArray(documents.id, toMark.map((d) => d.id)));
    marked = toMark.length;
    const perClub = new Map<string, number>();
    for (const d of toMark) perClub.set(d.clubId, (perClub.get(d.clubId) ?? 0) + 1);
    const from = todayBerlin(new Date(now.getTime() + retentionNoticeDays() * 86_400_000));
    for (const [clubId, n] of perClub) {
      await notifySafely({
        clubId,
        class: "optional",
        eventKey: "document.retention_notice",
        refId: `${clubId}#${today}`,
        audience: { roleTypes: roleTypesWithPermission("privacy:manage"), includeGuardians: false },
        content: {
          title: "Aufbewahrungsfrist von Dokumenten abgelaufen",
          body: `${n} Dokument(e) haben ihre Aufbewahrungsfrist erreicht und werden ab dem ${from.split("-").reverse().join(".")} gelöscht. Soll ein Dokument bleiben, setzen Sie vorher eine Sperre (Legal Hold).`,
          template: "reminder",
          category: BOARD_CATEGORY,
        },
        channels: ["in_app", "email"],
      });
    }
  }

  let deleted = 0;
  for (const group of groupBy(toDelete, (d) => `${d.clubId}|${d.docType}`)) {
    const afterCommit: Array<() => Promise<void>> = [];
    const removed = await db.transaction(async (tx) => {
      // Re-check under the transaction: a hold set a moment ago wins.
      const still = await tx.select({ id: documents.id, clubId: documents.clubId }).from(documents).where(and(inArray(documents.id, group.map((g) => g.id)), eq(documents.legalHold, false), eq(documents.status, "zur_loeschung")));
      const n = await purgeDocuments(tx, still, afterCommit);
      if (n > 0) await writeAudit(tx, { eventType: "document.retention_purge", subjectId: group[0]!.clubId, payload: { clubId: group[0]!.clubId, docType: group[0]!.docType, count: n } });
      return n;
    });
    for (const run of afterCommit) await run();
    deleted += removed;
  }
  if (marked + deleted > 0) logger.info({ marked, deleted }, "[documents] retention run");
  return { marked, deleted, dryRun };
}

function groupBy<T>(rows: T[], key: (row: T) => string): T[][] {
  const map = new Map<string, T[]>();
  for (const r of rows) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
  return [...map.values()];
}

