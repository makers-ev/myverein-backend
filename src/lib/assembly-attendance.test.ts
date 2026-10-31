import { describe, expect, it } from "vitest";

import { evaluateQuorum } from "./assembly-attendance.js";

describe("evaluateQuorum", () => {
  it("needs no quorum when the statute has none, even with nobody present", () => {
    expect(evaluateQuorum({ eligibleTotal: 40, represented: 0, quorumMode: "none", quorumValue: null })).toEqual({ required: 0, result: "beschlussfaehig" });
  });

  it("rounds a fraction up and compares with the represented members (present plus proxies)", () => {
    // 25 voting members, one fifth -> 5 needed.
    expect(evaluateQuorum({ eligibleTotal: 25, represented: 4, quorumMode: "fraction", quorumValue: 0.2 })).toEqual({ required: 5, result: "nicht_beschlussfaehig" });
    expect(evaluateQuorum({ eligibleTotal: 25, represented: 5, quorumMode: "fraction", quorumValue: 0.2 })).toEqual({ required: 5, result: "beschlussfaehig" });
    // 7 voting members, half -> 3.5 -> 4.
    expect(evaluateQuorum({ eligibleTotal: 7, represented: 3, quorumMode: "fraction", quorumValue: 0.5 }).required).toBe(4);
    // A float artefact (0.1 * 30 = 3.0000000000000004) must not demand a fourth person.
    expect(evaluateQuorum({ eligibleTotal: 30, represented: 3, quorumMode: "fraction", quorumValue: 0.1 })).toEqual({ required: 3, result: "beschlussfaehig" });
  });

  it("takes an absolute number as it is", () => {
    expect(evaluateQuorum({ eligibleTotal: 100, represented: 9, quorumMode: "absolute", quorumValue: 10 })).toEqual({ required: 10, result: "nicht_beschlussfaehig" });
    expect(evaluateQuorum({ eligibleTotal: 100, represented: 10, quorumMode: "absolute", quorumValue: 10 }).result).toBe("beschlussfaehig");
  });

  it("is never a quorum without voting members or without anybody present", () => {
    expect(evaluateQuorum({ eligibleTotal: 0, represented: 0, quorumMode: "fraction", quorumValue: 0.5 }).result).toBe("nicht_beschlussfaehig");
    expect(evaluateQuorum({ eligibleTotal: 10, represented: 0, quorumMode: "absolute", quorumValue: 0 }).result).toBe("nicht_beschlussfaehig");
  });

  it("reports missing rules instead of guessing", () => {
    expect(evaluateQuorum({ eligibleTotal: 10, represented: 10, quorumMode: null, quorumValue: null })).toEqual({ required: null, result: "regeln_fehlen" });
    expect(evaluateQuorum({ eligibleTotal: 10, represented: 10, quorumMode: "fraction", quorumValue: null }).result).toBe("regeln_fehlen");
  });
});
