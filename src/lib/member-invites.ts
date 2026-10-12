/**
 * Linking an account to a member without account by e-mail invitation (Wave 7 B4, ADR-003), and the reverse
 * (`unlinkAccount`). Tokens: 32 random bytes (base64url) that only exist in the mail; the database holds the HMAC-SHA256
 * (keyed with BETTER_AUTH_SECRET) -- a leaked table cannot be used to accept anything. Single use, TTL
 * `MEMBER_INVITE_TTL_DAYS` (default 14). Rules and responses: README "Account linking".
 */
import { createHmac, randomBytes } from "node:crypto";

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { auth } from "../auth/auth.js";
import { member, session, user } from "../auth/auth-schema.js";
import { db, pool } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberInvites, type ClubMemberInviteRow } from "../db/schema/club-member-invites.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { calendars } from "../db/schema/calendars.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubExitRequests } from "../db/schema/club-exit-requests.js";
import { formSubmissions, memberFieldValues } from "../db/schema/forms.js";
import { sendEmail } from "./email.js";
import { APP_NAME, buildMemberLinkedEmail, LOGO_CID, LOGO_PATH, SITE_URL } from "./emailTemplate.js";
import { meetingInvitees, meetings } from "../db/schema/meetings.js";
import { clubMemberDepartments, clubMembers, clubMemberStatusHistory, type ClubMemberRow } from "../db/schema/club-members.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { recordKeyReturnsForRemovedAccount } from "./key-returns.js";
import { locationKeyHolders, locations } from "../db/schema/locations.js";
import { accountLinkLockKey, assertRejoinAllowed, type DbExecutor } from "./club-members.js";
import { hasClubPermission, IMPLICIT_ROLE_TYPE } from "./club-permissions.js";
import { isOwnerRole } from "./member-protection.js";
import { BOARD_ROLE_TYPES } from "./club-permissions.js";
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
  return createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(token).digest("hex");
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
 * Accepts an invitation for the signed-in account. Order of checks: token (404) -> verified account e-mail equals the
 * invited address (403) -> not blocked from re-joining (409) -> either link (account is no member yet) or merge the
 * account's own untouched row into the invited one (409 `merge_conflict` otherwise). The token is CLAIMED atomically before anything is created (`UPDATE ... WHERE accepted_at IS NULL`),
 * so two parallel accepts cannot both succeed; a failure after the claim releases it again and removes what was created.
 */
export type AcceptResult = { clubId: string; clubName: string | null; clubMemberId: string; memberId: string; merged: boolean };

export async function acceptInvite(token: string, account: AcceptingUser): Promise<AcceptResult> {
  const { invite, row } = await findUsableInvite(token);
  // Accepts of ONE account in ONE club run one after the other, so two parallel accepts (e.g. two invitations to the same
  // address) deterministically end with the first linked and the second refused as "already a member" (single replica).
  return serialized(`${row.clubId}:${account.id}`, async () => {
    // Session-level advisory lock per (club, account) around addMember + link: the repair paths (ensureClubMember, taken
    // by GET /club-members, id resolution, ...) take the same lock and so cannot create a competing club_members row
    // for the new account membership while it is not linked yet.
    const lockClient = await pool.connect();
    try {
      await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [accountLinkLockKey(row.clubId, account.id)]);
      const result = await acceptClaimed(invite, row, account);
      await notifyInviter(invite, row, result.clubName, account.id);
      return result;
    } finally {
      await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [accountLinkLockKey(row.clubId, account.id)]).catch(() => undefined);
      lockClient.release();
    }
  });
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

async function acceptClaimed(invite: ClubMemberInviteRow, row: ClubMemberRow, account: AcceptingUser): Promise<AcceptResult> {
  const clubId = row.clubId;

  // The e-mail binding comes FIRST: a holder of the token with another account must not learn anything about merge state.
  if (!account.emailVerified || invite.email.toLowerCase() !== account.email.toLowerCase()) {
    throw new ForbiddenError("The invitation was issued for a different (or an unverified) e-mail address");
  }
  await assertRejoinAllowed(db, clubId, account.id);

  const existing = await db.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, account.id)) });
  if (existing) return mergeIntoInvitedRow(invite, row, account, existing);

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
    if (nowMember) throw new ConflictError("This account is already a member of the club", { details: { code: "already_member" } });
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
      if (accountMemberships.length > 1) throw new ConflictError("This account is already a member of the club", { details: { code: "already_member" } });

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
  return { clubId, clubName: club?.name ?? null, clubMemberId: row.id, memberId: created.id, merged: false };
}

const PROFILE_FIELDS = ["firstName", "lastName", "birthDate", "street", "postalCode", "city", "phone", "emergencyContactName", "emergencyContactPhone"] as const;
const isEmpty = (value: string | null | undefined) => value === null || value === undefined || value.trim() === "";

/**
 * The accepting account already is a member of the club (own `club_members` row, e.g. joined by application before the
 * board created the account-less record). If that own row is "untouched" the account is linked to the INVITED row and
 * the own row is retired, all in ONE transaction; otherwise 409 `merge_conflict` with a non-personal list of conflict
 * kinds (README "Account linking"). Roles, loans, keys, RSVPs hang on the account `member.id`, which does not change.
 */
async function mergeIntoInvitedRow(invite: ClubMemberInviteRow, row: ClubMemberRow, account: AcceptingUser, existing: typeof member.$inferSelect): Promise<AcceptResult> {
  const clubId = row.clubId;
  const result = await db.transaction(async (tx) => {
    const probe = await tx.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, existing.id) });
    // Lock both rows in id order (no deadlock with a concurrent merge in the other direction).
    const ids = [row.id, ...(probe ? [probe.id] : [])];
    const locked = await tx.select().from(clubMembers).where(inArray(clubMembers.id, ids)).orderBy(clubMembers.id).for("update");
    const invited = locked.find((r) => r.id === row.id);
    const own = probe ? locked.find((r) => r.id === probe.id) : undefined;
    if (!invited || invited.memberId !== null) throw new ConflictError("Member already has an account");
    if (own && own.memberId !== existing.id) throw new ConflictError("The account membership changed; try again");
    if (own && own.id === invited.id) throw new ConflictError("Member already has an account");
    if (isLeftStatus(effectiveStatus(invited, todayBerlin()))) throw new NotFoundError(NOT_FOUND_MESSAGE);

    if (own) {
      const [deps, exits, history, ownFields, invitedFields] = await Promise.all([
        tx.select({ n: sql<number>`count(*)::int` }).from(clubMemberDepartments).where(eq(clubMemberDepartments.clubMemberId, own.id)),
        tx.select({ n: sql<number>`count(*)::int` }).from(clubExitRequests).where(eq(clubExitRequests.clubMemberId, own.id)),
        // Creation entries have no from_status; anything else is a real change (or an earlier link/merge).
        tx.select({ n: sql<number>`count(*)::int` }).from(clubMemberStatusHistory).where(and(eq(clubMemberStatusHistory.clubMemberId, own.id), sql`${clubMemberStatusHistory.fromStatus} IS NOT NULL`)),
        tx.select({ fieldId: memberFieldValues.fieldId }).from(memberFieldValues).where(eq(memberFieldValues.clubMemberId, own.id)),
        tx.select({ fieldId: memberFieldValues.fieldId }).from(memberFieldValues).where(eq(memberFieldValues.clubMemberId, invited.id)),
      ]);
      const conflicts: string[] = [];
      if (!isEmpty(own.memberNumber) && !isEmpty(invited.memberNumber) && own.memberNumber !== invited.memberNumber) conflicts.push("member_number");
      if ((deps[0]?.n ?? 0) > 0) conflicts.push("departments");
      if (own.photoKey) conflicts.push("photo");
      if ((history[0]?.n ?? 0) > 0) conflicts.push("status_history");
      if ((exits[0]?.n ?? 0) > 0) conflicts.push("exit_requests");
      const invitedFieldIds = new Set(invitedFields.map((f) => f.fieldId));
      if (ownFields.some((f) => invitedFieldIds.has(f.fieldId))) conflicts.push("custom_fields");
      if (conflicts.length > 0) {
        // Kinds only -- no names, numbers or values of the other row.
        throw new ConflictError("The account already has its own member record with data that cannot be merged automatically; ask the board to resolve it", { details: { code: "merge_conflict", conflicts } });
      }
    }

    const [claimed] = await tx
      .update(clubMemberInvites)
      .set({ acceptedAt: new Date() })
      .where(and(eq(clubMemberInvites.id, invite.id), isNull(clubMemberInvites.acceptedAt), gt(clubMemberInvites.expiresAt, new Date())))
      .returning();
    if (!claimed) throw new NotFoundError(NOT_FOUND_MESSAGE);

    const patch: Partial<typeof clubMembers.$inferInsert> = {};
    if (own) {
      for (const field of PROFILE_FIELDS) if (isEmpty(invited[field]) && !isEmpty(own[field])) (patch as Record<string, unknown>)[field] = own[field];
      if (isEmpty(invited.memberNumber) && !isEmpty(own.memberNumber)) patch.memberNumber = own.memberNumber;
      if (isEmpty(invited.contactEmail) && !isEmpty(own.contactEmail)) patch.contactEmail = own.contactEmail;

      // Repoint everything that references the retired row, then free the unique member_id by deleting it.
      const keptGuardians = await tx.select({ guardianMemberId: guardianLinks.guardianMemberId }).from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, invited.id));
      if (keptGuardians.length > 0) {
        await tx.delete(guardianLinks).where(and(eq(guardianLinks.wardClubMemberId, own.id), inArray(guardianLinks.guardianMemberId, keptGuardians.map((g) => g.guardianMemberId))));
      }
      await tx.update(guardianLinks).set({ wardClubMemberId: invited.id }).where(eq(guardianLinks.wardClubMemberId, own.id));
      await tx.update(clubApplications).set({ clubMemberId: invited.id }).where(eq(clubApplications.clubMemberId, own.id));
      await tx.update(formSubmissions).set({ subjectClubMemberId: invited.id }).where(eq(formSubmissions.subjectClubMemberId, own.id));
      await tx.update(memberFieldValues).set({ clubMemberId: invited.id }).where(eq(memberFieldValues.clubMemberId, own.id));
      await tx.insert(auditLog).values({
        eventType: "club_member.merge",
        subjectId: invited.id,
        // Ids only: the retired row is gone afterwards, this is the trace.
        payload: { clubId, keptClubMemberId: invited.id, retiredClubMemberId: own.id, memberId: existing.id, userId: account.id, inviteId: invite.id },
      });
      await tx.delete(clubMembers).where(eq(clubMembers.id, own.id));
    }

    await tx
      .update(clubMembers)
      .set({ ...patch, memberId: existing.id, lastUserId: account.id, accountUnlinkedAt: null, contactEmail: patch.contactEmail ?? invited.contactEmail ?? account.email, updatedAt: new Date() })
      .where(and(eq(clubMembers.id, invited.id), isNull(clubMembers.memberId)));
    await tx.insert(clubMemberStatusHistory).values({
      clubMemberId: invited.id,
      fromStatus: invited.status,
      toStatus: invited.status,
      fromCategoryId: invited.categoryId,
      toCategoryId: invited.categoryId,
      effectiveOn: todayBerlin(),
      reason: own ? "merged" : "Konto verknüpft (Einladung)",
      changedBy: existing.id,
    });
    await tx.insert(auditLog).values({
      eventType: "club_member.invite_accept",
      subjectId: invited.id,
      payload: { clubId, inviteId: invite.id, memberId: existing.id, userId: account.id, merged: Boolean(own) },
    });
    return { merged: Boolean(own) };
  });

  const club = await db.query.organization.findFirst({ where: (o, { eq: same }) => same(o.id, clubId) });
  return { clubId, clubName: club?.name ?? null, clubMemberId: row.id, memberId: existing.id, merged: result.merged };
}

/**
 * Tells the board member who sent the invitation that the member is now linked. Best effort: never throws, nothing but
 * the member's display name and the club name is mailed (no token, no address, no profile data).
 */
async function notifyInviter(invite: ClubMemberInviteRow, row: ClubMemberRow, clubName: string | null, accountUserId: string): Promise<void> {
  try {
    if (!invite.createdBy) return;
    const inviter = await db.query.member.findFirst({ where: and(eq(member.id, invite.createdBy), eq(member.organizationId, row.clubId)) });
    if (!inviter || inviter.userId === accountUserId) return;
    const inviterUser = await db.query.user.findFirst({ where: eq(user.id, inviter.userId) });
    if (!inviterUser?.email) return;
    const roles = await db.select({ roleType: clubRoles.roleType }).from(clubRoles).where(eq(clubRoles.memberId, inviter.id));
    if (!hasClubPermission([IMPLICIT_ROLE_TYPE, ...roles.map((r) => r.roleType)], "members:write")) return;
    const club = clubName ?? "deinem Verein";
    await sendEmail({
      to: inviterUser.email,
      subject: `${row.displayName.replace(/[\r\n]+/g, " ")} hat ein Konto bei ${APP_NAME} verknüpft`,
      html: buildMemberLinkedEmail({ name: inviterUser.name, memberName: row.displayName, clubName: club, url: `${SITE_URL}` }),
      attachments: [{ filename: "logo.png", path: LOGO_PATH, cid: LOGO_CID }],
    });
  } catch (err) {
    logger.error({ errorName: err instanceof Error ? err.name : "unknown", inviteId: invite.id }, "[invites] inviter notification could not be sent");
  }
}

/** Everything that disappears with the account membership (counts, for the `force` warning). */
async function itemsBoundToAccount(tx: DbExecutor, clubId: string, accountMemberId: string) {
  const count = sql<number>`count(*)::int`;
  const [loans] = await tx
    .select({ n: count })
    .from(inventoryLoans)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLoans.itemId))
    .where(and(eq(inventoryLoans.memberId, accountMemberId), eq(inventoryItems.clubId, clubId), isNull(inventoryLoans.returnedAt)));
  const [keys] = await tx
    .select({ n: count })
    .from(locationKeyHolders)
    .innerJoin(locations, eq(locations.id, locationKeyHolders.locationId))
    .where(and(eq(locationKeyHolders.memberId, accountMemberId), eq(locations.clubId, clubId)));
  const [guardians] = await tx
    .select({ n: count })
    .from(guardianLinks)
    .innerJoin(clubMembers, eq(clubMembers.id, guardianLinks.wardClubMemberId))
    .where(and(eq(guardianLinks.guardianMemberId, accountMemberId), eq(clubMembers.clubId, clubId)));
  const [led] = await tx.select({ n: count }).from(departments).where(and(eq(departments.leadMemberId, accountMemberId), eq(departments.clubId, clubId)));
  const [rsvps] = await tx
    .select({ n: count })
    .from(eventAttendees)
    .innerJoin(events, eq(events.id, eventAttendees.eventId))
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(eq(eventAttendees.memberId, accountMemberId), eq(calendars.clubId, clubId)));
  const [invites] = await tx
    .select({ n: count })
    .from(meetingInvitees)
    .innerJoin(meetings, eq(meetings.id, meetingInvitees.meetingId))
    .where(and(eq(meetingInvitees.memberId, accountMemberId), eq(meetings.clubId, clubId)));
  const roles = await tx.select({ roleType: clubRoles.roleType }).from(clubRoles).where(eq(clubRoles.memberId, accountMemberId));
  return {
    openLoans: loans?.n ?? 0,
    keys: keys?.n ?? 0,
    guardianLinks: guardians?.n ?? 0,
    departmentsLed: led?.n ?? 0,
    eventRsvps: rsvps?.n ?? 0,
    meetingInvites: invites?.n ?? 0,
    roles: roles.length,
    roleTypes: roles.map((r) => r.roleType),
  };
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
export async function unlinkAccount(clubId: string, clubMemberId: string, actorMemberId: string, force: boolean, callerRoleTypes: readonly string[]): Promise<ClubMemberRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId))).for("update");
    if (!row) throw new NotFoundError("Member not found");
    if (!row.memberId) throw new ConflictError("Member has no account");
    if (row.memberId === actorMemberId) throw new ConflictError("You cannot unlink your own account");

    const account = await tx.query.member.findFirst({ where: eq(member.id, row.memberId) });
    if (!account) throw new ConflictError("Member has no account");
    if (isOwnerRole(account.role)) throw new ConflictError("The owner account cannot be unlinked", { details: { code: "owner_protected" } });

    const open = await itemsBoundToAccount(tx, clubId, account.id);
    // Board accounts lose their roles with the link: only a caller with roles:write may do that (not even `force` helps).
    if (open.roleTypes.some((r) => (BOARD_ROLE_TYPES as string[]).includes(r)) && !hasClubPermission(callerRoleTypes, "roles:write")) {
      throw new ForbiddenError("Unlinking a board member requires the roles:write permission", { details: { code: "board_protected" } });
    }
    const { roleTypes: _roleTypes, ...counts } = open;
    void _roleTypes;
    if (!force && Object.values(counts).some((n) => n > 0)) {
      throw new ConflictError("Unlinking deletes loans, key entries, roles, guardian links, led departments, RSVPs and meeting invitations of this account; remove them first or repeat with force", {
        details: { code: "account_has_open_items", ...counts },
      });
    }

    const [updated] = await tx.update(clubMembers).set({ accountUnlinkedAt: new Date(), updatedAt: new Date() }).where(eq(clubMembers.id, row.id)).returning();
    await recordKeyReturnsForRemovedAccount(tx, account.id, actorMemberId);
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
      payload: { clubId, accountMemberId: account.id, userId: account.userId, changedBy: actorMemberId, forced: force, ...counts },
    });
    return { ...updated!, memberId: null };
  });
}
