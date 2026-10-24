import { randomInt } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  ballotOptions,
  ballotVoters,
  ballotVotesOpen,
  ballotVotesSecret,
  ballots,
  meetingAgendaItems,
  meetingInvitations,
  meetingMinutes,
  meetingProxies,
  type BallotOptionRow,
  type BallotRow,
} from "../db/schema/assembly.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { meetingAttendance, meetingInvitees, meetingResolutions, meetings } from "../db/schema/meetings.js";
import { member } from "../auth/auth-schema.js";
import { writeAudit } from "./audit.js";
import { computeQuorum, deriveAll, freezeVotingRoll, loadEligibility, rulesOfMeeting, type QuorumStatus } from "./assembly-attendance.js";
import { hashContent } from "./assembly-invitation.js";
import { minutesHash } from "./minutes.js";
import { loadAssemblyRules, majorityFor, parseStoredAssemblyRules, type AssemblyRules, type MajorityTopic } from "./assembly-rules.js";
import { evaluateBallot, evaluateChoices } from "./ballot-evaluation.js";
import type { DbExecutor } from "./club-members.js";
import { BOARD_ROLE_TYPES } from "./club-permissions.js";
import { clubTimezone, formatWhen } from "./event-notify.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors.js";
import { enqueue } from "./jobs/queue.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Digital ballots (Wave 11 B5/B6; ADR-008). One `ballots` row is a vote on a resolution, a Wahlgang or a circular
 * resolution. The rules that decide it are frozen on the ballot when it opens. Three guarantees carry the module:
 *
 * - No double votes: the vote and the `has_voted` flag are ONE transaction, switched by a conditional UPDATE whose WHERE
 *   clause also holds the window, measured with the database clock (`clock_timestamp()`); no scheduler is needed for
 *   correctness. The transaction holds a SHARE lock on the ballot row, closing takes the row exclusively and therefore
 *   waits for every vote that was accepted before the window ended.
 * - Secret ballots (option A): the vote goes to `ballot_votes_secret` (no member, no timestamp, random key); nothing but
 *   aggregated counters is audited. Against an operator with database access this cannot be proven anonymous.
 * - Lifecycle `draft` -> `open` -> `closed` -> `counted` -> `finalized` (or `cancelled`); a result is frozen with a SHA-256.
 */

export type BallotPhase = "draft" | "scheduled" | "voting" | "ended" | "cancelled";

export const BALLOT_NOTIFY_JOB = "ballot_notify";

const fail = {
  conflict: (message: string, code: string, extra: Record<string, unknown> = {}) => new ConflictError(message, { details: { code, ...extra } }),
  invalid: (message: string, code: string, extra: Record<string, unknown> = {}) => new ValidationError(message, { details: { code, ...extra } }),
};

export const YES_NO_LABELS = { yes: "Ja", no: "Nein", abstain: "Enthaltung" } as const;

// --- Loading -------------------------------------------------------------------------------------------------------------

export async function loadBallot(executor: DbExecutor, clubId: string, ballotId: string): Promise<BallotRow> {
  const row = await executor.query.ballots.findFirst({ where: and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId)) });
  if (!row) throw new NotFoundError("Ballot not found");
  return row;
}

export async function optionsOf(executor: DbExecutor, ballotId: string): Promise<BallotOptionRow[]> {
  return executor.select().from(ballotOptions).where(eq(ballotOptions.ballotId, ballotId)).orderBy(asc(ballotOptions.position));
}

export function phaseOf(b: Pick<BallotRow, "status" | "opensAt">, now: Date = new Date()): BallotPhase {
  if (b.status === "draft") return "draft";
  if (b.status === "cancelled") return "cancelled";
  if (b.status === "open") return b.opensAt && b.opensAt.getTime() > now.getTime() ? "scheduled" : "voting";
  return "ended";
}

// --- Creating and editing a draft ----------------------------------------------------------------------------------------

export interface OptionSpec {
  label: string;
  kind: "yes" | "no" | "abstain" | "choice" | "candidate";
  candidateClubMemberId?: string | null;
}

/** Ja / Nein (/ Enthaltung) or free choices (+ Enthaltung). */
export function buildOptions(args: { choices?: string[] | undefined; allowAbstain?: boolean | undefined; circular: boolean; maxChoices: number }): { options: OptionSpec[]; maxChoices: number } {
  const abstain = args.allowAbstain ?? true;
  if (!args.choices || args.choices.length === 0) {
    const options: OptionSpec[] = [{ label: YES_NO_LABELS.yes, kind: "yes" }, { label: YES_NO_LABELS.no, kind: "no" }, ...(abstain ? [{ label: YES_NO_LABELS.abstain, kind: "abstain" as const }] : [])];
    if (args.maxChoices !== 1) throw fail.invalid("A yes/no ballot allows exactly one choice", "invalid_max_choices");
    return { options, maxChoices: 1 };
  }
  if (args.circular) throw fail.invalid("A circular resolution is a yes/no ballot", "circular_yes_no_only");
  const labels = args.choices.map((c) => c.trim());
  if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) throw fail.invalid("Choices must not repeat", "duplicate_choice");
  if (args.maxChoices > labels.length) throw fail.invalid("maxChoices exceeds the number of choices", "invalid_max_choices");
  return { options: [...labels.map((label) => ({ label, kind: "choice" as const })), ...(abstain ? [{ label: YES_NO_LABELS.abstain, kind: "abstain" as const }] : [])], maxChoices: args.maxChoices };
}

export async function insertBallot(
  tx: DbExecutor,
  v: Omit<typeof ballots.$inferInsert, "id" | "createdAt" | "updatedAt" | "status">,
  options: OptionSpec[],
): Promise<BallotRow> {
  const [row] = await tx.insert(ballots).values({ ...v, status: "draft" }).returning();
  await tx.insert(ballotOptions).values(options.map((o, i) => ({ ballotId: row!.id, position: i + 1, label: o.label, kind: o.kind, candidateClubMemberId: o.candidateClubMemberId ?? null })));
  return row!;
}

export interface CreateBallotInput {
  clubId: string;
  actorUserId: string;
  mode: "in_session" | "circular";
  meetingId?: string | undefined;
  agendaItemId?: string | null | undefined;
  title: string;
  description?: string | null | undefined;
  secret: boolean;
  topic: MajorityTopic;
  maxChoices: number;
  choices?: string[] | undefined;
  allowAbstain?: boolean | undefined;
  audience?: "all_voting_members" | "board" | undefined;
  /** Circular only: when the window ends (also settable when opening). */
  closesAt?: Date | null | undefined;
}

async function assertSwitches(executor: DbExecutor, clubId: string, mode: string, secret: boolean): Promise<AssemblyRules> {
  const rules = await loadAssemblyRules(executor, clubId);
  if (mode === "circular" && !rules.circularAllowed) throw fail.invalid("Circular resolutions are not enabled for this club", "circular_not_allowed");
  if (secret && !rules.secretBallotDigitalAllowed) throw fail.invalid("Digital secret ballots are not enabled for this club", "secret_ballot_not_allowed");
  return rules;
}

async function assertMeetingAndItem(executor: DbExecutor, clubId: string, meetingId: string, agendaItemId: string | null | undefined) {
  const meeting = await executor.query.meetings.findFirst({ where: and(eq(meetings.id, meetingId), eq(meetings.clubId, clubId)) });
  if (!meeting) throw new NotFoundError("Meeting not found");
  if (meeting.type !== "mitgliederversammlung") throw fail.invalid("Digital ballots exist for the general assembly only", "ballot_meeting_not_supported");
  if (agendaItemId) {
    const item = await executor.query.meetingAgendaItems.findFirst({ where: and(eq(meetingAgendaItems.id, agendaItemId), eq(meetingAgendaItems.meetingId, meetingId)) });
    if (!item) throw new NotFoundError("Agenda item not found");
  }
}

export async function createBallot(input: CreateBallotInput): Promise<BallotRow> {
  const circular = input.mode === "circular";
  if (circular && input.meetingId) throw fail.invalid("A circular resolution has no meeting; its record is created when it is finalized", "circular_without_meeting");
  if (!circular && !input.meetingId) throw fail.invalid("A ballot in a session needs a meeting", "meeting_required");
  if (!circular && input.audience) throw fail.invalid("audience applies to circular resolutions only", "audience_circular_only");
  await assertSwitches(db, input.clubId, input.mode, input.secret);
  if (input.meetingId) await assertMeetingAndItem(db, input.clubId, input.meetingId, input.agendaItemId);
  const { options, maxChoices } = buildOptions({ choices: input.choices, allowAbstain: input.allowAbstain, circular, maxChoices: input.maxChoices });
  return db.transaction(async (tx) => {
    const row = await insertBallot(
      tx,
      {
        clubId: input.clubId,
        meetingId: input.meetingId ?? null,
        agendaItemId: input.agendaItemId ?? null,
        title: input.title,
        description: input.description ?? null,
        mode: input.mode,
        kind: "resolution",
        audience: circular ? (input.audience ?? "all_voting_members") : null,
        secret: input.secret,
        topic: input.topic,
        maxChoices,
        closesAt: input.closesAt ?? null,
        createdBy: input.actorUserId,
      },
      options,
    );
    await writeAudit(tx, { eventType: "ballot.create", subjectId: row.id, actorUserId: input.actorUserId, payload: { clubId: input.clubId, kind: "resolution", meetingId: input.meetingId, mode: input.mode, anonymous: input.secret } });
    return row;
  });
}

export type UpdateBallotInput = Partial<Pick<CreateBallotInput, "title" | "description" | "secret" | "topic" | "maxChoices" | "choices" | "allowAbstain" | "audience" | "closesAt" | "agendaItemId">>;

export async function updateBallot(clubId: string, ballotId: string, actorUserId: string, patch: UpdateBallotInput): Promise<BallotRow> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId))).for("update");
    if (!locked) throw new NotFoundError("Ballot not found");
    if (locked.status !== "draft") throw fail.conflict("Only a draft can be edited", "ballot_not_draft");
    if (locked.kind === "election") throw fail.conflict("Election rounds are edited through the election", "ballot_is_election_round");
    const circular = locked.mode === "circular";
    if (patch.audience && !circular) throw fail.invalid("audience applies to circular resolutions only", "audience_circular_only");
    if (patch.secret !== undefined) await assertSwitches(tx, clubId, locked.mode, patch.secret);
    if (patch.agendaItemId) await assertMeetingAndItem(tx, clubId, locked.meetingId!, patch.agendaItemId);
    const set: Partial<typeof ballots.$inferInsert> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.secret !== undefined) set.secret = patch.secret;
    if (patch.topic !== undefined) set.topic = patch.topic;
    if (patch.audience !== undefined) set.audience = patch.audience;
    if (patch.closesAt !== undefined) set.closesAt = patch.closesAt;
    if (patch.agendaItemId !== undefined) set.agendaItemId = patch.agendaItemId;
    if (patch.choices !== undefined || patch.allowAbstain !== undefined || patch.maxChoices !== undefined) {
      const current = await optionsOf(tx, locked.id);
      const choices = patch.choices ?? current.filter((o) => o.kind === "choice").map((o) => o.label);
      const allowAbstain = patch.allowAbstain ?? current.some((o) => o.kind === "abstain");
      const built = buildOptions({ choices, allowAbstain, circular, maxChoices: patch.maxChoices ?? locked.maxChoices });
      await tx.delete(ballotOptions).where(eq(ballotOptions.ballotId, locked.id));
      await tx.insert(ballotOptions).values(built.options.map((o, i) => ({ ballotId: locked.id, position: i + 1, label: o.label, kind: o.kind })));
      set.maxChoices = built.maxChoices;
    }
    const [row] = await tx.update(ballots).set(set).where(eq(ballots.id, locked.id)).returning();
    await writeAudit(tx, { eventType: "ballot.update", subjectId: locked.id, actorUserId, payload: { clubId, changedFields: Object.keys(patch) } });
    return row!;
  });
}

export async function deleteDraft(clubId: string, ballotId: string): Promise<void> {
  const gone = await db.delete(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId), eq(ballots.status, "draft"), sql`${ballots.electionId} is null`)).returning({ id: ballots.id });
  if (gone.length === 0) {
    await loadBallot(db, clubId, ballotId);
    throw fail.conflict("Only a draft can be deleted", "ballot_not_draft");
  }
}

// --- Opening -------------------------------------------------------------------------------------------------------------

/** The statute parameters a ballot needs; throws 422 with the missing keys. */
function requireRules(rules: AssemblyRules, b: Pick<BallotRow, "topic" | "kind" | "mode" | "secret" | "majority">): { majority: NonNullable<ReturnType<typeof majorityFor>> } {
  const missing: string[] = [];
  const topic: MajorityTopic = b.kind === "election" ? "wahl" : (b.topic as MajorityTopic);
  // An election round may carry its own majority kind (fixed when the round was set up).
  const majority = (b.majority as ReturnType<typeof majorityFor>) ?? majorityFor(rules, topic);
  if (majority === null) missing.push("majorityByTopic.allgemein");
  if (rules.abstainCountsAs === null) missing.push("abstainCountsAs");
  if (b.mode === "circular") {
    if (!rules.circularAllowed) throw fail.invalid("Circular resolutions are not enabled for this club", "circular_not_allowed");
    if (rules.circularUnanimity === null) missing.push("circularUnanimity");
    else if (rules.circularUnanimity === false && rules.circularMinParticipation === null) missing.push("circularMinParticipation");
  }
  if (b.secret && !rules.secretBallotDigitalAllowed) throw fail.invalid("Digital secret ballots are not enabled for this club", "secret_ballot_not_allowed");
  if (missing.length > 0) throw fail.invalid("The statute parameters for this ballot are incomplete", "assembly_rules_incomplete", { missing });
  return { majority: majority! };
}

const STATUTE_LEVEL_TOPICS: readonly string[] = ["satzungsaenderung", "zweckaenderung", "aufloesung"];

export interface OpenBallotArgs {
  clubId: string;
  ballotId: string;
  actorUserId: string;
  /** Default: now (database clock). A future time makes the ballot `scheduled`. */
  opensAt?: Date | undefined;
  closesAt?: Date | null | undefined;
}

export async function openBallot(args: OpenBallotArgs): Promise<{ ballot: BallotRow; warnings: string[] }> {
  const { clubId, ballotId, actorUserId } = args;
  const pre = await loadBallot(db, clubId, ballotId);
  // The voters of a session are the frozen voting roll; the first ballot freezes it.
  if (pre.mode === "in_session" && pre.meetingId) {
    const m = await db.query.meetings.findFirst({ where: eq(meetings.id, pre.meetingId), columns: { votingRollFrozenAt: true } });
    if (m && !m.votingRollFrozenAt) {
      try {
        await freezeVotingRoll(clubId, pre.meetingId, actorUserId);
      } catch (err) {
        if (!(err instanceof ConflictError) || (err.details as { code?: string } | undefined)?.code !== "voting_roll_frozen") throw err;
      }
    }
  }

  const result = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId))).for("update");
    if (!b) throw new NotFoundError("Ballot not found");
    if (b.status !== "draft") throw fail.conflict("Only a draft can be opened", "ballot_not_draft");
    const circular = b.mode === "circular";

    const closesAt = args.closesAt !== undefined ? args.closesAt : b.closesAt;
    const now = Date.now();
    if (circular && !closesAt) throw fail.invalid("A circular resolution needs the end of the voting window", "closes_at_required");
    if (args.opensAt && args.opensAt.getTime() < now - 60_000) throw fail.invalid("opensAt must not be in the past", "invalid_window");
    if (closesAt && closesAt.getTime() <= Math.max(now, args.opensAt?.getTime() ?? 0)) throw fail.invalid("closesAt must be after the opening", "invalid_window");

    let rules: AssemblyRules;
    let voters: Array<{ clubMemberId: string; basis: string }>;
    let quorum: QuorumStatus | null = null;
    let asOf: string = todayBerlin();
    const warnings: string[] = [];

    if (!circular) {
      const [meeting] = await tx.select().from(meetings).where(and(eq(meetings.id, b.meetingId!), eq(meetings.clubId, clubId))).for("share");
      if (!meeting) throw new NotFoundError("Meeting not found");
      if (!["geplant", "abgehalten"].includes(meeting.status)) throw fail.conflict("The meeting is not open for ballots", "meeting_closed");
      rules = await rulesOfMeeting(tx, clubId, meeting);
      requireRules(rules, b);
      // The quorum is checked again whenever a ballot is opened.
      quorum = await computeQuorum(tx, clubId, meeting);
      if (quorum.result === "regeln_fehlen") throw fail.invalid("The statute parameters for the quorum are incomplete", "assembly_rules_incomplete", { missing: ["quorumMode", "quorumValue"] });
      if (quorum.result !== "beschlussfaehig") throw fail.conflict("The assembly has no quorum", "not_quorate", { quorum });
      const eligibility = await loadEligibility(tx, clubId, meeting);
      asOf = eligibility.asOf;
      voters = [...eligibility.byMember.entries()].filter(([, e]) => e.eligible).map(([clubMemberId, e]) => ({ clubMemberId, basis: e.basis }));

      // Record the invitation the assembly was called with; a missing or late one is a warning on the ballot, shown with the result.
      const [firstInvitation] = await tx.select().from(meetingInvitations).where(eq(meetingInvitations.meetingId, meeting.id)).orderBy(asc(meetingInvitations.version)).limit(1);
      if (!firstInvitation) warnings.push("no_invitation");
      else {
        if ((firstInvitation.periodCheck as { ok?: boolean }).ok === false) warnings.push(firstInvitation.exceptionReason ? "invitation_period_exception" : "invitation_period_violated");
        if (meeting.scheduleExceptions.length > 0) warnings.push("date_changed_after_invitation");
      }

      // A resolution needs an announced agenda item; statute-level topics and elections are blocked outright.
      const item = b.agendaItemId ? await tx.query.meetingAgendaItems.findFirst({ where: eq(meetingAgendaItems.id, b.agendaItemId) }) : undefined;
      if (!item || item.announcedInInvitationId === null) {
        const statuteLevel = b.kind === "election" || STATUTE_LEVEL_TOPICS.includes(b.topic);
        if (statuteLevel && rules.agendaRequiredInInvitation !== false) throw fail.invalid("This topic needs an agenda item announced in the invitation", "agenda_item_not_announced");
        warnings.push("agenda_item_not_announced");
      }
    } else {
      rules = await loadAssemblyRules(tx, clubId);
      requireRules(rules, b);
      voters = await circularVoters(tx, clubId, rules, b.audience === "board" ? "board" : "all_voting_members", asOf);
    }

    if (voters.length === 0) throw fail.conflict("Nobody is entitled to vote on this ballot", "no_eligible_voters");
    for (let i = 0; i < voters.length; i += 500) {
      await tx.insert(ballotVoters).values(voters.slice(i, i + 500).map((v) => ({ ballotId: b.id, clubMemberId: v.clubMemberId, eligible: true, basis: v.basis })));
    }
    const { majority } = requireRules(rules, b);
    const withoutAccount = circular
      ? (await tx.select({ n: sql<number>`count(*)::int` }).from(clubMembers).where(and(inArray(clubMembers.id, voters.map((v) => v.clubMemberId)), sql`${clubMembers.memberId} is null`)))[0]!.n
      : 0;
    const [row] = await tx
      .update(ballots)
      .set({
        status: "open",
        majority,
        rulesSnapshot: rules as unknown as Record<string, unknown>,
        opening: { eligible: voters.length, quorum, asOf, warnings, withoutAccount },
        opensAt: args.opensAt ?? sql`now()`,
        closesAt: closesAt ?? null,
        updatedAt: new Date(),
      })
      .where(eq(ballots.id, b.id))
      .returning();
    await writeAudit(tx, { eventType: "ballot.open", subjectId: b.id, actorUserId, payload: { clubId, eligible: voters.length, mode: b.mode, quorum: quorum?.result ?? null, anonymous: b.secret } });
    if (circular) await enqueue({ type: BALLOT_NOTIFY_JOB, payload: { kind: "opened", ballotId: b.id }, dedupeKey: `ballot_opened:${b.id}` }, tx);
    return { ballot: row!, warnings };
  });
  return result;
}

/** Voters of a circular resolution: members with a voting right today, or the accounts holding a board role. */
async function circularVoters(tx: DbExecutor, clubId: string, rules: AssemblyRules, audience: "all_voting_members" | "board", asOf: string): Promise<Array<{ clubMemberId: string; basis: string }>> {
  if (audience === "board") {
    const rows = await tx
      .select({ id: clubMembers.id, status: clubMembers.status, leftAt: clubMembers.leftAt, joinedAt: clubMembers.joinedAt })
      .from(clubRoles)
      .innerJoin(member, eq(member.id, clubRoles.memberId))
      .innerJoin(clubMembers, and(eq(clubMembers.memberId, member.id), eq(clubMembers.clubId, clubId)))
      .where(and(eq(member.organizationId, clubId), inArray(clubRoles.roleType, [...BOARD_ROLE_TYPES])));
    const seen = new Set<string>();
    return rows.filter((r) => !isLeftStatus(effectiveStatus(r, asOf)) && !seen.has(r.id) && !!seen.add(r.id)).map((r) => ({ clubMemberId: r.id, basis: "board" }));
  }
  if (rules.votingStatuses === null || rules.votingStatuses.length === 0 || rules.votingMinAge === null) {
    throw fail.invalid("The statute parameters for the voting right are incomplete", "assembly_rules_incomplete", { missing: ["votingStatuses", "votingMinAge"] });
  }
  return (await deriveAll(tx, clubId, rules, asOf)).filter((r) => r.result.eligible && !r.leftBefore).map((r) => ({ clubMemberId: r.id, basis: r.result.basis }));
}

// --- Voting --------------------------------------------------------------------------------------------------------------

export interface CastVoteArgs {
  clubId: string;
  ballotId: string;
  /** The caller's `club_members.id`. */
  callerClubMemberId: string;
  /** A proxy holder votes for this grantor; omitted = the caller's own vote. */
  forClubMemberId?: string | undefined;
  optionIds: string[];
}

function validateSelection(b: BallotRow, options: BallotOptionRow[], optionIds: string[]) {
  if (new Set(optionIds).size !== optionIds.length) throw fail.invalid("An option may be chosen once", "duplicate_option");
  const chosen = optionIds.map((id) => options.find((o) => o.id === id));
  if (chosen.some((o) => !o)) throw fail.invalid("Unknown option", "unknown_option");
  const kinds = chosen.map((o) => o!.kind);
  const yesNo = options.some((o) => o.kind === "yes");
  if (yesNo && optionIds.length !== 1) throw fail.invalid("Choose exactly one option", "invalid_selection");
  if (optionIds.length < 1 || optionIds.length > b.maxChoices) throw fail.invalid(`Choose between 1 and ${b.maxChoices} options`, "invalid_selection", { maxChoices: b.maxChoices });
  if (kinds.includes("abstain") && optionIds.length > 1) throw fail.invalid("An abstention cannot be combined with another choice", "invalid_selection");
}

export async function castVote(args: CastVoteArgs): Promise<{ forClubMemberId: string }> {
  const { clubId, ballotId, callerClubMemberId } = args;
  const target = args.forClubMemberId ?? callerClubMemberId;
  return db.transaction(async (tx) => {
    // SHARE: closing the ballot (exclusive) waits for every vote accepted before the window ended.
    const [b] = await tx.select().from(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId))).for("share");
    if (!b) throw new NotFoundError("Ballot not found");
    const options = await optionsOf(tx, b.id);
    validateSelection(b, options, args.optionIds);

    const [onRoll] = await tx.select({ eligible: ballotVoters.eligible }).from(ballotVoters).where(and(eq(ballotVoters.ballotId, b.id), eq(ballotVoters.clubMemberId, target)));
    if (!onRoll?.eligible) throw new ForbiddenError("You are not entitled to vote on this ballot", { details: { code: "not_eligible" } });

    if (b.mode === "in_session") {
      // Present in the room (checked in); a proxy holder votes for the grantor who is not present.
      const present = async (id: string) => (await tx.select({ present: meetingAttendance.present }).from(meetingAttendance).where(and(eq(meetingAttendance.meetingId, b.meetingId!), eq(meetingAttendance.clubMemberId, id))))[0]?.present === true;
      if (target === callerClubMemberId) {
        if (!(await present(callerClubMemberId))) throw new ForbiddenError("Check in at the assembly before voting", { details: { code: "not_checked_in" } });
      } else {
        const [proxy] = await tx.select().from(meetingProxies).where(and(eq(meetingProxies.meetingId, b.meetingId!), eq(meetingProxies.grantorClubMemberId, target), eq(meetingProxies.holderClubMemberId, callerClubMemberId)));
        if (!proxy) throw new ForbiddenError("No proxy for this member", { details: { code: "no_proxy" } });
        if (!(await present(callerClubMemberId))) throw new ForbiddenError("Check in at the assembly before voting", { details: { code: "not_checked_in" } });
        if (await present(target)) throw fail.conflict("The proxy giver is present", "grantor_present");
      }
    } else if (target !== callerClubMemberId) {
      throw new ForbiddenError("Proxies do not apply to circular resolutions", { details: { code: "proxy_not_allowed" } });
    }

    const castBy = target === callerClubMemberId ? null : callerClubMemberId;
    const updated = await tx.execute(sql`
      update ballot_voters v set has_voted = true, cast_by_club_member_id = ${castBy}
      from ballots bl
      where v.ballot_id = ${b.id} and bl.id = v.ballot_id and v.club_member_id = ${target} and v.eligible and not v.has_voted
        and bl.status = 'open' and bl.opens_at <= clock_timestamp() and (bl.closes_at is null or clock_timestamp() < bl.closes_at)
      returning v.id`);
    if (updated.rows.length === 0) {
      const [voter] = await tx.select({ eligible: ballotVoters.eligible, hasVoted: ballotVoters.hasVoted }).from(ballotVoters).where(and(eq(ballotVoters.ballotId, b.id), eq(ballotVoters.clubMemberId, target)));
      if (!voter || !voter.eligible) throw new ForbiddenError("You are not entitled to vote on this ballot", { details: { code: "not_eligible" } });
      const state = (await tx.execute(sql`select status, (opens_at > clock_timestamp()) as not_started from ballots where id = ${b.id}`)).rows[0] as { status: string; not_started: boolean };
      if (state.status !== "open") throw fail.conflict("The ballot is not open", "ballot_closed");
      if (state.not_started) throw fail.conflict("The ballot has not started yet", "ballot_not_started");
      if (voter.hasVoted) throw fail.conflict("Already voted", "already_voted");
      throw fail.conflict("The ballot is closed", "ballot_closed");
    }
    if (b.secret) await tx.insert(ballotVotesSecret).values(args.optionIds.map((optionId) => ({ ballotId: b.id, optionId })));
    else await tx.insert(ballotVotesOpen).values(args.optionIds.map((optionId) => ({ ballotId: b.id, optionId, clubMemberId: target })));
    return { forClubMemberId: target };
  });
}

// --- Closing, counting, finalizing ---------------------------------------------------------------------------------------

interface Counted {
  eligible: number;
  voted: number;
}

async function participation(executor: DbExecutor, ballotId: string): Promise<Counted> {
  const [row] = await executor
    .select({ eligible: sql<number>`count(*) filter (where ${ballotVoters.eligible})::int`, voted: sql<number>`count(*) filter (where ${ballotVoters.hasVoted})::int` })
    .from(ballotVoters)
    .where(eq(ballotVoters.ballotId, ballotId));
  return { eligible: row?.eligible ?? 0, voted: row?.voted ?? 0 };
}

export const participationOf = (ballotId: string): Promise<Counted> => participation(db, ballotId);

async function closeLocked(tx: DbExecutor, b: BallotRow, actorUserId: string | null, by: "manual" | "window"): Promise<BallotRow> {
  const p = await participation(tx, b.id);
  const [row] = await tx
    .update(ballots)
    .set({ status: "closed", closedAt: sql`now()`, closesAt: sql`case when ${ballots.closesAt} is null or ${ballots.closesAt} > now() then now() else ${ballots.closesAt} end`, updatedAt: new Date() })
    .where(eq(ballots.id, b.id))
    .returning();
  await writeAudit(tx, { eventType: "ballot.close", subjectId: b.id, clubId: b.clubId, actorUserId, payload: { clubId: b.clubId, by, eligible: p.eligible, participants: p.voted } });
  return row!;
}

/** Materializes the end of the window (read time and scheduler); a no-op while the window is still running. */
export async function settleBallot(clubId: string, ballotId: string): Promise<BallotRow> {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId))).for("update");
    if (!b) throw new NotFoundError("Ballot not found");
    if (b.status !== "open" || !b.closesAt) return b;
    const [{ expired }] = (await tx.execute(sql`select (closes_at <= clock_timestamp()) as expired from ballots where id = ${b.id}`)).rows as Array<{ expired: boolean }>;
    return expired ? closeLocked(tx, b, null, "window") : b;
  });
}

export async function closeBallot(clubId: string, ballotId: string, actorUserId: string): Promise<BallotRow> {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId))).for("update");
    if (!b) throw new NotFoundError("Ballot not found");
    if (b.status !== "open") throw fail.conflict("Only an open ballot can be closed", "ballot_not_open");
    if (b.opensAt && b.opensAt.getTime() > Date.now()) throw fail.conflict("The ballot has not started yet; cancel it instead", "ballot_not_started");
    return closeLocked(tx, b, actorUserId, "manual");
  });
}

type Tallies = Array<{ optionId: string; label: string; kind: string; votes: number }>;

async function tallyOf(tx: DbExecutor, b: BallotRow, options: BallotOptionRow[]): Promise<Tallies> {
  const table = b.secret ? ballotVotesSecret : ballotVotesOpen;
  const rows = await tx.select({ optionId: table.optionId, n: sql<number>`count(*)::int` }).from(table).where(eq(table.ballotId, b.id)).groupBy(table.optionId);
  const byOption = new Map(rows.map((r) => [r.optionId, r.n]));
  return options.map((o) => ({ optionId: o.id, label: o.label, kind: o.kind, votes: byOption.get(o.id) ?? 0 }));
}

export async function countBallot(clubId: string, ballotId: string, actorUserId: string | null): Promise<BallotRow> {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId))).for("update");
    if (!b) throw new NotFoundError("Ballot not found");
    if (b.status !== "closed") throw fail.conflict("Only a closed ballot can be counted", "ballot_not_closed");
    const options = await optionsOf(tx, b.id);
    const tallies = await tallyOf(tx, b, options);
    const p = await participation(tx, b.id);
    const rules = parseStoredAssemblyRules(b.rulesSnapshot);
    const opening = (b.opening ?? {}) as { quorum?: { result?: string } | null; warnings?: string[] };
    const quorum = (opening.quorum?.result ?? null) as "beschlussfaehig" | "nicht_beschlussfaehig" | "regeln_fehlen" | null;
    const votesOf = (kind: string) => tallies.filter((t) => t.kind === kind).reduce((n, t) => n + t.votes, 0);
    const cast = tallies.reduce((n, t) => n + t.votes, 0);
    if (cast < p.voted) throw fail.conflict("The recorded votes do not match the participation", "count_mismatch");

    const yesNo = options.some((o) => o.kind === "yes");
    const abstainCountsAs = rules.abstainCountsAs ?? "not_counted";
    const common = {
      majority: b.majority,
      abstainCountsAs,
      eligible: p.eligible,
      participants: p.voted,
      tallies,
      quorum,
      flags: { unannouncedAgendaItem: (opening.warnings ?? []).includes("agenda_item_not_announced") },
    };
    let result: Record<string, unknown>;
    if (yesNo) {
      if (cast !== p.voted) throw fail.conflict("The recorded votes do not match the participation", "count_mismatch");
      const evaluation = evaluateBallot({
        majority: b.majority as never,
        abstainCountsAs,
        counts: { yes: votesOf("yes"), no: votesOf("no"), abstain: votesOf("abstain") },
        eligible: p.eligible,
        quorum: b.mode === "circular" ? null : quorum,
        ...(b.mode === "circular" ? { circular: { unanimity: rules.circularUnanimity, minParticipation: rules.circularMinParticipation } } : {}),
      });
      result = { ...common, form: "yes_no", outcome: evaluation.outcome, reason: evaluation.reason, yes: evaluation.yes, no: evaluation.no, abstain: evaluation.abstain };
    } else {
      const evaluation = evaluateChoices({
        majority: b.majority as never,
        abstainCountsAs,
        options: tallies.filter((t) => t.kind !== "abstain").map((t) => ({ id: t.optionId, votes: t.votes })),
        abstainers: votesOf("abstain"),
        participants: p.voted,
        seats: b.maxChoices,
        quorum,
      });
      result = { ...common, form: "choice", seats: b.maxChoices, outcome: evaluation.outcome, electedOptionIds: evaluation.electedIds, tiedOptionIds: evaluation.tiedIds, openSeats: evaluation.openSeats, qualifiedOptionIds: evaluation.qualified.map((o) => o.id) };
    }
    const [row] = await tx.update(ballots).set({ status: "counted", countedAt: sql`now()`, result: { ...result, final: false }, updatedAt: new Date() }).where(eq(ballots.id, b.id)).returning();
    await writeAudit(tx, { eventType: "ballot.count", subjectId: b.id, clubId: b.clubId, actorUserId, payload: { clubId: b.clubId, outcome: result.outcome as string } });
    return row!;
  });
}

interface ResultDoc {
  form?: string;
  outcome?: string;
  yes?: number;
  no?: number;
  abstain?: number;
  tallies?: Tallies;
  electedOptionIds?: string[];
  eligible?: number;
  participants?: number;
  flags?: { unannouncedAgendaItem?: boolean };
  [key: string]: unknown;
}

function minutesText(args: { b: BallotRow; result: ResultDoc; resultHash: string; timezone: string }): string {
  const { b, result, resultHash, timezone } = args;
  const tallies = (result.tallies ?? []).map((t) => `- ${t.label}: ${t.votes}`).join("\n");
  const outcome = String(result.outcome);
  return [
    "# Beschlussprotokoll (Umlaufbeschluss)",
    "",
    `**Gegenstand:** ${b.title}`,
    ...(b.description ? ["", b.description] : []),
    "",
    `- Abstimmungsfenster: ${formatWhen(b.opensAt, timezone)} bis ${formatWhen(b.closesAt, timezone)}`,
    `- Stimmberechtigte: ${result.eligible}, abgegebene Stimmzettel: ${result.participants}`,
    `- Verfahren: ${b.secret ? "geheim" : "offen (namentlich)"}; Mehrheitsart: ${b.majority}`,
    "",
    "## Ergebnis",
    tallies,
    "",
    `**Beschluss: ${outcome.replace(/_/g, " ")}**`,
    "",
    `Prüfsumme (SHA-256 des Ergebnisses): ${resultHash}`,
    "",
  ].join("\n");
}

export async function finalizeBallot(clubId: string, ballotId: string, actorUserId: string | null): Promise<BallotRow> {
  const timezone = await clubTimezone(clubId);
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId))).for("update");
    if (!b) throw new NotFoundError("Ballot not found");
    if (b.status !== "counted") throw fail.conflict("Only a counted ballot can be finalized", "ballot_not_counted");
    const finalizedAt = new Date();
    const result: ResultDoc = { ...(b.result ?? {}), final: true, finalizedAt: finalizedAt.toISOString() };
    const resultHash = hashContent(result);
    const flags = result.flags ?? {};
    let meetingId = b.meetingId;

    if (b.mode === "circular") {
      // The record of a circular resolution: a meeting of its own (board circulars are read-scoped like board meetings) and the minutes.
      const board = b.audience === "board";
      const [created] = await tx
        .insert(meetings)
        .values({ clubId, type: board ? "vorstandssitzung" : "sonstige", title: `Umlaufbeschluss: ${b.title}`, scheduledAt: b.closesAt, status: "protokolliert", rulesSnapshot: b.rulesSnapshot, createdBy: b.createdBy })
        .returning({ id: meetings.id });
      meetingId = created!.id;
      if (board) {
        const voters = await tx.select({ id: ballotVoters.clubMemberId }).from(ballotVoters).where(eq(ballotVoters.ballotId, b.id));
        const ids = voters.flatMap((v) => (v.id ? [v.id] : []));
        if (ids.length > 0) await tx.insert(meetingInvitees).values(ids.map((clubMemberId) => ({ meetingId: meetingId!, clubMemberId, response: "zugesagt" })));
      }
      const content = minutesText({ b, result, resultHash, timezone });
      await tx.insert(meetingMinutes).values({ meetingId, version: 1, status: "archiviert", content, contentHash: minutesHash(content), approvedAt: finalizedAt, createdBy: b.createdBy });
    }

    if (b.kind === "resolution" && meetingId) {
      const unannounced = flags.unannouncedAgendaItem ? " (nicht in der Einladung angekündigt)" : "";
      const yesNo = result.form === "yes_no";
      const tallies = result.tallies ?? [];
      const winner = !yesNo ? tallies.find((t) => (result.electedOptionIds ?? []).includes(t.optionId)) : undefined;
      await tx.insert(meetingResolutions).values({
        meetingId,
        description: `${b.title}${unannounced}`,
        votesFor: yesNo ? Number(result.yes) : (winner?.votes ?? 0),
        votesAgainst: yesNo ? Number(result.no) : 0,
        votesAbstain: yesNo ? Number(result.abstain) : (tallies.find((t) => t.kind === "abstain")?.votes ?? 0),
        result: yesNo ? String(result.outcome) : (winner ? `entschieden: ${winner.label}` : String(result.outcome)),
        ballotId: b.id,
        agendaItemId: b.agendaItemId,
        source: "digital",
      });
    }
    const [row] = await tx.update(ballots).set({ status: "finalized", finalizedAt, result, resultHash, meetingId, updatedAt: finalizedAt }).where(eq(ballots.id, b.id)).returning();
    await writeAudit(tx, { eventType: "ballot.finalize", subjectId: b.id, clubId, actorUserId, payload: { clubId, outcome: String(result.outcome), resultHash } });
    return row!;
  });
}

export async function cancelBallot(clubId: string, ballotId: string, actorUserId: string): Promise<BallotRow> {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(ballots).where(and(eq(ballots.id, ballotId), eq(ballots.clubId, clubId))).for("update");
    if (!b) throw new NotFoundError("Ballot not found");
    if (b.status === "finalized" || b.status === "cancelled") throw fail.conflict("The ballot is already final", "ballot_final");
    const [row] = await tx.update(ballots).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ballots.id, b.id)).returning();
    await writeAudit(tx, { eventType: "ballot.cancel", subjectId: b.id, actorUserId, payload: { clubId, previousStatus: b.status } });
    return row!;
  });
}

// --- Reading -------------------------------------------------------------------------------------------------------------

/** Fisher-Yates with a CSPRNG: the order of a secret ballot's votes must not follow the order they were stored in. */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The individual votes of a closed ballot: named for an open ballot, anonymous and shuffled for a secret one. */
export async function listVotes(b: BallotRow): Promise<Array<{ optionId: string; clubMemberId?: string | null; displayName?: string | null }>> {
  if (b.secret) {
    const rows = await db.select({ optionId: ballotVotesSecret.optionId }).from(ballotVotesSecret).where(eq(ballotVotesSecret.ballotId, b.id));
    return shuffled(rows);
  }
  return db
    .select({ optionId: ballotVotesOpen.optionId, clubMemberId: ballotVotesOpen.clubMemberId, displayName: clubMembers.displayName })
    .from(ballotVotesOpen)
    .leftJoin(clubMembers, eq(clubMembers.id, ballotVotesOpen.clubMemberId))
    .where(eq(ballotVotesOpen.ballotId, b.id))
    .orderBy(asc(clubMembers.displayName), asc(ballotVotesOpen.optionId));
}

export interface MyBallotState {
  eligible: boolean;
  hasVoted: boolean;
  canVote: boolean;
  checkedIn: boolean | null;
  ownVoteOptionIds: string[] | null;
  proxies: Array<{ grantorClubMemberId: string; displayName: string | null; hasVoted: boolean }>;
}

/** What the caller can do on a ballot: their own entry, the proxies they hold and (open ballots only) their own vote. */
export async function myBallotState(b: BallotRow, me: string | null): Promise<MyBallotState> {
  const none: MyBallotState = { eligible: false, hasVoted: false, canVote: false, checkedIn: null, ownVoteOptionIds: null, proxies: [] };
  if (!me || b.status === "draft") return none;
  const [own] = await db.select({ eligible: ballotVoters.eligible, hasVoted: ballotVoters.hasVoted }).from(ballotVoters).where(and(eq(ballotVoters.ballotId, b.id), eq(ballotVoters.clubMemberId, me)));
  const voting = phaseOf(b) === "voting";
  let checkedIn: boolean | null = null;
  const proxies: MyBallotState["proxies"] = [];
  if (b.mode === "in_session" && b.meetingId) {
    const [att] = await db.select({ present: meetingAttendance.present }).from(meetingAttendance).where(and(eq(meetingAttendance.meetingId, b.meetingId), eq(meetingAttendance.clubMemberId, me)));
    checkedIn = att?.present === true;
    const held = await db
      .select({ grantor: meetingProxies.grantorClubMemberId, hasVoted: ballotVoters.hasVoted, displayName: clubMembers.displayName })
      .from(meetingProxies)
      .innerJoin(ballotVoters, and(eq(ballotVoters.ballotId, b.id), eq(ballotVoters.clubMemberId, meetingProxies.grantorClubMemberId), eq(ballotVoters.eligible, true)))
      .leftJoin(clubMembers, eq(clubMembers.id, meetingProxies.grantorClubMemberId))
      .where(and(eq(meetingProxies.meetingId, b.meetingId), eq(meetingProxies.holderClubMemberId, me)));
    for (const h of held) if (h.grantor) proxies.push({ grantorClubMemberId: h.grantor, displayName: h.displayName, hasVoted: h.hasVoted });
  }
  const ownVoteOptionIds = !b.secret && own?.hasVoted ? (await db.select({ optionId: ballotVotesOpen.optionId }).from(ballotVotesOpen).where(and(eq(ballotVotesOpen.ballotId, b.id), eq(ballotVotesOpen.clubMemberId, me)))).map((r) => r.optionId) : null;
  return {
    eligible: own?.eligible === true,
    hasVoted: own?.hasVoted === true,
    canVote: voting && own?.eligible === true && !own.hasVoted && (b.mode === "circular" || checkedIn === true),
    checkedIn,
    ownVoteOptionIds,
    proxies: voting && checkedIn ? proxies : [],
  };
}
