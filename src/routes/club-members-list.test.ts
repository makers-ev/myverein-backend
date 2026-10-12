import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { departments } from "../db/schema/departments.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { clubMemberRoutes } from "./club-members.js";
import { clubStatsRoutes } from "./club-stats.js";

/** Wave 7 B9 (search, filter, paging) and B11 (club KPIs) against a real database. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-stats", clubStatsRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const yearsAgo = (years: number) => {
  const d = new Date();
  return iso(new Date(Date.UTC(d.getUTCFullYear() - years, d.getUTCMonth(), d.getUTCDate())));
};

async function signUp(label: string): Promise<Actor> {
  const email = `cm-list-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `List ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

let club: string;
function call(who: Actor, url: string, init: { method?: string; body?: object } = {}) {
  return app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}
const json = async (res: Response) => (await res.json()) as Json;
const names = (body: Json) => (body.data as Json[]).map((m) => m.name as string);

describe("member list (B9) and club stats (B11)", () => {
  const actors: Record<"founder" | "secretary" | "treasurer" | "trainer" | "plain", Actor> = {} as never;
  const userIds: string[] = [];
  const ids: Record<string, string> = {};
  let dept1: string;
  let dept2: string;

  async function create(key: string, body: Json) {
    const res = await call(actors.founder, "/club-members", { method: "POST", body: { categoryKey: "aktiv", joinedAt: today(), ...body } });
    expect(res.status, key).toBe(201);
    ids[key] = (await json(res)).data.id;
  }

  beforeAll(async () => {
    for (const label of ["founder", "secretary", "treasurer", "trainer", "plain"] as const) {
      actors[label] = await signUp(label);
      userIds.push(actors[label].userId);
    }
    club = (await auth.api.createOrganization({ body: { name: `List ${suffix}`, slug: `lst-${suffix}`, userId: actors.founder.userId } }))!.id;
    const roles: Array<[keyof typeof actors, string | null]> = [
      ["founder", "vorsitz"],
      ["secretary", "schriftfuehrer"],
      ["treasurer", "kassenwart"],
      ["trainer", "trainer"],
      ["plain", null],
    ];
    for (const [label, role] of roles) {
      const account =
        label === "founder"
          ? (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, actors.founder.userId)) }))!
          : (await auth.api.addMember({ body: { userId: actors[label].userId, organizationId: club, role: "member" } }))!;
      if (role) await db.insert(clubRoles).values({ memberId: account.id, roleType: role });
    }
    [dept1, dept2] = (await db.insert(departments).values([{ clubId: club, name: "Fußball" }, { clubId: club, name: "Tennis" }]).returning()).map((d) => d.id) as [string, string];

    await create("anna", { displayName: "Anna Alpha", categoryKey: "jugend", birthDate: yearsAgo(10), memberNumber: "T-001", contactEmail: "anna.eltern@example.org", joinedAt: "2022-03-01" });
    await create("bernd", { displayName: "Bernd Beta", birthDate: yearsAgo(40), memberNumber: "T-002", joinedAt: "2021-01-01" });
    await create("clara", { displayName: "Clara 100% Gamma", status: "ruhend", birthDate: yearsAgo(70), memberNumber: "T-003", joinedAt: "2020-06-01" });
    await create("dora", { displayName: "Dora Delta", status: "probe", categoryKey: "passiv", memberNumber: "T-004" });
    await create("emil", { displayName: "Emil Epsilon", status: "interessent", memberNumber: "T-005" });
    await create("fritz", { displayName: "fritz Phi", memberNumber: "T-006", joinedAt: "2019-01-01" });
    for (const [member, dept] of [["anna", dept1], ["bernd", dept1]] as const) {
      expect((await call(actors.founder, `/club-members/${ids[member]}/departments`, { method: "POST", body: { departmentId: dept } })).status).toBe(201);
    }
    expect((await call(actors.founder, `/club-members/${ids.fritz}/transition`, { method: "POST", body: { toStatus: "ausgetreten" } })).status).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, club));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("GET /club-members", () => {
    it("returns the frame { data, page, pageSize, total } with default paging 50, sorted by name case-insensitively", async () => {
      const body = await json(await call(actors.founder, "/club-members"));
      expect(body).toMatchObject({ page: 1, pageSize: 50, total: 11 }); // 5 accounts + 6 account-less
      expect(body.data).toHaveLength(11);
      const sorted = names(body).map((n) => n.toLowerCase());
      expect(sorted).toEqual([...sorted].sort());
    });

    it("pages with a stable order and reports the total", async () => {
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const body = await json(await call(actors.founder, `/club-members?pageSize=4&page=${page}`));
        expect(body).toMatchObject({ page, pageSize: 4, total: 11 });
        seen.push(...(body.data as Json[]).map((m) => m.id));
      }
      expect(seen).toHaveLength(11);
      expect(new Set(seen).size).toBe(11);
      const beyond = await json(await call(actors.founder, "/club-members?pageSize=4&page=9"));
      expect(beyond.data).toEqual([]);
      expect(beyond.total).toBe(11);
    });

    it("validates paging and filter parameters (422)", async () => {
      for (const q of ["pageSize=101", "pageSize=0", "page=0", "page=abc", "status=bogus", "sort=email", "order=up", "hasAccount=maybe", "departmentId=nope", "ageMin=-1"]) {
        expect((await call(actors.founder, `/club-members?${q}`)).status, q).toBe(422);
      }
      expect((await call(actors.founder, "/club-members?ageMin=30&ageMax=10")).status).toBe(422);
      expect((await call(actors.founder, "/club-members?pageSize=100")).status).toBe(200);
    });

    it("searches the name (case-insensitive, % and _ are literal)", async () => {
      expect(names(await json(await call(actors.founder, "/club-members?q=ALPHA")))).toEqual(["Anna Alpha"]);
      expect(names(await json(await call(actors.founder, "/club-members?q=100%25")))).toEqual(["Clara 100% Gamma"]);
      expect((await json(await call(actors.founder, "/club-members?q=%25"))).total).toBe(1);
      expect((await json(await call(actors.founder, "/club-members?q=a_b"))).total).toBe(0);
    });

    it("member number and e-mail are searchable only with members:read_sensitive (no oracle)", async () => {
      expect(names(await json(await call(actors.founder, "/club-members?q=T-003")))).toEqual(["Clara 100% Gamma"]);
      expect(names(await json(await call(actors.founder, "/club-members?q=eltern@example")))).toEqual(["Anna Alpha"]);
      expect(names(await json(await call(actors.founder, `/club-members?q=cm-list-trainer-${suffix}`)))).toEqual(["List trainer"]); // account e-mail
      for (const q of ["T-003", "eltern@example", `cm-list-trainer-${suffix}`]) {
        for (const who of [actors.secretary, actors.plain, actors.trainer]) {
          const body = await json(await call(who, `/club-members?q=${q}`));
          expect(body.total, q).toBe(0);
          expect(body.data).toEqual([]);
        }
      }
      // The name search still works for them.
      expect(names(await json(await call(actors.plain, "/club-members?q=delta")))).toEqual(["Dora Delta"]);
    });

    it("filters by status (effective), category, department, account and combinations", async () => {
      expect(names(await json(await call(actors.founder, "/club-members?status=ruhend,probe")))).toEqual(["Clara 100% Gamma", "Dora Delta"]);
      expect(names(await json(await call(actors.founder, "/club-members?status=ausgetreten")))).toEqual(["fritz Phi"]);
      expect((await json(await call(actors.founder, "/club-members?status=aktiv"))).total).toBe(7); // 5 accounts + Anna + Bernd
      expect(names(await json(await call(actors.founder, "/club-members?category=jugend")))).toEqual(["Anna Alpha"]);
      expect(names(await json(await call(actors.founder, "/club-members?category=PASSIV,jugend")))).toEqual(["Anna Alpha", "Dora Delta"]);
      expect(names(await json(await call(actors.founder, `/club-members?departmentId=${dept1}`)))).toEqual(["Anna Alpha", "Bernd Beta"]);
      expect((await json(await call(actors.founder, `/club-members?departmentId=${dept2}`))).total).toBe(0);
      expect((await json(await call(actors.founder, "/club-members?hasAccount=true"))).total).toBe(5);
      expect((await json(await call(actors.founder, "/club-members?hasAccount=false"))).total).toBe(6);
      expect(names(await json(await call(actors.founder, `/club-members?hasAccount=false&status=aktiv&departmentId=${dept1}&q=bernd`)))).toEqual(["Bernd Beta"]);
    });

    it("filters by age only with members:read_sensitive (403 otherwise)", async () => {
      expect(names(await json(await call(actors.founder, "/club-members?ageMin=18&ageMax=59")))).toEqual(["Bernd Beta"]);
      expect(names(await json(await call(actors.founder, "/club-members?ageMax=12")))).toEqual(["Anna Alpha"]);
      expect(names(await json(await call(actors.founder, "/club-members?ageMin=65")))).toEqual(["Clara 100% Gamma"]);
      expect(names(await json(await call(actors.founder, "/club-members?ageMin=10&ageMax=10")))).toEqual(["Anna Alpha"]);
      for (const q of ["ageMin=18", "ageMax=12"]) {
        expect((await call(actors.secretary, `/club-members?${q}`)).status, q).toBe(403);
        expect((await call(actors.plain, `/club-members?${q}`)).status, q).toBe(403);
      }
    });

    it("sorts by joinedAt and memberNumber in both directions (memberNumber needs read_sensitive)", async () => {
      const byJoin = names(await json(await call(actors.founder, "/club-members?status=aktiv,ruhend,ausgetreten&hasAccount=false&sort=joinedAt&order=asc")));
      expect(byJoin).toEqual(["fritz Phi", "Clara 100% Gamma", "Bernd Beta", "Anna Alpha"]);
      expect(names(await json(await call(actors.founder, "/club-members?hasAccount=false&sort=memberNumber&order=desc")))).toEqual([
        "fritz Phi",
        "Emil Epsilon",
        "Dora Delta",
        "Clara 100% Gamma",
        "Bernd Beta",
        "Anna Alpha",
      ]);
      expect(names(await json(await call(actors.founder, "/club-members?hasAccount=false&order=desc")))[0]).toBe("fritz Phi");
      expect((await call(actors.secretary, "/club-members?sort=memberNumber")).status).toBe(403);
      expect((await call(actors.secretary, "/club-members?sort=joinedAt")).status).toBe(200);
    });

    it("keeps hiding sensitive fields for callers without read_sensitive in the paged shape", async () => {
      const body = await json(await call(actors.secretary, "/club-members?q=anna"));
      expect(body.data[0]).not.toHaveProperty("birthDate");
      expect(body.data[0]).not.toHaveProperty("memberNumber");
      expect(body.data[0]).toMatchObject({ name: "Anna Alpha", effectiveStatus: "aktiv", departments: [{ name: "Fußball" }] });
    });
  });

  describe("GET /club-stats", () => {
    it("is limited to board roles (403 for plain members, trainers; 401 without session)", async () => {
      expect((await call(actors.plain, "/club-stats")).status).toBe(403);
      expect((await call(actors.trainer, "/club-stats")).status).toBe(403);
      expect((await app.request(`/club-stats?clubId=${club}`)).status).toBe(401);
      for (const who of [actors.founder, actors.secretary, actors.treasurer]) expect((await call(who, "/club-stats")).status).toBe(200);
    });

    it("matches the reference data", async () => {
      const { data } = await json(await call(actors.treasurer, "/club-stats"));
      // counted: 5 accounts + Anna, Bernd, Clara (ruhend), Dora (probe); Emil is interessent, Fritz left.
      expect(data.members).toEqual({ total: 9, active: 7, withAccount: 5, withoutAccount: 4 });
      expect(data.byStatus).toEqual({ interessent: 1, probe: 1, aktiv: 7, ruhend: 1, ausgetreten: 1, ausgeschlossen: 0, verstorben: 0 });
      const byCategory = Object.fromEntries((data.byCategory as Json[]).map((c) => [c.key, c.count]));
      expect(byCategory).toMatchObject({ aktiv: 7, passiv: 1, jugend: 1, foerdernd: 0, ehrenmitglied: 0 });
      expect(data.byDepartment).toEqual([
        { id: dept1, name: "Fußball", count: 2 },
        { id: dept2, name: "Tennis", count: 0 },
      ]);
      expect(Object.fromEntries((data.ageBuckets as Json[]).map((b) => [b.label, b.count]))).toEqual({ "0–5": 0, "6–12": 1, "13–17": 0, "18–29": 0, "30–49": 1, "50–64": 0, "65+": 1 });
      expect(data.ageUnknown).toBe(6);
      expect(data.movement).toHaveLength(12);
      const current = data.movement[11];
      expect(current.month).toBe(today().slice(0, 7));
      // joined this month: Dora + the 5 accounts (the others joined earlier, Emil is only interessent); left today: Fritz
      expect(current.left).toBe(1);
      expect(current.joined).toBe(6);
    });

    it("contains no personal data", async () => {
      const text = JSON.stringify(await json(await call(actors.founder, "/club-stats")));
      for (const needle of ["Anna", "Bernd", "T-00", "eltern", "example.com", "birthDate", yearsAgo(10)]) expect(text).not.toContain(needle);
    });

    it("/me exposes club_stats:read to the board so clients can gate the dashboard", async () => {
      const board = await json(await call(actors.treasurer, "/club-members/me"));
      expect(board.data.permissions).toContain("club_stats:read");
      const plain = await json(await call(actors.plain, "/club-members/me"));
      expect(plain.data.permissions).not.toContain("club_stats:read");
    });
  });
});
