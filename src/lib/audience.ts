import { and, eq, inArray, isNull, or, gte, sql } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { pushTokens, type AnnouncementAudience, type CommunicationChannel } from "../db/schema/communication.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { departments } from "../db/schema/departments.js";
import { effectiveStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Audience resolver (Wave 9 B5, ADR-006). `resolveAudience` is a pure function: audience definition + candidate persons ->
 * deduplicated recipient snapshot with per-channel reachability. `loadAudienceCandidates` / `resolveClubAudience` add the
 * club-scoped DB loader. Nothing here sends anything.
 */

/** Statuses that never receive club communication: dormant members and everyone who left (see `effectiveStatus`). */
export const EXCLUDED_RECIPIENT_STATUSES = ["ruhend", "ausgetreten", "ausgeschlossen", "verstorben"] as const;

/** A person that could be addressed. Built by the loader from `club_members`, accounts, roles and guardian links. */
export interface AudienceCandidate {
  /** `club_members.id`; NULL for an account that has no club_members row (e.g. an external guardian). */
  clubMemberId: string | null;
  /** Better Auth `member.id` (the club account membership), NULL for account-less members. */
  accountMemberId: string | null;
  userId: string | null;
  displayName: string;
  firstName?: string | null;
  status: string;
  /** `club_members.left_at` (ISO date); a past date means the member has already left (Stichtag). */
  leftAt: string | null;
  /** Login e-mail of the linked account. */
  accountEmail: string | null;
  /** Contact e-mail of the member row (the ONLY address of an account-less member). */
  contactEmail: string | null;
  departmentIds: string[];
  categoryKey: string | null;
  /** `club_roles.role_type` values (accounts only). */
  roleTypes: string[];
  /** `club_members.id` of the wards this person is guardian of. */
  guardianOf: string[];
  /** Number of enabled push tokens of the account. */
  pushTokenCount: number;
}

export interface RecipientChannels {
  inApp: boolean;
  email: boolean;
  push: boolean;
}

export interface AudienceRecipient {
  /** Stable person key: the club member id, or `acct:<accountMemberId>` for accounts without a club_members row. */
  key: string;
  clubMemberId: string | null;
  accountMemberId: string | null;
  userId: string | null;
  displayName: string;
  firstName: string | null;
  /** Normalised e-mail address if the person is the owner of it for this send, else NULL. */
  email: string | null;
  /** `direct` = matched by the audience itself, `guardian` = only added as guardian of a matched ward. */
  via: "direct" | "guardian";
  channels: RecipientChannels;
  /** The e-mail address was already taken by another recipient (shared family address): this person gets no second mail. */
  emailCoveredBy: string | null;
}

export interface AudienceSummary {
  /** Persons in the snapshot. */
  total: number;
  /** Persons reachable by at least one of the requested channels (in-app counts for account holders). */
  reachable: number;
  email: number;
  push: number;
  inApp: number;
  /** Persons reachable by e-mail only (no account). */
  emailOnly: number;
  /** Persons without any channel and without a shared address covering them. */
  unreachable: number;
  /** Persons whose only address is already used by another recipient (counted in `reachable`: they are covered). */
  sharedAddress: number;
}

export interface ResolvedAudience {
  recipients: AudienceRecipient[];
}

export class AudienceLimitError extends Error {
  constructor(
    readonly size: number,
    readonly limit: number,
  ) {
    super(`Audience of ${size} recipients exceeds the limit of ${limit}`);
    this.name = "AudienceLimitError";
  }
}

export function defaultAudienceLimit(): number {
  const n = Number(process.env.AUDIENCE_MAX_RECIPIENTS ?? 2000);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 2000;
}

export interface ResolveOptions {
  /** Hard upper limit of persons in the snapshot (after deduplication). Default `AUDIENCE_MAX_RECIPIENTS` (2000). */
  limit?: number;
  /** ISO day the Stichtag status is evaluated on (default: today in Europe/Berlin). */
  today?: string;
}

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Trimmed, lower-cased address or NULL if it does not look like an address (also guards against header injection). */
export function normalizeEmail(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v && v.length <= 254 && EMAIL_RE.test(v) ? v : null;
}

const personKey = (c: AudienceCandidate): string => c.clubMemberId ?? `acct:${c.accountMemberId ?? c.userId ?? "unknown"}`;

function isEligible(c: AudienceCandidate, today: string): boolean {
  const status = effectiveStatus({ status: c.status, leftAt: c.leftAt }, today);
  return !(EXCLUDED_RECIPIENT_STATUSES as readonly string[]).includes(status);
}

/** The address a person can be mailed at: account login e-mail first, the contact e-mail of the member row otherwise. */
function addressOf(c: AudienceCandidate): string | null {
  return normalizeEmail(c.accountEmail) ?? normalizeEmail(c.contactEmail);
}

const hasAny = <T>(list: readonly T[] | undefined, wanted: ReadonlySet<T>): boolean => !!list && list.some((v) => wanted.has(v));

/**
 * Pure resolver. Rules:
 * - the audience is the UNION of `all`, `departmentIds`, `roleTypes` (accounts only), `categoryKeys`, `memberIds`;
 *   an empty definition matches nobody (deny by default);
 * - `all` means every club member (a row in `club_members`), not bare accounts;
 * - dormant and left members (incl. a past `left_at`) are never recipients, neither directly nor as guardian target;
 * - `includeGuardians` (default true) adds the guardians of every matched ward;
 * - deduplicated by person and by e-mail address: a shared address belongs to the first person (accounts before
 *   account-less members, direct before guardian, then by key) and the others are marked `emailCoveredBy`;
 * - account-less members are reachable by their contact e-mail only; no in-app, no push;
 * - more than `limit` persons -> `AudienceLimitError` (nothing is truncated silently).
 */
export function resolveAudience(audience: AnnouncementAudience, candidates: readonly AudienceCandidate[], options: ResolveOptions = {}): ResolvedAudience {
  const today = options.today ?? todayBerlin();
  const limit = options.limit ?? defaultAudienceLimit();
  const departmentIds = new Set(audience.departmentIds ?? []);
  const roleTypes = new Set(audience.roleTypes ?? []);
  const categoryKeys = new Set(audience.categoryKeys ?? []);
  const memberIds = new Set(audience.memberIds ?? []);

  // Collapse duplicate candidate rows of the same person (e.g. the loader returned a row twice) by key.
  const byKey = new Map<string, AudienceCandidate>();
  for (const c of candidates) if (!byKey.has(personKey(c))) byKey.set(personKey(c), c);
  const eligible = [...byKey.values()].filter((c) => isEligible(c, today));

  const direct = new Map<string, AudienceCandidate>();
  for (const c of eligible) {
    const matches =
      (audience.all === true && c.clubMemberId !== null) ||
      hasAny(c.departmentIds, departmentIds) ||
      (c.accountMemberId !== null && hasAny(c.roleTypes, roleTypes)) ||
      (c.categoryKey !== null && categoryKeys.has(c.categoryKey)) ||
      (c.clubMemberId !== null && memberIds.has(c.clubMemberId));
    if (matches) direct.set(personKey(c), c);
  }

  const guardians = new Map<string, AudienceCandidate>();
  if (audience.includeGuardians !== false) {
    const wardIds = new Set([...direct.values()].map((c) => c.clubMemberId).filter((id): id is string => id !== null));
    if (wardIds.size > 0) {
      for (const c of eligible) {
        if (!direct.has(personKey(c)) && c.guardianOf.some((id) => wardIds.has(id))) guardians.set(personKey(c), c);
      }
    }
  }

  const ordered: Array<{ c: AudienceCandidate; via: "direct" | "guardian" }> = [
    ...[...direct.values()].map((c) => ({ c, via: "direct" as const })),
    ...[...guardians.values()].map((c) => ({ c, via: "guardian" as const })),
  ];
  if (ordered.length > limit) throw new AudienceLimitError(ordered.length, limit);

  // Address ownership: accounts first (they also get the in-app copy), direct before guardian, then by key for determinism.
  const claimOrder = [...ordered].sort((a, b) => {
    const acct = Number(b.c.userId !== null) - Number(a.c.userId !== null);
    if (acct !== 0) return acct;
    if (a.via !== b.via) return a.via === "direct" ? -1 : 1;
    return personKey(a.c) < personKey(b.c) ? -1 : personKey(a.c) > personKey(b.c) ? 1 : 0;
  });
  const owners = new Map<string, string>();
  for (const { c } of claimOrder) {
    const address = addressOf(c);
    if (address && !owners.has(address)) owners.set(address, personKey(c));
  }

  const recipients = ordered.map(({ c, via }): AudienceRecipient => {
    const key = personKey(c);
    const address = addressOf(c);
    const owner = address ? owners.get(address) : undefined;
    const ownsAddress = address !== null && owner === key;
    return {
      key,
      clubMemberId: c.clubMemberId,
      accountMemberId: c.accountMemberId,
      userId: c.userId,
      displayName: c.displayName,
      firstName: c.firstName ?? null,
      email: ownsAddress ? address : null,
      via,
      channels: { inApp: c.userId !== null, email: ownsAddress, push: c.userId !== null && c.pushTokenCount > 0 },
      emailCoveredBy: address !== null && !ownsAddress ? (owner ?? null) : null,
    };
  });
  return { recipients };
}

/** Counts for the preview endpoint (numbers only, never a person list). `channels` are the channels the sender picked. */
export function summarizeAudience(recipients: readonly AudienceRecipient[], channels: readonly CommunicationChannel[] = ["in_app"]): AudienceSummary {
  const wantsInApp = channels.includes("in_app");
  const wantsEmail = channels.includes("email");
  const wantsPush = channels.includes("push");
  const summary: AudienceSummary = { total: recipients.length, reachable: 0, email: 0, push: 0, inApp: 0, emailOnly: 0, unreachable: 0, sharedAddress: 0 };
  for (const r of recipients) {
    const inApp = wantsInApp && r.channels.inApp;
    const email = wantsEmail && r.channels.email;
    const push = wantsPush && r.channels.push;
    if (inApp) summary.inApp += 1;
    if (email) summary.email += 1;
    if (push) summary.push += 1;
    if (inApp || email || push) {
      summary.reachable += 1;
      if (email && !inApp && !push) summary.emailOnly += 1;
    } else if (wantsEmail && r.emailCoveredBy !== null) {
      summary.sharedAddress += 1;
      summary.reachable += 1;
    } else {
      summary.unreachable += 1;
    }
  }
  return summary;
}

type DbExecutor = Pick<typeof db, "select">;

/** Loads every addressable person of ONE club (never reads other clubs). Filtering by audience/status is left to `resolveAudience`. */
export async function loadAudienceCandidates(clubId: string, executor: DbExecutor = db): Promise<AudienceCandidate[]> {
  const today = todayBerlin();
  const memberRows = await executor
    .select({
      clubMemberId: clubMembers.id,
      accountMemberId: clubMembers.memberId,
      userId: member.userId,
      displayName: clubMembers.displayName,
      firstName: clubMembers.firstName,
      status: clubMembers.status,
      leftAt: clubMembers.leftAt,
      accountEmail: user.email,
      contactEmail: clubMembers.contactEmail,
      categoryKey: memberCategories.key,
    })
    .from(clubMembers)
    .leftJoin(member, eq(member.id, clubMembers.memberId))
    .leftJoin(user, eq(user.id, member.userId))
    .leftJoin(memberCategories, eq(memberCategories.id, clubMembers.categoryId))
    .where(eq(clubMembers.clubId, clubId));

  // Accounts of the club without a club_members row (e.g. external guardians): addressable via roles / guardian links only.
  const linkedAccountIds = memberRows.map((r) => r.accountMemberId).filter((id): id is string => id !== null);
  const accountRows = await executor
    .select({ accountMemberId: member.id, userId: member.userId, displayName: user.name, accountEmail: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, clubId));
  const bareAccounts = accountRows.filter((a) => !linkedAccountIds.includes(a.accountMemberId));

  const accountIds = [...linkedAccountIds, ...bareAccounts.map((a) => a.accountMemberId)];
  const userIds = [...memberRows.map((r) => r.userId), ...bareAccounts.map((a) => a.userId)].filter((id): id is string => id !== null);
  const clubMemberIds = memberRows.map((r) => r.clubMemberId);

  const [deptRows, roleRows, guardianRows, tokenRows] = await Promise.all([
    clubMemberIds.length === 0
      ? []
      : executor
          .select({ clubMemberId: clubMemberDepartments.clubMemberId, departmentId: clubMemberDepartments.departmentId })
          .from(clubMemberDepartments)
          .innerJoin(departments, eq(departments.id, clubMemberDepartments.departmentId))
          .where(
            and(
              inArray(clubMemberDepartments.clubMemberId, clubMemberIds),
              eq(departments.clubId, clubId),
              or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, today)),
            ),
          ),
    accountIds.length === 0 ? [] : executor.select({ memberId: clubRoles.memberId, roleType: clubRoles.roleType }).from(clubRoles).where(inArray(clubRoles.memberId, accountIds)),
    clubMemberIds.length === 0
      ? []
      : executor
          .select({ guardianMemberId: guardianLinks.guardianMemberId, wardClubMemberId: guardianLinks.wardClubMemberId })
          .from(guardianLinks)
          .where(inArray(guardianLinks.wardClubMemberId, clubMemberIds)),
    userIds.length === 0
      ? []
      : executor
          .select({ userId: pushTokens.userId, n: sql<number>`count(*)::int` })
          .from(pushTokens)
          .where(and(inArray(pushTokens.userId, userIds), isNull(pushTokens.disabledAt)))
          .groupBy(pushTokens.userId),
  ]);

  const group = <K, V>(rows: Array<[K, V]>): Map<K, V[]> => {
    const m = new Map<K, V[]>();
    for (const [k, v] of rows) m.set(k, [...(m.get(k) ?? []), v]);
    return m;
  };
  const deptsByMember = group(deptRows.map((r) => [r.clubMemberId, r.departmentId] as [string, string]));
  const rolesByAccount = group(roleRows.map((r) => [r.memberId, r.roleType] as [string, string]));
  const wardsByGuardian = group(guardianRows.map((r) => [r.guardianMemberId, r.wardClubMemberId] as [string, string]));
  const tokensByUser = new Map(tokenRows.map((r) => [r.userId, r.n]));

  const candidates: AudienceCandidate[] = memberRows.map((r) => ({
    clubMemberId: r.clubMemberId,
    accountMemberId: r.accountMemberId,
    userId: r.userId ?? null,
    displayName: r.displayName,
    firstName: r.firstName,
    status: r.status,
    leftAt: r.leftAt,
    accountEmail: r.accountEmail ?? null,
    contactEmail: r.contactEmail,
    departmentIds: deptsByMember.get(r.clubMemberId) ?? [],
    categoryKey: r.categoryKey ?? null,
    roleTypes: r.accountMemberId ? (rolesByAccount.get(r.accountMemberId) ?? []) : [],
    guardianOf: r.accountMemberId ? (wardsByGuardian.get(r.accountMemberId) ?? []) : [],
    pushTokenCount: r.userId ? (tokensByUser.get(r.userId) ?? 0) : 0,
  }));
  for (const a of bareAccounts) {
    candidates.push({
      clubMemberId: null,
      accountMemberId: a.accountMemberId,
      userId: a.userId,
      displayName: a.displayName,
      firstName: null,
      status: "aktiv",
      leftAt: null,
      accountEmail: a.accountEmail,
      contactEmail: null,
      departmentIds: [],
      categoryKey: null,
      roleTypes: rolesByAccount.get(a.accountMemberId) ?? [],
      guardianOf: wardsByGuardian.get(a.accountMemberId) ?? [],
      pushTokenCount: tokensByUser.get(a.userId) ?? 0,
    });
  }
  return candidates;
}

/** Loader + resolver for one club. The audience can never reach another club: candidates are loaded by `clubId` only. */
export async function resolveClubAudience(clubId: string, audience: AnnouncementAudience, options: ResolveOptions = {}, executor: DbExecutor = db): Promise<ResolvedAudience> {
  return resolveAudience(audience, await loadAudienceCandidates(clubId, executor), options);
}
