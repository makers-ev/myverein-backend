import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import {
  documentFolders,
  documentPermissions,
  MAX_FOLDER_DEPTH,
  type DocumentFolderRow,
  type DocumentPermissionLevel,
  type DocumentPermissionRow,
  type DocumentRow,
} from "../db/schema/documents.js";
import { hasClubPermission } from "./club-permissions.js";
import type { DbExecutor } from "./club-members.js";
import { todayBerlin } from "./member-lifecycle.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Access rules of the document archive (Wave 13 B5). Deny-by-default:
 *
 * - `documents:manage` holders have `verwalten` everywhere, `documents:write` holders `schreiben` everywhere
 *   (the board roles). Nobody else has anything unless a folder right grants it.
 * - A folder right (`document_permissions`) names a role type, a department or a single club member and a level. The
 *   NEAREST folder on the way up (the folder itself first) that has any rows decides; if none of its rows matches the
 *   caller, the caller gets nothing (a sub-folder with its own rows therefore restricts what the parent granted).
 * - Documents without a folder (`folder_id` NULL) are reachable only through the global levels above.
 * - Everything the caller may not see is answered `404`, never `403`, so existence does not leak.
 */

export const LEVEL_ORDER: readonly DocumentPermissionLevel[] = ["lesen", "schreiben", "verwalten"];
export const levelRank = (level: DocumentPermissionLevel | null): number => (level === null ? 0 : LEVEL_ORDER.indexOf(level) + 1);
export const maxLevel = (a: DocumentPermissionLevel | null, b: DocumentPermissionLevel | null): DocumentPermissionLevel | null => (levelRank(a) >= levelRank(b) ? a : b);
export const atLeast = (have: DocumentPermissionLevel | null, need: DocumentPermissionLevel): boolean => levelRank(have) >= levelRank(need);

/** Who is asking: the account, its club member row (may be absent), roles and departments. */
export interface DocumentPrincipal {
  clubId: string;
  userId: string;
  accountMemberId: string;
  clubMemberId: string | null;
  roleTypes: string[];
  departmentIds: string[];
  isGuest: boolean;
}

export async function buildPrincipal(c: Context<ClubEnv>): Promise<DocumentPrincipal> {
  const membership = c.get("membership");
  const clubId = c.get("clubId");
  const [cm] = await db.select({ id: clubMembers.id }).from(clubMembers).where(and(eq(clubMembers.memberId, membership.id), eq(clubMembers.clubId, clubId))).limit(1);
  const departmentIds = new Set<string>();
  if (cm) {
    const today = todayBerlin();
    const rows = await db
      .select({ departmentId: clubMemberDepartments.departmentId })
      .from(clubMemberDepartments)
      .where(and(eq(clubMemberDepartments.clubMemberId, cm.id), or(isNull(clubMemberDepartments.until), sql`${clubMemberDepartments.until} >= ${today}`)));
    for (const r of rows) departmentIds.add(r.departmentId);
  }
  const bound = await db.select({ departmentId: clubRoles.departmentId }).from(clubRoles).where(eq(clubRoles.memberId, membership.id));
  for (const r of bound) if (r.departmentId) departmentIds.add(r.departmentId);
  return {
    clubId,
    userId: c.get("user").id,
    accountMemberId: membership.id,
    clubMemberId: cm?.id ?? null,
    roleTypes: c.get("clubRoleTypes"),
    departmentIds: [...departmentIds],
    isGuest: membership.role === "guest",
  };
}

/** The level every holder of a board permission has in every folder (and for documents without a folder). */
export function globalLevel(p: Pick<DocumentPrincipal, "roleTypes">): DocumentPermissionLevel | null {
  if (hasClubPermission(p.roleTypes, "documents:manage")) return "verwalten";
  if (hasClubPermission(p.roleTypes, "documents:write")) return "schreiben";
  return null;
}

/** The whole folder tree of a club with its rights, loaded once per request (clubs have tens of folders, not thousands). */
export interface FolderIndex {
  folders: Map<string, DocumentFolderRow>;
  permissions: Map<string, DocumentPermissionRow[]>;
}

export async function loadFolderIndex(clubId: string, executor: DbExecutor = db): Promise<FolderIndex> {
  const [folders, permissions] = await Promise.all([
    executor.select().from(documentFolders).where(eq(documentFolders.clubId, clubId)),
    executor.select().from(documentPermissions).where(eq(documentPermissions.clubId, clubId)),
  ]);
  const byFolder = new Map<string, DocumentPermissionRow[]>();
  for (const row of permissions) byFolder.set(row.folderId, [...(byFolder.get(row.folderId) ?? []), row]);
  return { folders: new Map(folders.map((f) => [f.id, f])), permissions: byFolder };
}

function matches(p: DocumentPrincipal, row: DocumentPermissionRow): boolean {
  if (row.subjectType === "rolle") return row.roleType !== null && p.roleTypes.includes(row.roleType);
  if (row.subjectType === "abteilung") return row.departmentId !== null && p.departmentIds.includes(row.departmentId);
  if (row.subjectType === "mitglied") return row.clubMemberId !== null && row.clubMemberId === p.clubMemberId;
  return false;
}

/** Effective level of the caller in a folder (`null` = none). `folderId = null` is the club root: only the global level counts. */
export function folderLevel(p: DocumentPrincipal, index: FolderIndex, folderId: string | null): DocumentPermissionLevel | null {
  let level = globalLevel(p);
  if (p.isGuest) return null;
  let current = folderId;
  for (let hops = 0; current !== null && hops <= MAX_FOLDER_DEPTH + 1; hops++) {
    const folder = index.folders.get(current);
    if (!folder) return level;
    const rows = index.permissions.get(current);
    if (rows && rows.length > 0) {
      for (const row of rows) if (matches(p, row)) level = maxLevel(level, row.level as DocumentPermissionLevel);
      return level;
    }
    current = folder.parentId;
  }
  return level;
}

/** Depth of a folder (root folders = 1). */
export function folderDepth(index: FolderIndex, folderId: string): number {
  let depth = 0;
  let current: string | null = folderId;
  while (current !== null && depth <= MAX_FOLDER_DEPTH + 1) {
    const folder = index.folders.get(current);
    if (!folder) break;
    depth += 1;
    current = folder.parentId;
  }
  return depth;
}

/** Ids of `folderId` and everything below it. */
export function subtreeIds(index: FolderIndex, folderId: string): Set<string> {
  const out = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of index.folders.values()) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Height of the subtree below a folder (a leaf = 1), to check a move against `MAX_FOLDER_DEPTH`. */
export function subtreeHeight(index: FolderIndex, folderId: string): number {
  let best = 1;
  for (const f of index.folders.values()) if (f.parentId === folderId) best = Math.max(best, 1 + subtreeHeight(index, f.id));
  return best;
}

/**
 * Central check for ONE document: may the caller do `need` with it? Archive documents follow their folder; a document in
 * the trash additionally needs `schreiben` for every action, so plain readers never see trashed files. Documents of the
 * personal storage are decided by `canAccessPersonalDocument` (B6) -- this function answers `false` for them, so a route
 * that forgot to dispatch fails closed.
 */
export function canAccessDocument(p: DocumentPrincipal, index: FolderIndex, doc: DocLike, need: DocumentPermissionLevel): boolean {
  if (doc.clubId !== p.clubId || doc.scope !== "verein") return false;
  const level = documentLevel(p, index, doc);
  if (doc.status !== "aktiv" && !atLeast(level, "schreiben")) return false;
  return atLeast(level, need);
}

type DocLike = Pick<DocumentRow, "scope" | "folderId" | "status" | "clubId"> & Partial<Pick<DocumentRow, "kind" | "createdBy">>;

/**
 * The level of the caller on ONE document: the folder level, but whoever REQUESTED a generated document can always read it
 * (a trainer who creates an attendance list must be able to open it although the system folder is a board folder). The
 * exception is read-only, applies to active documents only and never to uploads.
 */
export function documentLevel(p: DocumentPrincipal, index: FolderIndex, doc: DocLike): DocumentPermissionLevel | null {
  const level = folderLevel(p, index, doc.folderId);
  // The exception lasts only while the requester still holds the right to generate: somebody who left the board keeps no copy of the member list.
  if (!p.isGuest && doc.kind === "erzeugt" && doc.createdBy === p.userId && doc.status === "aktiv" && doc.scope === "verein" && hasClubPermission(p.roleTypes, "documents:generate")) return maxLevel(level, "lesen");
  return level;
}
