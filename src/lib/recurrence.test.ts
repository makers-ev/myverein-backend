import { describe, expect, it } from "vitest";

import { expandSeries, validateRule, zonedToUtc, type SeriesRule } from "./recurrence.js";

const base: SeriesRule = { freq: "weekly", interval: 1, startDate: "2026-01-05", startTime: "18:00", allDay: false, durationMinutes: 90, timezone: "Europe/Berlin" };
const until = new Date("2030-12-31T00:00:00Z");

const localDates = (rule: SeriesRule, opts: Partial<Parameters<typeof expandSeries>[1]> = {}) => expandSeries(rule, { until, ...opts }).occurrences.map((o) => o.localDate);

describe("zonedToUtc", () => {
  it("applies winter and summer offsets", () => {
    expect(zonedToUtc("2026-01-15", "18:00", "Europe/Berlin").toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(zonedToUtc("2026-07-15", "18:00", "Europe/Berlin").toISOString()).toBe("2026-07-15T16:00:00.000Z");
  });
  it("moves a non-existent spring time forward and takes the first of an ambiguous autumn time", () => {
    expect(zonedToUtc("2026-03-29", "02:30", "Europe/Berlin").toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(zonedToUtc("2026-10-25", "02:30", "Europe/Berlin").toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
  it("works in zones west of Greenwich", () => {
    expect(zonedToUtc("2026-07-01", "09:00", "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
  });
});

describe("expandSeries", () => {
  it("keeps 18:00 local across both daylight saving switches", () => {
    const rule: SeriesRule = { ...base, startDate: "2026-03-23", count: 3 };
    const times = expandSeries(rule, { until }).occurrences.map((o) => o.startsAt.toISOString());
    expect(times).toEqual(["2026-03-23T17:00:00.000Z", "2026-03-30T16:00:00.000Z", "2026-04-06T16:00:00.000Z"]);
    const autumn = expandSeries({ ...base, startDate: "2026-10-19", count: 2 }, { until }).occurrences.map((o) => o.startsAt.toISOString());
    expect(autumn).toEqual(["2026-10-19T16:00:00.000Z", "2026-10-26T17:00:00.000Z"]);
  });

  it("computes the end from the duration and leaves it open without one", () => {
    const [o] = expandSeries({ ...base, count: 1 }, { until }).occurrences;
    expect(o!.endsAt!.toISOString()).toBe("2026-01-05T18:30:00.000Z");
    const [open] = expandSeries({ ...base, durationMinutes: null, count: 1 }, { until }).occurrences;
    expect(open!.endsAt).toBeNull();
  });

  it("weekly with several weekdays and interval 2 starts at the first matching day", () => {
    const rule: SeriesRule = { ...base, startDate: "2026-01-07", byDay: ["MO", "WE", "FR"], interval: 2, count: 6 };
    expect(localDates(rule)).toEqual(["2026-01-07", "2026-01-09", "2026-01-19", "2026-01-21", "2026-01-23", "2026-02-02"]);
  });

  it("weekly defaults to the weekday of the start date", () => {
    expect(localDates({ ...base, count: 3 })).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
  });

  it("daily with interval and UNTIL (inclusive)", () => {
    expect(localDates({ ...base, freq: "daily", interval: 3, untilDate: "2026-01-14" })).toEqual(["2026-01-05", "2026-01-08", "2026-01-11", "2026-01-14"]);
  });

  it("monthly on the same day skips months without it (RFC 5545) and handles 29 February", () => {
    expect(localDates({ ...base, freq: "monthly", startDate: "2026-01-31", count: 4 })).toEqual(["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
    expect(localDates({ ...base, freq: "monthly", startDate: "2024-02-29", interval: 12, count: 2 })).toEqual(["2024-02-29", "2028-02-29"]);
  });

  it("monthly on the n-th weekday and the last weekday", () => {
    expect(localDates({ ...base, freq: "monthly", startDate: "2026-01-01", byDay: ["TU"], bySetPos: 2, count: 3 })).toEqual(["2026-01-13", "2026-02-10", "2026-03-10"]);
    expect(localDates({ ...base, freq: "monthly", startDate: "2026-01-01", byDay: ["FR"], bySetPos: -1, count: 3 })).toEqual(["2026-01-30", "2026-02-27", "2026-03-27"]);
    expect(localDates({ ...base, freq: "monthly", startDate: "2026-01-20", byDay: ["TU"], bySetPos: 1, count: 2 })).toEqual(["2026-02-03", "2026-03-03"]);
  });

  it("monthly at the end of the year rolls the year", () => {
    expect(localDates({ ...base, freq: "monthly", startDate: "2026-11-15", count: 3 })).toEqual(["2026-11-15", "2026-12-15", "2027-01-15"]);
  });

  it("stops at the horizon and reports unfinished; finished at COUNT/UNTIL", () => {
    const open = expandSeries(base, { until: new Date("2026-02-01T00:00:00Z") });
    expect(open.occurrences).toHaveLength(4);
    expect(open.finished).toBe(false);
    const counted = expandSeries({ ...base, count: 2 }, { until });
    expect(counted.finished).toBe(true);
    expect(expandSeries({ ...base, untilDate: "2026-01-12" }, { until }).finished).toBe(true);
  });

  it("COUNT includes occurrences removed by exceptions, holidays and `from`", () => {
    const rule: SeriesRule = { ...base, startDate: "2026-04-06", count: 3, skipHolidays: true };
    const r = expandSeries(rule, { until });
    expect(r.skippedHolidays.map((s) => s.holiday)).toEqual(["Ostermontag"]);
    expect(r.occurrences.map((o) => o.localDate)).toEqual(["2026-04-13", "2026-04-20"]);
    expect(localDates(rule, { exceptions: new Set(["2026-04-13"]) })).toEqual(["2026-04-20"]);
    expect(localDates({ ...rule, skipHolidays: false }, { from: new Date("2026-04-10T00:00:00Z") })).toEqual(["2026-04-13", "2026-04-20"]);
  });

  it("skips state holidays only for that state", () => {
    const rule: SeriesRule = { ...base, freq: "daily", startDate: "2026-01-05", count: 3, skipHolidays: true, state: "BY" };
    expect(localDates({ ...rule, startDate: "2026-01-05" })).toEqual(["2026-01-05", "2026-01-07"]);
    expect(localDates({ ...rule, state: "NW" })).toEqual(["2026-01-05", "2026-01-06", "2026-01-07"]);
  });

  it("builds all-day, multi-day occurrences from local day boundaries", () => {
    const [o] = expandSeries({ ...base, allDay: true, startTime: null, durationMinutes: null, durationDays: 3, freq: "monthly", startDate: "2026-03-27", count: 1 }, { until }).occurrences;
    expect(o!.startsAt.toISOString()).toBe("2026-03-26T23:00:00.000Z");
    expect(o!.endsAt!.toISOString()).toBe("2026-03-29T21:59:59.000Z");
  });

  it("respects the limit", () => {
    expect(expandSeries({ ...base, freq: "daily" }, { until, limit: 5 }).occurrences).toHaveLength(5);
  });

  it("a three year weekly horizon yields 157 occurrences", () => {
    expect(expandSeries(base, { until: new Date("2029-01-05T00:00:00Z") }).occurrences).toHaveLength(157);
  });
});

describe("validateRule", () => {
  it("accepts a valid rule", () => {
    expect(validateRule(base)).toEqual([]);
  });
  it("rejects contradictions", () => {
    expect(validateRule({ ...base, untilDate: "2026-02-01", count: 3 })).toContain("untilDate and count are mutually exclusive");
    expect(validateRule({ ...base, interval: 0 })).toContain("interval must be between 1 and 99");
    expect(validateRule({ ...base, timezone: "Mars/Base" })).toContain("timezone is not a valid IANA zone");
    expect(validateRule({ ...base, startTime: null })).toContain("startTime (HH:MM) is required for timed series");
    expect(validateRule({ ...base, untilDate: "2025-01-01" })).toContain("untilDate must be a valid date on or after startDate");
    expect(validateRule({ ...base, freq: "monthly", byDay: ["MO"] })).toContain("a monthly rule with byDay needs bySetPos");
    expect(validateRule({ ...base, bySetPos: 2 })).toContain("bySetPos only applies to monthly rules");
    expect(validateRule({ ...base, freq: "monthly", byDay: ["MO", "TU"], bySetPos: 1 })).toContain("bySetPos needs exactly one weekday in byDay");
    expect(validateRule({ ...base, freq: "daily", byDay: ["MO"] })).toContain("byDay only applies to weekly and monthly rules");
  });
  it("expandSeries throws on an invalid rule", () => {
    expect(() => expandSeries({ ...base, interval: 0 }, { until })).toThrow(/invalid series rule/);
  });
});
