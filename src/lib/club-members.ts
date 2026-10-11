import { and, eq, sql } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers, memberCategories, type ClubMemberRow, type MemberCategoryRow } from "../db/schema/club-members.js";
import { nextMemberNumber } from "./member-number.js";
import { NotFoundError } from "./errors.js";

/** Either the pool-backed `db` or a transaction handle -- both expose the same query API. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type MemberAccountRow = Pick<typeof member.$inferSelect, "id" | "organizationId" | "userId" | "createdAt">;

/** The five categories every club gets (Wave 7 B2). Names are German UI labels; `key` is the stable identifier. */
export const DEFAULT_CATEGORIES = [
  { key: "aktiv", name: "Aktiv", votingRight: true, sortOrder: 0 },
  { key: "passiv", name: "Passiv", votingRight: true, sortOrder: 1 },
  { key: "foerdernd", name: "Fördernd", votingRight: false, sortOrder: 2 },
  { key: "ehrenmitglied", name: "Ehrenmitglied", votingRight: true, sortOrder: 3 },
  { key: "jugend", name: "Jugend", votingRight: false, sortOrder: 4 },
] as const;

export const DEFAULT_CATEGORY_KEY = "aktiv";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

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
    const raced = await tx.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, memberRow.id) });
    if (raced) return raced;

    const account = defaults.user ?? (await tx.query.user.findFirst({ where: eq(user.id, memberRow.userId) }));
    if (!account) throw new NotFoundError("User not found");

    await ensureDefaultCategories(memberRow.organizationId, tx);
    const category =
      (defaults.categoryKey ? await findCategoryByKey(tx, memberRow.organizationId, defaults.categoryKey) : null) ??
      (await findCategoryByKey(tx, memberRow.organizationId, DEFAULT_CATEGORY_KEY));

    const memberNumber = defaults.memberNumber === undefined ? await nextMemberNumber(tx, memberRow.organizationId) : defaults.memberNumber;

    const [created] = await tx
      .insert(clubMembers)
      .values({
        clubId: memberRow.organizationId,
        memberId: memberRow.id,
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
  }
  if (!row) throw new NotFoundError("Member not found");
  return row;
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
