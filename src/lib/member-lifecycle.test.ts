import { describe, expect, it } from "vitest";

import type { MemberCategoryRow } from "../db/schema/club-members.js";
import { MEMBER_STATUSES } from "../db/schema/club-members.js";
import { ageOn, effectiveStatus, isLeftStatus, STATUS_TRANSITIONS, subtractYears, suggestCategory, todayBerlin, wouldCreateCycle } from "./member-lifecycle.js";

const category = (over: Partial<MemberCategoryRow>): MemberCategoryRow => ({
  id: "c-" + (over.key ?? "x"),
  clubId: "club",
  key: "x",
  name: "X",
  votingRight: true,
  minAge: null,
  maxAge: null,
  autoTransitionToKey: null,
  sortOrder: 0,
  archivedAt: null,
  createdAt: new Date("2020-01-01"),
  ...over,
});

describe("status matrix", () => {
  it("covers every status and only targets known statuses", () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...MEMBER_STATUSES].sort());
    for (const targets of Object.values(STATUS_TRANSITIONS)) for (const t of targets) expect(MEMBER_STATUSES).toContain(t);
  });

  it("allows the intended live transitions", () => {
    expect(STATUS_TRANSITIONS.interessent).toEqual(expect.arrayContaining(["probe", "aktiv", "ausgetreten"]));
    expect(STATUS_TRANSITIONS.probe).toContain("aktiv");
    expect(STATUS_TRANSITIONS.aktiv).toContain("ruhend");
    expect(STATUS_TRANSITIONS.ruhend).toContain("aktiv");
    for (const to of ["ausgetreten", "ausgeschlossen", "verstorben"] as const) expect(STATUS_TRANSITIONS.aktiv).toContain(to);
  });

  it("leaving statuses can only go back to aktiv", () => {
    for (const s of ["ausgetreten", "ausgeschlossen", "verstorben"] as const) expect(STATUS_TRANSITIONS[s]).toEqual(["aktiv"]);
  });

  it("forbids nonsense such as aktiv -> probe or interessent -> ruhend", () => {
    expect(STATUS_TRANSITIONS.aktiv).not.toContain("probe");
    expect(STATUS_TRANSITIONS.interessent).not.toContain("ruhend");
    expect(STATUS_TRANSITIONS.interessent).not.toContain("ausgeschlossen");
  });
});

describe("effectiveStatus (Stichtag)", () => {
  const today = "2026-10-11";
  it("keeps the stored status without left_at or with a future left_at", () => {
    expect(effectiveStatus({ status: "aktiv", leftAt: null }, today)).toBe("aktiv");
    expect(effectiveStatus({ status: "ruhend", leftAt: "2026-10-12" }, today)).toBe("ruhend");
  });
  it("turns into ausgetreten on the key date and after", () => {
    expect(effectiveStatus({ status: "aktiv", leftAt: "2026-10-11" }, today)).toBe("ausgetreten");
    expect(effectiveStatus({ status: "probe", leftAt: "2025-01-01" }, today)).toBe("ausgetreten");
  });
  it("never overrides a stored leaving status", () => {
    expect(effectiveStatus({ status: "ausgeschlossen", leftAt: "2020-01-01" }, today)).toBe("ausgeschlossen");
    expect(effectiveStatus({ status: "verstorben", leftAt: null }, today)).toBe("verstorben");
    expect(isLeftStatus("verstorben")).toBe(true);
    expect(isLeftStatus("ruhend")).toBe(false);
  });
});

describe("age helpers", () => {
  it("computes whole years, birthday inclusive", () => {
    expect(ageOn("2008-10-11", "2026-10-11")).toBe(18);
    expect(ageOn("2008-10-12", "2026-10-11")).toBe(17);
    expect(ageOn("2000-02-29", "2026-02-28")).toBe(25);
    expect(ageOn("2000-02-29", "2026-03-01")).toBe(26);
  });
  it("subtracts years with end-of-month clamping", () => {
    expect(subtractYears("2026-10-11", 18)).toBe("2008-10-11");
    expect(subtractYears("2028-02-29", 1)).toBe("2027-02-28");
    expect(subtractYears("2028-02-29", 4)).toBe("2024-02-29");
  });
});

describe("suggestCategory (fixed date 2026-10-11)", () => {
  const today = "2026-10-11";
  const jugend = category({ key: "jugend", maxAge: 17, autoTransitionToKey: "aktiv" });
  const aktiv = category({ key: "aktiv" });
  const byId = new Map([jugend, aktiv].map((c) => [c.id, c]));
  const byKey = new Map([jugend, aktiv].map((c) => [c.key, c]));
  const row = (over: object) => ({ categoryId: jugend.id, birthDate: "2008-01-01", status: "aktiv", leftAt: null as string | null, ...over });

  it("suggests the target once the member is older than max_age", () => {
    expect(suggestCategory(row({ birthDate: "2008-10-11" }), byId, byKey, today)?.to.key).toBe("aktiv"); // turned 18 today
    expect(suggestCategory(row({ birthDate: "2008-10-12" }), byId, byKey, today)).toBeNull(); // still 17
  });
  it("needs birth date, category and an unarchived existing target", () => {
    expect(suggestCategory(row({ birthDate: null }), byId, byKey, today)).toBeNull();
    expect(suggestCategory(row({ categoryId: null }), byId, byKey, today)).toBeNull();
    expect(suggestCategory(row({ categoryId: aktiv.id }), byId, byKey, today)).toBeNull();
    const archivedTarget = new Map([["aktiv", { ...aktiv, archivedAt: new Date() }]]);
    expect(suggestCategory(row({}), byId, archivedTarget, today)).toBeNull();
  });
  it("is silent for members who have left (also derived by left_at)", () => {
    expect(suggestCategory(row({ status: "ausgetreten" }), byId, byKey, today)).toBeNull();
    expect(suggestCategory(row({ leftAt: "2026-01-01" }), byId, byKey, today)).toBeNull();
  });
});

describe("wouldCreateCycle", () => {
  const cats = [
    { key: "a", autoTransitionToKey: "b" },
    { key: "b", autoTransitionToKey: "c" },
    { key: "c", autoTransitionToKey: null },
  ];
  it("detects direct and transitive cycles", () => {
    expect(wouldCreateCycle(cats, "c", "a")).toBe(true);
    expect(wouldCreateCycle(cats, "b", "a")).toBe(true);
    expect(wouldCreateCycle(cats, "c", "c")).toBe(true);
  });
  it("accepts chains", () => {
    expect(wouldCreateCycle(cats, "d", "a")).toBe(false);
    expect(wouldCreateCycle(cats, "c", "d")).toBe(false);
  });
});

describe("todayBerlin (A8)", () => {
  it("is the Berlin calendar day, not the UTC one, around midnight", () => {
    // 00:30 CEST on 1 July = 22:30 UTC on 30 June
    expect(todayBerlin(new Date("2026-06-30T22:30:00Z"))).toBe("2026-07-01");
    // 23:30 UTC on 30 June is already 01:30 CEST on 1 July
    expect(todayBerlin(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
    // winter time (CET = UTC+1): 00:30 CET on 1 January = 23:30 UTC on 31 December
    expect(todayBerlin(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
    // 21:59 UTC on 30 June is still 30 June 23:59 CEST
    expect(todayBerlin(new Date("2026-06-30T21:59:00Z"))).toBe("2026-06-30");
    // DST switch (29 March 2026, 02:00 CET -> 03:00 CEST)
    expect(todayBerlin(new Date("2026-03-28T23:30:00Z"))).toBe("2026-03-29");
  });

  it("makes an exit dated 'today' (Berlin) effective right after midnight CEST, and a birthday count at 00:30 CEST", () => {
    const justAfterMidnight = todayBerlin(new Date("2026-06-30T22:30:00Z")); // 2026-07-01 00:30 CEST
    expect(effectiveStatus({ status: "aktiv", leftAt: "2026-07-01" }, justAfterMidnight)).toBe("ausgetreten");
    // with UTC "today" (the old behaviour) the member would still be aktiv for another 1.5 hours
    expect(effectiveStatus({ status: "aktiv", leftAt: "2026-07-01" }, "2026-06-30")).toBe("aktiv");
    expect(ageOn("2016-07-01", justAfterMidnight)).toBe(10);
    expect(ageOn("2016-07-01", "2026-06-30")).toBe(9);
  });
});
