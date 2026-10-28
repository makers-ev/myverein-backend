import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { clubMembers } from "../db/schema/club-members.js";
import { departments } from "../db/schema/departments.js";
import { db } from "../db/client.js";
import {
  DOCUMENT_PERMISSION_LEVELS,
  DOCUMENT_SUBJECT_TYPES,
  documentFolders,
  documentPermissions,
  documents,
  documentVersions,
  MAX_FOLDER_DEPTH,
  type DocumentPermissionLevel,
  type DocumentRow,
  type DocumentVersionRow,
} from "../db/schema/documents.js";
import { writeAudit } from "../lib/audit.js";
import { CLUB_ROLE_TYPES, hasClubPermission } from "../lib/club-permissions.js";
import { isUuid } from "../lib/club-members.js";
import { DOCUMENT_RETENTION_CLASSES } from "../lib/retention/document-classes.js";
import { atLeast, buildPrincipal, canAccessDocument, documentLevel, folderDepth, folderLevel, globalLevel, loadFolderIndex, subtreeHeight, subtreeIds, type DocumentPrincipal, type FolderIndex } from "../lib/document-access.js";
import { addUploadedVersion, createUploadedDocument, listVersions, mediaOfVersion, purgeableCondition, purgeDocuments } from "../lib/documents.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { MAX_DOCUMENT_BYTES, streamMedia, streamSensitiveMedia } from "../lib/media.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, denyExternalGuests, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Document archive of the club (Wave 13 B5): folders with rights, uploads, versions, trash. Rules in
 * `src/lib/document-access.ts` (deny-by-default, nearest folder with rows decides, `404` for everything the caller may not
 * see). Files only through the media layer. The personal storage (`scope = person`) lives in `member-documents.ts`.
 */
export const documentRoutes = new Hono<ClubEnv>();

documentRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
documentRoutes.use("*", sessionGuard);
documentRoutes.use("*", clubGuard);
documentRoutes.use("*", async (c, next) => {
  denyExternalGuests(c);
  await next();
});

const uploadLimiter = rateLimit({ windowMs: 60_000, max: 30, key: (c) => `document-upload:${c.get("user").id}` });
const invalid = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

const nameSchema = cleanText(z.string().trim().min(1).max(100)).refine((v) => !/[/\\]/.test(v), { message: "must not contain slashes" });

function requireManage(c: { get(key: "clubRoleTypes"): string[] }): void {
  if (!hasClubPermission(c.get("clubRoleTypes"), "documents:manage")) throw new ForbiddenError("Missing documents:manage permission");
}

function shapeDocument(p: DocumentPrincipal, index: FolderIndex, doc: DocumentRow, version: DocumentVersionRow | null) {
  const level = documentLevel(p, index, doc);
  const manager = atLeast(level, "verwalten");
  return {
    id: doc.id,
    folderId: doc.folderId,
    kind: doc.kind,
    docType: doc.docType,
    title: doc.title,
    status: doc.status,
    trashedAt: doc.trashedAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    level,
    ...(manager ? { retentionUntil: doc.retentionUntil, legalHold: doc.legalHold } : {}),
    currentVersion: version ? { versionNo: version.versionNo, mimeType: version.mimeType, sizeBytes: version.sizeBytes, originalFilename: version.originalFilename, createdAt: version.createdAt } : null,
  };
}

async function currentVersionsOf(docs: DocumentRow[]): Promise<Map<string, DocumentVersionRow>> {
  const ids = docs.map((d) => d.currentVersionId).filter((id): id is string => id !== null);
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(documentVersions).where(inArray(documentVersions.id, ids));
  return new Map(rows.map((v) => [v.id, v]));
}

/** Loads an archive document the caller may see at `need`; everything else is the same `404`. */
async function loadDocument(c: { get(key: "clubId"): string }, p: DocumentPrincipal, index: FolderIndex, rawId: string, need: DocumentPermissionLevel): Promise<DocumentRow> {
  if (!isUuid(rawId)) throw new NotFoundError("Document not found");
  const [doc] = await db.select().from(documents).where(and(eq(documents.id, rawId), eq(documents.clubId, c.get("clubId")))).limit(1);
  if (!doc || !canAccessDocument(p, index, doc, "lesen") || (need !== "lesen" && !canAccessDocument(p, index, doc, need))) {
    if (doc && canAccessDocument(p, index, doc, "lesen")) throw new ForbiddenError(`Missing ${need} right on this document`);
    throw new NotFoundError("Document not found");
  }
  return doc;
}

function assertFolderExists(index: FolderIndex, folderId: string | null, p: DocumentPrincipal, need: DocumentPermissionLevel): void {
  if (folderId === null) {
    if (!atLeast(globalLevel(p), need)) throw new ForbiddenError(`Missing ${need} right for documents without a folder`);
    return;
  }
  const folder = index.folders.get(folderId);
  if (!folder || !atLeast(folderLevel(p, index, folderId), "lesen")) throw new NotFoundError("Folder not found");
  if (!atLeast(folderLevel(p, index, folderId), need)) throw new ForbiddenError(`Missing ${need} right on this folder`);
}

const folderIdField = z.union([z.uuid(), z.null()]);

// ---------------------------------------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------------------------------------

/** Folders the caller may read, each with their own level. A folder whose parent is not visible is returned as a root (the parent id is not leaked). */
documentRoutes.get("/folders", async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const visible = [...index.folders.values()].map((f) => ({ f, level: folderLevel(p, index, f.id) })).filter((x) => atLeast(x.level, "lesen"));
  const ids = new Set(visible.map((x) => x.f.id));
  return c.json({
    data: visible
      .map(({ f, level }) => ({ id: f.id, parentId: f.parentId && ids.has(f.parentId) ? f.parentId : null, name: f.name, systemKey: f.systemKey, level }))
      .sort((a, b) => a.name.localeCompare(b.name, "de") || a.id.localeCompare(b.id)),
    rootLevel: globalLevel(p),
    maxDepth: MAX_FOLDER_DEPTH,
  });
});

const createFolderSchema = z.object({ name: nameSchema, parentId: folderIdField.optional() });

documentRoutes.post("/folders", zValidator("json", createFolderSchema, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const body = c.req.valid("json");
  const parentId = body.parentId ?? null;
  const index = await loadFolderIndex(p.clubId);
  if (parentId === null) requireManage(c);
  else assertFolderExists(index, parentId, p, "verwalten");
  if (parentId !== null && folderDepth(index, parentId) >= MAX_FOLDER_DEPTH) throw new ValidationError(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`, { code: "UNPROCESSABLE_ENTITY", details: { code: "folder_depth" } });
  const [clash] = await db.select({ id: documentFolders.id }).from(documentFolders).where(and(eq(documentFolders.clubId, p.clubId), parentId === null ? isNull(documentFolders.parentId) : eq(documentFolders.parentId, parentId), sql`lower(${documentFolders.name}) = lower(${body.name})`)).limit(1);
  if (clash) throw new ConflictError("A folder with this name already exists here");
  const [row] = await db.insert(documentFolders).values({ clubId: p.clubId, parentId, name: body.name, createdBy: p.userId }).returning();
  await writeAudit(db, { eventType: "document_folder.create", subjectId: row!.id, payload: { clubId: p.clubId, folderId: row!.id, parentId } });
  return c.json({ data: { id: row!.id, parentId, name: row!.name, systemKey: null, level: folderLevel(p, await loadFolderIndex(p.clubId), row!.id) } }, 201);
});

const patchFolderSchema = z.object({ name: nameSchema.optional(), parentId: folderIdField.optional() }).refine((v) => v.name !== undefined || v.parentId !== undefined, { message: "nothing to change" });

documentRoutes.patch("/folders/:id", zValidator("json", patchFolderSchema, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const id = c.req.param("id");
  const index = await loadFolderIndex(p.clubId);
  if (!isUuid(id) || !index.folders.has(id)) throw new NotFoundError("Folder not found");
  assertFolderExists(index, id, p, "verwalten");
  const folder = index.folders.get(id)!;
  if (folder.systemKey) throw new ConflictError("System folders cannot be changed");
  const body = c.req.valid("json");
  const newParent = body.parentId === undefined ? folder.parentId : body.parentId;
  const newName = body.name ?? folder.name;
  if (newParent !== folder.parentId) {
    if (newParent === null) requireManage(c);
    else {
      assertFolderExists(index, newParent, p, "verwalten");
      if (subtreeIds(index, id).has(newParent)) throw new ConflictError("A folder cannot be moved into itself");
      if (folderDepth(index, newParent) + subtreeHeight(index, id) > MAX_FOLDER_DEPTH) throw new ValidationError(`Folders can be nested at most ${MAX_FOLDER_DEPTH} levels deep`, { details: { code: "folder_depth" } });
    }
  }
  const [clash] = await db
    .select({ id: documentFolders.id })
    .from(documentFolders)
    .where(and(eq(documentFolders.clubId, p.clubId), newParent === null ? isNull(documentFolders.parentId) : eq(documentFolders.parentId, newParent), sql`lower(${documentFolders.name}) = lower(${newName})`, sql`${documentFolders.id} <> ${id}`))
    .limit(1);
  if (clash) throw new ConflictError("A folder with this name already exists here");
  await db.update(documentFolders).set({ name: newName, parentId: newParent, updatedAt: new Date() }).where(eq(documentFolders.id, id));
  await writeAudit(db, { eventType: "document_folder.update", subjectId: id, payload: { clubId: p.clubId, folderId: id, parentId: newParent, changedFields: [body.name !== undefined ? "name" : null, body.parentId !== undefined ? "parentId" : null].filter(Boolean) } });
  return c.json({ data: { id, parentId: newParent, name: newName } });
});

documentRoutes.delete("/folders/:id", async (c) => {
  const p = await buildPrincipal(c);
  const id = c.req.param("id");
  const index = await loadFolderIndex(p.clubId);
  if (!isUuid(id) || !index.folders.has(id)) throw new NotFoundError("Folder not found");
  assertFolderExists(index, id, p, "verwalten");
  if (index.folders.get(id)!.systemKey) throw new ConflictError("System folders cannot be removed");
  const [{ n: subfolders }] = await db.select({ n: count() }).from(documentFolders).where(eq(documentFolders.parentId, id));
  const [{ n: docs }] = await db.select({ n: count() }).from(documents).where(eq(documents.folderId, id));
  if (subfolders > 0 || docs > 0) throw new ConflictError("Only empty folders can be removed (documents in the trash count)", { code: "CONFLICT", details: { code: "folder_not_empty" } });
  await db.delete(documentFolders).where(and(eq(documentFolders.id, id), eq(documentFolders.clubId, p.clubId)));
  await writeAudit(db, { eventType: "document_folder.delete", subjectId: id, payload: { clubId: p.clubId, folderId: id } });
  return c.body(null, 204);
});

documentRoutes.get("/folders/:id/permissions", async (c) => {
  requireManage(c);
  const p = await buildPrincipal(c);
  const id = c.req.param("id");
  const index = await loadFolderIndex(p.clubId);
  if (!isUuid(id) || !index.folders.has(id)) throw new NotFoundError("Folder not found");
  const rows = await db
    .select({ r: documentPermissions, departmentName: departments.name, memberName: clubMembers.displayName })
    .from(documentPermissions)
    .leftJoin(departments, eq(departments.id, documentPermissions.departmentId))
    .leftJoin(clubMembers, eq(clubMembers.id, documentPermissions.clubMemberId))
    .where(eq(documentPermissions.folderId, id));
  return c.json({
    data: rows.map(({ r, departmentName, memberName }) => ({ subjectType: r.subjectType, roleType: r.roleType, departmentId: r.departmentId, clubMemberId: r.clubMemberId, name: departmentName ?? memberName ?? null, level: r.level })),
    // Without own entries a folder inherits the entries of the nearest parent that has some.
    inheritsFrom: rows.length === 0 ? nearestFolderWithRights(index, id) : null,
  });
});

function nearestFolderWithRights(index: FolderIndex, folderId: string): string | null {
  let current = index.folders.get(folderId)?.parentId ?? null;
  while (current !== null) {
    if ((index.permissions.get(current) ?? []).length > 0) return current;
    current = index.folders.get(current)?.parentId ?? null;
  }
  return null;
}

const entrySchema = z
  .object({
    subjectType: z.enum(DOCUMENT_SUBJECT_TYPES),
    roleType: z.enum(CLUB_ROLE_TYPES).optional(),
    departmentId: z.uuid().optional(),
    clubMemberId: z.uuid().optional(),
    level: z.enum(DOCUMENT_PERMISSION_LEVELS),
  })
  .superRefine((v, ctx) => {
    const given = { rolle: v.roleType, abteilung: v.departmentId, mitglied: v.clubMemberId } as const;
    const set = Object.entries(given).filter(([, value]) => value !== undefined).map(([key]) => key);
    if (set.length !== 1 || set[0] !== v.subjectType) ctx.addIssue({ code: "custom", message: "exactly the field matching subjectType must be set" });
  });

const putPermissionsSchema = z.object({ entries: z.array(entrySchema).max(100) });

/** Replaces the whole set of entries of a folder (an empty list makes the folder inherit again). */
documentRoutes.put("/folders/:id/permissions", zValidator("json", putPermissionsSchema, invalid), async (c) => {
  requireManage(c);
  const p = await buildPrincipal(c);
  const id = c.req.param("id");
  const index = await loadFolderIndex(p.clubId);
  if (!isUuid(id) || !index.folders.has(id)) throw new NotFoundError("Folder not found");
  const { entries } = c.req.valid("json");
  const keyOf = (e: (typeof entries)[number]) => `${e.subjectType}:${e.roleType ?? e.departmentId ?? e.clubMemberId}`;
  if (new Set(entries.map(keyOf)).size !== entries.length) throw new ValidationError("Duplicate subject in the entries");
  const deptIds = entries.flatMap((e) => (e.departmentId ? [e.departmentId] : []));
  const memberIds = entries.flatMap((e) => (e.clubMemberId ? [e.clubMemberId] : []));
  if (deptIds.length > 0) {
    const found = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.clubId, p.clubId), inArray(departments.id, deptIds)));
    if (found.length !== new Set(deptIds).size) throw new ValidationError("Unknown department", { details: { field: "departmentId" } });
  }
  if (memberIds.length > 0) {
    const found = await db.select({ id: clubMembers.id }).from(clubMembers).where(and(eq(clubMembers.clubId, p.clubId), inArray(clubMembers.id, memberIds)));
    if (found.length !== new Set(memberIds).size) throw new ValidationError("Unknown member", { details: { field: "clubMemberId" } });
  }
  await db.transaction(async (tx) => {
    await tx.delete(documentPermissions).where(eq(documentPermissions.folderId, id));
    if (entries.length > 0) {
      await tx.insert(documentPermissions).values(
        entries.map((e) => ({ clubId: p.clubId, folderId: id, subjectType: e.subjectType, roleType: e.roleType ?? null, departmentId: e.departmentId ?? null, clubMemberId: e.clubMemberId ?? null, level: e.level, createdBy: p.userId })),
      );
    }
  });
  await writeAudit(db, { eventType: "document_folder.permissions", subjectId: id, payload: { clubId: p.clubId, folderId: id, entries: entries.length } });
  return c.json({ data: { folderId: id, entries: entries.length } });
});

// ---------------------------------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------------------------------

const listQuery = z.object({
  folderId: z.uuid().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["aktiv", "im_papierkorb"]).default("aktiv"),
  // `1`: the documents the caller generated themselves (readable for them whatever the folder rights say).
  mine: z.enum(["0", "1"]).default("0"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Without `folderId` and `q`: the documents without a folder (board only). With `folderId`: that folder. With `q`: search in
 * the titles of everything the caller may read. `status=im_papierkorb` needs `schreiben` in the folder.
 */
documentRoutes.get("/", zValidator("query", listQuery, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const q = c.req.valid("query");
  const index = await loadFolderIndex(p.clubId);
  const need: DocumentPermissionLevel = q.status === "aktiv" ? "lesen" : "schreiben";
  if (q.mine === "1") {
    if (q.status !== "aktiv") return c.json({ data: [], page: q.page, pageSize: q.pageSize, total: 0 });
    const own = and(eq(documents.clubId, p.clubId), eq(documents.scope, "verein"), eq(documents.status, "aktiv"), eq(documents.kind, "erzeugt"), eq(documents.createdBy, p.userId));
    const [ownTotal] = await db.select({ n: count() }).from(documents).where(own);
    const ownRows = await db.select().from(documents).where(own).orderBy(desc(documents.updatedAt), desc(documents.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
    const ownVersions = await currentVersionsOf(ownRows);
    return c.json({ data: ownRows.map((d) => shapeDocument(p, index, d, d.currentVersionId ? (ownVersions.get(d.currentVersionId) ?? null) : null)), page: q.page, pageSize: q.pageSize, total: ownTotal?.n ?? 0 });
  }

  let folderIds: string[];
  let includeRoot: boolean;
  if (q.folderId) {
    if (!index.folders.has(q.folderId) || !atLeast(folderLevel(p, index, q.folderId), "lesen")) throw new NotFoundError("Folder not found");
    folderIds = atLeast(folderLevel(p, index, q.folderId), need) ? [q.folderId] : [];
    includeRoot = false;
  } else if (q.q) {
    folderIds = [...index.folders.keys()].filter((id) => atLeast(folderLevel(p, index, id), need));
    includeRoot = atLeast(globalLevel(p), need);
  } else {
    folderIds = [];
    includeRoot = atLeast(globalLevel(p), need);
  }
  const placement = [folderIds.length > 0 ? inArray(documents.folderId, folderIds) : undefined, includeRoot ? isNull(documents.folderId) : undefined].filter((x) => x !== undefined);
  if (placement.length === 0) return c.json({ data: [], page: q.page, pageSize: q.pageSize, total: 0 });
  const escaped = q.q?.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const where = and(eq(documents.clubId, p.clubId), eq(documents.scope, "verein"), eq(documents.status, q.status), or(...placement), escaped ? ilike(documents.title, `%${escaped}%`) : undefined);
  const [total] = await db.select({ n: count() }).from(documents).where(where);
  const rows = await db
    .select()
    .from(documents)
    .where(where)
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const versions = await currentVersionsOf(rows);
  return c.json({ data: rows.map((d) => shapeDocument(p, index, d, d.currentVersionId ? (versions.get(d.currentVersionId) ?? null) : null)), page: q.page, pageSize: q.pageSize, total: total?.n ?? 0 });
});

const uploadBody = bodyLimit({
  maxSize: MAX_DOCUMENT_BYTES + 128 * 1024,
  onError: () => {
    throw new ValidationError(`File exceeds maximum size of ${MAX_DOCUMENT_BYTES} bytes`);
  },
});

const textField = (raw: unknown, max: number, field: string): string | null => {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new ValidationError(`${field} must be text`);
  const parsed = cleanText(z.string().trim().max(max)).safeParse(raw);
  if (!parsed.success) throw new ValidationError(`${field} is invalid`, { details: { field } });
  return parsed.data || null;
};

/** Multipart upload: `file`, optional `title`, `folderId` (empty = no folder, board only), `note`. */
documentRoutes.post("/", uploadLimiter, uploadBody, async (c) => {
  const p = await buildPrincipal(c);
  const body = await c.req.parseBody();
  const rawFolder = body["folderId"];
  const folderId = typeof rawFolder === "string" && rawFolder !== "" ? rawFolder : null;
  if (folderId !== null && !isUuid(folderId)) throw new NotFoundError("Folder not found");
  const index = await loadFolderIndex(p.clubId);
  // The right comes first: somebody who may not write here learns nothing about the request's other problems.
  assertFolderExists(index, folderId, p, "schreiben");
  const file = body["file"];
  if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");
  const title = textField(body["title"], 200, "title") ?? (file.name.replace(/\.[^.]{1,8}$/, "").slice(0, 200) || "Dokument");
  const { document, version } = await createUploadedDocument({ clubId: p.clubId, scope: "verein", folderId, ownerClubMemberId: null, docType: "upload", title, file, uploadedBy: p.userId, note: textField(body["note"], 500, "note") });
  await writeAudit(db, { eventType: "document.upload", subjectId: document.id, payload: { clubId: p.clubId, documentId: document.id, folderId, docType: "upload", sizeBytes: version.sizeBytes } });
  return c.json({ data: shapeDocument(p, index, document, version) }, 201);
});

/** The retention classes (proposals, to be confirmed legally): read-only for the board. */
documentRoutes.get("/retention-classes", (c) => {
  requireManage(c);
  return c.json({ data: DOCUMENT_RETENTION_CLASSES.map((k) => ({ docType: k.docType, class: k.class, label: k.label, years: k.years, startsOn: k.startsOn, description: k.description })) });
});

const legalHoldSchema = z.object({ active: z.boolean(), reason: cleanText(z.string().trim().min(1).max(200)).optional() });

/** Legal hold on one archive document (`verwalten`): it cannot be deleted or purged while it is on; a pending retention deletion is called off. */
documentRoutes.put("/:id/legal-hold", zValidator("json", legalHoldSchema, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await loadDocument(c, p, index, c.req.param("id"), "verwalten");
  const { active } = c.req.valid("json");
  const [updated] = await db
    .update(documents)
    .set({ legalHold: active, ...(active && doc.status === "zur_loeschung" ? { status: "aktiv" } : {}), updatedAt: new Date() })
    .where(eq(documents.id, doc.id))
    .returning();
  await writeAudit(db, { eventType: "document.legal_hold", subjectId: doc.id, actorUserId: p.userId, clubId: p.clubId, payload: { clubId: p.clubId, documentId: doc.id, active } });
  return c.json({ data: { id: updated!.id, legalHold: updated!.legalHold, status: updated!.status } });
});

documentRoutes.get("/:id", async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await loadDocument(c, p, index, c.req.param("id"), "lesen");
  const versions = await listVersions(doc.id);
  return c.json({
    data: {
      ...shapeDocument(p, index, doc, versions.find((v) => v.id === doc.currentVersionId) ?? null),
      versions: versions.map((v) => ({ versionNo: v.versionNo, mimeType: v.mimeType, sizeBytes: v.sizeBytes, sha256: v.sha256, originalFilename: v.originalFilename, note: v.note, createdAt: v.createdAt, generated: v.templateId !== null })),
    },
  });
});

/** New version of the same document (multipart: `file`, optional `note`). */
documentRoutes.post("/:id/versions", uploadLimiter, uploadBody, async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await loadDocument(c, p, index, c.req.param("id"), "schreiben");
  if (doc.kind === "erzeugt") throw new ConflictError("A generated document cannot get an uploaded version");
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) throw new ValidationError("Missing file upload (field name: file)");
  const { document, version } = await addUploadedVersion(doc, file, p.userId, textField(body["note"], 500, "note"));
  await writeAudit(db, { eventType: "document.version_add", subjectId: doc.id, payload: { clubId: p.clubId, documentId: doc.id, versionNo: version.versionNo, sizeBytes: version.sizeBytes } });
  return c.json({ data: shapeDocument(p, index, document, version) }, 201);
});

/** Authenticated download (no signed URL); `versionNo` selects an older version. Sensitive files (reports) are audited per retrieval. */
documentRoutes.get("/:id/download", async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await loadDocument(c, p, index, c.req.param("id"), "lesen");
  const rawNo = c.req.query("versionNo");
  const [version] = rawNo
    ? await db.select().from(documentVersions).where(and(eq(documentVersions.documentId, doc.id), eq(documentVersions.versionNo, Number(rawNo) || -1))).limit(1)
    : doc.currentVersionId
      ? await db.select().from(documentVersions).where(eq(documentVersions.id, doc.currentVersionId)).limit(1)
      : [];
  if (!version) throw new NotFoundError("Version not found");
  const media = await mediaOfVersion(version);
  if (!media) throw new NotFoundError("File not found");
  return media.sensitive ? streamSensitiveMedia(c, media, { accessedBy: p.userId, subjectId: doc.id }) : streamMedia(c, media);
});

const patchDocumentSchema = z
  .object({ title: cleanText(z.string().trim().min(1).max(200)).optional(), folderId: folderIdField.optional() })
  .refine((v) => v.title !== undefined || v.folderId !== undefined, { message: "nothing to change" });

documentRoutes.patch("/:id", zValidator("json", patchDocumentSchema, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await loadDocument(c, p, index, c.req.param("id"), "schreiben");
  const body = c.req.valid("json");
  const target = body.folderId === undefined ? doc.folderId : body.folderId;
  if (target !== doc.folderId) assertFolderExists(index, target, p, "schreiben");
  const [updated] = await db.update(documents).set({ title: body.title ?? doc.title, folderId: target, updatedAt: new Date() }).where(eq(documents.id, doc.id)).returning();
  await writeAudit(db, { eventType: "document.update", subjectId: doc.id, payload: { clubId: p.clubId, documentId: doc.id, toFolderId: target !== doc.folderId ? target : undefined, changedFields: [body.title !== undefined ? "title" : null, target !== doc.folderId ? "folderId" : null].filter(Boolean) } });
  const versions = await currentVersionsOf([updated!]);
  return c.json({ data: shapeDocument(p, index, updated!, updated!.currentVersionId ? (versions.get(updated!.currentVersionId) ?? null) : null) });
});

/** Moves to the trash (30 days, still counts against the quota); needs `schreiben`. */
documentRoutes.delete("/:id", async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await loadDocument(c, p, index, c.req.param("id"), "schreiben");
  if (doc.status !== "aktiv") throw new ConflictError("The document is already in the trash");
  await db.update(documents).set({ status: "im_papierkorb", trashedAt: new Date(), trashedBy: p.userId, updatedAt: new Date() }).where(eq(documents.id, doc.id));
  await writeAudit(db, { eventType: "document.trash", subjectId: doc.id, payload: { clubId: p.clubId, documentId: doc.id } });
  return c.body(null, 204);
});

documentRoutes.post("/:id/restore", async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await loadDocument(c, p, index, c.req.param("id"), "schreiben");
  if (doc.status !== "im_papierkorb") throw new ConflictError("The document is not in the trash");
  const [updated] = await db.update(documents).set({ status: "aktiv", trashedAt: null, trashedBy: null, updatedAt: new Date() }).where(eq(documents.id, doc.id)).returning();
  await writeAudit(db, { eventType: "document.restore", subjectId: doc.id, payload: { clubId: p.clubId, documentId: doc.id } });
  const versions = await currentVersionsOf([updated!]);
  return c.json({ data: shapeDocument(p, index, updated!, updated!.currentVersionId ? (versions.get(updated!.currentVersionId) ?? null) : null) });
});

/** Final deletion of ONE trashed document (`verwalten`); legal hold and retention block it (`409`). */
documentRoutes.delete("/:id/permanent", async (c) => {
  const p = await buildPrincipal(c);
  const index = await loadFolderIndex(p.clubId);
  const doc = await loadDocument(c, p, index, c.req.param("id"), "verwalten");
  if (doc.status !== "im_papierkorb") throw new ConflictError("Only documents in the trash can be deleted for good");
  const [ok] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, doc.id), purgeableCondition(new Date(), null))).limit(1);
  if (!ok) throw new ConflictError("The document is under legal hold or retention", { code: "CONFLICT", details: { code: "retention" } });
  const afterCommit: Array<() => Promise<void>> = [];
  await db.transaction((tx) => purgeDocuments(tx, [doc], afterCommit));
  for (const run of afterCommit) await run();
  await writeAudit(db, { eventType: "document.purge", subjectId: doc.id, payload: { clubId: p.clubId, documentId: doc.id, count: 1, source: "manual" } });
  return c.body(null, 204);
});

/** Empties the archive trash of the club (`documents:manage`); documents under legal hold or retention stay and are counted as `kept`. */
documentRoutes.post("/trash/empty", async (c) => {
  requireManage(c);
  const clubId = c.get("clubId");
  const trashed = await db.select({ id: documents.id, clubId: documents.clubId }).from(documents).where(and(eq(documents.clubId, clubId), eq(documents.scope, "verein"), eq(documents.status, "im_papierkorb")));
  const due = await db.select({ id: documents.id, clubId: documents.clubId }).from(documents).where(and(eq(documents.clubId, clubId), eq(documents.scope, "verein"), purgeableCondition(new Date(), null)));
  const afterCommit: Array<() => Promise<void>> = [];
  const removed = await db.transaction((tx) => purgeDocuments(tx, due, afterCommit));
  for (const run of afterCommit) await run();
  if (removed > 0) await writeAudit(db, { eventType: "document.purge", subjectId: clubId, payload: { clubId, count: removed, source: "empty_trash" } });
  return c.json({ data: { removed, kept: trashed.length - removed } });
});
