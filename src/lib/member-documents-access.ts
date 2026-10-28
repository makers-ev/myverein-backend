import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "../db/client.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { hasClubPermission } from "./club-permissions.js";
import { isUuid } from "./club-members.js";
import { NotFoundError } from "./errors.js";
import { liveLinkOf } from "./guardian-scope.js";
import type { DocumentPrincipal } from "./document-access.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Access to the personal storage of ONE club member (Wave 13 B6). Three ways in, nothing else:
 *   `self`     the person themselves (account linked to the club member),
 *   `guardian` an account with a LIVE confirmed guardian link to the ward (Wave 10 guardian scope: ends with majority, expiry
 *              or the ward's exit, evaluated at read time),
 *   `board`    `documents:read_personal`; every board access is logged and visible to the member.
 * Anybody else gets the same `404` as for an unknown member (no oracle). Documents of the personal storage never appear in the
 * archive routes (`canAccessDocument` is `false` for `scope = person`).
 */
export type PersonalRelation = "self" | "guardian" | "board";

export async function resolvePersonalSubject(c: Context<ClubEnv>, p: DocumentPrincipal, idParam: string): Promise<{ owner: ClubMemberRow; relation: PersonalRelation }> {
  let ownerId: string;
  if (idParam === "me") {
    if (!p.clubMemberId) throw new NotFoundError("Member not found");
    ownerId = p.clubMemberId;
  } else {
    if (!isUuid(idParam)) throw new NotFoundError("Member not found");
    ownerId = idParam;
  }
  const [owner] = await db.select().from(clubMembers).where(and(eq(clubMembers.id, ownerId), eq(clubMembers.clubId, p.clubId))).limit(1);
  if (!owner) throw new NotFoundError("Member not found");
  if (p.clubMemberId === owner.id) return { owner, relation: "self" };
  if (await liveLinkOf(p.accountMemberId, owner.id)) return { owner, relation: "guardian" };
  if (!p.isGuest && hasClubPermission(c.get("clubRoleTypes"), "documents:read_personal")) return { owner, relation: "board" };
  throw new NotFoundError("Member not found");
}
