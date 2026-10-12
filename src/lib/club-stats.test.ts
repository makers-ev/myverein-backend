import { describe, expect, it } from "vitest";

import { clubPermissionsFor, hasClubPermission } from "./club-permissions.js";
import { computeClubStats, lastMonths, type ClubStatsInput, type StatsMember } from "./club-stats.js";

const today = "2026-10-11";
const m = (id: string, over: Partial<StatsMember>): StatsMember => ({ id, memberId: null, status: "aktiv", joinedAt: "2020-01-01", leftAt: null, birthDate: null, categoryId: "cat-a", ...over });

const input: ClubStatsInput = {
  members: [
    m("1", { memberId: "acc1", birthDate: "1990-05-05" }), // 36, aktiv, account
    m("2", { birthDate: "2015-03-03", categoryId: "cat-j", joinedAt: "2026-10-02" }), // 11, no account, joined this month
    m("3", { status: "ruhend", birthDate: "1950-01-01" }), // 76
    m("4", { status: "probe" }), // age unknown
    m("5", { status: "interessent", joinedAt: "2026-10-05" }), // not counted, not joined
    m("6", { status: "ausgetreten", leftAt: "2026-09-15", joinedAt: "2019-01-01" }), // left last month
    m("7", { status: "aktiv", leftAt: "2026-10-01", joinedAt: "2018-01-01" }), // derived ausgetreten
    m("8", { status: "aktiv", leftAt: "2026-12-01", birthDate: "2008-10-11" }), // scheduled exit: still counted, 18
    m("9", { status: "verstorben", leftAt: "2025-10-11", joinedAt: "2000-01-01" }), // exactly 12 months ago: outside window start 2025-11
    m("10", { status: "aktiv", memberId: "acc10", birthDate: "2020-10-12", joinedAt: "2025-11-01" }), // 5, joined in first month of window
  ],
  categories: [
    { id: "cat-a", key: "aktiv", name: "Aktiv", archivedAt: null },
    { id: "cat-j", key: "jugend", name: "Jugend", archivedAt: null },
    { id: "cat-old", key: "alt", name: "Alt", archivedAt: new Date() },
  ],
  departments: [
    { id: "d1", name: "Fußball" },
    { id: "d2", name: "Tennis" },
  ],
  assignments: [
    { clubMemberId: "1", departmentId: "d1", until: null },
    { clubMemberId: "2", departmentId: "d1", until: "2027-01-01" },
    { clubMemberId: "3", departmentId: "d1", until: "2026-01-01" }, // ended
    { clubMemberId: "6", departmentId: "d1", until: null }, // left member
    { clubMemberId: "1", departmentId: "d2", until: null },
  ],
  exits: [
    { clubMemberId: "6", effectiveOn: "2026-09-15" }, // currently left: not counted twice
    { clubMemberId: "4", effectiveOn: "2026-08-20" }, // reopened later
    { clubMemberId: "4", effectiveOn: "2027-01-01" }, // future: ignored
  ],
};

describe("computeClubStats (reference data, today = 2026-10-11)", () => {
  const stats = computeClubStats(input, today);

  it("counts members independent of account; interessent and left are not members", () => {
    // counted: 1,2,3,4,8,10 (aktiv/ruhend/probe, effective)
    expect(stats.members).toEqual({ total: 6, active: 4, withAccount: 2, withoutAccount: 4 });
  });

  it("byStatus uses the effective status and lists every status", () => {
    expect(stats.byStatus).toEqual({ interessent: 1, probe: 1, aktiv: 4, ruhend: 1, ausgetreten: 2, ausgeschlossen: 0, verstorben: 1 });
  });

  it("byCategory covers the counted population, hides empty archived categories", () => {
    expect(stats.byCategory).toEqual([
      { key: "aktiv", name: "Aktiv", count: 5 },
      { key: "jugend", name: "Jugend", count: 1 },
    ]);
  });

  it("byDepartment counts current assignments of counted members only", () => {
    expect(stats.byDepartment).toEqual([
      { id: "d1", name: "Fußball", count: 2 },
      { id: "d2", name: "Tennis", count: 1 },
    ]);
  });

  it("buckets ages and reports unknown birth dates", () => {
    const counts = Object.fromEntries(stats.ageBuckets.map((b) => [b.label, b.count]));
    expect(counts).toEqual({ "0–5": 1, "6–12": 1, "13–17": 0, "18–29": 1, "30–49": 1, "50–64": 0, "65+": 1 });
    expect(stats.ageUnknown).toBe(1);
  });

  it("movement covers the last 12 months with joins from joined_at and exits from left_at/history", () => {
    expect(stats.movement).toHaveLength(12);
    expect(stats.movement[0]!.month).toBe("2025-11");
    expect(stats.movement[11]!.month).toBe("2026-10");
    const byMonth = Object.fromEntries(stats.movement.map((r) => [r.month, r]));
    expect(byMonth["2025-11"]).toEqual({ month: "2025-11", joined: 1, left: 0 });
    expect(byMonth["2026-08"]).toEqual({ month: "2026-08", joined: 0, left: 1 }); // 4: exit in history, reopened since
    expect(byMonth["2026-09"]).toEqual({ month: "2026-09", joined: 0, left: 1 }); // 6
    expect(byMonth["2026-10"]).toEqual({ month: "2026-10", joined: 1, left: 1 }); // joined: 2 (5 is interessent); left: 7 (derived)
  });

  it("contains no personal data", () => {
    const json = JSON.stringify(stats);
    expect(json).not.toMatch(/1990|2015|acc1|birth/);
  });
});

describe("helpers", () => {
  it("lastMonths wraps over year boundaries", () => {
    expect(lastMonths("2026-02-10", 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });
  it("only board roles hold club_stats:read (a real ClubPermission)", () => {
    for (const r of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "kassenwart", "beisitzer"]) expect(hasClubPermission([r], "club_stats:read")).toBe(true);
    for (const r of ["mitglied", "abteilungsleitung", "trainer", "erziehungsberechtigt"]) expect(hasClubPermission([r], "club_stats:read")).toBe(false);
    expect(hasClubPermission([], "club_stats:read")).toBe(false);
    expect(clubPermissionsFor(["kassenwart"])).toContain("club_stats:read");
  });
});
