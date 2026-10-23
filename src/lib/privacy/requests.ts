import { and, eq, inArray } from "drizzle-orm";

import { dataSubjectRequests, type DataSubjectRequestRow } from "../../db/schema/privacy.js";
import { writeAudit } from "../audit.js";
import type { DbExecutor } from "../club-members.js";

export type DsrKind = "access" | "erasure" | "rectification";

/** Art. 12(3) GDPR: one month after receipt. */
export function dueAtOf(receivedAt: Date): Date {
  const due = new Date(receivedAt);
  due.setUTCMonth(due.getUTCMonth() + 1);
  return due;
}

/**
 * Records a request, or returns the open one of the same kind for the member (a repeated click must not create a second
 * deadline). Writes `data_subject_request.create` only for a new row.
 */
export async function openRequest(executor: DbExecutor, input: { clubId: string; clubMemberId: string; kind: DsrKind; requestedByUserId: string | null }): Promise<{ row: DataSubjectRequestRow; created: boolean }> {
  const [existing] = await executor
    .select()
    .from(dataSubjectRequests)
    .where(and(eq(dataSubjectRequests.clubId, input.clubId), eq(dataSubjectRequests.clubMemberId, input.clubMemberId), eq(dataSubjectRequests.kind, input.kind), inArray(dataSubjectRequests.status, ["open", "in_progress"])));
  if (existing) return { row: existing, created: false };
  const receivedAt = new Date();
  const [row] = await executor
    .insert(dataSubjectRequests)
    .values({ clubId: input.clubId, clubMemberId: input.clubMemberId, kind: input.kind, status: "open", receivedAt, dueAt: dueAtOf(receivedAt), requestedByUserId: input.requestedByUserId })
    .returning();
  await writeAudit(executor, { eventType: "data_subject_request.create", subjectId: row!.id, payload: { clubId: input.clubId, clubMemberId: input.clubMemberId, kind: input.kind } });
  return { row: row!, created: true };
}

/** Closes the open requests of a kind for a member (the export / erasure just fulfilled them). Short result text, no personal data. */
export async function completeRequests(executor: DbExecutor, input: { clubId: string; clubMemberId: string; kind: DsrKind; handledByUserId: string | null; result: string }): Promise<number> {
  const rows = await executor
    .update(dataSubjectRequests)
    .set({ status: "done", handledByUserId: input.handledByUserId, completedAt: new Date(), result: input.result, updatedAt: new Date() })
    .where(and(eq(dataSubjectRequests.clubId, input.clubId), eq(dataSubjectRequests.clubMemberId, input.clubMemberId), eq(dataSubjectRequests.kind, input.kind), inArray(dataSubjectRequests.status, ["open", "in_progress"])))
    .returning({ id: dataSubjectRequests.id });
  for (const r of rows) await writeAudit(executor, { eventType: "data_subject_request.update", subjectId: r.id, payload: { clubId: input.clubId, clubMemberId: input.clubMemberId, status: "done", kind: input.kind } });
  return rows.length;
}
