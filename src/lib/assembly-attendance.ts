import { and, eq, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { meetingProxies, meetingVotingRoll } from "../db/schema/assembly.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { meetingAttendance, meetings, type MeetingRow } from "../db/schema/meetings.js";
import { writeAudit } from "./audit.js";
import { loadAssemblyRules, parseStoredAssemblyRules, type AssemblyRules } from "./assembly-rules.js";
import type { DbExecutor } from "./club-members.js";
import { localDate } from "./club-time.js";
import { loadClubSettings } from "./club-settings.js";
import { ConflictError, ValidationError } from "./errors.js";
import { todayBerlin } from "./member-lifecycle.js";
import { deriveVotingRight, type VotingBasis } from "./voting-right.js";

/**
 * Voting roll, proxies and quorum of a general assembly (Wave 11 B4). The roll is the frozen list of the members who may
 * vote; before it is frozen the same derivation (`deriveVotingRight`) runs live. The meeting is judged by the rules of its
 * first invitation (`meetings.rules_snapshot`), the current rules only while there is none.
 */

export async function rulesOfMeeting(executor: DbExecutor, clubId: string, meeting: Pick<MeetingRow, "rulesSnapshot">): Promise<AssemblyRules> {
  return meeting.rulesSnapshot ? parseStoredAssemblyRules(meeting.rulesSnapshot) : loadAssemblyRules(executor, clubId);
}

/** Reference day of the voting right: the meeting day in club time, else today. */
export async function referenceDay(executor: DbExecutor, clubId: string, meeting: Pick<MeetingRow, "scheduledAt">): Promise<string> {
  if (!meeting.scheduledAt) return todayBerlin();
  return localDate(meeting.scheduledAt, (await loadClubSettings(executor, clubId)).timezone);
}

export interface Eligibility {
  frozen: boolean;
  asOf: string;
  /** `club_members.id` -> eligible and why. Frozen: the stored roll; live: every member of the club. */
  byMember: Map<string, { eligible: boolean; basis: VotingBasis | string }>;
}

/** Live derivation for every member of the club as of `asOf`. */
export async function deriveAll(executor: DbExecutor, clubId: string, rules: AssemblyRules, asOf: string) {
  const rows = await executor
    .select({
      id: clubMembers.id,
      status: clubMembers.status,
      joinedAt: clubMembers.joinedAt,
      leftAt: clubMembers.leftAt,
      birthDate: clubMembers.birthDate,
      votingRight: memberCategories.votingRight,
      hasCategory: memberCategories.id,
    })
    .from(clubMembers)
    .leftJoin(memberCategories, eq(memberCategories.id, clubMembers.categoryId))
    .where(eq(clubMembers.clubId, clubId));
  return rows.map((r) => ({ id: r.id, result: deriveVotingRight(r, r.hasCategory ? { votingRight: r.votingRight ?? false } : null, rules, asOf), leftBefore: r.leftAt !== null && r.leftAt <= asOf }));
}

export async function loadEligibility(executor: DbExecutor, clubId: string, meeting: MeetingRow): Promise<Eligibility> {
  const asOf = await referenceDay(executor, clubId, meeting);
  const byMember = new Map<string, { eligible: boolean; basis: string }>();
  if (meeting.votingRollFrozenAt) {
    const roll = await executor.select().from(meetingVotingRoll).where(eq(meetingVotingRoll.meetingId, meeting.id));
    for (const r of roll) if (r.clubMemberId) byMember.set(r.clubMemberId, { eligible: r.eligible, basis: r.basis });
    return { frozen: true, asOf, byMember };
  }
  const rules = await rulesOfMeeting(executor, clubId, meeting);
  for (const r of await deriveAll(executor, clubId, rules, asOf)) byMember.set(r.id, r.result);
  return { frozen: false, asOf, byMember };
}

export const isEligible = (e: Eligibility, clubMemberId: string): boolean => e.byMember.get(clubMemberId)?.eligible === true;

/** Freezes the voting roll (once). Everybody who has not left before the reference day is listed with the basis. */
export async function freezeVotingRoll(clubId: string, meetingId: string, actorUserId: string): Promise<{ total: number; eligible: number; asOf: string }> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(meetings).where(and(eq(meetings.id, meetingId), eq(meetings.clubId, clubId))).for("update");
    if (!locked) throw new ConflictError("Meeting no longer exists");
    if (locked.votingRollFrozenAt) throw new ConflictError("The voting roll is already frozen", { details: { code: "voting_roll_frozen" } });
    const rules = await rulesOfMeeting(tx, clubId, locked);
    if (rules.votingStatuses === null || rules.votingStatuses.length === 0 || rules.votingMinAge === null) {
      throw new ValidationError("The statute parameters for the voting right are incomplete", { details: { code: "assembly_rules_incomplete", missing: ["votingStatuses", "votingMinAge"].filter((k) => (k === "votingStatuses" ? rules.votingStatuses === null || rules.votingStatuses.length === 0 : rules.votingMinAge === null)) } });
    }
    const asOf = await referenceDay(tx, clubId, locked);
    const derived = (await deriveAll(tx, clubId, rules, asOf)).filter((r) => !r.leftBefore);
    for (let i = 0; i < derived.length; i += 500) {
      await tx.insert(meetingVotingRoll).values(derived.slice(i, i + 500).map((r) => ({ meetingId, clubMemberId: r.id, eligible: r.result.eligible, basis: r.result.basis })));
    }
    const now = new Date();
    await tx.update(meetings).set({ votingRollFrozenAt: now, updatedAt: now }).where(eq(meetings.id, meetingId));
    // Attendance rows written before the freeze carry the roll's decision from now on.
    await tx.execute(sql`update meeting_attendance a set has_voting_right = r.eligible from meeting_voting_roll r where r.meeting_id = a.meeting_id and r.club_member_id = a.club_member_id and a.meeting_id = ${meetingId}`);
    const eligible = derived.filter((r) => r.result.eligible).length;
    await writeAudit(tx, { eventType: "meeting_voting_roll.freeze", subjectId: meetingId, actorUserId, payload: { clubId, meetingId, total: derived.length, eligible } });
    return { total: derived.length, eligible, asOf };
  });
}

/** Changes one entry of the frozen roll by hand. The reason is mandatory and lands in the audit trail (as a flag, not as text). */
export async function overrideVotingRight(args: { clubId: string; meetingId: string; clubMemberId: string; eligible: boolean; reason: string; actorUserId: string }): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(meetings).where(and(eq(meetings.id, args.meetingId), eq(meetings.clubId, args.clubId))).for("update");
    if (!locked) throw new ConflictError("Meeting no longer exists");
    if (!locked.votingRollFrozenAt) throw new ConflictError("Freeze the voting roll first", { details: { code: "voting_roll_not_frozen" } });
    await tx
      .insert(meetingVotingRoll)
      .values({ meetingId: args.meetingId, clubMemberId: args.clubMemberId, eligible: args.eligible, basis: "override", overrideReason: args.reason, overriddenBy: args.actorUserId })
      .onConflictDoUpdate({ target: [meetingVotingRoll.meetingId, meetingVotingRoll.clubMemberId], set: { eligible: args.eligible, basis: "override", overrideReason: args.reason, overriddenBy: args.actorUserId } });
    await tx.update(meetingAttendance).set({ hasVotingRight: args.eligible }).where(and(eq(meetingAttendance.meetingId, args.meetingId), eq(meetingAttendance.clubMemberId, args.clubMemberId)));
    await writeAudit(tx, { eventType: "meeting_voting_roll.override", subjectId: args.meetingId, actorUserId: args.actorUserId, payload: { clubId: args.clubId, meetingId: args.meetingId, clubMemberId: args.clubMemberId, eligible: args.eligible } });
  });
}

// --- Proxies ----------------------------------------------------------------------------------------------------------

export interface GrantProxyArgs {
  clubId: string;
  meeting: MeetingRow;
  grantorClubMemberId: string;
  holderClubMemberId: string;
  grantedBy: string;
  byBoard: boolean;
}

const refuse = (message: string, code: string, extra: Record<string, unknown> = {}, conflict = false) =>
  conflict ? new ConflictError(message, { details: { code, ...extra } }) : new ValidationError(message, { details: { code, ...extra } });

/** Applies the proxy rules of the statute; throws a `ValidationError` / `ConflictError` with `details.code`. Replaces an earlier holder of the same grantor. */
export async function grantProxy(tx: DbExecutor, args: GrantProxyArgs): Promise<void> {
  const { clubId, meeting, grantorClubMemberId: grantor, holderClubMemberId: holder } = args;
  if (grantor === holder) throw refuse("A member cannot be their own proxy", "proxy_self");
  // Members can no longer give a proxy once the meeting is over; the board still records them for the minutes.
  if (!args.byBoard && ["abgehalten", "protokolliert", "abgesagt"].includes(meeting.status)) throw refuse("The meeting is over", "meeting_closed", {}, true);
  const rules = await rulesOfMeeting(tx, clubId, meeting);
  if (rules.proxyAllowed === null || (rules.proxyAllowed && rules.maxProxiesPerPerson === null)) throw refuse("The statute parameters for proxies are not stated", "assembly_rules_incomplete", { missing: ["proxyAllowed", "maxProxiesPerPerson"].filter((k) => (k === "proxyAllowed" ? rules.proxyAllowed === null : rules.proxyAllowed && rules.maxProxiesPerPerson === null)) });
  if (!rules.proxyAllowed) throw refuse("The statute does not allow proxies", "proxy_not_allowed");
  const eligibility = await loadEligibility(tx, clubId, meeting);
  if (!isEligible(eligibility, grantor)) throw refuse("The proxy giver has no voting right", "grantor_not_eligible");
  if (!isEligible(eligibility, holder)) throw refuse("The proxy holder has no voting right", "holder_not_eligible");
  const [present] = await tx.select({ present: meetingAttendance.present }).from(meetingAttendance).where(and(eq(meetingAttendance.meetingId, meeting.id), eq(meetingAttendance.clubMemberId, grantor)));
  if (present?.present) throw refuse("The proxy giver is present", "grantor_present", {}, true);
  const existing = await tx.select().from(meetingProxies).where(eq(meetingProxies.meetingId, meeting.id));
  if (existing.some((p) => p.grantorClubMemberId === holder)) throw refuse("The proxy holder has given a proxy themselves", "holder_is_grantor", {}, true);
  if (existing.some((p) => p.holderClubMemberId === grantor)) throw refuse("The proxy giver holds proxies themselves", "grantor_is_holder", {}, true);
  const held = existing.filter((p) => p.holderClubMemberId === holder && p.grantorClubMemberId !== grantor).length;
  if (held + 1 > (rules.maxProxiesPerPerson ?? 0)) throw refuse("The proxy holder already holds the maximum number of proxies", "max_proxies_reached", { max: rules.maxProxiesPerPerson }, true);
  await tx
    .insert(meetingProxies)
    .values({ meetingId: meeting.id, grantorClubMemberId: grantor, holderClubMemberId: holder, grantedBy: args.grantedBy })
    .onConflictDoUpdate({ target: [meetingProxies.meetingId, meetingProxies.grantorClubMemberId], set: { holderClubMemberId: holder, grantedBy: args.grantedBy } });
  await writeAudit(tx, {
    eventType: "meeting_proxy.grant",
    subjectId: meeting.id,
    actorUserId: args.grantedBy,
    payload: { clubId, meetingId: meeting.id, grantorClubMemberId: grantor, holderClubMemberId: holder, byBoard: args.byBoard },
  });
}

// --- Quorum -------------------------------------------------------------------------------------------------------------

export type QuorumResult = "beschlussfaehig" | "nicht_beschlussfaehig" | "regeln_fehlen";

export interface QuorumStatus {
  rollFrozen: boolean;
  asOf: string;
  eligibleTotal: number;
  presentEligible: number;
  /** Proxies that count: the holder is present and eligible, the grantor is eligible and not present. */
  proxiesRepresented: number;
  /** `presentEligible + proxiesRepresented`. */
  represented: number;
  quorumMode: AssemblyRules["quorumMode"];
  quorumValue: number | null;
  required: number | null;
  result: QuorumResult;
}

/** Pure part of the quorum calculation. */
export function evaluateQuorum(args: { eligibleTotal: number; represented: number; quorumMode: AssemblyRules["quorumMode"]; quorumValue: number | null }): { required: number | null; result: QuorumResult } {
  const { eligibleTotal, represented, quorumMode, quorumValue } = args;
  if (quorumMode === null || (quorumMode !== "none" && quorumValue === null)) return { required: null, result: "regeln_fehlen" };
  if (quorumMode === "none") return { required: 0, result: "beschlussfaehig" };
  const required = quorumMode === "fraction" ? Math.ceil(eligibleTotal * quorumValue! - 1e-9) : Math.ceil(quorumValue!);
  // Nobody entitled to vote can never be a quorum, whatever the rule says.
  return { required, result: eligibleTotal > 0 && represented >= Math.max(required, 1) ? "beschlussfaehig" : "nicht_beschlussfaehig" };
}

/** Live quorum of a meeting; B5 calls it again whenever a vote is opened. */
export async function computeQuorum(executor: DbExecutor, clubId: string, meeting: MeetingRow): Promise<QuorumStatus> {
  const rules = await rulesOfMeeting(executor, clubId, meeting);
  const eligibility = await loadEligibility(executor, clubId, meeting);
  const eligibleTotal = [...eligibility.byMember.values()].filter((e) => e.eligible).length;
  const attendance = await executor.select({ id: meetingAttendance.clubMemberId, present: meetingAttendance.present }).from(meetingAttendance).where(eq(meetingAttendance.meetingId, meeting.id));
  const presentIds = new Set(attendance.filter((a) => a.present && a.id !== null).map((a) => a.id as string));
  const presentEligible = [...presentIds].filter((id) => isEligible(eligibility, id)).length;
  const proxies = rules.proxyAllowed ? await executor.select().from(meetingProxies).where(eq(meetingProxies.meetingId, meeting.id)) : [];
  const proxiesRepresented = proxies.filter((p) => p.grantorClubMemberId && p.holderClubMemberId && isEligible(eligibility, p.grantorClubMemberId) && isEligible(eligibility, p.holderClubMemberId) && presentIds.has(p.holderClubMemberId) && !presentIds.has(p.grantorClubMemberId)).length;
  const represented = presentEligible + proxiesRepresented;
  const { required, result } = evaluateQuorum({ eligibleTotal, represented, quorumMode: rules.quorumMode, quorumValue: rules.quorumValue });
  return { rollFrozen: eligibility.frozen, asOf: eligibility.asOf, eligibleTotal, presentEligible, proxiesRepresented, represented, quorumMode: rules.quorumMode, quorumValue: rules.quorumValue, required, result };
}
