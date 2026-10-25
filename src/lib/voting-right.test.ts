import { describe, expect, it } from "vitest";

import { deriveVotingRight, type VotingRightSubject } from "./voting-right.js";

const RULES = { votingStatuses: ["aktiv", "probe"] as const, votingMinAge: 16 };
const rules = { votingStatuses: [...RULES.votingStatuses], votingMinAge: RULES.votingMinAge };
const adult: VotingRightSubject = { status: "aktiv", joinedAt: "2020-01-01", leftAt: null, birthDate: "1990-05-05" };
const VOTES = { votingRight: true };
const ASOF = "2026-06-20";

describe("deriveVotingRight", () => {
  it("is eligible when category, status, age and membership dates agree", () => {
    expect(deriveVotingRight(adult, VOTES, rules, ASOF)).toEqual({ eligible: true, basis: "ok" });
  });

  it("derives nobody while the statute parameters are not stated", () => {
    expect(deriveVotingRight(adult, VOTES, { votingStatuses: null, votingMinAge: 16 }, ASOF).basis).toBe("rules_missing");
    expect(deriveVotingRight(adult, VOTES, { votingStatuses: [], votingMinAge: 16 }, ASOF).basis).toBe("rules_missing");
    expect(deriveVotingRight(adult, VOTES, { votingStatuses: ["aktiv"], votingMinAge: null }, ASOF).basis).toBe("rules_missing");
  });

  it("follows the category flag, and a missing category gives no right", () => {
    expect(deriveVotingRight(adult, { votingRight: false }, rules, ASOF)).toEqual({ eligible: false, basis: "category" });
    expect(deriveVotingRight(adult, null, rules, ASOF)).toEqual({ eligible: false, basis: "no_category" });
  });

  it("checks the allowed statuses", () => {
    expect(deriveVotingRight({ ...adult, status: "ruhend" }, VOTES, rules, ASOF).basis).toBe("status");
    expect(deriveVotingRight({ ...adult, status: "interessent" }, VOTES, rules, ASOF).basis).toBe("status");
    expect(deriveVotingRight({ ...adult, status: "probe" }, VOTES, rules, ASOF).eligible).toBe(true);
  });

  it("applies the minimum age on the reference day (birthday counts on its day)", () => {
    expect(deriveVotingRight({ ...adult, birthDate: "2010-06-20" }, VOTES, rules, ASOF)).toEqual({ eligible: true, basis: "ok" });
    expect(deriveVotingRight({ ...adult, birthDate: "2010-06-21" }, VOTES, rules, ASOF)).toEqual({ eligible: false, basis: "min_age" });
    expect(deriveVotingRight({ ...adult, birthDate: null }, VOTES, rules, ASOF).basis).toBe("birth_date_unknown");
    // Minimum age 0: the birth date is not needed.
    expect(deriveVotingRight({ ...adult, birthDate: null }, VOTES, { ...rules, votingMinAge: 0 }, ASOF).eligible).toBe(true);
  });

  it("uses entry and exit dates relative to the reference day", () => {
    expect(deriveVotingRight({ ...adult, joinedAt: "2026-06-20" }, VOTES, rules, ASOF).eligible).toBe(true);
    expect(deriveVotingRight({ ...adult, joinedAt: "2026-06-21" }, VOTES, rules, ASOF).basis).toBe("not_yet_member");
    expect(deriveVotingRight({ ...adult, leftAt: "2026-06-20" }, VOTES, rules, ASOF).basis).toBe("left");
    expect(deriveVotingRight({ ...adult, leftAt: "2026-06-21" }, VOTES, rules, ASOF).eligible).toBe(true);
    expect(deriveVotingRight({ ...adult, status: "ausgetreten", leftAt: null }, VOTES, rules, ASOF).basis).toBe("left");
    // A recorded exit in the future does not take the right away before it (the status already reads "ausgetreten").
    expect(deriveVotingRight({ ...adult, status: "ausgetreten", leftAt: "2026-12-31" }, VOTES, rules, ASOF).eligible).toBe(true);
  });
});
