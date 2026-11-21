import { describe, expect, it } from "vitest";

import { computeAssociationReport } from "./association-report.js";
import type { ClubStatsInput } from "./club-stats.js";

/** Who counts on a Stichtag in the past (Wave 15 review): exits without `left_at` are placed by the status history. */
describe("association report: members who left", () => {
  const base = { memberId: null, joinedAt: "2010-01-01", birthDate: "1980-05-05", categoryId: null };
  const input: ClubStatsInput = {
    members: [
      { id: "active", status: "aktiv", leftAt: null, ...base },
      { id: "left-dated", status: "ausgetreten", leftAt: "2024-06-30", ...base },
      { id: "dead-history", status: "verstorben", leftAt: null, ...base },
      { id: "dead-unknown", status: "verstorben", leftAt: null, ...base },
      { id: "lead", status: "interessent", leftAt: null, ...base },
    ],
    categories: [],
    departments: [],
    assignments: [],
    exits: [{ clubMemberId: "dead-history", effectiveOn: "2024-09-01" }],
  };
  const total = (stichtag: string) => computeAssociationReport(input, { stichtag, columns: ["ageGroup"], ageBands: [18], ageMode: "jahrgang" }).total;

  it("counts a member who died after the Stichtag (exit day from the history) and not one without any exit day", () => {
    expect(total("2024-01-01")).toBe(3); // active, left-dated, dead-history
    expect(total("2024-08-01")).toBe(2); // active, dead-history
    expect(total("2025-01-01")).toBe(1); // active
  });
});
