import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubInfoPages, clubInfoPageVersions, type ClubInfoPageRow } from "../db/schema/club-info-pages.js";
import { documents, documentVersions } from "../db/schema/documents.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { BOARD_ROLE_TYPES, hasClubPermission } from "../lib/club-permissions.js";
import { loadAssemblyRules } from "../lib/assembly-rules.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { termInfo } from "../lib/term-status.js";
import { boardPhotoUrls } from "../lib/member-photos.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { MAX_INFO_MARKDOWN_CHARS, writeInfoPage } from "../lib/club-info.js";
import { findMediaByKey, streamMedia } from "../lib/media.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, denyExternalGuests, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";
import { writeAudit } from "../lib/audit.js";

export const clubInfoRoutes = new Hono<ClubEnv>();

clubInfoRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubInfoRoutes.use("*", sessionGuard);
clubInfoRoutes.use("*", clubGuard);

/**
 * Aggregate Vereinsinfo view: current board (who holds a BOARD_ROLE_TYPES
 * role, with name/role/term end), department overview, and the club's info
 * pages (Satzung/Leitbild/...). One request instead of three round trips --
 * see Concept - MyVerein §2 "Vereinsinfo".
 */
clubInfoRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");

  const [allMembers, allDepartments, pages] = await Promise.all([
    db.query.member.findMany({ where: eq(member.organizationId, clubId) }),
    db.query.departments.findMany({ where: eq(departments.clubId, clubId), orderBy: (d, { asc }) => [asc(d.name)] }),
    db.query.clubInfoPages.findMany({ where: eq(clubInfoPages.clubId, clubId), orderBy: (p, { asc }) => [asc(p.slug)] }),
  ]);

  const memberIds = allMembers.map((m) => m.id);
  const boardRoleRows = memberIds.length
    ? await db.query.clubRoles.findMany({
        where: and(inArray(clubRoles.memberId, memberIds), inArray(clubRoles.roleType, BOARD_ROLE_TYPES)),
      })
    : [];

  const membersById = new Map(allMembers.map((m) => [m.id, m]));
  const userIds = [...new Set(boardRoleRows.map((r) => membersById.get(r.memberId)?.userId).filter((id): id is string => !!id))];
  const users = userIds.length ? await db.query.user.findMany({ where: inArray(user.id, userIds) }) : [];
  const usersById = new Map(users.map((u) => [u.id, u]));

  // Board photos: only for members:write / members:read_sensitive and the person themselves (consent follows in Wave 10).
  const roleTypes = c.get("clubRoleTypes");
  const boardPhotos = await boardPhotoUrls(clubId, [...new Set(boardRoleRows.map((r) => r.memberId))], {
    memberId: c.get("membership").id,
    canReadSensitive: hasClubPermission(roleTypes, "members:read_sensitive"),
    canWrite: hasClubPermission(roleTypes, "members:write"),
  });

  const today = todayBerlin();
  const warningDays = (await loadAssemblyRules(db, clubId)).termWarningDays;
  const board = boardRoleRows.map((roleRow) => {
    const memberRow = membersById.get(roleRow.memberId);
    const userRow = memberRow ? usersById.get(memberRow.userId) : undefined;
    return {
      memberId: roleRow.memberId,
      name: userRow?.name ?? null,
      roleType: roleRow.roleType,
      termEndsAt: roleRow.termEndsAt,
      ...termInfo(roleRow.termEndsAt, today, warningDays),
      photoUrl: boardPhotos.get(roleRow.memberId) ?? null,
    };
  });

  // The list carries metadata only; the content comes with GET /:slug (Wave 13 B4).
  return c.json({ data: { board, departments: allDepartments, pages: pages.map(pageSummary) } });
});

/** Metadata of a page for lists: no content, no author. */
function pageSummary(row: ClubInfoPageRow) {
  return {
    id: row.id,
    clubId: row.clubId,
    slug: row.slug,
    title: row.title,
    externalUrl: row.externalUrl,
    hasContent: row.contentMarkdown !== null && row.contentMarkdown.trim() !== "",
    hasAttachment: row.documentId !== null,
    validFrom: row.validFrom,
    currentVersion: row.currentVersion,
    updatedAt: row.updatedAt,
  };
}

/** Full page incl. the content and the metadata of the PDF attachment (download: GET /:slug/attachment). */
async function pageDetail(row: ClubInfoPageRow) {
  let attachment: { documentId: string; title: string; mimeType: string; sizeBytes: number } | null = null;
  if (row.documentId) {
    const [doc] = await db
      .select({ title: documents.title, mimeType: documentVersions.mimeType, sizeBytes: documentVersions.sizeBytes, status: documents.status })
      .from(documents)
      .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
      .where(eq(documents.id, row.documentId))
      .limit(1);
    if (doc && doc.status === "aktiv") attachment = { documentId: row.documentId, title: doc.title, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes };
  }
  return { ...pageSummary(row), contentMarkdown: row.contentMarkdown, attachment };
}

async function loadPage(clubId: string, slug: string): Promise<ClubInfoPageRow> {
  const row = await db.query.clubInfoPages.findFirst({ where: and(eq(clubInfoPages.clubId, clubId), eq(clubInfoPages.slug, slug)) });
  if (!row) throw new NotFoundError("Info page not found");
  return row;
}

function requireWrite(c: { get(key: "clubRoleTypes"): string[] }): void {
  if (!hasClubPermission(c.get("clubRoleTypes"), "club_info:write")) throw new ForbiddenError("Missing club_info:write permission");
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const versionParam = (raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw new NotFoundError("Version not found");
  return n;
};

clubInfoRoutes.get("/:slug", async (c) => {
  return c.json({ data: await pageDetail(await loadPage(c.get("clubId"), c.req.param("slug"))) });
});

/** PDF attached to the page (e.g. the adopted Satzung): readable by everybody who may read the page; authenticated stream, no URL. */
clubInfoRoutes.get("/:slug/attachment", async (c) => {
  denyExternalGuests(c);
  const page = await loadPage(c.get("clubId"), c.req.param("slug"));
  if (!page.documentId) throw new NotFoundError("No attachment");
  const [row] = await db
    .select({ storageKey: documentVersions.storageKey, status: documents.status })
    .from(documents)
    .innerJoin(documentVersions, eq(documentVersions.id, documents.currentVersionId))
    .where(and(eq(documents.id, page.documentId), eq(documents.clubId, c.get("clubId"))))
    .limit(1);
  if (!row || row.status !== "aktiv") throw new NotFoundError("No attachment");
  const media = await findMediaByKey(row.storageKey);
  if (!media || media.clubId !== c.get("clubId")) throw new NotFoundError("No attachment");
  return streamMedia(c, media);
});

const upsertPageSchema = z.object({
  title: cleanText(z.string().trim().min(1).max(200)),
  contentMarkdown: cleanText(z.string().max(MAX_INFO_MARKDOWN_CHARS), true).nullish(),
  // Only http(s): a `javascript:`/`data:` link must never reach a client that renders it as a link.
  externalUrl: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((value) => /^https?:\/\//i.test(value), { message: "externalUrl must be an http(s) URL" })
    .nullish(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "validFrom must be YYYY-MM-DD" }).refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), { message: "validFrom is not a date" }).nullish(),
  documentId: z.uuid().nullish(),
  note: cleanText(z.string().trim().max(500)).nullish(),
});

const invalid = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

/** Create-or-update semantics (slug is the natural key); every change is a new version. */
clubInfoRoutes.put("/:slug", zValidator("json", upsertPageSchema, invalid), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const slug = c.req.param("slug");
  // New pages need a tidy slug; pages that already exist keep whatever slug they were created with.
  if (!SLUG_RE.test(slug) && !(await db.query.clubInfoPages.findFirst({ where: and(eq(clubInfoPages.clubId, clubId), eq(clubInfoPages.slug, slug)), columns: { id: true } }))) {
    throw new ValidationError("slug must be 1-60 lower case letters, digits or '-'");
  }
  const body = c.req.valid("json");
  const userId = c.get("user").id;

  const result = await db.transaction(async (tx) => {
    const written = await writeInfoPage(tx, {
      clubId,
      slug,
      title: body.title,
      contentMarkdown: body.contentMarkdown ?? null,
      externalUrl: body.externalUrl ?? null,
      validFrom: body.validFrom ?? null,
      documentId: body.documentId ?? null,
      note: body.note || null,
      userId,
    });
    if (written.outcome !== "unchanged") {
      await writeAudit(tx, { eventType: written.outcome === "created" ? "club_info_page.create" : "club_info_page.update", subjectId: written.page.id, payload: { clubId, slug, version: written.page.currentVersion } });
    }
    return written;
  });

  return c.json({ data: await pageDetail(result.page), unchanged: result.outcome === "unchanged" }, result.outcome === "created" ? 201 : 200);
});

/** History of a page: metadata of every version, newest first (no content; authors only for the people who may write). */
clubInfoRoutes.get("/:slug/versions", async (c) => {
  denyExternalGuests(c);
  const page = await loadPage(c.get("clubId"), c.req.param("slug"));
  const canSeeAuthors = hasClubPermission(c.get("clubRoleTypes"), "club_info:write");
  const rows = await db
    .select({ v: clubInfoPageVersions, authorName: user.name })
    .from(clubInfoPageVersions)
    .leftJoin(user, eq(user.id, clubInfoPageVersions.createdBy))
    .where(eq(clubInfoPageVersions.pageId, page.id))
    .orderBy(desc(clubInfoPageVersions.versionNo));
  return c.json({
    data: rows.map(({ v, authorName }) => ({
      versionNo: v.versionNo,
      title: v.title,
      validFrom: v.validFrom,
      note: v.note,
      hasAttachment: v.documentId !== null,
      createdAt: v.createdAt,
      createdByName: canSeeAuthors ? authorName : null,
      current: v.versionNo === page.currentVersion,
    })),
  });
});

clubInfoRoutes.get("/:slug/versions/:n", async (c) => {
  denyExternalGuests(c);
  const page = await loadPage(c.get("clubId"), c.req.param("slug"));
  const [v] = await db
    .select()
    .from(clubInfoPageVersions)
    .where(and(eq(clubInfoPageVersions.pageId, page.id), eq(clubInfoPageVersions.versionNo, versionParam(c.req.param("n")))))
    .limit(1);
  if (!v) throw new NotFoundError("Version not found");
  return c.json({
    data: { versionNo: v.versionNo, title: v.title, contentMarkdown: v.contentMarkdown, externalUrl: v.externalUrl, validFrom: v.validFrom, hasAttachment: v.documentId !== null, note: v.note, createdAt: v.createdAt, current: v.versionNo === page.currentVersion },
  });
});

const restoreSchema = z.object({ note: cleanText(z.string().trim().max(500)).nullish() });

/** Restoring writes the old content as a NEW version (the history is never rewritten). */
clubInfoRoutes.post("/:slug/versions/:n/restore", zValidator("json", restoreSchema, invalid), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const slug = c.req.param("slug");
  const n = versionParam(c.req.param("n"));
  const body = c.req.valid("json");
  const page = await loadPage(clubId, slug);
  const [old] = await db
    .select()
    .from(clubInfoPageVersions)
    .where(and(eq(clubInfoPageVersions.pageId, page.id), eq(clubInfoPageVersions.versionNo, n)))
    .limit(1);
  if (!old) throw new NotFoundError("Version not found");

  const result = await db.transaction(async (tx) => {
    // An attachment that was removed from the archive meanwhile is dropped instead of failing the restore.
    let documentId = old.documentId;
    if (documentId) {
      const [doc] = await tx.select({ status: documents.status }).from(documents).where(and(eq(documents.id, documentId), eq(documents.clubId, clubId))).limit(1);
      if (!doc || doc.status !== "aktiv") documentId = null;
    }
    const written = await writeInfoPage(tx, {
      clubId,
      slug,
      title: old.title,
      contentMarkdown: old.contentMarkdown,
      externalUrl: old.externalUrl,
      validFrom: old.validFrom,
      documentId,
      note: body.note || `Wiederhergestellt aus Version ${n}`,
      userId: c.get("user").id,
    });
    if (written.outcome !== "unchanged") {
      await writeAudit(tx, { eventType: "club_info_page.update", subjectId: written.page.id, payload: { clubId, slug, version: written.page.currentVersion, restoredFromVersion: n } });
    }
    return written;
  });
  return c.json({ data: await pageDetail(result.page), unchanged: result.outcome === "unchanged" });
});

clubInfoRoutes.delete("/:slug", async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const slug = c.req.param("slug");
  const existing = await loadPage(clubId, slug);

  await db.delete(clubInfoPages).where(eq(clubInfoPages.id, existing.id));
  await writeAudit(db, { eventType: "club_info_page.delete", subjectId: existing.id, payload: { clubId, slug, version: existing.currentVersion } });

  return c.body(null, 204);
});
