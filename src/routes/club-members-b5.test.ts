import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers, clubMemberStatusHistory, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubMemberRoutes } from "./club-members.js";

/** Wave 7 B5: categories CRUD, status transitions + history, Stichtag derivation, age suggestions, re-join protection. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => iso(new Date());
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86_400_000));
const yearsAgo = (years: number, extraDays = 0) => {
  const d = new Date();
  return iso(new Date(Date.UTC(d.getUTCFullYear() - years, d.getUTCMonth(), d.getUTCDate() - extraDays)));
};

async function signUp(label: string): Promise<Actor> {
  const email = `cm-b5-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `B5 ${label}` } });
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
const data = async (res: Response) => (await json(res)).data as Json;

describe("member lifecycle, categories and age transitions (B5)", () => {
  let founder: Actor;
  let plain: Actor;
  const userIds: string[] = [];

  async function newMember(body: Json = {}): Promise<Json> {
    const res = await call(founder, "/club-members", { method: "POST", body: { displayName: `M ${randomUUID().slice(0, 6)}`, categoryKey: "aktiv", ...body } });
    expect(res.status).toBe(201);
    return data(res);
  }
  const transition = (id: string, body: Json, who = founder) => call(who, `/club-members/${id}/transition`, { method: "POST", body });
  const historyOf = (id: string) => db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, id));

  beforeAll(async () => {
    founder = await signUp("founder");
    plain = await signUp("plain");
    userIds.push(founder.userId, plain.userId);
    club = (await auth.api.createOrganization({ body: { name: `B5 ${suffix}`, slug: `b5-${suffix}`, userId: founder.userId } }))!.id;
    const founderMember = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, founder.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: founderMember.id, roleType: "vorsitz" });
    await auth.api.addMember({ body: { userId: plain.userId, organizationId: club, role: "member" } });
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, club));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("status transitions", () => {
    it("walks interessent -> probe -> aktiv -> ruhend -> aktiv and writes history", async () => {
      const m = await newMember({ status: "interessent" });
      for (const to of ["probe", "aktiv", "ruhend", "aktiv"]) {
        const res = await transition(m.id, { toStatus: to, reason: "weil" });
        expect(res.status, to).toBe(200);
        const body = await json(res);
        expect(body.data.status).toBe(to);
        expect(body.data.effectiveStatus).toBe(to);
        expect(body.transition).toMatchObject({ toStatus: to, kind: "status" });
      }
      const history = (await historyOf(m.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      expect(history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
        [null, "interessent"],
        ["interessent", "probe"],
        ["probe", "aktiv"],
        ["aktiv", "ruhend"],
        ["ruhend", "aktiv"],
      ]);
      expect(history[1]!.reason).toBe("weil");
      const api = await data(await call(founder, `/club-members/${m.id}/history`));
      expect(api as unknown as Json[]).toHaveLength(5);
    });

    it("rejects transitions outside the matrix with 409 and lists the allowed targets", async () => {
      const m = await newMember({ status: "interessent" });
      const res = await transition(m.id, { toStatus: "ruhend" });
      expect(res.status).toBe(409);
      expect((await json(res)).error.details.allowed).toEqual(expect.arrayContaining(["probe", "aktiv"]));
      expect((await transition(m.id, { toStatus: "interessent" })).status).toBe(409); // same status
      const live = await newMember();
      expect((await transition(live.id, { toStatus: "probe" })).status).toBe(409);
    });

    it("exit sets left_at and the leaving status; reopen needs reopen:true and a reason", async () => {
      const m = await newMember();
      const out = await transition(m.id, { toStatus: "ausgetreten", reason: "Umzug" });
      expect(out.status).toBe(200);
      expect((await data(out)).leftAt).toBe(today());
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, m.id) }))?.exitReason).toBe("Umzug");

      expect((await transition(m.id, { toStatus: "aktiv" })).status).toBe(422);
      expect((await transition(m.id, { toStatus: "aktiv", reopen: true })).status).toBe(422);
      expect((await transition(m.id, { toStatus: "ruhend", reopen: true, reason: "x" })).status).toBe(409);
      const back = await transition(m.id, { toStatus: "aktiv", reopen: true, reason: "Rückkehr" });
      expect(back.status).toBe(200);
      expect(await data(back)).toMatchObject({ status: "aktiv", leftAt: null });
    });

    it("excluded and deceased members can only come back by an explicit reopen", async () => {
      for (const to of ["ausgeschlossen", "verstorben"]) {
        const m = await newMember();
        expect((await transition(m.id, { toStatus: to })).status).toBe(200);
        expect((await transition(m.id, { toStatus: "ausgetreten" })).status).toBe(409);
        expect((await transition(m.id, { toStatus: "aktiv", reopen: true, reason: "Korrektur" })).status).toBe(200);
      }
    });

    it("a future exit date keeps the status and is derived on the key date (Stichtag); it can be taken back", async () => {
      const m = await newMember();
      const future = daysFromNow(30);
      const res = await transition(m.id, { toStatus: "ausgetreten", effectiveOn: future, reason: "Kündigung zum Stichtag" });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.transition.kind).toBe("scheduled_exit");
      expect(body.data).toMatchObject({ status: "aktiv", effectiveStatus: "aktiv", leftAt: future });

      // Time passes: the stored row has a left_at in the past -> read as ausgetreten without any job.
      await db.update(clubMembers).set({ leftAt: daysFromNow(-1) }).where(eq(clubMembers.id, m.id));
      const detail = await data(await call(founder, `/club-members/${m.id}`));
      expect(detail).toMatchObject({ status: "aktiv", effectiveStatus: "ausgetreten" });
      const filtered = (await json(await call(founder, "/club-members?status=ausgetreten&pageSize=100"))).data as Json[];
      expect(filtered.map((r) => r.id)).toContain(m.id);
      const active = (await json(await call(founder, "/club-members?status=aktiv&pageSize=100"))).data as Json[];
      expect(active.map((r) => r.id)).not.toContain(m.id);
      // From the derived status only a reopen leads back.
      expect((await transition(m.id, { toStatus: "ruhend" })).status).toBe(409);
      expect((await transition(m.id, { toStatus: "aktiv", reopen: true, reason: "ok" })).status).toBe(200);

      const m2 = await newMember();
      expect((await transition(m2.id, { toStatus: "ausgetreten", effectiveOn: future })).status).toBe(200);
      const cancel = await transition(m2.id, { toStatus: "aktiv" });
      expect(cancel.status).toBe(200);
      expect((await json(cancel)).transition.kind).toBe("cancel_exit");
      expect(await data(await call(founder, `/club-members/${m2.id}`))).toMatchObject({ leftAt: null, effectiveStatus: "aktiv" });
    });

    it("validates dates: no future ausgeschlossen/verstorben or non-exit, no exit before joining", async () => {
      const m = await newMember({ joinedAt: "2024-05-01" });
      expect((await transition(m.id, { toStatus: "ausgeschlossen", effectiveOn: daysFromNow(3) })).status).toBe(422);
      expect((await transition(m.id, { toStatus: "ruhend", effectiveOn: daysFromNow(3) })).status).toBe(422);
      expect((await transition(m.id, { toStatus: "ausgetreten", effectiveOn: "2024-01-01" })).status).toBe(422);
      expect((await transition(m.id, {})).status).toBe(422);
      expect((await transition(m.id, { toStatus: "bogus" })).status).toBe(422);
      const past = await transition(m.id, { toStatus: "ausgetreten", effectiveOn: "2025-06-30" });
      expect(past.status).toBe(200);
      expect((await data(past)).leftAt).toBe("2025-06-30");
    });

    it("changes the category through the same route with history; same category is a 409, archived/unknown a 422", async () => {
      const m = await newMember({ categoryKey: "aktiv" });
      const jugend = (await db.query.memberCategories.findFirst({ where: and(eq(memberCategories.clubId, club), eq(memberCategories.key, "jugend")) }))!;
      const res = await transition(m.id, { categoryKey: "passiv", reason: "Wunsch" });
      expect(res.status).toBe(200);
      expect((await json(res)).data.category).toBe("passiv");
      expect((await transition(m.id, { categoryKey: "passiv" })).status).toBe(409);
      expect((await transition(m.id, { categoryId: randomUUID() })).status).toBe(422);
      const both = await transition(m.id, { categoryId: jugend.id, toStatus: "ruhend" });
      expect(both.status).toBe(200);
      const last = (await historyOf(m.id)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      expect(last).toMatchObject({ fromStatus: "aktiv", toStatus: "ruhend", toCategoryId: jugend.id });
      expect(last.fromCategoryId).not.toBe(jugend.id);
    });

    it("is club-scoped (foreign id 404) and needs members:write", async () => {
      const m = await newMember();
      expect((await transition(m.id, { toStatus: "ruhend" }, plain)).status).toBe(403);
      expect((await call(plain, `/club-members/${m.id}/history`)).status).toBe(403);
      expect((await transition(randomUUID(), { toStatus: "ruhend" })).status).toBe(404);
    });
  });

  describe("re-join protection", () => {
    it("an excluded person cannot re-join by application, addMember or invitation until the board reopens", async () => {
      const guest = await signUp("excluded");
      userIds.push(guest.userId);
      const added = (await auth.api.addMember({ body: { userId: guest.userId, organizationId: club, role: "member" } }))!;
      const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, added.id) }))!;
      expect((await transition(row.id, { toStatus: "ausgeschlossen", reason: "Vorfall" })).status).toBe(200);
      await auth.api.removeMember({ body: { memberIdOrEmail: added.id, organizationId: club }, headers: new Headers({ cookie: founder.cookie }) });
      expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, row.id) })).toMatchObject({ memberId: null, status: "ausgeschlossen" });

      // Application: 409 on approve, nothing created.
      const apply = await app.request("/club-members/apply", { method: "POST", headers: { cookie: guest.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() }, body: JSON.stringify({ clubId: club }) });
      expect(apply.status).toBe(201);
      const appId = ((await json(apply)).data.application as Json).id as string;
      const approve = await app.request(`/club-applications/${appId}/approve?clubId=${club}`, { method: "POST", headers: { cookie: founder.cookie, "x-forwarded-for": randomUUID() } });
      expect(approve.status).toBe(409);
      expect((await json(approve)).error.details).toMatchObject({ code: "member_rejoin_blocked" });
      expect(await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, guest.userId)) })).toBeUndefined();

      // Direct addMember is rejected as well.
      await expect(auth.api.addMember({ body: { userId: guest.userId, organizationId: club, role: "member" } })).rejects.toThrow();
      expect(await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, guest.userId)) })).toBeUndefined();

      // Board reopens -> the person may join again and gets the old row back.
      expect((await transition(row.id, { toStatus: "aktiv", reopen: true, reason: "Begnadigt" })).status).toBe(200);
      const rejoined = (await auth.api.addMember({ body: { userId: guest.userId, organizationId: club, role: "member" } }))!;
      expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, row.id) })).toMatchObject({ memberId: rejoined.id, status: "aktiv" });
    });
  });

  describe("member categories", () => {
    it("lists non-archived categories for every member incl. memberCount; archived ones only for writers", async () => {
      const asPlain = (await json(await call(plain, "/club-members/categories"))).data as Json[];
      expect(asPlain.map((c) => c.key)).toEqual(expect.arrayContaining(["aktiv", "passiv", "foerdernd", "ehrenmitglied", "jugend"]));
      expect(asPlain.every((c) => typeof c.memberCount === "number")).toBe(true);
      expect((await call(plain, "/club-members/categories?includeArchived=true")).status).toBe(403);
    });

    it("creates (key from name or explicit), rejects duplicates, bad ranges and non-writers", async () => {
      const created = await call(founder, "/club-members/categories", { method: "POST", body: { name: "Ehren Jugend", votingRight: false, minAge: 6, maxAge: 17 } });
      expect(created.status).toBe(201);
      expect(await data(created)).toMatchObject({ key: "ehren-jugend", name: "Ehren Jugend", votingRight: false, minAge: 6, maxAge: 17, memberCount: 0, archived: false });
      expect((await call(founder, "/club-members/categories", { method: "POST", body: { name: "Nochmal", key: "ehren-jugend" } })).status).toBe(409);
      expect((await call(founder, "/club-members/categories", { method: "POST", body: { name: "Falsch", minAge: 20, maxAge: 10 } })).status).toBe(422);
      expect((await call(founder, "/club-members/categories", { method: "POST", body: { name: "Bad Key", key: "Bad Key!" } })).status).toBe(422);
      expect((await call(founder, "/club-members/categories", { method: "POST", body: { name: "Auto", autoTransitionToKey: "aktiv" } })).status).toBe(422); // needs maxAge
      expect((await call(plain, "/club-members/categories", { method: "POST", body: { name: "Hacker" } })).status).toBe(403);
    });

    it("PATCH changes name/voting/ages/transition/sort but never the key; validates targets and cycles", async () => {
      const a = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Kat A", key: "kat-a", maxAge: 10 } }));
      const b = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Kat B", key: "kat-b", maxAge: 20 } }));
      const patched = await call(founder, `/club-members/categories/${a.id}`, { method: "PATCH", body: { name: "Kat A neu", votingRight: false, sortOrder: 99, autoTransitionToKey: "kat-b" } });
      expect(patched.status).toBe(200);
      expect(await data(patched)).toMatchObject({ key: "kat-a", name: "Kat A neu", votingRight: false, sortOrder: 99, autoTransitionToKey: "kat-b" });
      expect((await call(founder, `/club-members/categories/${a.id}`, { method: "PATCH", body: { key: "neu" } })).status).toBe(422);
      expect((await call(founder, `/club-members/categories/${b.id}`, { method: "PATCH", body: { autoTransitionToKey: "kat-a" } })).status).toBe(422); // cycle
      expect((await call(founder, `/club-members/categories/${b.id}`, { method: "PATCH", body: { autoTransitionToKey: "kat-b" } })).status).toBe(422); // self
      expect((await call(founder, `/club-members/categories/${b.id}`, { method: "PATCH", body: { autoTransitionToKey: "gibt-es-nicht" } })).status).toBe(422);
      expect((await call(founder, `/club-members/categories/${a.id}`, { method: "PATCH", body: { maxAge: null } })).status).toBe(422); // transition needs maxAge
      expect((await call(founder, `/club-members/categories/${a.id}`, { method: "PATCH", body: { autoTransitionToKey: null, maxAge: null } })).status).toBe(200);
      expect((await call(plain, `/club-members/categories/${a.id}`, { method: "PATCH", body: { name: "x" } })).status).toBe(403);
      expect((await call(founder, `/club-members/categories/${randomUUID()}`, { method: "PATCH", body: { name: "x" } })).status).toBe(404);
    });

    it("archiving needs moveTo while active members remain; moves them with history; the default stays", async () => {
      const cat = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Kurzzeit", key: "kurzzeit" } }));
      const other = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Ziel", key: "ziel" } }));
      const stays = await newMember({ categoryKey: "kurzzeit" });
      const left = await newMember({ categoryKey: "kurzzeit" });
      await transition(left.id, { toStatus: "ausgetreten" });

      const blocked = await call(founder, `/club-members/categories/${cat.id}`, { method: "DELETE" });
      expect(blocked.status).toBe(409);
      expect((await json(blocked)).error.details.memberCount).toBe(1); // the member who left does not count
      expect((await call(founder, `/club-members/categories/${cat.id}?moveTo=${cat.id}`, { method: "DELETE" })).status).toBe(422);
      expect((await call(founder, `/club-members/categories/${cat.id}?moveTo=${randomUUID()}`, { method: "DELETE" })).status).toBe(422);
      expect((await call(plain, `/club-members/categories/${cat.id}?moveTo=${other.id}`, { method: "DELETE" })).status).toBe(403);

      const ok = await call(founder, `/club-members/categories/${cat.id}?moveTo=${other.id}`, { method: "DELETE" });
      expect(ok.status).toBe(200);
      expect(await data(ok)).toMatchObject({ archived: true, movedMembers: 1 });
      expect((await data(await call(founder, `/club-members/${stays.id}`))).categoryId).toBe(other.id);
      expect((await historyOf(stays.id)).some((h) => h.reason === "Kategorie archiviert" && h.toCategoryId === other.id)).toBe(true);
      expect((await data(await call(founder, `/club-members/${left.id}`))).categoryId).toBe(cat.id); // history stays untouched

      const listed = (await json(await call(plain, "/club-members/categories"))).data as Json[];
      expect(listed.map((c) => c.key)).not.toContain("kurzzeit");
      const withArchived = (await json(await call(founder, "/club-members/categories?includeArchived=true"))).data as Json[];
      expect(withArchived.find((c) => c.key === "kurzzeit")).toMatchObject({ archived: true });
      expect((await call(founder, `/club-members/categories/${cat.id}`, { method: "DELETE" })).status).toBe(409); // already archived
      // Archived categories are not assignable any more.
      expect((await call(founder, "/club-members", { method: "POST", body: { displayName: "Z", categoryKey: "kurzzeit" } })).status).toBe(422);

      const aktiv = (await db.query.memberCategories.findFirst({ where: and(eq(memberCategories.clubId, club), eq(memberCategories.key, "aktiv")) }))!;
      expect((await call(founder, `/club-members/categories/${aktiv.id}?moveTo=${other.id}`, { method: "DELETE" })).status).toBe(409);
    });

    it("archiving clears auto transitions that point to it", async () => {
      const target = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Tmp Ziel", key: "tmp-ziel" } }));
      const source = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Tmp Quelle", key: "tmp-quelle", maxAge: 5, autoTransitionToKey: "tmp-ziel" } }));
      const res = await call(founder, `/club-members/categories/${target.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      expect((await data(res)).clearedAutoTransitions).toBe(1);
      expect((await db.query.memberCategories.findFirst({ where: eq(memberCategories.id, source.id) }))?.autoTransitionToKey).toBeNull();
    });
  });

  describe("age transition suggestions", () => {
    let youth: Json;
    let adult: Json;
    let ids: { old: string; young: string; noBirth: string; left: string };

    beforeAll(async () => {
      adult = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Erwachsene", key: "erwachsene" } }));
      youth = await data(await call(founder, "/club-members/categories", { method: "POST", body: { name: "Junioren", key: "junioren", maxAge: 17, autoTransitionToKey: "erwachsene" } }));
      ids = {
        old: (await newMember({ categoryKey: "junioren", birthDate: yearsAgo(18) })).id, // turned 18 today
        young: (await newMember({ categoryKey: "junioren", birthDate: yearsAgo(18, -1) })).id, // 18th birthday tomorrow
        noBirth: (await newMember({ categoryKey: "junioren" })).id,
        left: (await newMember({ categoryKey: "junioren", birthDate: yearsAgo(30) })).id,
      };
      await transition(ids.left, { toStatus: "ausgetreten" });
    }, 30_000);

    it("lists only qualifying members (writers); never changes anything by itself", async () => {
      const list = (await json(await call(founder, "/club-members/transition-suggestions"))).data as Json[];
      expect(list.map((s) => s.id)).toEqual([ids.old]);
      expect(list[0]).toMatchObject({ category: { key: "junioren" }, suggestedCategory: { id: adult.id, key: "erwachsene" } });
      expect(list[0]).not.toHaveProperty("birthDate");
      expect((await data(await call(founder, `/club-members/${ids.old}`))).categoryId).toBe(youth.id);
      expect((await call(plain, "/club-members/transition-suggestions")).status).toBe(403);
    });

    it("shows suggestedCategory in the member shape for sensitive readers", async () => {
      const one = await data(await call(founder, `/club-members/${ids.old}`));
      expect(one.suggestedCategory).toMatchObject({ key: "erwachsene" });
      expect((await data(await call(founder, `/club-members/${ids.young}`))).suggestedCategory).toBeNull();
      const asPlain = await data(await call(plain, `/club-members/${ids.old}`));
      expect(asPlain).not.toHaveProperty("suggestedCategory");
      expect(asPlain).not.toHaveProperty("birthDate");
    });

    it("apply moves the selected qualifying members in one transaction with history and skips the rest", async () => {
      expect((await call(plain, "/club-members/transition-suggestions/apply", { method: "POST", body: { memberIds: [ids.old] } })).status).toBe(403);
      expect((await call(founder, "/club-members/transition-suggestions/apply", { method: "POST", body: { memberIds: [] } })).status).toBe(422);
      const foreign = randomUUID();
      const res = await call(founder, "/club-members/transition-suggestions/apply", { method: "POST", body: { memberIds: [ids.old, ids.young, ids.noBirth, ids.left, foreign, ids.old] } });
      expect(res.status).toBe(200);
      const result = await data(res);
      expect(result.applied).toEqual([{ id: ids.old, fromCategoryId: youth.id, toCategoryId: adult.id }]);
      expect((result.skipped as Json[]).map((s) => s.id).sort()).toEqual([ids.young, ids.noBirth, ids.left, foreign].sort());
      expect((await data(await call(founder, `/club-members/${ids.old}`))).categoryId).toBe(adult.id);
      expect((await data(await call(founder, `/club-members/${ids.young}`))).categoryId).toBe(youth.id);
      const h = (await historyOf(ids.old)).find((x) => x.reason === "Altersübergang");
      expect(h).toMatchObject({ fromCategoryId: youth.id, toCategoryId: adult.id });
      // Idempotent: the same call again applies nothing.
      const again = await data(await call(founder, "/club-members/transition-suggestions/apply", { method: "POST", body: { memberIds: [ids.old] } }));
      expect(again.applied).toEqual([]);
    });
  });
});
