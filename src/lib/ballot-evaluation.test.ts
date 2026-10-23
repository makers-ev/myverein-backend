import { describe, expect, it } from "vitest";

import type { MajorityKind } from "./assembly-rules.js";
import { evaluateBallot, evaluateChoices } from "./ballot-evaluation.js";

const run = (majority: MajorityKind, yes: number, no: number, abstain: number, abstainCountsAs: "not_counted" | "against" = "not_counted") =>
  evaluateBallot({ majority, abstainCountsAs, counts: { yes, no, abstain }, eligible: 100 }).outcome;

describe("evaluateBallot (yes / no / abstain)", () => {
  it.each<[MajorityKind, number, number, number, "not_counted" | "against", string]>([
    ["einfach", 5, 4, 0, "not_counted", "angenommen"],
    ["einfach", 4, 4, 0, "not_counted", "abgelehnt"],
    ["einfach", 5, 4, 3, "not_counted", "angenommen"],
    ["einfach", 5, 4, 3, "against", "abgelehnt"],
    ["einfach", 0, 0, 5, "not_counted", "abgelehnt"],
    ["absolut", 5, 1, 4, "not_counted", "abgelehnt"],
    ["absolut", 6, 1, 4, "not_counted", "angenommen"],
    ["zwei_drittel", 8, 4, 10, "not_counted", "angenommen"],
    ["zwei_drittel", 7, 4, 0, "not_counted", "abgelehnt"],
    ["zwei_drittel", 8, 4, 10, "against", "abgelehnt"],
    ["drei_viertel", 9, 3, 0, "not_counted", "angenommen"],
    ["drei_viertel", 8, 3, 0, "not_counted", "abgelehnt"],
    ["einstimmig", 9, 0, 3, "not_counted", "angenommen"],
    ["einstimmig", 9, 0, 3, "against", "abgelehnt"],
    ["einstimmig", 9, 1, 0, "not_counted", "abgelehnt"],
    ["einstimmig", 0, 0, 4, "not_counted", "abgelehnt"],
  ])("%s with %i/%i/%i (%s) is %s", (majority, yes, no, abstain, rule, expected) => {
    expect(run(majority, yes, no, abstain, rule)).toBe(expected);
  });

  it("is not quorate when the quorum at opening failed, whatever the votes say", () => {
    const r = evaluateBallot({ majority: "einfach", abstainCountsAs: "not_counted", counts: { yes: 9, no: 0, abstain: 0 }, eligible: 10, quorum: "nicht_beschlussfaehig" });
    expect(r).toMatchObject({ outcome: "nicht_beschlussfaehig", reason: "quorum" });
    expect(evaluateBallot({ majority: "einfach", abstainCountsAs: "not_counted", counts: { yes: 9, no: 0, abstain: 0 }, eligible: 10, quorum: "beschlussfaehig" }).outcome).toBe("angenommen");
  });

  describe("circular resolutions", () => {
    const circular = (counts: { yes: number; no: number; abstain: number }, c: { unanimity: boolean | null; minParticipation: number | null }, eligible = 10) =>
      evaluateBallot({ majority: "einfach", abstainCountsAs: "not_counted", counts, eligible, circular: c });

    it("needs every eligible member to say yes with unanimity", () => {
      expect(circular({ yes: 10, no: 0, abstain: 0 }, { unanimity: true, minParticipation: null }).outcome).toBe("angenommen");
      expect(circular({ yes: 9, no: 0, abstain: 0 }, { unanimity: true, minParticipation: null })).toMatchObject({ outcome: "abgelehnt", reason: "unanimity" });
      expect(circular({ yes: 9, no: 0, abstain: 1 }, { unanimity: true, minParticipation: null }).outcome).toBe("abgelehnt");
    });

    it("needs the minimum participation, then the majority", () => {
      expect(circular({ yes: 3, no: 0, abstain: 0 }, { unanimity: false, minParticipation: 0.5 })).toMatchObject({ outcome: "nicht_beschlussfaehig", reason: "participation" });
      expect(circular({ yes: 4, no: 1, abstain: 0 }, { unanimity: false, minParticipation: 0.5 }).outcome).toBe("angenommen");
      expect(circular({ yes: 2, no: 3, abstain: 0 }, { unanimity: false, minParticipation: 0.5 }).outcome).toBe("abgelehnt");
    });

    it("refuses to decide while the circular parameters are not stated", () => {
      expect(circular({ yes: 10, no: 0, abstain: 0 }, { unanimity: null, minParticipation: null })).toMatchObject({ outcome: "nicht_beschlussfaehig", reason: "rules_missing" });
      expect(circular({ yes: 10, no: 0, abstain: 0 }, { unanimity: false, minParticipation: null }).reason).toBe("rules_missing");
    });
  });
});

describe("evaluateChoices (elections and free options)", () => {
  const options = (...votes: number[]) => votes.map((v, i) => ({ id: `o${i + 1}`, votes: v }));
  const base = { abstainCountsAs: "not_counted" as const, abstainers: 0 };

  it("elects the relative winner of one seat", () => {
    const r = evaluateChoices({ ...base, majority: "einfach", options: options(5, 3, 1), participants: 9, seats: 1 });
    expect(r).toMatchObject({ outcome: "entschieden", electedIds: ["o1"], tiedIds: [] });
  });

  it("reports a tie at the last seat instead of deciding it", () => {
    const r = evaluateChoices({ ...base, majority: "einfach", options: options(4, 4, 1), participants: 9, seats: 1 });
    expect(r).toMatchObject({ outcome: "gleichstand", electedIds: [], tiedIds: ["o1", "o2"], openSeats: 1 });
    const two = evaluateChoices({ ...base, majority: "einfach", options: options(6, 4, 4, 1), participants: 9, seats: 2 });
    expect(two).toMatchObject({ outcome: "gleichstand", electedIds: ["o1"], tiedIds: ["o2", "o3"], openSeats: 1 });
  });

  it("fills several seats when all qualified options fit", () => {
    const r = evaluateChoices({ ...base, majority: "einfach", options: options(5, 4, 0), participants: 9, seats: 3 });
    expect(r).toMatchObject({ outcome: "entschieden", electedIds: ["o1", "o2"] });
  });

  it("applies the absolute and the 2/3 threshold against the voters", () => {
    expect(evaluateChoices({ ...base, majority: "absolut", options: options(4, 3), participants: 9, seats: 1 }).outcome).toBe("kein_ergebnis");
    expect(evaluateChoices({ ...base, majority: "absolut", options: options(5, 3), participants: 9, seats: 1 }).electedIds).toEqual(["o1"]);
    // 9 voters, 3 abstained: 2/3 of 6 = 4.
    expect(evaluateChoices({ majority: "zwei_drittel", abstainCountsAs: "not_counted", abstainers: 3, options: options(4, 2), participants: 9, seats: 1 }).electedIds).toEqual(["o1"]);
    expect(evaluateChoices({ majority: "zwei_drittel", abstainCountsAs: "against", abstainers: 3, options: options(4, 2), participants: 9, seats: 1 }).outcome).toBe("kein_ergebnis");
  });

  it("is not quorate when the quorum failed", () => {
    expect(evaluateChoices({ ...base, majority: "einfach", options: options(5), participants: 5, seats: 1, quorum: "nicht_beschlussfaehig" }).outcome).toBe("nicht_beschlussfaehig");
  });
});
