import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { memberFieldDefinitions, memberFieldValues } from "../db/schema/forms.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { ageGroupIndex, ageGroupLabels } from "../lib/association-report.js";
import { clubStatsRoutes } from "./club-stats.js";
import { createEventFixture, type EventFixture, type TestUser } from "./event-test-support.js";

describe("association report: age groups", () => {
  it("labels ascending bounds and assigns the edges of each group", () => {
    const bands = [6, 14, 18, 26, 40, 60];
    expect(ageGroupLabels(bands)).toEqual(["0-6", "7-14", "15-18", "19-26", "27-40", "41-60", "61+"]);
    expect([0, 6, 7, 14, 15, 18, 19, 26, 27, 40, 41, 60, 61, 99].map((a) => ageGroupIndex(a, bands))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6]);
    expect(ageGroupLabels([18])).toEqual(["0-18", "19+"]);
  });
});

/** GET /club-stats/association-report. Every assertion looks at the test's own departments only (the fixture adds its own members to the club). */
describe("association report route", () => {
  let fx: EventFixture;
  let sport: string;
  let chess: string;
  const get = (who: { cookie: string }, query = "", club?: string) => fx.req(who, `/club-stats/association-report${query ? `?${query}` : ""}`, { club });
  // The route is limited to 10 requests a minute per user, so each test gets its own board account.
  const boardUser = async (label: string, roleType = "vorsitz"): Promise<TestUser> => {
    const u = await fx.addAccount(label);
    await db.insert(clubRoles).values({ memberId: u.memberId, roleType });
    return u;
  };
  const rowsOf = async (res: Response) => (await fx.json(res)).data.rows as Array<Record<string, string | number>>;
  const rowFor = (rows: Array<Record<string, string | number>>, match: Record<string, string>) => rows.find((r) => Object.entries(match).every(([k, v]) => r[k] === v));
  const addMember = async (name: string, v: { birth?: string | null; joined?: string; left?: string | null; status?: string; dept?: string[]; deptSince?: string; deptUntil?: string }) => {
    const [cm] = await db.insert(clubMembers).values({ clubId: fx.clubId, displayName: name, status: v.status ?? "aktiv", joinedAt: v.joined ?? "2020-01-01", leftAt: v.left ?? null, birthDate: v.birth ?? null }).returning();
    for (const d of v.dept ?? []) await db.insert(clubMemberDepartments).values({ clubMemberId: cm!.id, departmentId: d, since: v.deptSince ?? "2020-01-01", until: v.deptUntil ?? null });
    return cm!.id;
  };

  beforeAll(async () => {
    fx = await createEventFixture("assocrep", [["/club-stats", clubStatsRoutes]]);
    [{ id: sport }, { id: chess }] = (await db.insert(departments).values([{ clubId: fx.clubId, name: "Fußball Verband" }, { clubId: fx.clubId, name: "Schach Verband" }]).returning()) as [{ id: string }, { id: string }];
    // Reference day 2026-06-30. Ages (jahrgang / exact): see assertions.
    await addMember("=Formel", { birth: "2020-01-01", dept: [sport] }); // jahrgang 6 -> 0-6; exact 6
    await addMember("Kind7", { birth: "2019-12-31", dept: [sport] }); // jahrgang 7 -> 7-14; exact 6 (birthday after Stichtag? no: 2019-12-31 -> 6)
    await addMember("Jugend", { birth: "2008-07-01", dept: [sport] }); // jahrgang 18 -> 15-18; exact 17
    await addMember("Senior", { birth: "1950-05-05", dept: [sport, chess] }); // 61+ in both
    await addMember("OhneGeburt", { birth: null, dept: [sport] });
    await addMember("OhneSparte", { birth: "1990-01-01" });
    // Stichtag logic
    await addMember("Ausgetreten vorher", { birth: "1990-01-01", status: "ausgetreten", left: "2026-06-30", dept: [chess] });
    await addMember("Ausgetreten später", { birth: "1990-01-01", status: "ausgetreten", left: "2026-07-01", dept: [chess] });
    await addMember("Zukünftig", { birth: "1990-01-01", joined: "2026-07-01", dept: [chess] });
    await addMember("Interessent", { birth: "1990-01-01", status: "interessent", dept: [chess] });
    await addMember("Ruhend", { birth: "1990-01-01", status: "ruhend", dept: [chess] });
    await addMember("Sparte endet", { birth: "1990-01-01", dept: [chess], deptUntil: "2026-06-30" });
    await addMember("Sparte beginnt", { birth: "1990-01-01", dept: [chess], deptSince: "2026-07-01" });
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("is deny-by-default: board roles may, trainers, leaders, members and strangers may not", async () => {
    for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "kassenwart", "beisitzer"]) {
      const u = await boardUser(`board-${role}`, role);
      expect((await get(u, "stichtag=2026-06-30")).status, role).toBe(200);
    }
    for (const who of [fx.users.trainerA, fx.users.leaderA, fx.users.member1]) {
      expect((await get(who)).status).toBe(403);
      expect((await get(who, "format=csv")).status).toBe(403);
    }
    expect((await get(fx.users.outsider)).status).toBe(404);
    expect((await fx.app.request(`/club-stats/association-report?clubId=${fx.clubId}`)).status).toBe(401);
    expect((await db.select().from(auditLog).where(eq(auditLog.eventType, "association_report.export"))).filter((a) => a.clubId === fx.clubId)).toHaveLength(0);
  }, 60_000);

  it("counts by department and age group on the reference day (joined, left, future, interested, open assignments)", async () => {
    const u = await boardUser("stichtag");
    const res = await get(u, "stichtag=2026-06-30");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await fx.json(res)).data;
    expect(body).toMatchObject({ stichtag: "2026-06-30", columns: ["department", "ageGroup"], ageMode: "jahrgang", ageGroups: ["0-6", "7-14", "15-18", "19-26", "27-40", "41-60", "61+"] });
    expect(typeof body.note).toBe("string");
    const rows = body.rows as Array<Record<string, string | number>>;
    const sportRows = rows.filter((r) => r.department === "Fußball Verband");
    expect(sportRows.map((r) => [r.ageGroup, r.count])).toEqual([["0-6", 1], ["7-14", 1], ["15-18", 1], ["61+", 1], ["unbekannt", 1]]);
    const chessRows = rows.filter((r) => r.department === "Schach Verband");
    // Senior (61+), Ausgetreten später + Ruhend + Sparte endet? (endet am Stichtag = nicht mehr) + 'Sparte beginnt' (noch nicht) excluded.
    expect(chessRows.map((r) => [r.ageGroup, r.count])).toEqual([["27-40", 2], ["61+", 1]]);
    expect(rowFor(rows, { department: "ohne Abteilung", ageGroup: "27-40" })?.count).toBeGreaterThanOrEqual(3); // OhneSparte, Sparte endet, Sparte beginnt
    // Left on the reference day / future joiner / interested are never counted anywhere.
    const ages = await get(await boardUser("noname"), "stichtag=2026-06-30&columns=ageGroup");
    expect(JSON.stringify((await fx.json(ages)).data)).not.toMatch(/Ausgetreten|Zukünftig|Interessent|Formel/);
    const later = await rowsOf(await get(await boardUser("nextday"), "stichtag=2026-07-01&columns=department"));
    expect(rowFor(later, { department: "Schach Verband" })?.count).toBe(4); // Senior, Zukünftig, Ruhend, Sparte beginnt; not Ausgetreten (left 07-01), Sparte endet or Interessent
  }, 60_000);

  it("total counts every member once while a member in two departments counts in both rows", async () => {
    const u = await boardUser("total");
    const dep = (await fx.json(await get(u, "stichtag=2026-06-30&columns=department"))).data;
    const none = (await fx.json(await get(await boardUser("total2"), "stichtag=2026-06-30&columns=ageGroup"))).data;
    expect(dep.total).toBe(none.total);
    expect(dep.rows.reduce((s: number, r: { count: number }) => s + r.count, 0)).toBe(dep.total + 1);
    expect(none.rows.reduce((s: number, r: { count: number }) => s + r.count, 0)).toBe(none.total);
  }, 60_000);

  it("uses the birth year (jahrgang) by default and exact age with ageMode=stichtag; honours custom age bands", async () => {
    const jahr = await rowsOf(await get(await boardUser("jahr"), "stichtag=2026-06-30&columns=department,ageGroup"));
    const exact = await rowsOf(await get(await boardUser("exact"), "stichtag=2026-06-30&columns=department,ageGroup&ageMode=stichtag"));
    // Jugend, born 2008-07-01: jahrgang 18 -> 15-18; exact 17 -> 15-18 too. Kind7 born 2019-12-31: jahrgang 7 -> 7-14, exact 6 -> 0-6.
    expect(rowFor(jahr, { department: "Fußball Verband", ageGroup: "7-14" })?.count).toBe(1);
    expect(rowFor(exact, { department: "Fußball Verband", ageGroup: "7-14" })).toBeUndefined();
    expect(rowFor(exact, { department: "Fußball Verband", ageGroup: "0-6" })?.count).toBe(2);
    const bands = await fx.json(await get(await boardUser("bands"), "stichtag=2026-06-30&columns=department,ageGroup&ageBands=10,20"));
    expect(bands.data.ageGroups).toEqual(["0-10", "11-20", "21+"]);
    expect(rowFor(bands.data.rows, { department: "Fußball Verband", ageGroup: "0-10" })?.count).toBe(2);
  }, 60_000);

  it("validates parameters with stable codes", async () => {
    const u = await boardUser("invalid");
    for (const q of ["stichtag=2026-02-30", "stichtag=morgen", "columns=name", "format=xlsx", "delimiter=%7C", "ageMode=x"]) {
      const res = await get(u, q);
      expect(res.status, q).toBe(422);
      expect((await fx.json(res)).error.code).toBe("UNPROCESSABLE_ENTITY");
    }
    for (const q of ["ageBands=14,6", "ageBands=a,b", "ageBands=6,6", "ageBands=-1", "ageBands=200"]) {
      const res = await get(await boardUser(`bands-invalid-${q}`), q);
      expect(res.status, q).toBe(422);
      expect((await fx.json(res)).error.details.code, q).toBe("invalid_age_bands");
    }
  }, 60_000);

  it("needs a gender field for the gender column and reads it from a select/text custom field", async () => {
    const needs = await get(await boardUser("g1"), "columns=gender");
    expect(needs.status).toBe(422);
    expect((await fx.json(needs)).error.details.code).toBe("gender_field_required");
    for (const key of ["nope", "shirt"]) {
      if (key === "shirt") await db.insert(memberFieldDefinitions).values({ clubId: fx.clubId, key: "shirt", label: "Shirt", fieldType: "checkbox" });
      const res = await get(await boardUser(`g-${key}`), `columns=gender&genderField=${key}`);
      expect(res.status).toBe(422);
      expect((await fx.json(res)).error.details.code).toBe("unknown_gender_field");
    }
    // A foreign club's field of the same key is not visible.
    await db.insert(memberFieldDefinitions).values({ clubId: fx.otherClubId, key: "foreign", label: "F", fieldType: "text" });
    expect((await get(await boardUser("g-foreign"), "columns=gender&genderField=foreign")).status).toBe(422);

    const [def] = await db.insert(memberFieldDefinitions).values({ clubId: fx.clubId, key: "geschlecht", label: "Geschlecht", fieldType: "select", options: [{ value: "w", label: "weiblich" }, { value: "m", label: "männlich" }], sensitive: true }).returning();
    const ids = await db.select({ id: clubMembers.id, name: clubMembers.displayName }).from(clubMembers).where(eq(clubMembers.clubId, fx.clubId));
    const idOf = (n: string) => ids.find((i) => i.name === n)!.id;
    await db.insert(memberFieldValues).values([
      { clubMemberId: idOf("Kind7"), fieldId: def!.id, value: "w" },
      { clubMemberId: idOf("Jugend"), fieldId: def!.id, value: "m" },
      { clubMemberId: idOf("Senior"), fieldId: def!.id, value: "" },
    ]);
    const board = await boardUser("g-board");
    const res = await get(board, "stichtag=2026-06-30&columns=department,gender&genderField=geschlecht");
    expect(res.status).toBe(200);
    const rows = await rowsOf(res);
    expect(rowFor(rows, { department: "Fußball Verband", gender: "weiblich" })?.count).toBe(1);
    expect(rowFor(rows, { department: "Fußball Verband", gender: "männlich" })?.count).toBe(1);
    expect(rowFor(rows, { department: "Fußball Verband", gender: "unbekannt" })?.count).toBe(3);
    // Sensitive field: kassenwart and beisitzer (club_stats:read) have read_sensitive only for the kassenwart.
    const beisitzer = await boardUser("g-beisitzer", "beisitzer");
    expect((await get(beisitzer, "columns=gender&genderField=geschlecht")).status).toBe(403);
    const kassenwart = await boardUser("g-kassenwart", "kassenwart");
    expect((await get(kassenwart, "columns=gender&genderField=geschlecht")).status).toBe(200);
    // Without the gender column the field is not touched, so the beisitzer may still call.
    expect((await get(beisitzer, "columns=department")).status).toBe(200);
  }, 90_000);

  it("keeps the requested column order and supports category", async () => {
    const body = (await fx.json(await get(await boardUser("order"), "stichtag=2026-06-30&columns=category,department"))).data;
    expect(body.columns).toEqual(["category", "department"]);
    expect(Object.keys(body.rows[0])).toEqual(expect.arrayContaining(["category", "department", "count"]));
    expect(body.rows.every((r: { ageGroup?: string }) => r.ageGroup === undefined)).toBe(true);
    expect(body.rows.every((r: { category: string }) => typeof r.category === "string")).toBe(true);
  }, 60_000);

  it("exports CSV with BOM, CRLF, German header, sum row, neutralised formulas, delimiter choice and an audit entry without personal data", async () => {
    await db.update(departments).set({ name: "=SUMME(A1)" }).where(eq(departments.id, chess));
    try {
      const u = await boardUser("csv");
      const res = await get(u, "stichtag=2026-06-30&columns=department,ageGroup&format=csv");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/csv/);
      expect(res.headers.get("content-disposition")).toBe('attachment; filename="verbandsmeldung-2026-06-30.csv"');
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const bytes = new Uint8Array(await res.clone().arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = await res.text();
      expect(text.startsWith("Abteilung;Altersgruppe;Anzahl\r\n")).toBe(true);
      const lines = text.trimEnd().split("\r\n");
      expect(lines.at(-1)).toMatch(/^Summe;;\d+$/);
      expect(text).toContain("'=SUMME(A1);");
      expect(text).not.toMatch(/(^|;|\r\n)=SUMME/);
      expect(text).not.toMatch(/Senior|Kind7|Jugend|Formel/);
      const comma = await (await get(await boardUser("csv2"), "stichtag=2026-06-30&columns=ageGroup&format=csv&delimiter=,")).text();
      expect(comma.startsWith("Altersgruppe,Anzahl\r\n")).toBe(true);
      // A JSON preview writes no audit entry, each CSV export exactly one.
      await get(await boardUser("json"), "stichtag=2026-06-30");
      const audits = await db.select().from(auditLog).where(eq(auditLog.eventType, "association_report.export"));
      const mine = audits.filter((a) => a.clubId === fx.clubId);
      expect(mine).toHaveLength(2);
      expect(mine[0]!.actorUserId).toBe(u.userId);
      expect(mine[0]!.payload).toMatchObject({ clubId: fx.clubId, stichtag: "2026-06-30", columns: "department,ageGroup" });
      expect(Object.keys(mine[0]!.payload as object).sort()).toEqual(["clubId", "columns", "rows", "stichtag"]);
    } finally {
      await db.update(departments).set({ name: "Schach Verband" }).where(eq(departments.id, chess));
    }
  }, 60_000);

  it("defaults the reference day to today and answers an empty club with zero counts", async () => {
    const u = await boardUser("today");
    const body = (await fx.json(await get(u))).data;
    expect(body.stichtag).toBe(todayBerlin());
    // A day before any member joined: nothing to count.
    const empty = await get(await boardUser("empty"), "stichtag=1950-01-01");
    expect((await fx.json(empty)).data).toMatchObject({ rows: [], total: 0 });
    const csv = await (await get(await boardUser("empty-csv"), "stichtag=1950-01-01&format=csv")).text();
    expect(csv).toBe("Abteilung;Altersgruppe;Anzahl\r\nSumme;;0\r\n");
  }, 60_000);

  it("rate-limits per user", async () => {
    const u = await boardUser("limit");
    for (let i = 0; i < 10; i++) expect((await get(u, "stichtag=1950-01-01")).status).toBe(200);
    expect((await get(u, "stichtag=1950-01-01")).status).toBe(429);
  }, 60_000);
});
