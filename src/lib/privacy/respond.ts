import type { Context } from "hono";

import { writeAudit } from "../audit.js";
import { db } from "../../db/client.js";
import { buildMemberExport, renderExportHtml } from "./export.js";
import { completeRequests } from "./requests.js";

export type ExportFormat = "json" | "html";

/**
 * Builds the export, writes the access entry (`member_data.export`: ids, format and size only) and answers as JSON
 * (`{ data }`) or as a readable HTML download. Never cached.
 */
export async function respondWithExport(c: Context, input: { clubId: string; clubMemberId: string; format: ExportFormat; via: "self" | "board" | "guardian"; userId: string; closeAccessRequests: boolean }): Promise<Response> {
  const data = await buildMemberExport(input.clubId, input.clubMemberId);
  const body = input.format === "html" ? renderExportHtml(data) : JSON.stringify({ data });
  await db.transaction(async (tx) => {
    await writeAudit(tx, { eventType: "member_data.export", subjectId: input.clubMemberId, payload: { clubId: input.clubId, exportedBy: input.userId, via: input.via, format: input.format, bytes: Buffer.byteLength(body, "utf8") } });
    if (input.closeAccessRequests) await completeRequests(tx, { clubId: input.clubId, clubMemberId: input.clubMemberId, kind: "access", handledByUserId: input.userId, result: "Export delivered" });
  });
  c.header("Cache-Control", "private, no-store");
  if (input.format === "html") {
    c.header("Content-Disposition", 'attachment; filename="datenauskunft.html"');
    return c.html(body);
  }
  c.header("Content-Type", "application/json; charset=UTF-8");
  c.header("Content-Disposition", 'attachment; filename="datenauskunft.json"');
  return c.body(body);
}
