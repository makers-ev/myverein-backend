import { and, eq, inArray } from "drizzle-orm";

import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import type { DbExecutor } from "./club-members.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Helpers for the member references of meetings (Wave 11). Invitees, attendance, proxies and the voting roll point at
 * `club_members.id` (also members without an account); the API still accepts the account membership id as `memberId`
 * for the transition period.
 */

/** `club_members.id` of the caller's account membership (`member.id`) in a club; null while there is none. */
export async function callerClubMemberId(executor: DbExecutor, clubId: string, accountMemberId: string): Promise<string | null> {
  const row = await executor.query.clubMembers.findFirst({ where: and(eq(clubMembers.clubId, clubId), eq(clubMembers.memberId, accountMemberId)), columns: { id: true } });
  return row?.id ?? null;
}

export interface MemberRef {
  clubMemberId?: string | undefined;
  /** Legacy alias: the account membership id (`member.id`). */
  memberId?: string | undefined;
}

/** A member of the club by either reference; null when unknown, from another club or no longer a member. */
export async function resolveClubMember(executor: DbExecutor, clubId: string, ref: MemberRef): Promise<ClubMemberRow | null> {
  const where = ref.clubMemberId ? eq(clubMembers.id, ref.clubMemberId) : ref.memberId ? eq(clubMembers.memberId, ref.memberId) : undefined;
  if (!where) return null;
  const row = await executor.query.clubMembers.findFirst({ where: and(eq(clubMembers.clubId, clubId), where) });
  if (!row || isLeftStatus(effectiveStatus(row, todayBerlin()))) return null;
  return row;
}

/** Several members of the club at once (unknown ids are simply missing in the result). */
export async function clubMembersByIds(executor: DbExecutor, clubId: string, ids: readonly string[]): Promise<Map<string, ClubMemberRow>> {
  if (ids.length === 0) return new Map();
  const rows = await executor.select().from(clubMembers).where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r]));
}
