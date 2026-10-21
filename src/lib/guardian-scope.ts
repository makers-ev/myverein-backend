import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { member, organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { guardianLinks, type GuardianLinkRow } from "../db/schema/guardian-links.js";
import { NotFoundError } from "./errors.js";
import { ageOn, effectiveStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * `guardianScope` (Wave 10 B4): what a guardian may reach is bound to the WARD, never to a role string.
 *
 * A link grants something only if, evaluated at READ time (no cron dependency): the board confirmed it (`confirmed_at`),
 * `valid_from <= today <= valid_until`, the guardian's account membership and the ward belong to the same club, the ward is
 * younger than 18 (the link ends with the majority, whatever `valid_until` says) and has not left the club. Everything else
 * is "not found" -- the same answer for a foreign club, a foreign child, an expired link and an unknown id (no oracle).
 */

/** Age at which a guardian link ends by itself. */
export const GUARDIAN_LINK_END_AGE = 18;

export interface WardLink {
  link: GuardianLinkRow;
  ward: ClubMemberRow;
  clubId: string;
  clubName: string;
}

/** SQL condition: the link is confirmed and inside its validity window today. */
export function linkIsLive(today = todayBerlin()) {
  return and(isNotNull(guardianLinks.confirmedAt), lte(guardianLinks.validFrom, today), or(isNull(guardianLinks.validUntil), sql`${guardianLinks.validUntil} >= ${today}`));
}

function wardStillInScope(ward: ClubMemberRow, today: string): boolean {
  if (ward.birthDate !== null && ageOn(ward.birthDate, today) >= GUARDIAN_LINK_END_AGE) return false;
  return !["ausgetreten", "ausgeschlossen", "verstorben"].includes(effectiveStatus(ward, today));
}

/** Every ward of the account (all clubs, or one club), links live today. */
export async function activeWardLinks(userId: string, opts: { clubId?: string; wardId?: string } = {}): Promise<WardLink[]> {
  const today = todayBerlin();
  const rows = await db
    .select({ link: guardianLinks, ward: clubMembers, clubName: organization.name })
    .from(guardianLinks)
    .innerJoin(member, eq(member.id, guardianLinks.guardianMemberId))
    .innerJoin(clubMembers, and(eq(clubMembers.id, guardianLinks.wardClubMemberId), eq(clubMembers.clubId, member.organizationId)))
    .innerJoin(organization, eq(organization.id, clubMembers.clubId))
    .where(
      and(
        eq(member.userId, userId),
        linkIsLive(today),
        opts.clubId !== undefined ? eq(clubMembers.clubId, opts.clubId) : undefined,
        opts.wardId !== undefined ? eq(clubMembers.id, opts.wardId) : undefined,
      ),
    )
    .orderBy(asc(organization.name), asc(clubMembers.displayName), asc(clubMembers.id));
  return rows.filter((r) => wardStillInScope(r.ward, today)).map((r) => ({ link: r.link, ward: r.ward, clubId: r.ward.clubId, clubName: r.clubName }));
}

/** The live link of THIS account membership to the ward, or null. */
export async function liveLinkOf(guardianAccountMemberId: string, wardClubMemberId: string): Promise<{ link: GuardianLinkRow; ward: ClubMemberRow } | null> {
  const today = todayBerlin();
  const [row] = await db
    .select({ link: guardianLinks, ward: clubMembers })
    .from(guardianLinks)
    .innerJoin(member, eq(member.id, guardianLinks.guardianMemberId))
    .innerJoin(clubMembers, and(eq(clubMembers.id, guardianLinks.wardClubMemberId), eq(clubMembers.clubId, member.organizationId)))
    .where(and(eq(guardianLinks.guardianMemberId, guardianAccountMemberId), eq(guardianLinks.wardClubMemberId, wardClubMemberId), linkIsLive(today)));
  return row && wardStillInScope(row.ward, today) ? row : null;
}

/** The ward of a guardian route: the caller's live link in this club, else 404 (never 403: no oracle for foreign children). */
export async function requireWard(userId: string, clubId: string, wardId: string): Promise<WardLink> {
  const [found] = await activeWardLinks(userId, { clubId, wardId });
  if (!found) throw new NotFoundError("Ward not found");
  return found;
}

/** Ids among `wardIds` the account membership is a live guardian of (photo rules and similar read paths). */
export async function liveWardIds(guardianAccountMemberId: string, wardIds: string[]): Promise<Set<string>> {
  if (wardIds.length === 0) return new Set();
  const today = todayBerlin();
  const rows = await db
    .select({ ward: clubMembers })
    .from(guardianLinks)
    .innerJoin(member, eq(member.id, guardianLinks.guardianMemberId))
    .innerJoin(clubMembers, and(eq(clubMembers.id, guardianLinks.wardClubMemberId), eq(clubMembers.clubId, member.organizationId)))
    .where(and(eq(guardianLinks.guardianMemberId, guardianAccountMemberId), inArray(guardianLinks.wardClubMemberId, wardIds), linkIsLive(today)));
  return new Set(rows.filter((r) => wardStillInScope(r.ward, today)).map((r) => r.ward.id));
}
