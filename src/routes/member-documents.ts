import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { documents, documentVersions, type DocumentRow, type DocumentVersionRow } from "../db/schema/documents.js";
import { writeAudit } from "../lib/audit.js";
import { buildPrincipal } from "../lib/document-access.js";
import { addUploadedVersion, createUploadedDocument, mediaOfVersion, purgeableCondition, purgeDocuments } from "../lib/documents.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import { isUuid } from "../lib/club-members.js";
import { MAX_DOCUMENT_BYTES, streamSensitiveMedia } from "../lib/media.js";
import { resolvePersonalSubject, type PersonalRelation } from "../lib/member-documents-access.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Personal document storage per club member (Wave 13 B6), also for members without an account. `:memberId` is a
 * `club_members.id` or `me`. Who may come in is decided by `resolvePersonalSubject` (self, guardian of a ward, board with
 * `documents:read_personal`); the files are always sensitive: authenticated stream, audit entry per retrieval, never a URL.
 *
 * Deletion differs from the archive: the member (or guardian) may remove their own UPLOADS for good; receipts and generated
 * documents can only be hidden from the own list (they are evidence); final deletion of those is retention or the board with a reason.
 */
export const memberDocumentRoutes = new Hono<ClubEnv>();

memberDocumentRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
memberDocumentRoutes.use("*", sessionGuard);
memberDocumentRoutes.use("*", clubGuard);

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 30, key: (c) => `member-document-upload:${c.get("user").id}` });
const MAX_DOCUMENTS_PER_MEMBER = 500;
/** Why the board removes a document of somebody else's storage (structured, so no free text lands in the log). */
export const BOARD_DELETE_REASONS = ["wunsch_mitglied", "falsch_zugeordnet", "fehlerhaft", "sonstiges"] as const;

const invalid = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

/** `upload` = put there by the member side, `vorstand_upload` = by the board, everything else was generated. */
function sourceOf(doc: DocumentRow): "member" | "vorstand" | "erzeugt" {
  if (doc.kind === "erzeugt") return "erzeugt";
  return doc.docType === "vorstand_upload" ? "vorstand" : "member";
}

function shape(doc: DocumentRow, version: DocumentVersionRow | null, relation: PersonalRelation) {
  const source = sourceOf(doc);
  const ownUpload = source === "member";
  return {
    id: doc.id,
    title: doc.title,
    docType: doc.docType,
    kind: doc.kind,
    source,
    hidden: doc.hiddenByOwner,
    createdAt: doc.createdAt,
    mimeType: version?.mimeType ?? null,
    sizeBytes: version?.sizeBytes ?? null,
    originalFilename: version?.originalFilename ?? null,
    // The member side removes its own uploads and hides the rest; the board removes with a reason.
    canDelete: relation === "board" || ownUpload,
    canHide: relation !== "board" && !ownUpload,
    ...(relation === "board" ? { retentionUntil: doc.retentionUntil, legalHold: doc.legalHold } : {}),
  };
}

async function loadPersonalDocument(clubId: string, ownerId: string, rawId: string): Promise<DocumentRow> {
  if (!isUuid(rawId)) throw new NotFoundError("Document not found");
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, rawId), eq(documents.clubId, clubId), eq(documents.scope, "person"), eq(documents.ownerClubMemberId, ownerId)))
    .limit(1);
  if (!doc) throw new NotFoundError("Document not found");
  return doc;
}

async function logBoardAccess(clubId: string, ownerId: string, relation: PersonalRelation, action: "list" | "download" | "upload" | "delete", documentId?: string): Promise<void> {
  if (relation !== "board") return;
  await writeAudit(db, { eventType: "member_document.board_access", subjectId: ownerId, payload: { clubId, clubMemberId: ownerId, documentId, action } });
}

const listQuery = z.object({ includeHidden: z.enum(["0", "1"]).default("0") });

/** The documents of one member, newest first; the member side does not see what it hid unless `includeHidden=1`. */
memberDocumentRoutes.get("/:memberId", zValidator("query", listQuery, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const { owner, relation } = await resolvePersonalSubject(c, p, c.req.param("memberId"));
  const includeHidden = relation === "board" || c.req.valid("query").includeHidden === "1";
  const rows = await db
    .select({ d: documents, v: documentVersions })
    .from(documents)
    .leftJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .where(and(eq(documents.clubId, p.clubId), eq(documents.scope, "person"), eq(documents.ownerClubMemberId, owner.id), eq(documents.status, "aktiv")))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(MAX_DOCUMENTS_PER_MEMBER);
  await logBoardAccess(p.clubId, owner.id, relation, "list");
  return c.json({
    data: rows.filter((r) => includeHidden || !r.d.hiddenByOwner).map((r) => shape(r.d, r.v, relation)),
    relation,
    owner: { clubMemberId: owner.id, displayName: owner.displayName, hasAccount: owner.memberId !== null },
  });
});

/** Who from the board looked into this storage (visible to the member and the guardians, not to the board itself). */
memberDocumentRoutes.get("/:memberId/access-log", async (c) => {
  const p = await buildPrincipal(c);
  const { owner, relation } = await resolvePersonalSubject(c, p, c.req.param("memberId"));
  if (relation === "board") throw new NotFoundError("Member not found");
  const rows = await db
    .select({ a: auditLog, byName: user.name, title: documents.title })
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.actorUserId))
    .leftJoin(documents, and(sql`${documents.id}::text = ${auditLog.payload}->>'documentId'`, eq(documents.clubId, p.clubId), eq(documents.ownerClubMemberId, owner.id)))
    .where(and(eq(auditLog.clubId, p.clubId), eq(auditLog.subjectMemberId, owner.id), eq(auditLog.eventType, "member_document.board_access")))
    .orderBy(desc(auditLog.createdAt))
    .limit(100);
  return c.json({ data: rows.map(({ a, byName, title }) => ({ at: a.createdAt, action: (a.payload as { action?: string } | null)?.action ?? null, byName: byName ?? null, documentTitle: title ?? null })) });
});

const uploadBody = bodyLimit({
  maxSize: MAX_DOCUMENT_BYTES + 128 * 1024,
  onError: () => {
    throw new ValidationError(`File exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes`);
  },
});

const textField = (raw: unknown, max: number, field: string): string | null => {
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = cleanText(z.string().trim().max(max)).safeParse(raw);
  if (!parsed.success) throw new ValidationError(`${field} is invalid`, { details: { field } });
  return parsed.data || null;
};

/** Multipart upload (`file`, `title?`, `note?`) into the storage of the member: by the member, a guardian or the board. */
memberDocumentRoutes.post("/:memberId", uploadLimiter, uploadBody, async (c) => {
  const p = await buildPrincipal(c);
  const { owner, relation } = await resolvePersonalSubject(c, p, c.req.param("memberId"));
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");
  const [{ n }] = await db.select({ n: count() }).from(documents).where(and(eq(documents.clubId, p.clubId), eq(documents.scope, "person"), eq(documents.ownerClubMemberId, owner.id)));
  if (n >= MAX_DOCUMENTS_PER_MEMBER) throw new ConflictError("The personal storage is full", { code: "CONFLICT", details: { code: "member_document_limit" } });
  const title = textField(body["title"], 200, "title") ?? (file.name.replace(/\.[^.]{1,8}$/, "").slice(0, 200) || "Dokument");
  const { document, version } = await createUploadedDocument({
    clubId: p.clubId,
    scope: "person",
    folderId: null,
    ownerClubMemberId: owner.id,
    docType: relation === "board" ? "vorstand_upload" : "upload",
    title,
    file,
    uploadedBy: p.userId,
    note: textField(body["note"], 500, "note"),
  });
  await writeAudit(db, { eventType: "member_document.upload", subjectId: owner.id, payload: { clubId: p.clubId, clubMemberId: owner.id, documentId: document.id, sizeBytes: version.sizeBytes, via: relation } });
  await logBoardAccess(p.clubId, owner.id, relation, "upload", document.id);
  return c.json({ data: shape(document, version, relation) }, 201);
});

/** Sensitive, authenticated download; the media layer writes the audit entry before the first byte. */
memberDocumentRoutes.get("/:memberId/:docId/download", async (c) => {
  const p = await buildPrincipal(c);
  const { owner, relation } = await resolvePersonalSubject(c, p, c.req.param("memberId"));
  const doc = await loadPersonalDocument(p.clubId, owner.id, c.req.param("docId"));
  if (doc.status !== "aktiv" || !doc.currentVersionId) throw new NotFoundError("Document not found");
  if (relation !== "board" && doc.hiddenByOwner && c.req.query("includeHidden") !== "1") throw new NotFoundError("Document not found");
  const [version] = await db.select().from(documentVersions).where(eq(documentVersions.id, doc.currentVersionId)).limit(1);
  const media = version ? await mediaOfVersion(version) : null;
  if (!media) throw new NotFoundError("File not found");
  await logBoardAccess(p.clubId, owner.id, relation, "download", doc.id);
  return streamSensitiveMedia(c, media, { accessedBy: p.userId, subjectId: doc.id });
});

/** New version of an upload (same rules as the upload: the member side only for its own uploads). */
memberDocumentRoutes.post("/:memberId/:docId/versions", uploadLimiter, uploadBody, async (c) => {
  const p = await buildPrincipal(c);
  const { owner, relation } = await resolvePersonalSubject(c, p, c.req.param("memberId"));
  const doc = await loadPersonalDocument(p.clubId, owner.id, c.req.param("docId"));
  if (doc.kind === "erzeugt" || (relation !== "board" && sourceOf(doc) !== "member")) throw new ConflictError("This document cannot get a new version");
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");
  const { document, version } = await addUploadedVersion(doc, file, p.userId, textField(body["note"], 500, "note"));
  await logBoardAccess(p.clubId, owner.id, relation, "upload", doc.id);
  return c.json({ data: shape(document, version, relation) }, 201);
});

async function removeForGood(doc: DocumentRow): Promise<void> {
  const [ok] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, doc.id), purgeableCondition(new Date(), null, true))).limit(1);
  if (!ok) throw new ConflictError("The document is under legal hold or retention", { code: "CONFLICT", details: { code: "retention" } });
  const afterCommit: Array<() => Promise<void>> = [];
  await db.transaction((tx) => purgeDocuments(tx, [doc], afterCommit));
  for (const run of afterCommit) await run();
}

const boardDeleteSchema = z.object({ reason: z.enum(BOARD_DELETE_REASONS) });

/**
 * Member side: removes an own upload for good (`204`); receipts/generated documents answer `409 not_deletable` (hide them
 * instead). Board: removes any document with a structured `reason` (`422` without), unless legal hold or retention applies.
 */
memberDocumentRoutes.delete("/:memberId/:docId", async (c) => {
  const p = await buildPrincipal(c);
  const { owner, relation } = await resolvePersonalSubject(c, p, c.req.param("memberId"));
  const doc = await loadPersonalDocument(p.clubId, owner.id, c.req.param("docId"));
  let reason: string | undefined;
  if (relation === "board") {
    const parsed = boardDeleteSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new ValidationError("A reason is required", { details: parsed.error.issues });
    reason = parsed.data.reason;
  } else if (sourceOf(doc) !== "member") {
    throw new ConflictError("Receipts and generated documents cannot be deleted, only hidden", { code: "CONFLICT", details: { code: "not_deletable" } });
  }
  await removeForGood(doc);
  await writeAudit(db, { eventType: "member_document.delete", subjectId: owner.id, payload: { clubId: p.clubId, clubMemberId: owner.id, documentId: doc.id, reason, via: relation } });
  await logBoardAccess(p.clubId, owner.id, relation, "delete", doc.id);
  return c.body(null, 204);
});

async function setHidden(c: Parameters<typeof buildPrincipal>[0], hidden: boolean): Promise<Response> {
  const p = await buildPrincipal(c);
  const { owner, relation } = await resolvePersonalSubject(c, p, c.req.param("memberId") ?? "");
  if (relation === "board") throw new NotFoundError("Member not found");
  const doc = await loadPersonalDocument(p.clubId, owner.id, c.req.param("docId") ?? "");
  const [updated] = await db.update(documents).set({ hiddenByOwner: hidden, updatedAt: new Date() }).where(eq(documents.id, doc.id)).returning();
  await writeAudit(db, { eventType: "member_document.hide", subjectId: owner.id, payload: { clubId: p.clubId, clubMemberId: owner.id, documentId: doc.id, hidden, via: relation } });
  const [version] = updated!.currentVersionId ? await db.select().from(documentVersions).where(eq(documentVersions.id, updated!.currentVersionId)).limit(1) : [];
  return c.json({ data: shape(updated!, version ?? null, relation) });
}

/** Hides a document from the own list (it stays stored as evidence); the member side only. */
memberDocumentRoutes.post("/:memberId/:docId/hide", (c) => setHidden(c, true));
memberDocumentRoutes.post("/:memberId/:docId/unhide", (c) => setHidden(c, false));
