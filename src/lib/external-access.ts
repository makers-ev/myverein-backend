import { randomBytes } from "node:crypto";

import { and, asc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubExternalInvites, externalAccessAssignments, type ClubExternalInviteRow, type ExternalAccessAssignmentRow } from "../db/schema/external-access.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { locations } from "../db/schema/locations.js";
import { sponsors } from "../db/schema/sponsors.js";
import { writeAudit } from "./audit.js";
import { assertClubNotSuspended } from "./club-platform.js";
import { EXTERNAL_ROLE_TYPES, type ExternalRoleType } from "./club-permissions.js";
import { ensureClubMember, markDetachedMembersLeft } from "./club-members.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { inviteLinkContext } from "./invite-context.js";
import { logger } from "./logger.js";
import { hashInviteToken, inviteTtlDays, maskEmail } from "./member-invites.js";
import { todayBerlin } from "./member-lifecycle.js";

/**
 * External logins (Wave 15 B2): `sponsor` and `dienstleister` are account memberships with `member.role = guest`, NO implicit
 * `mitglied` and NO permission. The boundary is enforced centrally in `clubGuard`: an "external-only" account (a guest whose roles
 * are only external roles) reaches nothing but `EXTERNAL_ALLOWED` (its own view under `/external`, its own profile and in-app
 * messages); every other club route is 403 `external_role_restricted`. So they never see member data, whatever a single route
 * would allow a guest. Invitation tokens work like the member invitation (Wave 7 B4): HMAC in the DB, single use, TTL.
 */

const EXTERNAL_SET: ReadonlySet<string> = new Set(EXTERNAL_ROLE_TYPES);
const EXTERNAL_GUEST_ROLE = "guest" as unknown as "member";

/** True for a guest account whose effective roles are only external roles (sponsor / dienstleister). */
export function isExternalOnly(memberRole: string, roleTypes: readonly string[]): boolean {
  return memberRole === "guest" && roleTypes.length > 0 && roleTypes.every((r) => EXTERNAL_SET.has(r));
}

/** The only club routes an external-only account may call (method + path prefix). Everything else is 403. */
const EXTERNAL_ALLOWED: ReadonlyArray<{ method: string | null; path: string; prefix: boolean }> = [
  { method: null, path: "/external", prefix: true },
  { method: "GET", path: "/club-members/me", prefix: false },
  { method: "GET", path: "/club-inbox", prefix: false },
  { method: "GET", path: "/club-inbox/unread-count", prefix: false },
  { method: "POST", path: "/club-inbox/", prefix: true },
];

export function externalPathAllowed(method: string, path: string): boolean {
  const p = path.replace(/\/+$/, "") || "/";
  return EXTERNAL_ALLOWED.some((rule) => (rule.method === null || rule.method === method) && (rule.prefix ? p === rule.path.replace(/\/$/, "") || p.startsWith(rule.path.endsWith("/") ? rule.path : `${rule.path}/`) : p === rule.path));
}

const NOT_FOUND = "Invitation not found or expired";

export function inviteStatus(row: ClubExternalInviteRow): "pending" | "expired" | "accepted" | "revoked" {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
}

export async function shapeInvites(rows: ClubExternalInviteRow[]) {
  const ids = [...new Set(rows.map((r) => r.sponsorId).filter((v): v is string => !!v))];
  const names = new Map((ids.length ? await db.select({ id: sponsors.id, name: sponsors.name }).from(sponsors).where(inArray(sponsors.id, ids)) : []).map((s) => [s.id, s.name]));
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    roleType: r.roleType,
    displayName: r.displayName,
    sponsor: r.sponsorId && names.has(r.sponsorId) ? { id: r.sponsorId, name: names.get(r.sponsorId)! } : null,
    status: inviteStatus(r),
    expiresAt: r.expiresAt,
    acceptedAt: r.acceptedAt,
    createdAt: r.createdAt,
  }));
}

export async function createExternalInvite(input: { clubId: string; email: string; roleType: ExternalRoleType; displayName: string; sponsorId: string | null; createdBy: string | null }): Promise<{ invite: ClubExternalInviteRow; token: string }> {
  if (input.sponsorId) {
    if (input.roleType !== "sponsor") throw new ValidationError("A sponsor can only be linked to a sponsor login", { details: { code: "sponsor_only_for_sponsor_role" } });
    const [s] = await db.select({ id: sponsors.id }).from(sponsors).where(and(eq(sponsors.id, input.sponsorId), eq(sponsors.clubId, input.clubId)));
    if (!s) throw new ValidationError("Unknown sponsor", { details: { code: "unknown_sponsor" } });
  }
  const token = randomBytes(32).toString("base64url");
  const invite = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(clubExternalInvites)
      .values({ clubId: input.clubId, email: input.email, roleType: input.roleType, displayName: input.displayName, sponsorId: input.roleType === "sponsor" ? input.sponsorId : null, tokenHash: hashInviteToken(token), expiresAt: new Date(Date.now() + inviteTtlDays() * 86_400_000), createdBy: input.createdBy })
      .returning();
    await writeAudit(tx, { eventType: "external_access.invite", subjectId: row!.id, payload: { clubId: input.clubId, inviteId: row!.id, roleType: input.roleType, sponsorId: row!.sponsorId ?? undefined } });
    return row!;
  });
  return { invite, token };
}

async function usableInvite(token: string): Promise<ClubExternalInviteRow> {
  const [row] = await db.select().from(clubExternalInvites).where(eq(clubExternalInvites.tokenHash, hashInviteToken(token)));
  if (!row || inviteStatus(row) !== "pending") throw new NotFoundError(NOT_FOUND, { details: { code: "invite_not_found" } });
  // Wave 15 B7: no new logins for a club suspended by the platform (preview and accept: 403 CLUB_SUSPENDED).
  await assertClubNotSuspended(row.clubId);
  return row;
}

export async function previewExternalInvite(token: string, accountEmail: string) {
  const invite = await usableInvite(token);
  const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, invite.clubId));
  return { clubId: invite.clubId, clubName: club?.name ?? null, roleType: invite.roleType, displayName: invite.displayName, invitedEmail: maskEmail(invite.email), emailMatches: invite.email.toLowerCase() === accountEmail.toLowerCase(), expiresAt: invite.expiresAt };
}

/**
 * Accepts an external invitation for the signed-in account: verified e-mail must match (403), the token is claimed atomically
 * (404 when used/expired/revoked meanwhile), then the account membership (new: `guest`, club_members row `interessent` without a
 * member number, like guardians) gets the external role and -- for a sponsor -- the sponsor link. A failure releases the claim.
 */
export async function acceptExternalInvite(token: string, account: { id: string; email: string; emailVerified: boolean }) {
  const invite = await usableInvite(token);
  if (!account.emailVerified || invite.email.toLowerCase() !== account.email.toLowerCase()) throw new ForbiddenError("The invitation was issued for a different (or an unverified) e-mail address", { details: { code: "invite_email_mismatch" } });
  const [claimed] = await db
    .update(clubExternalInvites)
    .set({ acceptedAt: new Date() })
    .where(and(eq(clubExternalInvites.id, invite.id), isNull(clubExternalInvites.acceptedAt), isNull(clubExternalInvites.revokedAt), gt(clubExternalInvites.expiresAt, new Date())))
    .returning();
  if (!claimed) throw new NotFoundError(NOT_FOUND, { details: { code: "invite_not_found" } });
  const release = () => db.update(clubExternalInvites).set({ acceptedAt: null }).where(eq(clubExternalInvites.id, invite.id)).catch((err) => logger.error({ err, inviteId: invite.id }, "[external-access] could not release a claimed invite"));

  let createdMemberId: string | null = null;
  try {
    let account_ = await db.query.member.findFirst({ where: and(eq(member.organizationId, invite.clubId), eq(member.userId, account.id)) });
    if (!account_) {
      const created = await inviteLinkContext.run({ clubMemberId: "external" }, () => auth.api.addMember({ body: { userId: account.id, organizationId: invite.clubId, role: EXTERNAL_GUEST_ROLE } }));
      if (!created) throw new ConflictError("Could not create the club membership");
      account_ = created as typeof member.$inferSelect;
      createdMemberId = account_.id;
      const own = await ensureClubMember(db, account_, { memberNumber: null });
      if (own.status !== "interessent") {
        await db.update(clubMembers).set({ status: "interessent", updatedAt: new Date() }).where(eq(clubMembers.id, own.id));
        await db.insert(clubMemberStatusHistory).values({ clubMemberId: own.id, fromStatus: null, toStatus: "interessent", toCategoryId: own.categoryId, effectiveOn: todayBerlin(), reason: invite.roleType === "sponsor" ? "Externe Rolle: Sponsor" : "Externe Rolle: Dienstleister" });
      }
    }
    const memberId = account_.id;
    await db.transaction(async (tx) => {
      await tx.insert(clubRoles).values({ memberId, roleType: invite.roleType }).onConflictDoNothing();
      if (invite.sponsorId) await tx.update(sponsors).set({ linkedMemberId: memberId, updatedAt: new Date() }).where(and(eq(sponsors.id, invite.sponsorId), eq(sponsors.clubId, invite.clubId)));
      await tx.update(clubExternalInvites).set({ acceptedMemberId: memberId }).where(eq(clubExternalInvites.id, invite.id));
      await writeAudit(tx, { eventType: "external_access.invite_accept", subjectId: invite.id, clubId: invite.clubId, actorUserId: account.id, payload: { clubId: invite.clubId, inviteId: invite.id, memberId, roleType: invite.roleType, newMembership: createdMemberId !== null } });
    });
    const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, invite.clubId));
    return { clubId: invite.clubId, clubName: club?.name ?? null, memberId, roleType: invite.roleType };
  } catch (err) {
    // Roll back everything this acceptance created: the club_members row first (it would otherwise survive as an orphan
    // `interessent` once the account membership is gone), then the account membership.
    if (createdMemberId) {
      const id = createdMemberId;
      await db.delete(clubMembers).where(eq(clubMembers.memberId, id)).catch((e) => logger.error({ err: e, memberId: id }, "[external-access] could not remove the member row of a failed acceptance"));
      await db.delete(member).where(eq(member.id, id)).catch((e) => logger.error({ err: e, memberId: id }, "[external-access] could not remove the membership of a failed acceptance"));
    }
    await release();
    throw err;
  }
}

/** Whether `memberId` is an account membership of the club holding an external role; returns its roles. */
export async function externalAccount(clubId: string, memberId: string) {
  const row = await db.query.member.findFirst({ where: and(eq(member.id, memberId), eq(member.organizationId, clubId)) });
  if (!row) throw new NotFoundError("Account not found");
  const roles = (await db.select({ roleType: clubRoles.roleType }).from(clubRoles).where(eq(clubRoles.memberId, memberId))).map((r) => r.roleType);
  if (!roles.some((r) => EXTERNAL_SET.has(r))) throw new NotFoundError("Account not found");
  return { member: row, roles };
}

/**
 * Assignment shape. `forSelf` (the external login's own view): an UPCOMING assignment only shows title and window -- location,
 * address and note appear once the window has started (the provider learns the access details only when they are needed).
 */
export async function shapeAssignments(rows: ExternalAccessAssignmentRow[], forSelf = false) {
  const locIds = [...new Set(rows.map((r) => r.locationId).filter((v): v is string => !!v))];
  const locs = new Map((locIds.length ? await db.select({ id: locations.id, name: locations.name, address: locations.address }).from(locations).where(inArray(locations.id, locIds)) : []).map((l) => [l.id, l]));
  const now = Date.now();
  return rows.map((r) => {
    const active = r.validFrom.getTime() <= now && r.validUntil.getTime() > now;
    const hide = forSelf && !active;
    return {
      id: r.id,
      title: r.title,
      note: hide ? null : r.note,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      active,
      location: !hide && r.locationId && locs.has(r.locationId) ? locs.get(r.locationId)! : null,
    };
  });
}

/** Current and upcoming assignments of one account (past ones are not shown). */
export async function currentAssignments(clubId: string, memberId: string, forSelf = false) {
  const rows = await db
    .select()
    .from(externalAccessAssignments)
    .where(and(eq(externalAccessAssignments.clubId, clubId), eq(externalAccessAssignments.memberId, memberId), gte(externalAccessAssignments.validUntil, new Date())))
    .orderBy(asc(externalAccessAssignments.validFrom));
  return shapeAssignments(rows, forSelf);
}

/** The board list of external accounts with roles, linked sponsors and current assignments. */
export async function listExternalAccounts(clubId: string) {
  const rows = await db
    .select({ memberId: member.id, name: user.name, email: user.email, roleType: clubRoles.roleType })
    .from(clubRoles)
    .innerJoin(member, eq(member.id, clubRoles.memberId))
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, clubId), inArray(clubRoles.roleType, [...EXTERNAL_ROLE_TYPES])))
    .orderBy(asc(user.name));
  const byMember = new Map<string, { memberId: string; name: string; email: string; roleTypes: string[] }>();
  for (const r of rows) {
    const e = byMember.get(r.memberId) ?? { memberId: r.memberId, name: r.name, email: r.email, roleTypes: [] };
    e.roleTypes.push(r.roleType);
    byMember.set(r.memberId, e);
  }
  const ids = [...byMember.keys()];
  if (ids.length === 0) return [];
  const linked = await db.select({ id: sponsors.id, name: sponsors.name, memberId: sponsors.linkedMemberId }).from(sponsors).where(and(eq(sponsors.clubId, clubId), inArray(sponsors.linkedMemberId, ids)));
  const out = [];
  for (const e of byMember.values()) {
    out.push({ ...e, status: "active" as const, sponsors: linked.filter((s) => s.memberId === e.memberId).map((s) => ({ id: s.id, name: s.name })), assignments: await currentAssignments(clubId, e.memberId) });
  }
  return out;
}

/**
 * Ends the external access of an account: external roles, assignments and sponsor links go; the account membership itself is
 * removed when nothing else is left (a guest without other roles and without guardian links), and its club_members row is closed.
 */
export async function removeExternalAccess(clubId: string, memberId: string): Promise<{ membershipRemoved: boolean }> {
  const { member: row } = await externalAccount(clubId, memberId);
  let membershipRemoved = false;
  await db.transaction(async (tx) => {
    await tx.delete(clubRoles).where(and(eq(clubRoles.memberId, memberId), inArray(clubRoles.roleType, [...EXTERNAL_ROLE_TYPES])));
    await tx.delete(externalAccessAssignments).where(and(eq(externalAccessAssignments.clubId, clubId), eq(externalAccessAssignments.memberId, memberId)));
    await tx.update(sponsors).set({ linkedMemberId: null, updatedAt: new Date() }).where(and(eq(sponsors.clubId, clubId), eq(sponsors.linkedMemberId, memberId)));
    const [{ n: roles }] = await tx.select({ n: sql<number>`count(*)::int` }).from(clubRoles).where(eq(clubRoles.memberId, memberId));
    const [{ n: links }] = await tx.select({ n: sql<number>`count(*)::int` }).from(guardianLinks).where(eq(guardianLinks.guardianMemberId, memberId));
    if (row.role === "guest" && roles === 0 && links === 0) {
      await tx.delete(member).where(eq(member.id, memberId));
      membershipRemoved = true;
    }
    await writeAudit(tx, { eventType: "external_access.remove", subjectId: memberId, payload: { clubId, memberId, membershipRemoved } });
  });
  if (membershipRemoved) await markDetachedMembersLeft(db, clubId);
  return { membershipRemoved };
}
