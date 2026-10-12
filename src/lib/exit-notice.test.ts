import { describe, expect, it } from "vitest";

import { addDays, earliestExitDate, lastDayOfMonth } from "./exit-notice.js";

const rule = (noticePeriodDays: number | null, noticeMode: string | null) => ({ noticePeriodDays, noticeMode });

describe("addDays / lastDayOfMonth", () => {
  it("handles month, year and leap-year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(lastDayOfMonth(2024, 2)).toBe("2024-02-29");
    expect(lastDayOfMonth(2026, 2)).toBe("2026-02-28");
    expect(lastDayOfMonth(2026, 12)).toBe("2026-12-31");
  });
});

describe("earliestExitDate", () => {
  it("without settings the exit is possible today", () => {
    expect(earliestExitDate("2026-10-11", rule(null, null))).toBe("2026-10-11");
    expect(earliestExitDate("2026-10-11", rule(0, "immediate"))).toBe("2026-10-11");
  });

  it("immediate: only the notice period, no rounding", () => {
    expect(earliestExitDate("2026-10-11", rule(14, "immediate"))).toBe("2026-10-25");
    expect(earliestExitDate("2026-10-11", rule(14, null))).toBe("2026-10-25");
  });

  it("month_end rounds up to the end of the month", () => {
    expect(earliestExitDate("2026-10-11", rule(0, "month_end"))).toBe("2026-10-31");
    expect(earliestExitDate("2026-10-11", rule(30, "month_end"))).toBe("2026-11-30");
    expect(earliestExitDate("2026-01-20", rule(30, "month_end"))).toBe("2026-02-28");
    expect(earliestExitDate("2024-01-30", rule(30, "month_end"))).toBe("2024-02-29");
  });

  it("a date that already is the end stays (no extra month)", () => {
    expect(earliestExitDate("2026-10-31", rule(0, "month_end"))).toBe("2026-10-31");
    expect(earliestExitDate("2026-09-30", rule(0, "quarter_end"))).toBe("2026-09-30");
    expect(earliestExitDate("2026-12-31", rule(0, "year_end"))).toBe("2026-12-31");
    expect(earliestExitDate("2026-05-31", rule(30, "month_end"))).toBe("2026-06-30");
  });

  it("quarter_end rounds up to 31 Mar / 30 Jun / 30 Sep / 31 Dec", () => {
    expect(earliestExitDate("2026-01-01", rule(0, "quarter_end"))).toBe("2026-03-31");
    expect(earliestExitDate("2026-04-01", rule(0, "quarter_end"))).toBe("2026-06-30");
    expect(earliestExitDate("2026-10-11", rule(0, "quarter_end"))).toBe("2026-12-31");
    expect(earliestExitDate("2026-10-11", rule(90, "quarter_end"))).toBe("2027-03-31");
  });

  it("year_end rounds up to 31 December, also across the year change", () => {
    expect(earliestExitDate("2026-01-01", rule(0, "year_end"))).toBe("2026-12-31");
    expect(earliestExitDate("2026-12-31", rule(1, "year_end"))).toBe("2027-12-31");
    expect(earliestExitDate("2026-10-11", rule(90, "year_end"))).toBe("2027-12-31");
  });
});
