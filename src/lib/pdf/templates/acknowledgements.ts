import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { user } from "../../../auth/auth-schema.js";
import { db } from "../../../db/client.js";
import { clubMembers } from "../../../db/schema/club-members.js";
import { documentAcknowledgements, documents, documentVersions } from "../../../db/schema/documents.js";
import { ACK_NOTICE, derivedStatus } from "../../acknowledgements.js";
import { hasClubPermission } from "../../club-permissions.js";
import { atLeast, canAccessDocument, documentLevel, loadFolderIndex } from "../../document-access.js";
import { ForbiddenError, NotFoundError } from "../../errors.js";
import { defineTemplate } from "../registry.js";
import { dateDe, dateTimeDe } from "./shared.js";

/** Proof of the acknowledgements of one document version ("Bestätigungsprotokoll", Wave 13 B11). */

const MAX_ROWS = 3000;
const STATUS_LABEL: Record<string, string> = { offen: "offen", bestaetigt: "bestätigt", abgelehnt: "abgelehnt", abgelaufen: "abgelaufen" };

interface ProofData {
  title: string;
  versionNo: number;
  sha256: string;
  filename: string;
  rows: Array<{ name: string; status: string; at: string | null; by: string }>;
  total: number;
  counts: Record<string, number>;
  wordings: string[];
}

const params = z.object({ documentId: z.uuid(), versionNo: z.number().int().min(1).max(10_000).optional() }).strict();

export const bestaetigungsprotokollTemplate = defineTemplate({
  id: "bestaetigungsprotokoll",
  version: 1,
  label: "Bestätigungsprotokoll",
  description: "Nachweis, wer eine Fassung eines Dokuments wann bestätigt oder abgelehnt hat (bei Kindern durch wen), mit Wortlaut und Prüfsumme der Fassung.",
  destination: "archive",
  permission: "documents:generate",
  docType: "bestaetigungsprotokoll",
  sensitive: true,
  folder: { systemKey: "bestaetigungen", name: "Bestätigungsprotokolle" },
  sync: true,
  paramsSchema: params,
  authorize: async (actor, p) => {
    if (actor.isGuest || !hasClubPermission(actor.roleTypes, "documents:generate")) throw new ForbiddenError("Missing documents:generate permission");
    const [doc] = await db.select().from(documents).where(and(eq(documents.id, p.documentId), eq(documents.clubId, actor.clubId))).limit(1);
    const index = await loadFolderIndex(actor.clubId);
    // The protocol names people: only somebody who manages acknowledgements of the document (write access) may create it.
    if (!doc || !canAccessDocument(actor, index, doc, "lesen") || !atLeast(documentLevel(actor, index, doc), "schreiben")) throw new NotFoundError("Document not found");
  },
  build: async (clubId, p): Promise<{ data: ProofData; title: string; filename: string }> => {
    const [doc] = await db.select().from(documents).where(and(eq(documents.id, p.documentId), eq(documents.clubId, clubId), eq(documents.scope, "verein"))).limit(1);
    if (!doc) throw new NotFoundError("Document not found");
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(p.versionNo !== undefined ? and(eq(documentVersions.documentId, doc.id), eq(documentVersions.versionNo, p.versionNo)) : eq(documentVersions.id, doc.currentVersionId ?? "00000000-0000-0000-0000-000000000000"))
      .limit(1);
    if (!version) throw new NotFoundError("Version not found");
    const rows = await db
      .select({ ack: documentAcknowledgements, person: clubMembers.displayName, actor: user.name })
      .from(documentAcknowledgements)
      .innerJoin(clubMembers, eq(clubMembers.id, documentAcknowledgements.clubMemberId))
      .leftJoin(user, eq(user.id, documentAcknowledgements.actedByUserId))
      .where(and(eq(documentAcknowledgements.versionId, version.id), eq(documentAcknowledgements.clubId, clubId)))
      .orderBy(asc(clubMembers.displayName), asc(documentAcknowledgements.id));
    const counts: Record<string, number> = { offen: 0, bestaetigt: 0, abgelehnt: 0, abgelaufen: 0 };
    const now = new Date();
    const mapped = rows.map((r) => {
      const status = derivedStatus(r.ack, now);
      counts[status] = (counts[status] ?? 0) + 1;
      const by = r.ack.givenBy === "guardian" ? `Erziehungsberechtigte(r): ${r.actor ?? "unbekannt"}` : r.ack.givenBy === "board_paper" ? `Vorstand nach Papiernachweis vom ${dateDe(r.ack.proofDate)} (${r.ack.proofSource ?? ""})` : r.ack.givenBy === "self" ? "selbst" : "";
      return { name: r.person, status, at: r.ack.respondedAt?.toISOString() ?? null, by };
    });
    const wordings = [...new Set(rows.map((r) => r.ack.wording))].slice(0, 5);
    return {
      data: { title: doc.title, versionNo: version.versionNo, sha256: version.sha256, filename: version.originalFilename, rows: mapped.slice(0, MAX_ROWS), total: mapped.length, counts, wordings },
      title: `Bestätigungsprotokoll ${doc.title}`,
      filename: "bestaetigungsprotokoll.pdf",
    };
  },
  layout: (built) => {
    const d = built.data as ProofData;
    return {
      format: "a4" as const,
      title: built.title,
      blocks: [
        { type: "heading", text: "Bestätigungsprotokoll" },
        { type: "keyValue", rows: [["Dokument", d.title], ["Fassung", `Version ${d.versionNo} (${d.filename})`], ["Prüfsumme der Fassung (SHA-256)", d.sha256], ["Personen", String(d.total)], ["bestätigt", String(d.counts["bestaetigt"] ?? 0)], ["abgelehnt", String(d.counts["abgelehnt"] ?? 0)], ["offen", String(d.counts["offen"] ?? 0)], ["abgelaufen", String(d.counts["abgelaufen"] ?? 0)]] },
        { type: "heading", text: "Wortlaut der Bestätigung", level: 2 },
        ...d.wordings.map((text) => ({ type: "paragraph" as const, text })),
        { type: "heading", text: "Bestätigungen", level: 2 },
        d.rows.length > 0
          ? { type: "table", columns: [{ title: "Person", width: 3 }, { title: "Status", width: 1.4 }, { title: "Zeitpunkt", width: 2 }, { title: "Gegeben durch", width: 4 }], rows: d.rows.map((r) => [r.name, STATUS_LABEL[r.status] ?? r.status, dateTimeDe(r.at ? new Date(r.at) : null), r.by]) }
          : { type: "paragraph", text: "Zu dieser Fassung wurden keine Bestätigungen angefordert." },
        ...(d.total > MAX_ROWS ? [{ type: "paragraph" as const, text: `Die Liste wurde auf ${MAX_ROWS} Einträge gekürzt.` }] : []),
        { type: "paragraph", text: ACK_NOTICE },
      ],
    };
  },
});
