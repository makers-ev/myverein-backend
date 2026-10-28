import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { ACK_STATUSES, documentAcknowledgements, documents, documentVersions, type DocumentRow, type DocumentVersionRow } from "../db/schema/documents.js";
import { ACK_NOTICE, actingRelation, derivedStatus, derivedStatusSql, resolveAudience } from "../lib/acknowledgements.js";
import { writeAudit } from "../lib/audit.js";
import { isUuid } from "../lib/club-members.js";
import { cleanText } from "../lib/text-policy.js";
import { recipientsForClubMember } from "../lib/decision-notify.js";
import { atLeast, buildPrincipal, canAccessDocument, documentLevel, folderLevel, globalLevel, loadFolderIndex, type DocumentPrincipal, type FolderIndex } from "../lib/document-access.js";
import { SITE_URL } from "../lib/emailTemplate.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { activeWardLinks } from "../lib/guardian-scope.js";
import { mediaOfVersion } from "../lib/documents.js";
import { streamMedia, streamSensitiveMedia } from "../lib/media.js";
import { buildCsv } from "../lib/member-csv.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "../lib/member-lifecycle.js";
import { notifySafely } from "../lib/notify/dispatcher.js";
import type { NotifyRecipient } from "../lib/notify/types.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Digital acknowledgements (Wave 13 B11): the board asks a group of people to read a document of the archive and confirm
 * a specific version; the person (or a guardian for a child) answers while signed in; a proof PDF (template
 * `bestaetigungsprotokoll`) documents the result. Simple electronic confirmation, no qualified signature.
 *
 * Rights: asking, the overview, reminders, paper proofs and the export need write access (`schreiben`) to the document (the
 * archive rule, `documentLevel`); answering needs to be the person (an adult) or a guardian with a live link. Everything else
 * is a `404`. The routes are open to external guests (guardians), who can only ever reach what their wards are asked.
 */
export const acknowledgementRoutes = new Hono<ClubEnv>();

acknowledgementRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
acknowledgementRoutes.use("*", sessionGuard);
acknowledgementRoutes.use("*", clubGuard);

const requestLimiter = rateLimit({ windowMs: 60_000, max: 20, key: (c) => `ack-request:${c.get("user").id}` });
// Answering may ask for the password: the limit also bounds guessing.
const respondLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (c) => `ack-respond:${c.get("user").id}` });
const invalid = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

type AckRow = typeof documentAcknowledgements.$inferSelect;

async function loadDocumentOf(clubId: string, documentId: string): Promise<DocumentRow | null> {
  if (!isUuid(documentId)) return null;
  const [doc] = await db.select().from(documents).where(and(eq(documents.id, documentId), eq(documents.clubId, clubId), eq(documents.scope, "verein"))).limit(1);
  return doc ?? null;
}

/** The archive document the caller manages (`schreiben`); every other case is the same `404`. */
async function requireManagedDocument(p: DocumentPrincipal, index: FolderIndex, documentId: string): Promise<DocumentRow> {
  const doc = await loadDocumentOf(p.clubId, documentId);
  if (!doc || !canAccessDocument(p, index, doc, "lesen") || !atLeast(documentLevel(p, index, doc), "schreiben")) throw new NotFoundError("Document not found");
  return doc;
}

const manages = (p: DocumentPrincipal, index: FolderIndex, doc: DocumentRow): boolean => canAccessDocument(p, index, doc, "lesen") && atLeast(documentLevel(p, index, doc), "schreiben");

// ---------------------------------------------------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------------------------------------------------

const requestSchema = z.object({
  documentId: z.uuid(),
  audience: z
    .object({ all: z.boolean().optional(), departmentIds: z.array(z.uuid()).max(50).optional(), categoryKeys: z.array(z.string().min(1).max(60)).max(50).optional(), clubMemberIds: z.array(z.uuid()).max(3000).optional() })
    .strict(),
  wording: cleanText(z.string().trim().min(10).max(2000), true).optional(),
  dueAt: z.string().date().optional(),
  requiresReauth: z.boolean().default(false),
});

const defaultWording = (title: string) => `Ich habe das Dokument „${title}“ gelesen und bestätige es in der vorliegenden Fassung.`;

acknowledgementRoutes.post("/requests", requestLimiter, zValidator("json", requestSchema, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const body = c.req.valid("json");
  const index = await loadFolderIndex(p.clubId);
  const doc = await requireManagedDocument(p, index, body.documentId);
  if (doc.status !== "aktiv" || !doc.currentVersionId) throw new ConflictError("Only an active document with a file can be acknowledged", { details: { code: "document_not_available" } });
  if (body.dueAt !== undefined && body.dueAt < todayBerlin()) throw new ValidationError("The due date must not be in the past", { details: { field: "dueAt" } });
  const [version] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc.currentVersionId)).limit(1);
  if (!version) throw new ConflictError("The document has no file", { details: { code: "document_not_available" } });
  const personIds = await resolveAudience(p.clubId, body.audience);
  const wording = body.wording ?? defaultWording(doc.title);
  const dueAt = body.dueAt ? new Date(`${body.dueAt}T23:59:59+01:00`) : null;

  const result = await db.transaction(async (tx) => {
    // One request per version at a time: the unique key (version, person) is the last line of defence against a double submit.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ack-request:${version.id}`}, 0))`);
    const existing = await tx.select().from(documentAcknowledgements).where(and(eq(documentAcknowledgements.versionId, version.id), inArray(documentAcknowledgements.clubMemberId, personIds)));
    const byPerson = new Map(existing.map((e) => [e.clubMemberId, e]));
    const toCreate = personIds.filter((id) => !byPerson.has(id));
    // An open (or expired) request is renewed with the new due date and wording; a decided one stays as it is.
    const toRenew = existing.filter((e) => e.status === "offen");
    for (let i = 0; i < toCreate.length; i += 500) {
      await tx.insert(documentAcknowledgements).values(
        toCreate.slice(i, i + 500).map((clubMemberId) => ({ clubId: p.clubId, documentId: doc.id, versionId: version.id, sha256: version.sha256, clubMemberId, status: "offen", wording, requestedBy: p.userId, dueAt, requiresReauth: body.requiresReauth })),
      );
    }
    if (toRenew.length > 0) {
      await tx
        .update(documentAcknowledgements)
        .set({ dueAt, wording, requiresReauth: body.requiresReauth, requestedBy: p.userId, requestedAt: new Date() })
        .where(inArray(documentAcknowledgements.id, toRenew.map((r) => r.id)));
    }
    const counts = { created: toCreate.length, renewed: toRenew.length, skipped: existing.length - toRenew.length };
    await writeAudit(tx, { eventType: "acknowledgement.request", subjectId: doc.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, documentId: doc.id, versionId: version.id, ...counts } });
    return { counts, notify: [...toCreate, ...toRenew.map((r) => r.clubMemberId)] };
  });

  void notifyRequested(p.clubId, doc.title, result.notify, version.id, dueAt);
  return c.json({ data: { documentId: doc.id, versionId: version.id, versionNo: version.versionNo, ...result.counts, notice: ACK_NOTICE } }, 201);
});

/** In-app, push and mail to the people asked (and to the guardians of children), best effort and after the commit. */
async function notifyRequested(clubId: string, title: string, personIds: string[], versionId: string, dueAt: Date | null): Promise<void> {
  if (personIds.length === 0) return;
  const recipients: NotifyRecipient[] = [];
  const seen = new Set<string>();
  for (const id of personIds) {
    for (const r of await recipientsForClubMember(id)) {
      const key = r.userId ?? r.clubMemberId ?? r.email ?? "";
      if (key === "" || seen.has(key)) continue;
      seen.add(key);
      recipients.push(r);
    }
  }
  await notifySafely({
    clubId,
    class: "optional",
    eventKey: "acknowledgement.requested",
    refId: `${versionId}#${Date.now()}`,
    recipients,
    content: {
      title: `Bitte bestätigen: ${title.slice(0, 120)}`,
      body: `Der Verein bittet um deine Bestätigung des Dokuments „${title.slice(0, 120)}“.${dueAt ? ` Bitte bis ${todayBerlin(dueAt).split("-").reverse().join(".")}.` : ""} Du findest es unter „Offene Bestätigungen“; für Kinder bestätigen die Erziehungsberechtigten.`,
      template: "reminder",
      category: "reminders",
      ctaLabel: "Offene Bestätigungen",
      ctaUrl: SITE_URL,
    },
    channels: ["in_app", "email", "push"],
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Overview, export, reminders (managers)
// ---------------------------------------------------------------------------------------------------------------------

const overviewQuery = z.object({
  documentId: z.uuid().optional(),
  status: z.enum(ACK_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Documents the caller may manage, as a SQL condition (folder rights, same rule as the archive list). */
function managedDocuments(p: DocumentPrincipal, index: FolderIndex) {
  const folders = [...index.folders.keys()].filter((id) => atLeast(folderLevel(p, index, id), "schreiben"));
  const root = atLeast(globalLevel(p), "schreiben");
  const parts = [folders.length > 0 ? inArray(documents.folderId, folders) : undefined, root ? isNull(documents.folderId) : undefined].filter((x) => x !== undefined);
  return parts.length > 0 ? and(eq(documents.clubId, p.clubId), eq(documents.scope, "verein"), or(...parts)) : undefined;
}

async function overviewRows(p: DocumentPrincipal, index: FolderIndex, q: { documentId?: string | undefined; status?: (typeof ACK_STATUSES)[number] | undefined }, limit: number, offset: number) {
  const scope = q.documentId ? (await requireManagedDocument(p, index, q.documentId), and(eq(documents.id, q.documentId), eq(documents.clubId, p.clubId))) : managedDocuments(p, index);
  if (!scope) return { rows: [], total: 0, summary: { offen: 0, bestaetigt: 0, abgelehnt: 0, abgelaufen: 0 } };
  const where = and(scope, q.status ? sql`${derivedStatusSql} = ${q.status}` : undefined);
  const [total] = await db.select({ n: count() }).from(documentAcknowledgements).innerJoin(documents, eq(documents.id, documentAcknowledgements.documentId)).where(where);
  const grouped = await db.select({ status: derivedStatusSql, n: count() }).from(documentAcknowledgements).innerJoin(documents, eq(documents.id, documentAcknowledgements.documentId)).where(scope).groupBy(derivedStatusSql);
  const summary = { offen: 0, bestaetigt: 0, abgelehnt: 0, abgelaufen: 0 } as Record<string, number>;
  for (const g of grouped) summary[g.status] = g.n;
  const rows = await db
    .select({ ack: documentAcknowledgements, status: derivedStatusSql, docTitle: documents.title, versionNo: documentVersions.versionNo, person: clubMembers.displayName, memberNumber: clubMembers.memberNumber, actor: user.name })
    .from(documentAcknowledgements)
    .innerJoin(documents, eq(documents.id, documentAcknowledgements.documentId))
    .innerJoin(documentVersions, eq(documentVersions.id, documentAcknowledgements.versionId))
    .innerJoin(clubMembers, eq(clubMembers.id, documentAcknowledgements.clubMemberId))
    .leftJoin(user, eq(user.id, documentAcknowledgements.actedByUserId))
    .where(where)
    .orderBy(desc(documentAcknowledgements.requestedAt), clubMembers.displayName, documentAcknowledgements.id)
    .limit(limit)
    .offset(offset);
  return { rows, total: total?.n ?? 0, summary };
}

function shapeManaged(r: Awaited<ReturnType<typeof overviewRows>>["rows"][number]) {
  return {
    id: r.ack.id,
    documentId: r.ack.documentId,
    documentTitle: r.docTitle,
    versionId: r.ack.versionId,
    versionNo: r.versionNo,
    clubMemberId: r.ack.clubMemberId,
    personName: r.person,
    status: r.status,
    requestedAt: r.ack.requestedAt,
    dueAt: r.ack.dueAt,
    respondedAt: r.ack.respondedAt,
    givenBy: r.ack.givenBy,
    actedByName: r.ack.givenBy === "guardian" || r.ack.givenBy === "board_paper" ? r.actor : null,
    proofDate: r.ack.proofDate,
    proofSource: r.ack.proofSource,
    requiresReauth: r.ack.requiresReauth,
  };
}

acknowledgementRoutes.get("/", zValidator("query", overviewQuery, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const q = c.req.valid("query");
  const index = await loadFolderIndex(p.clubId);
  const out = await overviewRows(p, index, q, q.pageSize, (q.page - 1) * q.pageSize);
  return c.json({ data: out.rows.map(shapeManaged), summary: out.summary, page: q.page, pageSize: q.pageSize, total: out.total, notice: ACK_NOTICE });
});

acknowledgementRoutes.get("/export.csv", zValidator("query", z.object({ documentId: z.uuid() }), invalid), async (c) => {
  const p = await buildPrincipal(c);
  const q = c.req.valid("query");
  const index = await loadFolderIndex(p.clubId);
  const out = await overviewRows(p, index, { documentId: q.documentId }, 10_000, 0);
  const label: Record<string, string> = { offen: "offen", bestaetigt: "bestätigt", abgelehnt: "abgelehnt", abgelaufen: "abgelaufen" };
  const by: Record<string, string> = { self: "selbst", guardian: "Erziehungsberechtigte(r)", board_paper: "Vorstand (Papier)" };
  const csv = buildCsv(
    ["Name", "Mitgliedsnummer", "Dokument", "Version", "Status", "Angefordert", "Frist", "Beantwortet", "Gegeben durch", "Handelnde Person", "Nachweisdatum", "Nachweisquelle", "SHA-256 der Fassung"],
    out.rows.map((r) => [r.person, r.memberNumber, r.docTitle, r.versionNo, label[r.status] ?? r.status, r.ack.requestedAt.toISOString(), r.ack.dueAt?.toISOString() ?? "", r.ack.respondedAt?.toISOString() ?? "", r.ack.givenBy ? (by[r.ack.givenBy] ?? "") : "", r.ack.givenBy === "guardian" || r.ack.givenBy === "board_paper" ? (r.actor ?? "") : "", r.ack.proofDate ?? "", r.ack.proofSource ?? "", r.ack.sha256]),
  );
  await writeAudit(db, { eventType: "acknowledgement.export", subjectId: q.documentId, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, documentId: q.documentId, rows: out.rows.length } });
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", 'attachment; filename="bestaetigungen.csv"');
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  return c.body(csv);
});

/** Reminds everybody whose request is still open (and not reminded in the last 24 hours). */
acknowledgementRoutes.post("/remind", requestLimiter, zValidator("json", z.object({ documentId: z.uuid() }), invalid), async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await requireManagedDocument(p, index, c.req.valid("json").documentId);
  const open = await db
    .select()
    .from(documentAcknowledgements)
    .where(and(eq(documentAcknowledgements.documentId, doc.id), sql`${derivedStatusSql} = 'offen'`, or(isNull(documentAcknowledgements.remindedAt), sql`${documentAcknowledgements.remindedAt} < now() - interval '24 hours'`)));
  if (open.length > 0) {
    await db.update(documentAcknowledgements).set({ remindedAt: new Date() }).where(inArray(documentAcknowledgements.id, open.map((o) => o.id)));
    void notifyRequested(p.clubId, doc.title, open.map((o) => o.clubMemberId), `remind-${doc.id}`, null);
  }
  await writeAudit(db, { eventType: "acknowledgement.remind", subjectId: doc.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, documentId: doc.id, count: open.length } });
  return c.json({ data: { reminded: open.length } });
});

// ---------------------------------------------------------------------------------------------------------------------
// The person (or the guardian)
// ---------------------------------------------------------------------------------------------------------------------

const mineQuery = z.object({ status: z.enum(ACK_STATUSES).optional(), page: z.coerce.number().int().min(1).max(100_000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50) });

/** Everything the caller is asked: for themselves and for the children they are a guardian of. */
acknowledgementRoutes.get("/mine", zValidator("query", mineQuery, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const q = c.req.valid("query");
  const wards = await activeWardLinks(p.userId, { clubId: p.clubId });
  const people = new Map<string, { relation: "self" | "guardian"; canAnswer: boolean }>();
  if (p.clubMemberId) {
    const [self] = await db.select().from(clubMembers).where(eq(clubMembers.id, p.clubMemberId)).limit(1);
    const rel = self ? await actingRelation(p, self) : null;
    if (self && rel && !isLeftStatus(effectiveStatus(self, todayBerlin()))) people.set(self.id, rel);
  }
  for (const w of wards) people.set(w.ward.id, { relation: "guardian", canAnswer: true });
  if (people.size === 0) return c.json({ data: [], page: q.page, pageSize: q.pageSize, total: 0, notice: ACK_NOTICE });
  const where = and(eq(documentAcknowledgements.clubId, p.clubId), inArray(documentAcknowledgements.clubMemberId, [...people.keys()]), q.status ? sql`${derivedStatusSql} = ${q.status}` : undefined);
  const [total] = await db.select({ n: count() }).from(documentAcknowledgements).where(where);
  const rows = await db
    .select({ ack: documentAcknowledgements, status: derivedStatusSql, docTitle: documents.title, current: documents.currentVersionId, versionNo: documentVersions.versionNo, person: clubMembers.displayName })
    .from(documentAcknowledgements)
    .innerJoin(documents, eq(documents.id, documentAcknowledgements.documentId))
    .innerJoin(documentVersions, eq(documentVersions.id, documentAcknowledgements.versionId))
    .innerJoin(clubMembers, eq(clubMembers.id, documentAcknowledgements.clubMemberId))
    .where(where)
    .orderBy(desc(documentAcknowledgements.requestedAt), documentAcknowledgements.id)
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return c.json({
    data: rows.map((r) => {
      const rel = people.get(r.ack.clubMemberId)!;
      return {
        id: r.ack.id,
        documentTitle: r.docTitle,
        versionNo: r.versionNo,
        clubMemberId: r.ack.clubMemberId,
        personName: r.person,
        relation: rel.relation,
        status: r.status,
        wording: r.ack.wording,
        requestedAt: r.ack.requestedAt,
        dueAt: r.ack.dueAt,
        respondedAt: r.ack.respondedAt,
        requiresReauth: r.ack.requiresReauth,
        // The page of a child is answered by the guardian; a request past its due date or already answered cannot be answered again.
        canAnswer: rel.canAnswer && r.status === "offen",
        isCurrentVersion: r.current === r.ack.versionId,
      };
    }),
    page: q.page,
    pageSize: q.pageSize,
    total: total?.n ?? 0,
    notice: ACK_NOTICE,
  });
});

interface Loaded {
  ack: AckRow;
  doc: DocumentRow;
  version: DocumentVersionRow;
  person: typeof clubMembers.$inferSelect;
  acting: Awaited<ReturnType<typeof actingRelation>>;
  manager: boolean;
}

/** The acknowledgement the caller may see (as the person, the guardian or the manager of the document); anything else is a `404`. */
async function loadVisible(c: Parameters<typeof buildPrincipal>[0], rawId: string): Promise<{ p: DocumentPrincipal; loaded: Loaded; index: FolderIndex }> {
  if (!isUuid(rawId)) throw new NotFoundError("Acknowledgement not found");
  const p = await buildPrincipal(c);
  const [row] = await db
    .select({ ack: documentAcknowledgements, doc: documents, version: documentVersions, person: clubMembers })
    .from(documentAcknowledgements)
    .innerJoin(documents, eq(documents.id, documentAcknowledgements.documentId))
    .innerJoin(documentVersions, eq(documentVersions.id, documentAcknowledgements.versionId))
    .innerJoin(clubMembers, eq(clubMembers.id, documentAcknowledgements.clubMemberId))
    .where(and(eq(documentAcknowledgements.id, rawId), eq(documentAcknowledgements.clubId, p.clubId)))
    .limit(1);
  if (!row) throw new NotFoundError("Acknowledgement not found");
  const index = await loadFolderIndex(p.clubId);
  const acting = await actingRelation(p, row.person);
  const manager = manages(p, index, row.doc);
  if (!acting && !manager) throw new NotFoundError("Acknowledgement not found");
  // A document the board took out of circulation (trash, deletion pending) is no longer readable through a request.
  if (!manager && row.doc.status !== "aktiv") throw new NotFoundError("Acknowledgement not found");
  return { p, index, loaded: { ack: row.ack, doc: row.doc, version: row.version, person: row.person, acting, manager } };
}

acknowledgementRoutes.get("/:id", async (c) => {
  const { loaded } = await loadVisible(c, c.req.param("id"));
  const { ack, doc, version, person, acting, manager } = loaded;
  const status = derivedStatus(ack);
  return c.json({
    data: {
      id: ack.id,
      documentId: manager ? doc.id : null,
      documentTitle: doc.title,
      versionNo: version.versionNo,
      sha256: ack.sha256,
      mimeType: version.mimeType,
      clubMemberId: person.id,
      personName: person.displayName,
      status,
      wording: ack.wording,
      requestedAt: ack.requestedAt,
      dueAt: ack.dueAt,
      respondedAt: ack.respondedAt,
      givenBy: ack.givenBy,
      requiresReauth: ack.requiresReauth,
      canAnswer: !!acting?.canAnswer && status === "offen",
      relation: acting?.relation ?? "manager",
      isCurrentVersion: doc.currentVersionId === ack.versionId,
      notice: ACK_NOTICE,
    },
  });
});

/** The file of exactly the version that is to be confirmed, for the person asked and for the managers (authenticated stream). */
acknowledgementRoutes.get("/:id/document", async (c) => {
  const { p, loaded } = await loadVisible(c, c.req.param("id"));
  const media = await mediaOfVersion(loaded.version);
  if (!media) throw new NotFoundError("File not found");
  return media.sensitive ? streamSensitiveMedia(c, media, { accessedBy: p.userId, subjectId: loaded.doc.id }) : streamMedia(c, media);
});

const respondSchema = z.object({ decision: z.enum(["bestaetigt", "abgelehnt"]), password: z.string().min(1).max(256).optional() });

acknowledgementRoutes.post("/:id/confirm", respondLimiter, zValidator("json", respondSchema, invalid), async (c) => {
  const { p, loaded } = await loadVisible(c, c.req.param("id"));
  const body = c.req.valid("json");
  const { ack, person, acting } = loaded;
  if (!acting) throw new NotFoundError("Acknowledgement not found");
  if (isLeftStatus(effectiveStatus(person, todayBerlin()))) throw new ConflictError("The person is no longer a member", { details: { code: "member_left" } });
  if (!acting.canAnswer) throw new ForbiddenError("A minor's request is answered by a guardian", { details: { code: "guardian_required" } });
  if (loaded.doc.status !== "aktiv") throw new ConflictError("The document is no longer available", { details: { code: "document_not_available" } });
  const status = derivedStatus(ack);
  // Answering twice with the same decision is not an error (a retried request must not fail); a different decision after the fact is.
  if (status === "bestaetigt" || status === "abgelehnt") {
    if (status === body.decision) return c.json({ data: { id: ack.id, status, respondedAt: ack.respondedAt, alreadyDone: true } });
    throw new ConflictError("This request has already been answered", { details: { code: "already_answered" } });
  }
  if (status === "abgelaufen") throw new ConflictError("This request has expired; ask the board for a new one", { details: { code: "expired" } });

  if (ack.requiresReauth) {
    if (!body.password) throw new ForbiddenError("Enter your password to confirm this document", { details: { code: "reauth_required" } });
    try {
      await auth.api.verifyPassword({ body: { password: body.password }, headers: c.req.raw.headers });
    } catch {
      throw new ForbiddenError("The password is not correct", { details: { code: "reauth_failed" } });
    }
  }

  const givenBy = acting.relation;
  const updated = await db.transaction(async (tx) => {
    // The first answer wins: a parallel second request finds the row decided and reads it back.
    const [row] = await tx
      .update(documentAcknowledgements)
      .set({ status: body.decision, respondedAt: new Date(), actedByUserId: p.userId, actedByClubMemberId: p.clubMemberId, givenBy })
      .where(and(eq(documentAcknowledgements.id, ack.id), eq(documentAcknowledgements.status, "offen")))
      .returning();
    if (!row) return null;
    await writeAudit(tx, { eventType: "acknowledgement.respond", subjectId: person.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, acknowledgementId: ack.id, documentId: ack.documentId, status: body.decision, givenBy } });
    return row;
  });
  if (!updated) {
    const [now] = await db.select().from(documentAcknowledgements).where(eq(documentAcknowledgements.id, ack.id)).limit(1);
    if (now && now.status === body.decision) return c.json({ data: { id: now.id, status: now.status, respondedAt: now.respondedAt, alreadyDone: true } });
    throw new ConflictError("This request has already been answered", { details: { code: "already_answered" } });
  }
  return c.json({ data: { id: updated.id, status: updated.status, respondedAt: updated.respondedAt, givenBy: updated.givenBy, alreadyDone: false } });
});

// ---------------------------------------------------------------------------------------------------------------------
// Paper proof (managers): for people who cannot answer digitally (no account, adult)
// ---------------------------------------------------------------------------------------------------------------------

const paperSchema = z.object({
  decision: z.enum(["bestaetigt", "abgelehnt"]),
  proofDate: z.string().date(),
  proofSource: cleanText(z.string().trim().min(1).max(200)),
});

acknowledgementRoutes.post("/:id/paper", respondLimiter, zValidator("json", paperSchema, invalid), async (c) => {
  const { p, loaded } = await loadVisible(c, c.req.param("id"));
  const body = c.req.valid("json");
  if (!loaded.manager) throw new NotFoundError("Acknowledgement not found");
  if (body.proofDate > todayBerlin()) throw new ValidationError("The proof date must not be in the future", { details: { field: "proofDate" } });
  const status = derivedStatus(loaded.ack);
  if (status === "bestaetigt" || status === "abgelehnt") throw new ConflictError("This request has already been answered", { details: { code: "already_answered" } });
  const [row] = await db
    .update(documentAcknowledgements)
    .set({ status: body.decision, respondedAt: new Date(), actedByUserId: p.userId, actedByClubMemberId: p.clubMemberId, givenBy: "board_paper", proofDate: body.proofDate, proofSource: body.proofSource })
    .where(and(eq(documentAcknowledgements.id, loaded.ack.id), eq(documentAcknowledgements.status, "offen")))
    .returning();
  if (!row) throw new ConflictError("This request has already been answered", { details: { code: "already_answered" } });
  await writeAudit(db, { eventType: "acknowledgement.paper", subjectId: loaded.person.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, acknowledgementId: row.id, documentId: row.documentId, status: row.status } });
  return c.json({ data: { id: row.id, status: row.status, respondedAt: row.respondedAt, givenBy: row.givenBy } });
});
