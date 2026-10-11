import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { clubMemberRoutes } from "./club-members.js";
import { clubStatsRoutes } from "./club-stats.js";
import { meetingRoutes } from "./meetings.js";

/** Review fixes of the member foundation (guests, normalisation, leftAt, suggestions right, former members, locking, sorting). */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-stats", clubStatsRoutes);
app.route("/meetings", meetingRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  // eslint-disable-next-line no-console
  if (appError.status >= 500) console.error("[test] 500 caused by", err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; memberId: string; clubMemberId: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const iso = (d: Date) => d.toISOString().slice(0, 10);
const yearsAgo = (years: number, extraDays = 0) => {
  const d = new Date();
  return iso(new Date(Date.UTC(d.getUTCFullYear() - years, d.getUTCMonth(), d.getUTCDate() - extraDays)));
};

let club: string;
async function signUp(label: string) {
  const email = `rf-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `RF ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}
function call(who: { cookie: string }, url: string, init: { method?: string; body?: object } = {}) {
  return app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}
const data = async (res: Response) => ((await res.json()) as Json).data as Json;

describe("member foundation review fixes", () => {
  let founder: Actor;
  let plain: Actor;
  let guest: Actor;
  let treasurer: Actor; // kassenwart: members:read_sensitive, no members:write
  let secretary: Actor; // schriftfuehrer: members:write, no members:read_sensitive
  const userIds: string[] = [];

  async function join(label: string, role: "member" | "guest", clubRole?: string): Promise<Actor> {
    const s = await signUp(label);
    userIds.push(s.userId);
    const account = (await auth.api.addMember({ body: { userId: s.userId, organizationId: club, role } }))!;
    if (clubRole) await db.insert(clubRoles).values({ memberId: account.id, roleType: clubRole });
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
    return { ...s, memberId: account.id, clubMemberId: row.id };
  }
  async function newMember(body: Json = {}): Promise<Json> {
    const res = await call(founder, "/club-members", { method: "POST", body: { displayName: `M ${randomUUID().slice(0, 6)}`, categoryKey: "aktiv", ...body } });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return data(res);
  }

  beforeAll(async () => {
    const f = await signUp("founder");
    userIds.push(f.userId);
    club = (await auth.api.createOrganization({ body: { name: `RF ${suffix}`, slug: `rf-${suffix}`, userId: f.userId } }))!.id;
    const fm = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, f.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: fm.id, roleType: "vorsitz" });
    const fr = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, fm.id) }))!;
    founder = { ...f, memberId: fm.id, clubMemberId: fr.id };
    plain = await join("plain", "member");
    guest = await join("guest", "guest");
    treasurer = await join("treasurer", "member", "kassenwart");
    secretary = await join("secretary", "member", "schriftfuehrer");
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, club));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  // --- A1 ------------------------------------------------------------------------------------

  describe("external guests (A1)", () => {
    let meetingId: string;
    beforeAll(async () => {
      const res = await call(founder, "/meetings", { method: "POST", body: { type: "sonstige", title: "Offenes Treffen" } });
      expect(res.status).toBe(201);
      meetingId = (await data(res)).id;
    });

    it("cannot read meetings: the list and every meeting route answer 404", async () => {
      expect((await call(guest, "/meetings")).status).toBe(404);
      for (const path of ["", "/invitees", "/attendance", "/resolutions", "/overlap"]) {
        expect((await call(guest, `/meetings/${meetingId}${path}`)).status, path).toBe(404);
      }
      expect((await call(plain, "/meetings")).status).toBe(200);
      expect((await call(plain, `/meetings/${meetingId}`)).status).toBe(200);
    });

    it("cannot read the member list (403) nor other members (404), but keeps /me and the own row", async () => {
      expect((await call(guest, "/club-members")).status).toBe(403);
      expect((await call(guest, `/club-members/${plain.clubMemberId}`)).status).toBe(404);
      expect((await call(guest, `/club-members/${plain.memberId}`)).status).toBe(404); // member.id fallback does not bypass it
      for (const sub of ["departments", "roles", "guardians"]) expect((await call(guest, `/club-members/${plain.clubMemberId}/${sub}`)).status, sub).toBe(404);
      expect((await call(guest, "/club-members/me")).status).toBe(200);
      const own = await call(guest, `/club-members/${guest.clubMemberId}`);
      expect(own.status).toBe(200);
      expect((await data(own)).id).toBe(guest.clubMemberId);
      expect((await call(plain, "/club-members")).status).toBe(200);
    });
  });

  // --- A2 / A3 / A7 -------------------------------------------------------------------------

  describe("categories", () => {
    it("normalises autoTransitionToKey (trim + lower case) on create and PATCH, the suggestion fires and cycles are found with 'Aktiv'-style input", async () => {
      const kinder = await call(founder, "/club-members/categories", { method: "POST", body: { name: "Kinder", maxAge: 12, autoTransitionToKey: "  Jugend " } });
      expect(kinder.status).toBe(201);
      const kinderBody = await data(kinder);
      expect(kinderBody.autoTransitionToKey).toBe("jugend");

      const child = await newMember({ categoryKey: "kinder", birthDate: yearsAgo(14, 5) });
      const detail = await data(await call(founder, `/club-members/${child.id}`));
      expect(detail.suggestedCategory).toMatchObject({ key: "jugend" });

      // jugend -> kinder would close the loop kinder -> jugend -> kinder; input in other spelling must not hide it
      const cycle = await call(founder, `/club-members/categories/${(await data(await call(founder, "/club-members/categories?includeArchived=true"))).find((c: Json) => c.key === "jugend").id}`, {
        method: "PATCH",
        body: { maxAge: 17, autoTransitionToKey: " KINDER " },
      });
      expect(cycle.status).toBe(422);

      const patched = await call(founder, `/club-members/categories/${kinderBody.id}`, { method: "PATCH", body: { autoTransitionToKey: " Aktiv " } });
      expect(patched.status).toBe(200);
      expect((await data(patched)).autoTransitionToKey).toBe("aktiv");
    });

    it("archiving clears the pointers that name the archived category, whatever spelling they were created with", async () => {
      const goal = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Zielgruppe" } }));
      const source = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Quellgruppe", maxAge: 10, autoTransitionToKey: " ZIELGRUPPE " } }));
      expect(source.autoTransitionToKey).toBe("zielgruppe");
      const archived = await call(founder, `/club-members/categories/${goal.id}`, { method: "DELETE" });
      expect(archived.status).toBe(200);
      expect((await data(archived)).clearedAutoTransitions).toBe(1);
      const after = (await data(await call(founder, "/club-members/categories"))).find((c: Json) => c.id === source.id);
      expect(after.autoTransitionToKey).toBeNull();
    });

    it("two parallel PATCHes that would close a cycle together: exactly one wins, the other is a 422", async () => {
      const a = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Zyklus A", maxAge: 10 } }));
      const b = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Zyklus B", maxAge: 10 } }));
      const [r1, r2] = await Promise.all([
        call(founder, `/club-members/categories/${a.id}`, { method: "PATCH", body: { autoTransitionToKey: b.key } }),
        call(founder, `/club-members/categories/${b.id}`, { method: "PATCH", body: { autoTransitionToKey: a.key } }),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 422]);
    });

    it("archiving in parallel with moves into the category never errors out with 500 and leaves nobody behind", async () => {
      const target = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Wettlauf" } }));
      const fallback = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Auffangbecken" } }));
      const members = await Promise.all([newMember(), newMember(), newMember()]);
      const results = await Promise.all([
        call(founder, `/club-members/categories/${target.id}?moveTo=${fallback.id}`, { method: "DELETE" }),
        ...members.map((m) => call(founder, `/club-members/${m.id}`, { method: "PATCH", body: { categoryId: target.id } })),
        ...members.map((m) => call(founder, `/club-members/${m.id}/transition`, { method: "POST", body: { categoryId: target.id } })),
      ]);
      for (const res of results) expect([200, 409, 422], String(res.status)).toContain(res.status);
      expect(results[0].status).toBe(200);
      // Whoever still got into the archived category before the archive moved on with it: nobody remains in it.
      const stuck = await db.query.clubMembers.findMany({ where: and(eq(clubMembers.clubId, club), eq(clubMembers.categoryId, target.id)) });
      expect(stuck).toEqual([]);
    });

    it("apply of suggestions parallel to archiving the target does not deadlock", async () => {
      const goal = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Ziel Lock" } }));
      const kids = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Quelle Lock", maxAge: 5, autoTransitionToKey: goal.key } }));
      const kid = await newMember({ categoryKey: kids.key, birthDate: yearsAgo(9) });
      const [apply, archive] = await Promise.all([
        call(founder, "/club-members/transition-suggestions/apply", { method: "POST", body: { memberIds: [kid.id] } }),
        call(founder, `/club-members/categories/${goal.id}`, { method: "DELETE" }),
      ]);
      expect(apply.status).toBe(200);
      // Order decides: archive first (200) -> the target is archived and the kid stays; apply first -> the kid sits in the
      // target, so the archive correctly refuses without moveTo (409). Never a 500 / deadlock, never a member in an archived category.
      expect([200, 409]).toContain(archive.status);
      const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, kid.id) }))!;
      const nowIn = await db.query.memberCategories.findFirst({ where: (c, { eq: same }) => same(c.id, row.categoryId!) });
      expect(nowIn?.archivedAt ?? null).toBeNull();
    });
  });

  describe("PATCH rules (A3)", () => {
    it("rejects leftAt (also null) with a pointer to the transition route", async () => {
      const m = await newMember();
      for (const leftAt of ["2020-01-01", null]) {
        const res = await call(founder, `/club-members/${m.id}`, { method: "PATCH", body: { leftAt } });
        expect(res.status).toBe(422);
        expect(JSON.stringify(await res.json())).toContain("transition");
      }
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, m.id) }))!.leftAt).toBeNull();
    });
  });

  // --- A4 / A6 -------------------------------------------------------------------------------

  describe("transition suggestions and club stats rights (A4, A6)", () => {
    it("GET needs members:write AND members:read_sensitive; apply only members:write", async () => {
      expect((await call(plain, "/club-members/transition-suggestions")).status).toBe(403);
      expect((await call(treasurer, "/club-members/transition-suggestions")).status).toBe(403); // read_sensitive only
      expect((await call(secretary, "/club-members/transition-suggestions")).status).toBe(403); // write only
      expect((await call(founder, "/club-members/transition-suggestions")).status).toBe(200);
      const apply = await call(secretary, "/club-members/transition-suggestions/apply", { method: "POST", body: { memberIds: [randomUUID()] } });
      expect(apply.status).toBe(200);
      expect((await call(treasurer, "/club-members/transition-suggestions/apply", { method: "POST", body: { memberIds: [randomUUID()] } })).status).toBe(403);
    });

    it("club_stats:read is a real permission in /me and gates /club-stats", async () => {
      for (const who of [founder, treasurer, secretary]) {
        expect((await data(await call(who, "/club-members/me"))).permissions, who.userId).toContain("club_stats:read");
        expect((await call(who, "/club-stats")).status).toBe(200);
      }
      expect((await data(await call(plain, "/club-members/me"))).permissions).not.toContain("club_stats:read");
      expect((await call(plain, "/club-stats")).status).toBe(403);
      expect((await call(guest, "/club-stats")).status).toBe(403);
    });
  });

  // --- A5 ----------------------------------------------------------------------------------

  describe("former members are hidden from plain members (A5)", () => {
    let leaver: Json;
    let interested: Json;
    let regular: Json;
    beforeAll(async () => {
      leaver = await newMember({ displayName: "Ehemalig Eva" });
      expect((await call(founder, `/club-members/${leaver.id}/transition`, { method: "POST", body: { toStatus: "ausgetreten" } })).status).toBe(200);
      interested = await newMember({ displayName: "Interessent Ida", status: "interessent" });
      regular = await newMember({ displayName: "Regulaer Rolf" });
    });
    const names = async (who: Actor, query = "") => ((await (await call(who, `/club-members?pageSize=100${query}`)).json()) as Json).data.map((m: Json) => m.name) as string[];

    it("a plain member sees only probe/aktiv/ruhend in list and detail", async () => {
      const list = await names(plain);
      expect(list).toContain("Regulaer Rolf");
      expect(list).not.toContain("Ehemalig Eva");
      expect(list).not.toContain("Interessent Ida");
      expect((await call(plain, `/club-members/${leaver.id}`)).status).toBe(404);
      expect((await call(plain, `/club-members/${interested.id}`)).status).toBe(404);
      expect((await call(plain, `/club-members/${leaver.id}/departments`)).status).toBe(404);
      expect((await call(plain, `/club-members/${regular.id}`)).status).toBe(200);
    });

    it("status filters only narrow the visible set", async () => {
      const filtered = await call(plain, "/club-members?status=ausgetreten,interessent");
      expect(((await filtered.json()) as Json).total).toBe(0);
      expect(await names(plain, "&status=aktiv")).toContain("Regulaer Rolf");
    });

    it("the own row is always reachable and total matches the visible set", async () => {
      expect((await call(plain, `/club-members/${plain.clubMemberId}`)).status).toBe(200);
      const list = (await (await call(plain, "/club-members?pageSize=100")).json()) as Json;
      expect(list.total).toBe(list.data.length);
    });

    it("members:write and members:read_sensitive holders see former members and interessenten", async () => {
      for (const who of [founder, secretary, treasurer]) {
        const list = await names(who);
        expect(list).toEqual(expect.arrayContaining(["Ehemalig Eva", "Interessent Ida"]));
        expect((await call(who, `/club-members/${leaver.id}`)).status).toBe(200);
      }
    });

    it("/club-stats still counts the former member (unchanged)", async () => {
      const stats = await data(await call(founder, "/club-stats"));
      expect(stats.byStatus.ausgetreten).toBeGreaterThanOrEqual(1);
    });
  });

  // --- A9 ----------------------------------------------------------------------------------

  describe("natural sort by member number (A9)", () => {
    it("sorts ORD-1, ORD-2, ORD-0003, ORD-10, ORD-A (and reverses completely)", async () => {
      for (const number of ["ORD-2", "ORD-10", "ORD-1", "ORD-0003", "ORD-A"]) await newMember({ memberNumber: number, displayName: `Nummer ${number}` });
      const order = async (dir: string) =>
        ((await (await call(founder, `/club-members?q=ORD-&sort=memberNumber&order=${dir}`)).json()) as Json).data.map((m: Json) => m.memberNumber) as string[];
      expect(await order("asc")).toEqual(["ORD-1", "ORD-2", "ORD-0003", "ORD-10", "ORD-A"]);
      expect(await order("desc")).toEqual(["ORD-A", "ORD-10", "ORD-0003", "ORD-2", "ORD-1"]);
    });
  });
});
