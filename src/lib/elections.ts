import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { ballotOptions, ballots, clubRoleTerms, electionCandidates, elections, type ElectionCandidateRow, type ElectionRow } from "../db/schema/assembly.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { meetingResolutions, meetings } from "../db/schema/meetings.js";
import { writeAudit } from "./audit.js";
import { loadAssemblyRules, MAJORITY_KINDS } from "./assembly-rules.js";
import { insertBallot } from "./ballots.js";
import { ASSIGNABLE_ROLE_TYPES } from "./club-permissions.js";
import type { DbExecutor } from "./club-members.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { resolveClubMember } from "./meeting-members.js";
import { todayBerlin } from "./member-lifecycle.js";

/**
 * Elections and the feedback into the role model (Wave 11 B7). An election is the office to fill (`role_type`, department,
 * seats, term, election lead); every Wahlgang is a `ballots` row of kind `election` (Stichwahl = the next round), voted and
 * counted by `lib/ballots.ts`. This module sets the rounds up, turns a finalized round into elected candidates (a tie at the
 * last seat needs a documented lot, it is never decided silently) and, once an elected person accepts, writes `club_roles`
 * (with `term_ends_at`) and the history `club_role_terms`. The previous holders of the office end when the new group is
 * complete and active. An elected person without an account is `pending_account`: the role follows automatically when the
 * account is linked (`grantPendingElectionRoles`). The roles an election can fill are the assignable ones except the guardian role.
 */

export const ELECTION_ROLE_TYPES = ASSIGNABLE_ROLE_TYPES.filter((r) => r !== "erziehungsberechtigt");
/** Roles that belong to a department (the election then needs one). */
export const DEPARTMENT_ROLE_TYPES: readonly string[] = ["abteilungsleitung", "trainer"];

const fail = {
  conflict: (message: string, code: string, extra: Record<string, unknown> = {}) => new ConflictError(message, { details: { code, ...extra } }),
  invalid: (message: string, code: string, extra: Record<string, unknown> = {}) => new ValidationError(message, { details: { code, ...extra } }),
};

/** Candidates who hold or will hold a seat of the election. */
const SEATED = ["elected", "accepted", "pending_account"] as const;

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

export async function loadElection(executor: DbExecutor, clubId: string, id: string): Promise<ElectionRow> {
  const row = await executor.query.elections.findFirst({ where: and(eq(elections.id, id), eq(elections.clubId, clubId)) });
  if (!row) throw new NotFoundError("Election not found");
  return row;
}

export async function candidatesOf(executor: DbExecutor, electionId: string): Promise<ElectionCandidateRow[]> {
  return executor.select().from(electionCandidates).where(eq(electionCandidates.electionId, electionId)).orderBy(asc(electionCandidates.createdAt), asc(electionCandidates.id));
}

async function assertMeeting(executor: DbExecutor, clubId: string, meetingId: string) {
  const meeting = await executor.query.meetings.findFirst({ where: and(eq(meetings.id, meetingId), eq(meetings.clubId, clubId)), columns: { type: true } });
  if (!meeting) throw new NotFoundError("Meeting not found");
  if (meeting.type !== "mitgliederversammlung") throw fail.invalid("Elections are held in the general assembly", "ballot_meeting_not_supported");
}

async function assertLead(executor: DbExecutor, clubId: string, electionId: string | null, leadId: string) {
  if (!(await resolveClubMember(executor, clubId, { clubMemberId: leadId }))) throw new NotFoundError("Member not found in this club");
  if (electionId) {
    const [candidate] = await executor.select({ id: electionCandidates.id }).from(electionCandidates).where(and(eq(electionCandidates.electionId, electionId), eq(electionCandidates.clubMemberId, leadId), inArray(electionCandidates.status, ["proposed", "willing", ...SEATED])));
    if (candidate) throw fail.conflict("The election lead cannot be a candidate", "lead_is_candidate");
  }
}

export interface CreateElectionInput {
  clubId: string;
  actorUserId: string;
  meetingId?: string | undefined;
  roleType: string;
  departmentId?: string | undefined;
  seats: number;
  termMonths?: number | undefined;
  electionLeadClubMemberId?: string | undefined;
}

async function assertOffice(executor: DbExecutor, clubId: string, roleType: string, departmentId: string | null | undefined) {
  const bound = DEPARTMENT_ROLE_TYPES.includes(roleType);
  if (bound && !departmentId) throw fail.invalid("This office belongs to a department", "department_required");
  if (!bound && departmentId) throw fail.invalid("This office has no department", "department_not_allowed");
  if (departmentId && !(await executor.query.departments.findFirst({ where: and(eq(departments.id, departmentId), eq(departments.clubId, clubId)), columns: { id: true } }))) throw new NotFoundError("Department not found");
}

export async function createElection(input: CreateElectionInput): Promise<ElectionRow> {
  if (!(ELECTION_ROLE_TYPES as readonly string[]).includes(input.roleType)) throw fail.invalid("This office cannot be filled by an election", "role_not_electable");
  await assertOffice(db, input.clubId, input.roleType, input.departmentId);
  if (input.meetingId) await assertMeeting(db, input.clubId, input.meetingId);
  if (input.electionLeadClubMemberId) await assertLead(db, input.clubId, null, input.electionLeadClubMemberId);
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(elections)
      .values({ clubId: input.clubId, meetingId: input.meetingId ?? null, roleType: input.roleType, departmentId: input.departmentId ?? null, seats: input.seats, termMonths: input.termMonths ?? null, electionLeadClubMemberId: input.electionLeadClubMemberId ?? null, createdBy: input.actorUserId })
      .returning();
    await writeAudit(tx, { eventType: "election.create", subjectId: row!.id, actorUserId: input.actorUserId, payload: { clubId: input.clubId, roleType: input.roleType, seats: input.seats } });
    return row!;
  });
}

export interface UpdateElectionInput {
  meetingId?: string | undefined;
  seats?: number | undefined;
  termMonths?: number | null | undefined;
  electionLeadClubMemberId?: string | null | undefined;
}

export async function updateElection(clubId: string, id: string, actorUserId: string, patch: UpdateElectionInput): Promise<ElectionRow> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(elections).where(and(eq(elections.id, id), eq(elections.clubId, clubId))).for("update");
    if (!locked) throw new NotFoundError("Election not found");
    if (locked.status === "closed") throw fail.conflict("The election is closed", "election_closed");
    if (patch.meetingId) await assertMeeting(tx, clubId, patch.meetingId);
    if (patch.electionLeadClubMemberId) await assertLead(tx, clubId, id, patch.electionLeadClubMemberId);
    if (patch.seats !== undefined) {
      const seated = (await candidatesOf(tx, id)).filter((c) => (SEATED as readonly string[]).includes(c.status)).length;
      if (patch.seats < seated) throw fail.conflict("There are already more elected candidates than seats", "seats_below_elected");
    }
    const set: Partial<typeof elections.$inferInsert> = {};
    if (patch.meetingId !== undefined) set.meetingId = patch.meetingId;
    if (patch.seats !== undefined) set.seats = patch.seats;
    if (patch.termMonths !== undefined) set.termMonths = patch.termMonths;
    if (patch.electionLeadClubMemberId !== undefined) set.electionLeadClubMemberId = patch.electionLeadClubMemberId;
    const [row] = await tx.update(elections).set(set).where(eq(elections.id, id)).returning();
    await writeAudit(tx, { eventType: "election.update", subjectId: id, actorUserId, payload: { clubId, changedFields: Object.keys(set) } });
    return row!;
  });
}

// --- Candidates ------------------------------------------------------------------------------------------------------------

export async function proposeCandidate(args: { clubId: string; electionId: string; clubMemberId: string; proposedBy: string | null; actorUserId: string; willing?: boolean }): Promise<ElectionCandidateRow> {
  return db.transaction(async (tx) => {
    const election = await lockElection(tx, args.clubId, args.electionId);
    if (election.status === "decided" || election.status === "closed") throw fail.conflict("The seats are filled", "election_filled");
    const person = await resolveClubMember(tx, args.clubId, { clubMemberId: args.clubMemberId });
    if (!person) throw new NotFoundError("Member not found in this club");
    if (election.electionLeadClubMemberId === person.id) throw fail.conflict("The election lead cannot be a candidate", "lead_is_candidate");
    const [existing] = await tx.select().from(electionCandidates).where(and(eq(electionCandidates.electionId, election.id), eq(electionCandidates.clubMemberId, person.id)));
    if (existing) throw fail.conflict("Already a candidate", "already_candidate");
    const status = args.willing ? "willing" : "proposed";
    const [row] = await tx.insert(electionCandidates).values({ electionId: election.id, clubMemberId: person.id, proposedBy: args.proposedBy, status }).returning();
    await writeAudit(tx, { eventType: "election.candidate", subjectId: election.id, actorUserId: args.actorUserId, payload: { action: "propose", clubId: args.clubId, clubMemberId: person.id, status } });
    return row!;
  });
}

/** A candidate says yes, no or withdraws. Elected candidates answer through `answerElection`, not here. */
export async function setCandidateStatus(args: { clubId: string; electionId: string; candidateId: string; status: "willing" | "declined" | "withdrawn"; actorUserId: string; manager: boolean }): Promise<ElectionCandidateRow> {
  return db.transaction(async (tx) => {
    const election = await lockElection(tx, args.clubId, args.electionId);
    const [candidate] = await tx.select().from(electionCandidates).where(and(eq(electionCandidates.id, args.candidateId), eq(electionCandidates.electionId, election.id))).for("update");
    if (!candidate) throw new NotFoundError("Candidate not found");
    const allowed: Record<string, string[]> = { proposed: ["willing", "declined", "withdrawn"], willing: ["withdrawn"], declined: onlyManager(args.manager, ["willing"]), withdrawn: onlyManager(args.manager, ["willing"]) };
    if (!(allowed[candidate.status] ?? []).includes(args.status)) throw fail.conflict("This change is not possible in the current state", "invalid_candidate_transition", { from: candidate.status, to: args.status });
    if (args.status === "withdrawn" || args.status === "declined") {
      const running = await tx
        .select({ id: ballots.id })
        .from(ballots)
        .innerJoin(ballotOptions, eq(ballotOptions.ballotId, ballots.id))
        .where(and(eq(ballots.electionId, election.id), eq(ballotOptions.candidateClubMemberId, candidate.clubMemberId!), inArray(ballots.status, ["draft", "open"])));
      if (running.length > 0) throw fail.conflict("The candidate is on a round that is not finished", "round_running");
    }
    const [row] = await tx.update(electionCandidates).set({ status: args.status }).where(eq(electionCandidates.id, candidate.id)).returning();
    await writeAudit(tx, { eventType: "election.candidate", subjectId: election.id, actorUserId: args.actorUserId, payload: { action: "status", clubId: args.clubId, clubMemberId: candidate.clubMemberId, status: args.status } });
    return row!;
  });
}

const onlyManager = (isManager: boolean, values: string[]): string[] => (isManager ? values : []);

export async function removeCandidate(clubId: string, electionId: string, candidateId: string, actorUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const election = await lockElection(tx, clubId, electionId);
    const [candidate] = await tx.select().from(electionCandidates).where(and(eq(electionCandidates.id, candidateId), eq(electionCandidates.electionId, election.id))).for("update");
    if (!candidate) throw new NotFoundError("Candidate not found");
    if ((SEATED as readonly string[]).includes(candidate.status)) throw fail.conflict("An elected candidate cannot be removed", "candidate_elected");
    const used = candidate.clubMemberId ? await tx.select({ id: ballotOptions.id }).from(ballotOptions).innerJoin(ballots, eq(ballots.id, ballotOptions.ballotId)).where(and(eq(ballots.electionId, election.id), eq(ballotOptions.candidateClubMemberId, candidate.clubMemberId))).limit(1) : [];
    if (used.length > 0) throw fail.conflict("The candidate stood in a round", "candidate_in_round");
    await tx.delete(electionCandidates).where(eq(electionCandidates.id, candidate.id));
    await writeAudit(tx, { eventType: "election.candidate", subjectId: election.id, actorUserId, payload: { action: "remove", clubId, clubMemberId: candidate.clubMemberId, status: candidate.status } });
  });
}

async function lockElection(tx: DbExecutor, clubId: string, id: string): Promise<ElectionRow> {
  const [row] = await tx.select().from(elections).where(and(eq(elections.id, id), eq(elections.clubId, clubId))).for("update");
  if (!row) throw new NotFoundError("Election not found");
  return row;
}

// --- Rounds ----------------------------------------------------------------------------------------------------------------

export interface CreateRoundInput {
  clubId: string;
  electionId: string;
  actorUserId: string;
  /** Narrow a Stichwahl down to these candidates (default: every willing candidate who is not elected). */
  candidateIds?: string[] | undefined;
  secret?: boolean | undefined;
  /** Majority kind of this round; default: the statute's `wahl` majority when the round opens. */
  majority?: (typeof MAJORITY_KINDS)[number] | undefined;
  agendaItemId?: string | null | undefined;
}

/** Sets up the next Wahlgang as a draft ballot (the board opens, closes, counts and finalizes it like any other ballot). */
export async function createRound(input: CreateRoundInput): Promise<{ ballotId: string; round: number }> {
  const { clubId } = input;
  if (input.secret && !(await loadAssemblyRules(db, clubId)).secretBallotDigitalAllowed) throw fail.invalid("Digital secret ballots are not enabled for this club", "secret_ballot_not_allowed");
  return db.transaction(async (tx) => {
    const election = await lockElection(tx, clubId, input.electionId);
    if (!election.meetingId) throw fail.invalid("Assign the election to a general assembly first", "meeting_required");
    if (election.status === "decided" || election.status === "closed") throw fail.conflict("The seats are filled", "election_filled");
    const rounds = await tx.select().from(ballots).where(eq(ballots.electionId, election.id)).orderBy(asc(ballots.round));
    if (rounds.some((r) => !["finalized", "cancelled"].includes(r.status))) throw fail.conflict("The previous round is not finished", "round_pending");
    // A finalized round must be decided (or its result discarded by cancelling) before the next one starts.
    const decided = new Set((((election.decision ?? {}) as { rounds?: Array<{ ballotId: string }> }).rounds ?? []).map((r) => r.ballotId));
    if (rounds.some((r) => r.status === "finalized" && !decided.has(r.id))) throw fail.conflict("Decide the previous round first", "round_not_decided");

    const all = await candidatesOf(tx, election.id);
    const seated = all.filter((c) => (SEATED as readonly string[]).includes(c.status)).length;
    const seatsLeft = election.seats - seated;
    if (seatsLeft < 1) throw fail.conflict("The seats are filled", "election_filled");
    let pool = all.filter((c) => c.status === "willing");
    if (input.candidateIds) {
      const wanted = new Set(input.candidateIds);
      if (input.candidateIds.some((id) => !pool.some((c) => c.id === id))) throw fail.invalid("Only willing candidates can stand in a round", "candidate_not_willing");
      pool = pool.filter((c) => wanted.has(c.id));
    }
    if (pool.length === 0) throw fail.invalid("There is no willing candidate", "no_candidates");
    const people = await tx.select({ id: clubMembers.id, displayName: clubMembers.displayName }).from(clubMembers).where(inArray(clubMembers.id, pool.map((c) => c.clubMemberId!)));
    const names = new Map(people.map((p) => [p.id, p.displayName]));
    const number = rounds.filter((r) => r.status !== "cancelled").length + 1;
    const ballot = await insertBallot(
      tx,
      {
        clubId,
        meetingId: election.meetingId,
        agendaItemId: input.agendaItemId ?? null,
        title: `Wahl ${officeLabel(election)}, Wahlgang ${number}`,
        mode: "in_session",
        kind: "election",
        electionId: election.id,
        round: number,
        secret: input.secret ?? false,
        topic: "wahl",
        majority: input.majority ?? null,
        maxChoices: Math.min(seatsLeft, pool.length),
        createdBy: input.actorUserId,
      },
      [...pool.map((c) => ({ label: names.get(c.clubMemberId!) ?? "?", kind: "candidate" as const, candidateClubMemberId: c.clubMemberId })), { label: "Enthaltung", kind: "abstain" as const }],
    );
    if (election.status === "planned") await tx.update(elections).set({ status: "running" }).where(eq(elections.id, election.id));
    await writeAudit(tx, { eventType: "ballot.create", subjectId: ballot.id, actorUserId: input.actorUserId, payload: { clubId, kind: "election", meetingId: election.meetingId, mode: "in_session", anonymous: ballot.secret } });
    return { ballotId: ballot.id, round: number };
  });
}

export const officeLabel = (e: Pick<ElectionRow, "roleType">): string =>
  ({ vorsitz: "Vorsitz", stellv_vorsitz: "stellvertretender Vorsitz", kassenwart: "Kassenwart", schriftfuehrer: "Schriftführung", beisitzer: "Beisitz", abteilungsleitung: "Abteilungsleitung", trainer: "Trainer" })[e.roleType] ?? e.roleType;

// --- Deciding a round ------------------------------------------------------------------------------------------------------

interface RoundDecision {
  round: number;
  ballotId: string;
  electedCandidateIds: string[];
  lot: { note: string; candidateIds: string[] } | null;
  decidedAt: string;
}

export interface DecideInput {
  clubId: string;
  electionId: string;
  actorUserId: string;
  /** Candidates (election_candidates.id) who win the open seats of a tie; the note documents how it was drawn. */
  lot?: { candidateIds: string[]; note: string } | undefined;
}

/** Turns the latest finalized round into elected candidates (nobody elected is a valid, recorded outcome: the next round follows). */
export async function decideElection(input: DecideInput): Promise<{ round: number; electedCandidateIds: string[]; filled: boolean }> {
  const { clubId } = input;
  return db.transaction(async (tx) => {
    const election = await lockElection(tx, clubId, input.electionId);
    if (election.status === "decided" || election.status === "closed") throw fail.conflict("The seats are filled", "election_filled");
    const [latest] = await tx.select().from(ballots).where(and(eq(ballots.electionId, election.id), ne(ballots.status, "cancelled"))).orderBy(desc(ballots.round)).limit(1);
    if (!latest || latest.status !== "finalized") throw fail.conflict("The latest round is not finalized", "round_not_final");
    const history = ((election.decision ?? {}) as { rounds?: RoundDecision[] }).rounds ?? [];
    if (history.some((r) => r.ballotId === latest.id)) throw fail.conflict("This round is already decided", "round_decided");

    const result = (latest.result ?? {}) as { outcome?: string; electedOptionIds?: string[]; tiedOptionIds?: string[]; openSeats?: number; tallies?: Array<{ optionId: string; votes: number; kind: string }> };
    const options = await tx.select().from(ballotOptions).where(eq(ballotOptions.ballotId, latest.id));
    const candidates = await candidatesOf(tx, election.id);
    const toCandidate = (optionId: string) => {
      const memberId = options.find((o) => o.id === optionId)?.candidateClubMemberId;
      return candidates.find((c) => c.clubMemberId === memberId);
    };
    let winners = (result.electedOptionIds ?? []).map(toCandidate).filter((c): c is ElectionCandidateRow => !!c);

    let lot: RoundDecision["lot"] = null;
    if (result.outcome === "gleichstand") {
      const tied = (result.tiedOptionIds ?? []).map(toCandidate).filter((c): c is ElectionCandidateRow => !!c);
      const openSeats = result.openSeats ?? 0;
      if (!input.lot) throw fail.conflict("The votes tie: record the lot", "tie_needs_lot", { tiedCandidateIds: tied.map((c) => c.id), openSeats });
      const picked = [...new Set(input.lot.candidateIds)];
      if (picked.length !== openSeats || picked.some((id) => !tied.some((c) => c.id === id))) throw fail.invalid("The lot must name exactly the open seats among the tied candidates", "invalid_lot", { tiedCandidateIds: tied.map((c) => c.id), openSeats });
      lot = { note: input.lot.note, candidateIds: picked };
      winners = [...winners, ...tied.filter((c) => picked.includes(c.id))];
    } else if (input.lot) {
      throw fail.invalid("There is no tie to draw a lot for", "no_tie");
    }

    // A round without a winner (no majority, no quorum) is recorded too: the next round may start.
    if (winners.length > 0) await tx.update(electionCandidates).set({ status: "elected" }).where(inArray(electionCandidates.id, winners.map((c) => c.id)));
    const seated = candidates.filter((c) => (SEATED as readonly string[]).includes(c.status)).length + winners.length;
    const filled = seated >= election.seats;
    const entry: RoundDecision = { round: latest.round ?? 1, ballotId: latest.id, electedCandidateIds: winners.map((c) => c.id), lot, decidedAt: new Date().toISOString() };
    await tx
      .update(elections)
      .set({ decision: { rounds: [...history, entry] }, status: filled ? "decided" : "running", decidedAt: filled ? new Date() : null })
      .where(eq(elections.id, election.id));

    // The record of the assembly: who was elected, with the votes.
    if (election.meetingId) {
      const people = winners.length === 0 ? [] : await tx.select({ id: clubMembers.id, displayName: clubMembers.displayName }).from(clubMembers).where(inArray(clubMembers.id, winners.map((c) => c.clubMemberId!)));
      const votesOf = (c: ElectionCandidateRow) => result.tallies?.find((t) => t.optionId === options.find((o) => o.candidateClubMemberId === c.clubMemberId)?.id)?.votes ?? 0;
      await tx.insert(meetingResolutions).values({
        meetingId: election.meetingId,
        description: winners.length === 0 ? `Wahl ${officeLabel(election)}, Wahlgang ${entry.round}: kein Ergebnis` : `Wahl ${officeLabel(election)}, Wahlgang ${entry.round}: gewählt ${people.map((p) => p.displayName).join(", ")}${lot ? " (Losentscheid bei Stimmengleichheit)" : ""}`,
        votesFor: winners.reduce((n, c) => n + votesOf(c), 0),
        votesAgainst: 0,
        votesAbstain: result.tallies?.find((t) => t.kind === "abstain")?.votes ?? 0,
        result: winners.length === 0 ? "kein Ergebnis" : "gewählt",
        ballotId: latest.id,
        agendaItemId: latest.agendaItemId,
        source: "digital",
      });
    }
    await writeAudit(tx, { eventType: "election.decide", subjectId: election.id, actorUserId: input.actorUserId, payload: { clubId, electedCount: winners.length, lot: lot !== null, round: entry.round } });
    return { round: entry.round, electedCandidateIds: entry.electedCandidateIds, filled };
  });
}

// --- Acceptance and the role feedback ---------------------------------------------------------------------------------------

/** Writes the role (with the end of the term) and the term history for a member who has an account. */
async function grantRole(tx: DbExecutor, election: ElectionRow, clubMemberId: string, accountMemberId: string): Promise<void> {
  const today = todayBerlin();
  const termEndsAt = election.termMonths ? addMonths(today, election.termMonths) : null;
  const [existing] = await tx
    .select()
    .from(clubRoles)
    .where(and(eq(clubRoles.memberId, accountMemberId), eq(clubRoles.roleType, election.roleType), election.departmentId ? eq(clubRoles.departmentId, election.departmentId) : isNull(clubRoles.departmentId)));
  if (existing) await tx.update(clubRoles).set({ termEndsAt }).where(eq(clubRoles.id, existing.id));
  else await tx.insert(clubRoles).values({ memberId: accountMemberId, roleType: election.roleType, departmentId: election.departmentId, termEndsAt });
  const [openTerm] = await tx
    .select({ id: clubRoleTerms.id })
    .from(clubRoleTerms)
    .where(and(eq(clubRoleTerms.clubId, election.clubId), eq(clubRoleTerms.clubMemberId, clubMemberId), eq(clubRoleTerms.roleType, election.roleType), election.departmentId ? eq(clubRoleTerms.departmentId, election.departmentId) : isNull(clubRoleTerms.departmentId), isNull(clubRoleTerms.endsOn)));
  if (!openTerm) await tx.insert(clubRoleTerms).values({ clubId: election.clubId, clubMemberId, roleType: election.roleType, departmentId: election.departmentId, startsOn: today, electionId: election.id });
  else await tx.update(clubRoleTerms).set({ electionId: election.id }).where(eq(clubRoleTerms.id, openTerm.id));
  await writeAudit(tx, { eventType: "election.role_grant", subjectId: election.id, payload: { clubId: election.clubId, clubMemberId, electionId: election.id, roleType: election.roleType, termEndsAt } });
}

/**
 * Once the new group is complete (all seats elected, everybody answered, nobody waiting for an account) the previous holders of
 * the office end: their role is removed and their open term closes today. Then the election is closed.
 */
async function settleElection(tx: DbExecutor, electionId: string): Promise<void> {
  const election = (await tx.select().from(elections).where(eq(elections.id, electionId)))[0]!;
  if (election.status !== "decided") return;
  const candidates = await candidatesOf(tx, electionId);
  if (candidates.some((c) => c.status === "elected" || c.status === "pending_account")) return;
  const group = candidates.filter((c) => c.status === "accepted" && c.clubMemberId).map((c) => c.clubMemberId!);
  const today = todayBerlin();
  const roleScope = election.departmentId ? eq(clubRoles.departmentId, election.departmentId) : isNull(clubRoles.departmentId);
  const holders = await tx
    .select({ roleId: clubRoles.id, accountId: member.id, clubMemberId: clubMembers.id })
    .from(clubRoles)
    .innerJoin(member, eq(member.id, clubRoles.memberId))
    .leftJoin(clubMembers, and(eq(clubMembers.memberId, member.id), eq(clubMembers.clubId, election.clubId)))
    .where(and(eq(member.organizationId, election.clubId), eq(clubRoles.roleType, election.roleType), roleScope));
  for (const h of holders) {
    if (h.clubMemberId && group.includes(h.clubMemberId)) continue;
    await tx.delete(clubRoles).where(eq(clubRoles.id, h.roleId));
    await writeAudit(tx, { eventType: "election.role_end", subjectId: election.id, payload: { clubId: election.clubId, clubMemberId: h.clubMemberId ?? undefined, electionId: election.id, roleType: election.roleType } });
  }
  const termScope = election.departmentId ? eq(clubRoleTerms.departmentId, election.departmentId) : isNull(clubRoleTerms.departmentId);
  const open = await tx.select().from(clubRoleTerms).where(and(eq(clubRoleTerms.clubId, election.clubId), eq(clubRoleTerms.roleType, election.roleType), termScope, isNull(clubRoleTerms.endsOn)));
  for (const term of open) if (!term.clubMemberId || !group.includes(term.clubMemberId)) await tx.update(clubRoleTerms).set({ endsOn: today }).where(eq(clubRoleTerms.id, term.id));
  await tx.update(elections).set({ status: "closed" }).where(eq(elections.id, electionId));
}

/**
 * The elected person says yes or no (or the board records it for them, e.g. spoken in the assembly). With an account the role
 * is written at once; without one the candidate is `pending_account` and gets the role when the account is linked.
 */
export async function answerElection(args: { clubId: string; electionId: string; candidateId: string; accept: boolean; actorUserId: string; onBehalf: boolean }): Promise<ElectionCandidateRow> {
  return db.transaction(async (tx) => {
    const election = await lockElection(tx, args.clubId, args.electionId);
    const [candidate] = await tx.select().from(electionCandidates).where(and(eq(electionCandidates.id, args.candidateId), eq(electionCandidates.electionId, election.id))).for("update");
    if (!candidate || !candidate.clubMemberId) throw new NotFoundError("Candidate not found");
    if (candidate.status !== "elected") throw fail.conflict("Only an elected candidate can answer", "not_elected");
    const [person] = await tx.select({ accountId: clubMembers.memberId }).from(clubMembers).where(eq(clubMembers.id, candidate.clubMemberId));
    let status: "accepted" | "pending_account" | "declined" = "declined";
    if (args.accept) {
      status = person?.accountId ? "accepted" : "pending_account";
      if (person?.accountId) await grantRole(tx, election, candidate.clubMemberId, person.accountId);
    }
    const [row] = await tx.update(electionCandidates).set({ status }).where(eq(electionCandidates.id, candidate.id)).returning();
    // A refusal reopens the seat: the board can set up another round.
    if (status === "declined" && (election.status === "decided" || election.status === "closed")) await tx.update(elections).set({ status: "running", decidedAt: null }).where(eq(elections.id, election.id));
    await writeAudit(tx, { eventType: "election.accept", subjectId: election.id, actorUserId: args.actorUserId, payload: { clubId: args.clubId, clubMemberId: candidate.clubMemberId, onBehalf: args.onBehalf, pendingAccount: status === "pending_account" } });
    await settleElection(tx, election.id);
    return row!;
  });
}

/** Called when an account is linked to a club member: elected people who accepted without an account get their role now. */
export async function grantPendingElectionRoles(tx: DbExecutor, clubId: string, clubMemberId: string): Promise<number> {
  const [person] = await tx.select({ accountId: clubMembers.memberId }).from(clubMembers).where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId)));
  if (!person?.accountId) return 0;
  const pending = await tx
    .select({ candidateId: electionCandidates.id, electionId: electionCandidates.electionId })
    .from(electionCandidates)
    .innerJoin(elections, eq(elections.id, electionCandidates.electionId))
    .where(and(eq(elections.clubId, clubId), eq(electionCandidates.clubMemberId, clubMemberId), eq(electionCandidates.status, "pending_account")));
  for (const p of pending) {
    const election = await lockElection(tx, clubId, p.electionId);
    await grantRole(tx, election, clubMemberId, person.accountId);
    await tx.update(electionCandidates).set({ status: "accepted" }).where(eq(electionCandidates.id, p.candidateId));
    await settleElection(tx, election.id);
  }
  return pending.length;
}

