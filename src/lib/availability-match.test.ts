import { describe, expect, it } from "vitest";

import { computeAvailability, type AvailabilityInput } from "./availability-match.js";

describe("computeAvailability", () => {
  it("all members available via a matching regular slot", () => {
    // 2026-09-21 is a Monday -> schema weekday 0.
    const candidate = new Date("2026-09-21T10:00:00");
    const members: AvailabilityInput[] = [
      { memberId: "m1", slots: [{ weekday: 0, startTime: "09:00", endTime: "12:00" }], exceptions: [] },
      { memberId: "m2", slots: [{ weekday: 0, startTime: "08:00", endTime: "18:00" }], exceptions: [] },
    ];

    expect(computeAvailability(candidate, members)).toEqual([
      { memberId: "m1", available: true },
      { memberId: "m2", available: true },
    ]);
  });

  it("partial availability: one member has a slot, the other doesn't", () => {
    const candidate = new Date("2026-09-21T10:00:00");
    const members: AvailabilityInput[] = [
      { memberId: "m1", slots: [{ weekday: 0, startTime: "09:00", endTime: "12:00" }], exceptions: [] },
      { memberId: "m2", slots: [{ weekday: 2, startTime: "09:00", endTime: "12:00" }], exceptions: [] },
    ];

    expect(computeAvailability(candidate, members)).toEqual([
      { memberId: "m1", available: true },
      { memberId: "m2", available: false },
    ]);
  });

  it("none available: no slots and no exceptions default-closed", () => {
    const candidate = new Date("2026-09-21T10:00:00");
    const members: AvailabilityInput[] = [
      { memberId: "m1", slots: [], exceptions: [] },
      { memberId: "m2", slots: [], exceptions: [] },
    ];

    expect(computeAvailability(candidate, members)).toEqual([
      { memberId: "m1", available: false },
      { memberId: "m2", available: false },
    ]);
  });

  it("exception (unavailable) overrides a matching regular slot", () => {
    const candidate = new Date("2026-09-21T10:00:00");
    const members: AvailabilityInput[] = [
      {
        memberId: "m1",
        slots: [{ weekday: 0, startTime: "09:00", endTime: "12:00" }],
        exceptions: [{ date: "2026-09-21", isAvailable: false }],
      },
    ];

    expect(computeAvailability(candidate, members)).toEqual([{ memberId: "m1", available: false }]);
  });

  it("exception (available) overrides the absence of a matching slot", () => {
    const candidate = new Date("2026-09-21T10:00:00");
    const members: AvailabilityInput[] = [
      {
        memberId: "m1",
        slots: [],
        exceptions: [{ date: "2026-09-21", isAvailable: true }],
      },
    ];

    expect(computeAvailability(candidate, members)).toEqual([{ memberId: "m1", available: true }]);
  });

  it("time-of-day boundaries: available at start, not available at end (half-open range)", () => {
    const members: AvailabilityInput[] = [
      { memberId: "m1", slots: [{ weekday: 0, startTime: "09:00", endTime: "12:00" }], exceptions: [] },
    ];

    expect(computeAvailability(new Date("2026-09-21T09:00:00"), members)).toEqual([{ memberId: "m1", available: true }]);
    expect(computeAvailability(new Date("2026-09-21T12:00:00"), members)).toEqual([{ memberId: "m1", available: false }]);
  });

  describe("weekday numbering conversion (JS getDay() Sun=0..Sat=6 vs schema Mon=0..Sun=6)", () => {
    it("Sunday candidate matches a schema weekday=6 slot (not weekday=0)", () => {
      // 2026-09-20 is a Sunday.
      const candidate = new Date("2026-09-20T10:00:00");
      const members: AvailabilityInput[] = [
        { memberId: "wrong", slots: [{ weekday: 0, startTime: "09:00", endTime: "12:00" }], exceptions: [] },
        { memberId: "right", slots: [{ weekday: 6, startTime: "09:00", endTime: "12:00" }], exceptions: [] },
      ];

      expect(computeAvailability(candidate, members)).toEqual([
        { memberId: "wrong", available: false },
        { memberId: "right", available: true },
      ]);
    });

    it("Monday candidate matches a schema weekday=0 slot (not weekday=1)", () => {
      // 2026-09-21 is a Monday.
      const candidate = new Date("2026-09-21T10:00:00");
      const members: AvailabilityInput[] = [
        { memberId: "wrong", slots: [{ weekday: 1, startTime: "09:00", endTime: "12:00" }], exceptions: [] },
        { memberId: "right", slots: [{ weekday: 0, startTime: "09:00", endTime: "12:00" }], exceptions: [] },
      ];

      expect(computeAvailability(candidate, members)).toEqual([
        { memberId: "wrong", available: false },
        { memberId: "right", available: true },
      ]);
    });
  });
});
