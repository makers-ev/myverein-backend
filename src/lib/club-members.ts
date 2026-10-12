import { and, asc, eq, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers, clubMemberStatusHistory, LEFT_STATUSES, memberCategories, type ClubMemberRow, type MemberCategoryRow } from "../db/schema/club-members.js";
import { todayBerlin } from "./member-lifecycle.js";
import { nextMemberNumber } from "./member-number.js";
import { ConflictError, NotFoundError } from "./errors.js";

/** Either the pool-backed `db` or a transaction handle -- both expose the same query API. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type MemberAccountRow = Pick<typeof member.$inferSelect, "id" | "organizationId" | "userId" | "createdAt">;

/** The five categories every club gets (Wave 7 B2). Names are German UI labels; `key` is the stable identifier. */
export const DEFAULT_CATEGORIES = [
  { key: "aktiv", name: "Aktiv", votingRight: true, applicantSelectable: true, sortOrder: 0 },
  { key: "passiv", name: "Passiv", votingRight: true, applicantSelectable: true, sortOrder: 1 },
  { key: "foerdernd", name: "Fördernd", votingRight: false, applicantSelectable: true, sortOrder: 2 },
  { key: "ehrenmitglied", name: "Ehrenmitglied", votingRight: true, applicantSelectable: false, sortOrder: 3 },
  { key: "jugend", name: "Jugend", votingRight: false, applicantSelectable: true, sortOrder: 4 },
] as const;

export const DEFAULT_CATEGORY_KEY = "aktiv";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Key of the advisory lock that serialises "link an invited account" with the repair paths of `ensureClubMember`. */
export const accountLinkLockKey = (clubId: string, userId: string) => `account-link:${clubId}:${userId}`;

/** Idempotently creates the five default categories for a club (existing keys are left untouched). */
export async function ensureDefaultCategories(clubId: string, executor: DbExecutor = db): Promise<void> {
  await executor
    .insert(memberCategories)
    .values(DEFAULT_CATEGORIES.map((c) => ({ clubId, ...c })))
    .onConflictDoNothing({ target: [memberCategories.clubId, memberCategories.key] });
}

/** Category row of a club by key, or null. */
export async function findCategoryByKey(executor: DbExecutor, clubId: string, key: string): Promise<MemberCategoryRow | null> {
  const row = await executor.query.memberCategories.findFirst({
    where: and(eq(memberCategories.clubId, clubId), eq(memberCategories.key, key.trim().toLowerCase())),
  });
  return row ?? null;
}

export interface EnsureClubMemberDefaults {
  /** Category key for a newly created row; unknown keys fall back to "aktiv". */
  categoryKey?: string;
  birthDate?: string | null;
  /** ISO date; defaults to the day the account membership was created. */
  joinedAt?: string;
  memberNumber?: string | null;
  /** Account user, if the caller already has it (saves one query). */
  user?: { name: string; email: string };
}

/** Statuses a plain account re-join must never undo (only an explicit board `reopen` transition can). */
const NO_AUTO_REJOIN_STATUSES = ["ausgeschlossen", "verstorben"];

/**
 * A person who was excluded (`ausgeschlossen`) or marked deceased (`verstorben`) in this club cannot come back by
 * re-joining with the same account (application approval, invitation, addMember): the board has to reopen the member
 * first (`POST /club-members/:id/transition` with `reopen`). Throws 409.
 */
export async function assertRejoinAllowed(executor: DbExecutor, clubId: string, userId: string): Promise<void> {
  const blocked = await executor.query.clubMembers.findFirst({
    where: and(eq(clubMembers.clubId, clubId), eq(clubMembers.lastUserId, userId), isNull(clubMembers.memberId), inArray(clubMembers.status, NO_AUTO_REJOIN_STATUSES)),
  });
  if (blocked) {
    throw new ConflictError("This person was excluded from the club or is marked deceased; the member must be reopened by the board before re-joining", {
      details: { code: "member_rejoin_blocked", clubMemberId: blocked.id, status: blocked.status },
    });
  }
}

/**
 * Guarantees the invariant "every account member has exactly one club_members
 * row" (ADR-003). Returns the existing row untouched if there is one;
 * otherwise creates it (display name from `user.name`, contact e-mail from
 * `user.email`, automatic member number, default category). Safe to call
 * repeatedly and concurrently (unique `member_id`); runs in a (nested)
 * transaction so the member number allocation stays atomic.
 */
export async function ensureClubMember(executor: DbExecutor, memberRow: MemberAccountRow, defaults: EnsureClubMemberDefaults = {}): Promise<ClubMemberRow> {
  const existing = await executor.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, memberRow.id) });
  if (existing) return existing;

  return executor.transaction(async (tx) => {
    // Waits while an invitation is being accepted for this account (lib/member-invites.ts holds the same lock between
    // addMember and the link), then re-reads: the linked row is found instead of a second one being created.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${accountLinkLockKey(memberRow.organizationId, memberRow.userId)}, 0))`);
    const raced = await tx.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, memberRow.id) });
    if (raced) return raced;

    const account = defaults.user ?? (await tx.query.user.findFirst({ where: eq(user.id, memberRow.userId) }));
    if (!account) throw new NotFoundError("User not found");

    await assertRejoinAllowed(tx, memberRow.organizationId, memberRow.userId);

    // Re-join of a person whose account membership was removed earlier: reuse the old row (same member number and
    // history) instead of creating a duplicate.
    const detached = await tx.query.clubMembers.findFirst({
      // A row the board deliberately unlinked (account_unlinked_at) is not reused: the person starts as a new member.
      where: and(eq(clubMembers.clubId, memberRow.organizationId), eq(clubMembers.lastUserId, memberRow.userId), isNull(clubMembers.memberId), isNull(clubMembers.accountUnlinkedAt)),
      orderBy: (t, { desc }) => [desc(t.updatedAt)],
    });
    if (detached) {
      const [relinked] = await tx
        .update(clubMembers)
        .set({ memberId: memberRow.id, status: "aktiv", leftAt: null, exitReason: null, updatedAt: new Date() })
        .where(and(eq(clubMembers.id, detached.id), isNull(clubMembers.memberId)))
        .returning();
      if (relinked) {
        await tx.insert(clubMemberStatusHistory).values({
          clubMemberId: relinked.id,
          fromStatus: detached.status,
          toStatus: "aktiv",
          fromCategoryId: detached.categoryId,
          toCategoryId: detached.categoryId,
          effectiveOn: todayBerlin(),
          reason: "Konto-Mitgliedschaft wiederhergestellt",
        });
        return relinked;
      }
    }

    await ensureDefaultCategories(memberRow.organizationId, tx);
    const requested = defaults.categoryKey ? await findCategoryByKey(tx, memberRow.organizationId, defaults.categoryKey) : null;
    // An archived category is never assigned to new members; unknown/archived keys fall back to the default.
    const category = requested && !requested.archivedAt ? requested : await findCategoryByKey(tx, memberRow.organizationId, DEFAULT_CATEGORY_KEY);

    const memberNumber = defaults.memberNumber === undefined ? await nextMemberNumber(tx, memberRow.organizationId) : defaults.memberNumber;

    const [created] = await tx
      .insert(clubMembers)
      .values({
        clubId: memberRow.organizationId,
        memberId: memberRow.id,
        lastUserId: memberRow.userId,
        displayName: account.name,
        contactEmail: account.email,
        birthDate: defaults.birthDate ?? null,
        memberNumber,
        categoryId: category?.id ?? null,
        status: "aktiv",
        joinedAt: defaults.joinedAt ?? memberRow.createdAt.toISOString().slice(0, 10),
      })
      .onConflictDoNothing({ target: clubMembers.memberId })
      .returning();
    if (created) return created;

    const winner = await tx.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, memberRow.id) });
    if (!winner) throw new Error("club_members row could neither be created nor found");
    return winner;
  });
}

/**
 * Resolves the `:id` of `/club-members/:id` within one club. The canonical id is `club_members.id` (uuid); an id
 * that is not a uuid is resolved as `member.id` for the transition period (ADR-003). Always scoped to `clubId`, so a
 * foreign club's id yields the same 404 as an unknown one.
 */
export async function resolveClubMember(clubId: string, idParam: string, executor: DbExecutor = db): Promise<ClubMemberRow> {
  let row: ClubMemberRow | undefined;
  if (isUuid(idParam)) {
    row = await executor.query.clubMembers.findFirst({ where: and(eq(clubMembers.id, idParam), eq(clubMembers.clubId, clubId)) });
  } else {
    row = await executor.query.clubMembers.findFirst({ where: and(eq(clubMembers.memberId, idParam), eq(clubMembers.clubId, clubId)) });
    if (!row) {
      // Repair: an account member of THIS club whose club_members row is missing (a join path bypassed the hook).
      const account = await executor.query.member.findFirst({ where: and(eq(member.id, idParam), eq(member.organizationId, clubId)) });
      if (account) row = await ensureClubMember(executor, account);
    }
  }
  if (!row) throw new NotFoundError("Member not found");
  // A row whose account membership was removed meanwhile (leave / user deletion do not fire a hook) is closed lazily.
  if (row.memberId === null && row.lastUserId !== null && row.accountUnlinkedAt === null && !LEFT_STATUSES.includes(row.status as never)) {
    await markDetachedMembersLeft(executor, clubId);
    row = (await executor.query.clubMembers.findFirst({ where: eq(clubMembers.id, row.id) })) ?? row;
  }
  return row;
}

/**
 * Closes club_members rows whose account membership no longer exists (removed, left, or the user was deleted; NOT a
 * deliberate board unlink, see `accountUnlinkedAt`):
 * status `ausgetreten`, `left_at` today, reason + history entry. Rows that never had an account (`last_user_id IS NULL`,
 * e.g. children created by the board) are untouched. Idempotent; returns the number of rows closed.
 */
export async function markDetachedMembersLeft(executor: DbExecutor, clubId?: string): Promise<number> {
  return executor.transaction(async (tx) => {
    const today = todayBerlin();
    const stale = await tx
      .select({ id: clubMembers.id, status: clubMembers.status, categoryId: clubMembers.categoryId })
      .from(clubMembers)
      .where(
        and(
          isNull(clubMembers.memberId),
          isNotNull(clubMembers.lastUserId),
          // A deliberate unlink (POST /club-members/:id/unlink) is not an exit.
          isNull(clubMembers.accountUnlinkedAt),
          notInArray(clubMembers.status, [...LEFT_STATUSES]),
          clubId ? eq(clubMembers.clubId, clubId) : undefined,
        ),
      )
      .orderBy(asc(clubMembers.id))
      .for("update");
    if (stale.length === 0) return 0;
    await tx
      .update(clubMembers)
      .set({ status: "ausgetreten", leftAt: today, exitReason: DETACHED_REASON, updatedAt: new Date() })
      .where(inArray(clubMembers.id, stale.map((r) => r.id)));
    await tx.insert(clubMemberStatusHistory).values(
      stale.map((r) => ({ clubMemberId: r.id, fromStatus: r.status, toStatus: "ausgetreten", fromCategoryId: r.categoryId, toCategoryId: r.categoryId, effectiveOn: today, reason: DETACHED_REASON })),
    );
    const closed = stale;
    return closed.length;
  });
}

export const DETACHED_REASON = "Konto-Mitgliedschaft entfernt";

/** Per club: account members vs. club_members rows linked to an account. `missing` must be 0 (operational check). */
export async function checkClubMemberConsistency(executor: DbExecutor, clubId?: string): Promise<Array<{ clubId: string; members: number; linked: number; missing: number }>> {
  const result = await executor.execute<{ club_id: string; members: string; linked: string }>(sql`
    SELECT m.organization_id AS club_id, count(*)::text AS members, count(cm.id)::text AS linked
    FROM member m
    LEFT JOIN club_members cm ON cm.member_id = m.id
    ${clubId ? sql`WHERE m.organization_id = ${clubId}` : sql``}
    GROUP BY m.organization_id
    ORDER BY m.organization_id`);
  return result.rows.map((r) => ({ clubId: r.club_id, members: Number(r.members), linked: Number(r.linked), missing: Number(r.members) - Number(r.linked) }));
}

/**
 * True if another club_members row of the club already carries `memberNumber`. Locks the club's organization row so
 * two concurrent writers can't both pass the check (the DB column is deliberately not unique, see schema).
 */
export async function memberNumberTaken(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], clubId: string, memberNumber: string, exceptId?: string): Promise<boolean> {
  await tx.execute(sql`SELECT 1 FROM organization WHERE id = ${clubId} FOR UPDATE`);
  const rows = await tx
    .select({ id: clubMembers.id })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.memberNumber, memberNumber)))
    .limit(2);
  return rows.some((r) => r.id !== exceptId);
}
