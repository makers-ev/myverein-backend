import { isLeftStatus, ageOn } from "./member-lifecycle.js";
import type { AssemblyRules } from "./assembly-rules.js";

/**
 * Voting right derived from the master data and the statute parameters (Wave 11 B4), pure. The category flag
 * (`member_categories.voting_right`), the allowed statuses, the minimum age and the entry / exit dates all have to agree on
 * the reference day (`asOf`, ISO date: the day of the meeting). The first failing check names the `basis`.
 */

export type VotingBasis =
  /** Eligible: category with voting right, allowed status, old enough, member on the day. */
  | "ok"
  /** The club has not stated `votingStatuses` / `votingMinAge` yet: nobody is derived as eligible. */
  | "rules_missing"
  | "not_yet_member"
  | "left"
  | "status"
  | "no_category"
  | "category"
  | "birth_date_unknown"
  | "min_age"
  /** Set by hand with a reason (voting roll override). */
  | "override";

export interface VotingRightSubject {
  status: string;
  joinedAt: string;
  leftAt: string | null;
  birthDate: string | null;
}

export interface VotingRightResult {
  eligible: boolean;
  basis: VotingBasis;
}

export function deriveVotingRight(
  subject: VotingRightSubject,
  category: { votingRight: boolean } | null,
  rules: Pick<AssemblyRules, "votingStatuses" | "votingMinAge">,
  asOf: string,
): VotingRightResult {
  const no = (basis: VotingBasis): VotingRightResult => ({ eligible: false, basis });
  if (rules.votingStatuses === null || rules.votingStatuses.length === 0 || rules.votingMinAge === null) return no("rules_missing");
  if (subject.joinedAt > asOf) return no("not_yet_member");
  if (subject.leftAt !== null ? subject.leftAt <= asOf : isLeftStatus(subject.status)) return no("left");
  // A left status with an exit date still in the future says nothing about the status on the reference day.
  if (!isLeftStatus(subject.status) && !rules.votingStatuses.includes(subject.status as (typeof rules.votingStatuses)[number])) return no("status");
  if (category === null) return no("no_category");
  if (!category.votingRight) return no("category");
  if (rules.votingMinAge > 0) {
    if (subject.birthDate === null) return no("birth_date_unknown");
    if (ageOn(subject.birthDate, asOf) < rules.votingMinAge) return no("min_age");
  }
  return { eligible: true, basis: "ok" };
}
