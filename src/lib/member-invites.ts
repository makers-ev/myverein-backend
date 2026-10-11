/**
 * Linking an account to a member without account by e-mail invitation (Wave 7 B4, ADR-003), and the reverse
 * (`unlinkAccount`). Tokens: 32 random bytes (base64url) that only exist in the mail; the database holds the HMAC-SHA256
 * (keyed with BETTER_AUTH_SECRET) -- a leaked table cannot be used to accept anything. Single use, TTL
 * `MEMBER_INVITE_TTL_DAYS` (default 14). Rules and responses: README "Account linking".
 */
import { createHmac, randomBytes } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { auth } from "../auth/auth.js";
import { member, session } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberInvites, type ClubMemberInviteRow } from "../db/schema/club-member-invites.js";
import { clubMembers, clubMemberStatusHistory, type ClubMemberRow } from "../db/schema/club-members.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { locationKeyHolders, locations } from "../db/schema/locations.js";
import { assertRejoinAllowed, type DbExecutor } from "./club-members.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError } from "./errors.js";
import { inviteLinkContext } from "./invite-context.js";
import { logger } from "./logger.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/** Invitation validity in days (`MEMBER_INVITE_TTL_DAYS`, default 14, clamped to 1-60). */
export function inviteTtlDays(): number {
  const configured = Number(process.env.MEMBER_INVITE_TTL_DAYS);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(Math.floor(configured), 60) : 14;
}

export function hashInviteToken(token: string): string {
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "").update(token).digest("hex");
}

/** "Max Mustermann" -> "Max M."; a single name -> "M***". Enough for the invitee to recognise themself. */
export function maskName(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  if (!first) return "***";
  if (rest.length === 0) return `${first.charAt(0)}***`;
  return `${first} ${rest.map((part) => `${part.charAt(0)}.`).join(" ")}`;
}

/** "max.muster@example.com" -> "m***@example.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email.charAt(0)}***${email.slice(at)}`;
}

const NOT_FOUND_MESSAGE = "Invitation not found or expired";

/** Replaces any open invite of the member by a new one. Returns the row and the plain token (to be mailed, never stored). */
export async function createInvite(clubId: string, clubMemberId: string, email: string, createdBy: string): Promise<{ invite: ClubMemberInviteRow; token: string }> {
  const token = randomBytes(32).toString("base64url");
  const invite = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId))).for("update");
    if (!row) throw new NotFoundError("Member not found");
    if (row.memberId) throw new ConflictError("Member already has an account");
    if (isLeftStatus(effectiveStatus(row, todayBerlin()))) throw new ConflictError("Member has left the club");

    await tx.delete(clubMemberInvites).where(and(eq(clubMemberInvites.clubMemberId, row.id), isNull(clubMemberInvites.acceptedAt)));
    const [created] = await tx
      .insert(clubMemberInvites)
      .values({ clubMemberId: row.id, email, tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + inviteTtlDays() * 86_400_000), createdBy })
      .returning();
    await tx.insert(auditLog).values({
      eventType: "club_member.invite",
      subjectId: row.id,
      // No e-mail address in the audit log.
      payload: { clubId, inviteId: created!.id, expiresAt: created!.expiresAt.toISOString(), createdBy },
    });
    return created!;
  });
  return { invite, token };
}

async function findUsableInvite(token: string): Promise<{ invite: ClubMemberInviteRow; row: ClubMemberRow }> {
  const invite = await db.query.clubMemberInvites.findFirst({ where: eq(clubMemberInvites.tokenHash, hashInviteToken(token)) });
  if (!invite || invite.acceptedAt || invite.expiresAt.getTime() <= Date.now()) throw new NotFoundError(NOT_FOUND_MESSAGE);
  const row = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, invite.clubMemberId) });
  if (!row || row.memberId !== null || isLeftStatus(effectiveStatus(row, todayBerlin()))) throw new NotFoundError(NOT_FOUND_MESSAGE);
  return { invite, row };
}

/** What the invitee sees before confirming. 404 for unknown / expired / used tokens (indistinguishable). */
export async function previewInvite(token: string, accountEmail: string) {
  const { invite, row } = await findUsableInvite(token);
  const club = await db.query.organization.findFirst({ where: (o, { eq: same }) => same(o.id, row.clubId) });
  return {
    clubId: row.clubId,
    clubName: club?.name ?? null,
    memberName: maskName(row.displayName),
    invitedEmail: maskEmail(invite.email),
    emailMatches: invite.email.toLowerCase() === accountEmail.toLowerCase(),
    expiresAt: invite.expiresAt,
  };
}

interface AcceptingUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Accepts an invitation for the signed-in account. Order of checks: token (404) -> the account is not yet a member of
 * the club (409 `merge_not_supported`) -> verified account e-mail equals the invited address (403) -> not blocked from
 * re-joining (409). The token is CLAIMED atomically before anything is created (`UPDATE ... WHERE accepted_at IS NULL`),
 * so two parallel accepts cannot both succeed; a failure after the claim releases it again and removes what was created.
 */
export async function acceptInvite(token: string, account: AcceptingUser): Promise<{ clubId: string; clubName: string | null; clubMemberId: string; memberId: string }> {
  const { invite, row } = await findUsableInvite(token);
  // Accepts of ONE account in ONE club run one after the other, so two parallel accepts (e.g. two invitations to the same
  // address) deterministically end with the first linked and the second refused as "already a member" (single replica).
  return serialized(`${row.clubId}:${account.id}`, () => acceptClaimed(invite, row, account));
}

const tails = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(work);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

async function acceptClaimed(invite: ClubMemberInviteRow, row: ClubMemberRow, account: AcceptingUser): Promise<{ clubId: string; clubName: string | null; clubMemberId: string; memberId: string }> {
  const clubId = row.clubId;

  const existing = await db.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, account.id)) });
  if (existing) {
    throw new ConflictError("This account is already a member of the club; merging accounts with members is not supported", { details: { code: "merge_not_supported" } });
  }
  if (!account.emailVerified || invite.email.toLowerCase() !== account.email.toLowerCase()) {
    throw new ForbiddenError("The invitation was issued for a different (or an unverified) e-mail address");
  }
  await assertRejoinAllowed(db, clubId, account.id);

  const [claimed] = await db
    .update(clubMemberInvites)
    .set({ acceptedAt: new Date() })
    .where(and(eq(clubMemberInvites.id, invite.id), isNull(clubMemberInvites.acceptedAt), gt(clubMemberInvites.expiresAt, new Date())))
    .returning();
  if (!claimed) throw new NotFoundError(NOT_FOUND_MESSAGE);

  const release = () => db.update(clubMemberInvites).set({ acceptedAt: null }).where(eq(clubMemberInvites.id, invite.id)).catch((err) => logger.error({ err, inviteId: invite.id }, "[invites] could not release a claimed invite"));

  let created: Awaited<ReturnType<typeof auth.api.addMember>>;
  try {
    // The hook skips ensureClubMember inside this context: the invited row is linked below instead.
    created = await inviteLinkContext.run({ clubMemberId: row.id }, () => auth.api.addMember({ body: { userId: account.id, organizationId: clubId, role: "member" } }));
  } catch (err) {
    await release();
    if (err instanceof ConflictError || err instanceof ForbiddenError) throw err;
    const nowMember = await db.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, account.id)) });
    if (nowMember) throw new ConflictError("This account is already a member of the club; merging accounts with members is not supported", { details: { code: "merge_not_supported" } });
    throw err;
  }
  if (!created) {
    await release();
    throw new ConflictError("Could not create the club membership");
  }

  try {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(clubMembers).where(eq(clubMembers.id, row.id)).for("update");
      if (!locked || locked.memberId !== null) throw new ConflictError("Member already has an account");

      // Two parallel accepts of the same account (two invitations) must end with ONE account membership in the club.
      const accountMemberships = await tx.select({ id: member.id }).from(member).where(and(eq(member.organizationId, clubId), eq(member.userId, account.id)));
      if (accountMemberships.length > 1) throw new ConflictError("This account is already a member of the club; merging accounts with members is not supported", { details: { code: "merge_not_supported" } });

      await tx
        .update(clubMembers)
        .set({ memberId: created.id, lastUserId: account.id, accountUnlinkedAt: null, contactEmail: locked.contactEmail ?? account.email, updatedAt: new Date() })
        .where(and(eq(clubMembers.id, locked.id), isNull(clubMembers.memberId)));
      await tx.insert(clubMemberStatusHistory).values({
        clubMemberId: locked.id,
        fromStatus: locked.status,
        toStatus: locked.status,
        fromCategoryId: locked.categoryId,
        toCategoryId: locked.categoryId,
        effectiveOn: todayBerlin(),
        reason: "Konto verknüpft (Einladung)",
        changedBy: created.id,
      });
      await tx.insert(auditLog).values({
        eventType: "club_member.invite_accept",
        subjectId: locked.id,
        payload: { clubId, inviteId: invite.id, memberId: created.id, userId: account.id },
      });
    });
  } catch (err) {
    // Compensate: no half-linked state (account membership without link, invite burnt).
    await db.delete(member).where(eq(member.id, created.id)).catch((cleanupErr) => logger.error({ err: cleanupErr, memberId: created.id }, "[invites] could not remove membership after a failed link"));
    await release();
    if (isUniqueViolation(err)) throw new ConflictError("Member already has an account");
    throw err;
  }

  const club = await db.query.organization.findFirst({ where: (o, { eq: same }) => same(o.id, clubId) });
  return { clubId, clubName: club?.name ?? null, clubMemberId: row.id, memberId: created.id };
}

/** Open loans and key holder entries of an account in a club (they disappear with the account membership). */
async function openItemsOf(tx: DbExecutor, clubId: string, accountMemberId: string): Promise<{ openLoans: number; keys: number }> {
  const [loans] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(inventoryLoans)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLoans.itemId))
    .where(and(eq(inventoryLoans.memberId, accountMemberId), eq(inventoryItems.clubId, clubId), isNull(inventoryLoans.returnedAt)));
  const [keys] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(locationKeyHolders)
    .innerJoin(locations, eq(locations.id, locationKeyHolders.locationId))
    .where(and(eq(locationKeyHolders.memberId, accountMemberId), eq(locations.clubId, clubId)));
  return { openLoans: loans?.n ?? 0, keys: keys?.n ?? 0 };
}

/**
 * Detaches the account from a member (board action). The club_members row stays with its status and `last_user_id`, the
 * member simply has no account afterwards -- this is NOT an exit: `account_unlinked_at` keeps `markDetachedMembersLeft`
 * from closing the row and keeps a later re-join of the same person from reusing it.
 *
 * Better Auth's own `removeMember` endpoint needs an org owner/admin session and fires `afterRemoveMember`, so the
 * account membership row is deleted here directly, in the same transaction (roles, loans, key holder entries and RSVPs
 * of the account go with it via their foreign keys, exactly like `removeMember`). Refuses (409) the caller's own
 * account, an owner account, and -- unless `force` -- an account with open loans / keys.
 */
export async function unlinkAccount(clubId: string, clubMemberId: string, actorMemberId: string, force: boolean): Promise<ClubMemberRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId))).for("update");
    if (!row) throw new NotFoundError("Member not found");
    if (!row.memberId) throw new ConflictError("Member has no account");
    if (row.memberId === actorMemberId) throw new ConflictError("You cannot unlink your own account");

    const account = await tx.query.member.findFirst({ where: eq(member.id, row.memberId) });
    if (!account) throw new ConflictError("Member has no account");
    if (account.role.split(",").map((r) => r.trim()).includes("owner")) throw new ConflictError("The owner account cannot be unlinked");

    const open = await openItemsOf(tx, clubId, account.id);
    if (!force && (open.openLoans > 0 || open.keys > 0)) {
      throw new ConflictError("The account still has open loans or keys; return them first or repeat with force", { details: { code: "account_has_open_items", ...open } });
    }

    const [updated] = await tx.update(clubMembers).set({ accountUnlinkedAt: new Date(), updatedAt: new Date() }).where(eq(clubMembers.id, row.id)).returning();
    await tx.delete(member).where(eq(member.id, account.id));
    await tx.update(session).set({ activeOrganizationId: null }).where(and(eq(session.userId, account.userId), eq(session.activeOrganizationId, clubId)));
    await tx.insert(clubMemberStatusHistory).values({
      clubMemberId: row.id,
      fromStatus: row.status,
      toStatus: row.status,
      fromCategoryId: row.categoryId,
      toCategoryId: row.categoryId,
      effectiveOn: todayBerlin(),
      reason: "Konto-Verknüpfung getrennt",
      changedBy: actorMemberId,
    });
    await tx.insert(auditLog).values({
      eventType: "club_member.unlink",
      subjectId: row.id,
      payload: { clubId, accountMemberId: account.id, userId: account.userId, changedBy: actorMemberId, forced: force, ...open },
    });
    return { ...updated!, memberId: null };
  });
}
