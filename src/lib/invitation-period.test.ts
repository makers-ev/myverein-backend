import { describe, expect, it } from "vitest";

import { checkInvitationPeriod } from "./invitation-period.js";

const rules = (minDays: number | null, bufferDays: number | null) => ({ invitationMinDays: minDays, invitationDeliveryBufferDays: bufferDays });
const at = (iso: string) => new Date(iso);

describe("checkInvitationPeriod", () => {
  it("accepts exactly the required number of calendar days and rejects one less", () => {
    // Required 14 + 3 = 17 days: sent Mon 2026-06-01, meeting Thu 2026-06-18.
    const ok = checkInvitationPeriod({ scheduledAt: at("2026-06-18T16:00:00Z") }, rules(14, 3), at("2026-06-01T09:00:00Z"));
    expect(ok).toMatchObject({ ok: true, reason: "ok", requiredDays: 17, daysAvailable: 17, earliestMeetingDay: "2026-06-18", latestSendDay: "2026-06-01" });
    const late = checkInvitationPeriod({ scheduledAt: at("2026-06-17T16:00:00Z") }, rules(14, 3), at("2026-06-01T09:00:00Z"));
    expect(late).toMatchObject({ ok: false, reason: "too_late", daysAvailable: 16, earliestMeetingDay: "2026-06-18", latestSendDay: "2026-05-31" });
  });

  it("counts calendar days in Europe/Berlin, not UTC: 23:30 UTC is already the next day", () => {
    // Sent 2026-06-01 23:30Z = 2026-06-02 01:30 Berlin; meeting 2026-06-16 in Berlin -> 14 days available.
    const check = checkInvitationPeriod({ scheduledAt: at("2026-06-16T10:00:00Z") }, rules(14, 0), at("2026-06-01T23:30:00Z"));
    expect(check).toMatchObject({ sendDay: "2026-06-02", meetingDay: "2026-06-16", daysAvailable: 14, ok: true });
    const tooLate = checkInvitationPeriod({ scheduledAt: at("2026-06-15T10:00:00Z") }, rules(14, 0), at("2026-06-01T23:30:00Z"));
    expect(tooLate.ok).toBe(false);
  });

  it("is not shifted by the spring daylight saving switch (23 hour day)", () => {
    // Switch on 2026-03-29. Sent Fri 2026-03-27 12:00 Berlin, meeting Mon 2026-03-30 19:00 Berlin: 3 calendar days.
    const check = checkInvitationPeriod({ scheduledAt: at("2026-03-30T17:00:00Z") }, rules(3, 0), at("2026-03-27T11:00:00Z"));
    expect(check).toMatchObject({ daysAvailable: 3, ok: true });
    // A meeting just after midnight local time on the day after the switch still counts as that day.
    expect(checkInvitationPeriod({ scheduledAt: at("2026-03-29T23:30:00Z") }, rules(3, 0), at("2026-03-27T11:00:00Z"))).toMatchObject({ meetingDay: "2026-03-30", daysAvailable: 3, ok: true });
  });

  it("is not shifted by the autumn daylight saving switch (25 hour day)", () => {
    // Switch on 2026-10-25. Sent Fri 2026-10-23 23:50 Berlin (21:50Z), meeting Mon 2026-10-26 00:10 Berlin (2026-10-25T23:10Z).
    const check = checkInvitationPeriod({ scheduledAt: at("2026-10-25T23:10:00Z") }, rules(3, 0), at("2026-10-23T21:50:00Z"));
    expect(check).toMatchObject({ sendDay: "2026-10-23", meetingDay: "2026-10-26", daysAvailable: 3, ok: true });
  });

  it("reports missing rules and a missing date instead of guessing", () => {
    expect(checkInvitationPeriod({ scheduledAt: at("2026-06-18T16:00:00Z") }, rules(null, 3), at("2026-06-01T09:00:00Z"))).toMatchObject({ ok: false, reason: "rules_missing", requiredDays: null, earliestMeetingDay: null });
    expect(checkInvitationPeriod({ scheduledAt: at("2026-06-18T16:00:00Z") }, rules(14, null), at("2026-06-01T09:00:00Z")).reason).toBe("rules_missing");
    expect(checkInvitationPeriod({ scheduledAt: null }, rules(14, 3), at("2026-06-01T09:00:00Z"))).toMatchObject({ ok: false, reason: "no_date", earliestMeetingDay: "2026-06-18" });
  });

  it("applies the period of a Nachtrag from its own sending day", () => {
    const first = checkInvitationPeriod({ scheduledAt: at("2026-06-30T16:00:00Z") }, rules(14, 0), at("2026-06-10T09:00:00Z"));
    const nachtrag = checkInvitationPeriod({ scheduledAt: at("2026-06-30T16:00:00Z") }, rules(14, 0), at("2026-06-20T09:00:00Z"));
    expect(first.ok).toBe(true);
    expect(nachtrag).toMatchObject({ ok: false, earliestMeetingDay: "2026-07-04" });
  });

  it("allows a zero period and falls back to Berlin for an invalid zone", () => {
    expect(checkInvitationPeriod({ scheduledAt: at("2026-06-01T20:00:00Z") }, rules(0, 0), at("2026-06-01T08:00:00Z"))).toMatchObject({ ok: true, daysAvailable: 0 });
    expect(checkInvitationPeriod({ scheduledAt: at("2026-06-01T20:00:00Z") }, rules(0, 0), at("2026-06-01T08:00:00Z"), "Mars/Base").timezone).toBe("Europe/Berlin");
  });
});
