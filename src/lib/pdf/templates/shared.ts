import { and, eq } from "drizzle-orm";

import { db } from "../../../db/client.js";
import { clubMembers, memberCategories, type ClubMemberRow } from "../../../db/schema/club-members.js";
import { hasClubPermission } from "../../club-permissions.js";
import type { DocumentPrincipal } from "../../document-access.js";
import { ForbiddenError, NotFoundError } from "../../errors.js";
import { liveLinkOf } from "../../guardian-scope.js";
import { todayBerlin } from "../../member-lifecycle.js";

/** `2024-03-07` -> `07.03.2024`; anything else is returned unchanged (it is cut and escaped by the engine anyway). */
export function dateDe(value: string | Date | null | undefined): string {
  if (!value) return "";
  const iso = value instanceof Date ? todayBerlin(value) : value;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso);
}

export const timeDe = (value: Date | null | undefined): string =>
  value ? new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(value) : "";

export const dateTimeDe = (value: Date | null | undefined): string => (value ? `${dateDe(value)} ${timeDe(value)}` : "");

/** Splits long text into paragraphs the engine accepts (it cuts a single paragraph block at 8000 characters). */
export function paragraphChunks(text: string, size = 7000): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current.length + line.length + 1 > size && current !== "") {
      out.push(current);
      current = "";
    }
    // A single endless line is cut in pieces so nothing is lost silently.
    let rest = line;
    while (rest.length > size) {
      out.push(rest.slice(0, size));
      rest = rest.slice(size);
    }
    current = current === "" ? rest : `${current}\n${rest}`;
  }
  if (current !== "") out.push(current);
  return out;
}

export async function memberWithCategory(clubId: string, clubMemberId: string): Promise<{ row: ClubMemberRow; categoryName: string | null }> {
  const [found] = await db
    .select({ row: clubMembers, categoryName: memberCategories.name })
    .from(clubMembers)
    .leftJoin(memberCategories, eq(memberCategories.id, clubMembers.categoryId))
    .where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId)))
    .limit(1);
  if (!found) throw new NotFoundError("Member not found");
  return found;
}

/** The relation of the caller to a member: `self`, `guardian` (live confirmed link) or `board` (member records right); `null` = a stranger. */
export async function relationTo(actor: DocumentPrincipal, clubMemberId: string): Promise<"self" | "guardian" | "board" | null> {
  if (actor.clubMemberId === clubMemberId) return "self";
  if (await liveLinkOf(actor.accountMemberId, clubMemberId)) return "guardian";
  if (!actor.isGuest && (hasClubPermission(actor.roleTypes, "members:write") || hasClubPermission(actor.roleTypes, "documents:read_personal"))) return "board";
  return null;
}

/** Strangers get the same `404` as for an unknown member; a board member without the member records right gets `403`. */
export async function requireRelation(actor: DocumentPrincipal, clubMemberId: string, allowed: ReadonlyArray<"self" | "guardian" | "board">): Promise<"self" | "guardian" | "board"> {
  const relation = await relationTo(actor, clubMemberId);
  if (relation === null || !allowed.includes(relation)) throw new NotFoundError("Member not found");
  return relation;
}

export function requireMembersWrite(actor: DocumentPrincipal): void {
  if (actor.isGuest || !hasClubPermission(actor.roleTypes, "members:write")) throw new ForbiddenError("Missing members:write permission");
}
