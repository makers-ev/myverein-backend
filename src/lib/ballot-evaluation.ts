import type { AbstainRule, MajorityKind } from "./assembly-rules.js";
import type { QuorumResult } from "./assembly-attendance.js";

/**
 * Evaluation of a ballot (Wave 11 B5), pure. The club's statute parameters are the club's own reading of its statute, not
 * legal advice; the definitions below are the assumptions the product makes and the UI shows next to the result:
 *
 * - `einfach`: more yes than no (a tie is rejected; abstentions only count against when `abstainCountsAs = against`);
 * - `absolut`: more than half of ALL votes cast, abstentions included;
 * - `zwei_drittel` / `drei_viertel`: yes is at least 2/3 resp. 3/4 of yes + no (+ abstentions when they count against);
 * - `einstimmig`: at least one yes and nobody against (abstentions count against only with `abstainCountsAs = against`).
 */

export type BallotOutcome = "angenommen" | "abgelehnt" | "nicht_beschlussfaehig";
export type OutcomeReason = "ok" | "quorum" | "participation" | "unanimity" | "rules_missing";

export interface YesNoCounts {
  yes: number;
  no: number;
  abstain: number;
}

export interface EvaluateBallotArgs {
  majority: MajorityKind;
  abstainCountsAs: AbstainRule;
  counts: YesNoCounts;
  /** Everybody who was entitled to vote on this ballot. */
  eligible: number;
  /** Quorum at opening (in-session ballots); `null`/omitted = no quorum applies (circular). */
  quorum?: QuorumResult | null;
  /** Circular resolution: unanimity of all eligible members, or a minimum participation. */
  circular?: { unanimity: boolean | null; minParticipation: number | null };
}

export interface BallotEvaluation {
  outcome: BallotOutcome;
  reason: OutcomeReason;
  yes: number;
  no: number;
  abstain: number;
  participants: number;
}

/** Whether `yes` meets `majority` against the other side (`against` = no + abstentions that count against). */
export function meetsMajority(majority: MajorityKind, yes: number, against: number, votesCast: number): boolean {
  const denominator = yes + against;
  switch (majority) {
    case "einfach":
      return yes > against;
    case "absolut":
      return yes * 2 > votesCast;
    case "zwei_drittel":
      return denominator > 0 && yes * 3 >= 2 * denominator;
    case "drei_viertel":
      return denominator > 0 && yes * 4 >= 3 * denominator;
    case "einstimmig":
      return yes > 0 && against === 0;
  }
}

export function evaluateBallot(args: EvaluateBallotArgs): BallotEvaluation {
  const { counts, eligible } = args;
  const participants = counts.yes + counts.no + counts.abstain;
  const base = { yes: counts.yes, no: counts.no, abstain: counts.abstain, participants };
  const done = (outcome: BallotOutcome, reason: OutcomeReason): BallotEvaluation => ({ outcome, reason, ...base });

  if (args.quorum !== undefined && args.quorum !== null && args.quorum !== "beschlussfaehig") return done("nicht_beschlussfaehig", "quorum");

  if (args.circular) {
    const { unanimity, minParticipation } = args.circular;
    if (unanimity === true) return counts.yes === eligible && eligible > 0 ? done("angenommen", "ok") : done("abgelehnt", "unanimity");
    if (unanimity === null || (unanimity === false && minParticipation === null)) return done("nicht_beschlussfaehig", "rules_missing");
    if (participants < Math.max(1, Math.ceil(eligible * minParticipation! - 1e-9))) return done("nicht_beschlussfaehig", "participation");
  }

  const against = counts.no + (args.abstainCountsAs === "against" ? counts.abstain : 0);
  return meetsMajority(args.majority, counts.yes, against, participants) ? done("angenommen", "ok") : done("abgelehnt", "ok");
}

// --- Choice ballots (elections, free options) ----------------------------------------------------------------------------

export interface ChoiceEvaluationArgs {
  majority: MajorityKind;
  abstainCountsAs: AbstainRule;
  options: Array<{ id: string; votes: number }>;
  /** Voters who chose the abstain option. */
  abstainers: number;
  /** Voters who handed in a ballot (abstainers included). */
  participants: number;
  seats: number;
  quorum?: QuorumResult | null;
}

export type ChoiceOutcome = "entschieden" | "gleichstand" | "kein_ergebnis" | "nicht_beschlussfaehig";

export interface ChoiceEvaluation {
  outcome: ChoiceOutcome;
  /** Ranked by votes (descending), only options that met the majority. */
  qualified: Array<{ id: string; votes: number }>;
  /** Won a seat without a lot. */
  electedIds: string[];
  /** Options with equal votes at the last seat: decided by a documented lot (`openSeats` of them win). */
  tiedIds: string[];
  openSeats: number;
}

/**
 * Per option the votes are compared with the voters (a voter may pick up to `seats` options). `einfach` is the relative
 * majority (the options with the most votes win, at least one vote); the other kinds are thresholds against the voters
 * (without abstainers unless they count against). More qualified options than seats: the best ones win, a tie at the last
 * seat is reported (never silently resolved).
 */
export function evaluateChoices(args: ChoiceEvaluationArgs): ChoiceEvaluation {
  const none = (outcome: ChoiceOutcome): ChoiceEvaluation => ({ outcome, qualified: [], electedIds: [], tiedIds: [], openSeats: 0 });
  if (args.quorum !== undefined && args.quorum !== null && args.quorum !== "beschlussfaehig") return none("nicht_beschlussfaehig");

  const base = args.participants - (args.abstainCountsAs === "not_counted" ? args.abstainers : 0);
  const qualifies = (votes: number): boolean => {
    if (votes <= 0) return false;
    switch (args.majority) {
      case "einfach":
        return true;
      case "absolut":
        return votes * 2 > args.participants;
      case "zwei_drittel":
        return votes * 3 >= 2 * base;
      case "drei_viertel":
        return votes * 4 >= 3 * base;
      case "einstimmig":
        return votes === base;
    }
  };
  const qualified = args.options
    .filter((o) => qualifies(o.votes))
    .sort((a, b) => b.votes - a.votes || a.id.localeCompare(b.id));
  if (qualified.length === 0) return none("kein_ergebnis");
  if (qualified.length <= args.seats) {
    // Relative majority with free seats: a tie among the best of several seats does not matter, everybody wins.
    return { outcome: "entschieden", qualified, electedIds: qualified.map((o) => o.id), tiedIds: [], openSeats: 0 };
  }
  const lastVotes = qualified[args.seats - 1]!.votes;
  const above = qualified.filter((o) => o.votes > lastVotes);
  const level = qualified.filter((o) => o.votes === lastVotes);
  if (above.length + level.length === args.seats) return { outcome: "entschieden", qualified, electedIds: [...above, ...level].map((o) => o.id), tiedIds: [], openSeats: 0 };
  return { outcome: "gleichstand", qualified, electedIds: above.map((o) => o.id), tiedIds: level.map((o) => o.id), openSeats: args.seats - above.length };
}
