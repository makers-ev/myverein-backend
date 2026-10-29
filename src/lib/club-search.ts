import { and, asc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { departments } from "../db/schema/departments.js";
import { documents } from "../db/schema/documents.js";
import { events } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { getVisibleCalendarIds } from "./calendar-visibility.js";
import { atLeast, folderLevel, globalLevel, loadFolderIndex, type DocumentPrincipal } from "./document-access.js";
import { BadRequestError } from "./errors.js";
import { todayBerlin } from "./member-lifecycle.js";
import { visibleStatusCondition } from "./member-read-scope.js";

/**
 * Global search of one club (Wave 14 S2): members, events, documents and locations, each group only for callers who may read
 * it anyway. The query is never logged (it may be a name). LIKE metacharacters are escaped, so `%` and `_` match literally.
 */

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 10;

export interface SearchCaller extends DocumentPrincipal {
  /** Whether the caller also sees former members and interessenten (members:write / members:read_sensitive). */
  seesAllMembers: boolean;
}

export interface SearchResult {
  members?: Array<{ id: string; name: string; departmentNames?: string[] }>;
  events: Array<{ id: string; title: string; startsAt: Date }>;
  documents: Array<{ id: string; title: string; folderId: string | null }>;
  locations: Array<{ id: string; name: string }>;
}

/** Trims the query and rejects anything shorter than two characters (`400 QUERY_TOO_SHORT`). */
export function normalizeQuery(raw: string | undefined): string {
  const q = (raw ?? "").trim().slice(0, SEARCH_MAX_LENGTH).trim();
  if (q.length < SEARCH_MIN_LENGTH) throw new BadRequestError(`Search text needs at least ${SEARCH_MIN_LENGTH} characters`, { code: "QUERY_TOO_SHORT", details: { code: "query_too_short", min: SEARCH_MIN_LENGTH } });
  return q;
}

/** `limit` per group: default 5, clamped to 1..10 (garbage falls back to the default). */
export function normalizeLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) return SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

async function searchMembers(caller: SearchCaller, pattern: string, limit: number): Promise<NonNullable<SearchResult["members"]>> {
  const today = todayBerlin();
  const rows = await db
    .select({ id: clubMembers.id, name: clubMembers.displayName })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, caller.clubId), ilike(clubMembers.displayName, pattern), caller.seesAllMembers ? undefined : or(visibleStatusCondition(today), eq(clubMembers.memberId, caller.accountMemberId))))
    .orderBy(sql`lower(${clubMembers.displayName})`, asc(clubMembers.id))
    .limit(limit);
  if (rows.length === 0) return [];
  const depts = await db
    .select({ clubMemberId: clubMemberDepartments.clubMemberId, name: departments.name })
    .from(clubMemberDepartments)
    .innerJoin(departments, eq(departments.id, clubMemberDepartments.departmentId))
    .where(and(inArray(clubMemberDepartments.clubMemberId, rows.map((r) => r.id)), or(isNull(clubMemberDepartments.until), sql`${clubMemberDepartments.until} > ${today}`)))
    .orderBy(asc(departments.name));
  const byMember = new Map<string, string[]>();
  for (const d of depts) byMember.set(d.clubMemberId, [...(byMember.get(d.clubMemberId) ?? []), d.name]);
  return rows.map((r) => ({ id: r.id, name: r.name, ...(byMember.has(r.id) ? { departmentNames: byMember.get(r.id)! } : {}) }));
}

async function searchEvents(caller: SearchCaller, pattern: string, limit: number) {
  const calendarIds = await getVisibleCalendarIds(caller.clubId, caller.accountMemberId, caller.roleTypes);
  if (calendarIds.length === 0) return [];
  // Upcoming first (nearest first), then the past (most recent first).
  return db
    .select({ id: events.id, title: events.title, startsAt: events.startsAt })
    .from(events)
    .where(and(inArray(events.calendarId, calendarIds), ilike(events.title, pattern)))
    .orderBy(sql`(${events.startsAt} < now())`, sql`abs(extract(epoch from (${events.startsAt} - now())))`, asc(events.id))
    .limit(limit);
}

/** Archive documents the caller may read (active only, trash excluded); the personal storage is never searched. */
async function searchDocuments(caller: SearchCaller, pattern: string, limit: number) {
  const index = await loadFolderIndex(caller.clubId);
  const folderIds = [...index.folders.keys()].filter((id) => atLeast(folderLevel(caller, index, id), "lesen"));
  const includeRoot = atLeast(globalLevel(caller), "lesen");
  const placement = [folderIds.length > 0 ? inArray(documents.folderId, folderIds) : undefined, includeRoot ? isNull(documents.folderId) : undefined].filter((x) => x !== undefined);
  if (placement.length === 0) return [];
  return db
    .select({ id: documents.id, title: documents.title, folderId: documents.folderId })
    .from(documents)
    .where(and(eq(documents.clubId, caller.clubId), eq(documents.scope, "verein"), eq(documents.status, "aktiv"), isNull(documents.trashedAt), or(...placement), ilike(documents.title, pattern)))
    .orderBy(sql`lower(${documents.title})`, asc(documents.id))
    .limit(limit);
}

async function searchLocations(caller: SearchCaller, pattern: string, limit: number) {
  return db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.clubId, caller.clubId), ilike(locations.name, pattern)))
    .orderBy(sql`lower(${locations.name})`, asc(locations.id))
    .limit(limit);
}

export async function searchClub(caller: SearchCaller, q: string, limit: number): Promise<SearchResult> {
  const pattern = likePattern(q);
  const [members, evs, docs, locs] = await Promise.all([
    caller.isGuest ? Promise.resolve(undefined) : searchMembers(caller, pattern, limit),
    searchEvents(caller, pattern, limit),
    caller.isGuest ? Promise.resolve(undefined) : searchDocuments(caller, pattern, limit),
    searchLocations(caller, pattern, limit),
  ]);
  return { ...(members ? { members } : {}), events: evs, documents: docs ?? [], locations: locs };
}

