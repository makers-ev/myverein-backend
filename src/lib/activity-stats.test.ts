import { describe, expect, it } from "vitest";

import { computeActivityBuckets, dayKey, generateDayKeys, generateWeekKeys, periodKeyFn, weekKey } from "./activity-stats.js";

describe("dayKey / weekKey", () => {
  it("formats a UTC calendar day", () => {
    expect(dayKey(new Date("2026-08-18T23:59:59.000Z"))).toBe("2026-08-18");
  });

  it("truncates to the Monday of the ISO week, UTC", () => {
    // 2026-08-18 is a Tuesday
    expect(weekKey(new Date("2026-08-18T12:00:00.000Z"))).toBe("2026-08-17");
    // A Monday truncates to itself
    expect(weekKey(new Date("2026-08-17T00:00:00.000Z"))).toBe("2026-08-17");
    // A Sunday belongs to the week that started the preceding Monday
    expect(weekKey(new Date("2026-08-23T12:00:00.000Z"))).toBe("2026-08-17");
  });
});

describe("generateDayKeys / generateWeekKeys", () => {
  it("generates consecutive day keys ending at endDate, oldest first", () => {
    const keys = generateDayKeys(3, new Date("2026-08-18T00:00:00.000Z"));
    expect(keys).toEqual(["2026-08-16", "2026-08-17", "2026-08-18"]);
  });

  it("generates consecutive week-start keys 7 days apart", () => {
    const keys = generateWeekKeys(3, new Date("2026-08-18T00:00:00.000Z"));
    expect(keys).toEqual(["2026-08-03", "2026-08-10", "2026-08-17"]);
  });
});

describe("computeActivityBuckets", () => {
  it("returns one fewer bucket than bucketKeys (first is lookback-only)", () => {
    const result = computeActivityBuckets([], [], ["d0", "d1", "d2"]);
    expect(result.map((r) => r.key)).toEqual(["d1", "d2"]);
  });

  it("counts new users in the bucket they signed up in", () => {
    const signups = [
      { userId: "a", day: "d1" },
      { userId: "b", day: "d2" },
    ];
    const result = computeActivityBuckets(signups, [], ["d0", "d1", "d2"]);
    expect(result.find((r) => r.key === "d1")!.newUsers).toBe(1);
    expect(result.find((r) => r.key === "d2")!.newUsers).toBe(1);
  });

  it("classifies retained: active in this bucket and the previous one", () => {
    const sessions = [
      { userId: "a", day: "d0" },
      { userId: "a", day: "d1" },
    ];
    const result = computeActivityBuckets([], sessions, ["d0", "d1"]);
    expect(result[0].activeUsers).toBe(1);
    expect(result[0].retained).toBe(1);
    expect(result[0].reactivated).toBe(0);
  });

  it("classifies reactivated: active now, not in the previous bucket, not new", () => {
    const signups = [{ userId: "a", day: "d0" }]; // signed up two buckets ago, not "new" in d2
    const sessions = [
      { userId: "a", day: "d0" },
      // gap at d1 -- inactive
      { userId: "a", day: "d2" },
    ];
    const result = computeActivityBuckets(signups, sessions, ["d0", "d1", "d2"]);
    const d2 = result.find((r) => r.key === "d2")!;
    expect(d2.activeUsers).toBe(1);
    expect(d2.retained).toBe(0);
    expect(d2.reactivated).toBe(1);
  });

  it("does not double-count a new signup as reactivated", () => {
    const signups = [{ userId: "a", day: "d2" }];
    const sessions = [{ userId: "a", day: "d2" }];
    const result = computeActivityBuckets(signups, sessions, ["d0", "d1", "d2"]);
    const d2 = result.find((r) => r.key === "d2")!;
    expect(d2.newUsers).toBe(1);
    expect(d2.retained).toBe(0);
    expect(d2.reactivated).toBe(0);
  });

  it("ignores rows whose day falls outside every bucket key", () => {
    const sessions = [{ userId: "a", day: "way-out-of-range" }];
    const result = computeActivityBuckets([], sessions, ["d0", "d1"]);
    expect(result[0].activeUsers).toBe(0);
  });
});

describe("periodKeyFn", () => {
  const now = new Date("2026-08-18T00:00:00.000Z");
  const classify = periodKeyFn(30, now);

  it("labels a date within the current period", () => {
    expect(classify(new Date("2026-08-10T00:00:00.000Z"))).toBe("current");
  });

  it("labels a date within the previous period", () => {
    // current = [2026-07-19, now]; prev = [2026-06-19, 2026-07-19)
    expect(classify(new Date("2026-06-25T00:00:00.000Z"))).toBe("prev");
  });

  it("labels a date within the period before that", () => {
    // prev2 = [2026-05-20, 2026-06-19)
    expect(classify(new Date("2026-05-25T00:00:00.000Z"))).toBe("prev2");
  });

  it("labels anything older as out-of-range", () => {
    expect(classify(new Date("2026-01-01T00:00:00.000Z"))).toBe("out-of-range");
  });
});
