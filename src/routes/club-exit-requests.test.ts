import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubExitRequests } from "../db/schema/club-exit-requests.js";
import { clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { locationKeyHolders, locations } from "../db/schema/locations.js";
import { toAppError } from "../lib/errors.js";
import { addDays, earliestExitDate } from "../lib/exit-notice.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubExitRequestRoutes } from "./club-exit-requests.js";
import { clubMemberRoutes } from "./club-members.js";
import { clubSettingsRoutes } from "./club-settings.js";
import { myClubRoutes } from "./my-clubs.js";

/** Wave 7 B6: club settings, notice calculation, exit requests (cancellation / exclusion), checklist, access end. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.route("/club-settings", clubSettingsRoutes);
app.route("/club-exit-requests", clubExitRequestRoutes);
app.route("/my-clubs", myClubRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  // eslint-disable-next-line no-console
  if (appError.status >= 500) console.error("[test] 500 caused by", err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; memberId: string; clubMemberId: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const today = () => todayBerlin();

async function signUp(label: string) {
  const email = `b6-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `B6 ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}
let club: string;
let clubSlug: string;
let otherClub: string;
function call(who: { cookie: string }, url: string, init: { method?: string; body?: object; clubId?: string } = {}) {
  return app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${init.clubId ?? club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}
const data = async (res: Response) => ((await res.json()) as Json).data as Json;
const body = async (res: Response) => (await res.json()) as Json;

describe("exit workflow (B6)", () => {
  let founder: Actor;
  let outsider: Actor; // founder of another club
  const userIds: string[] = [];

  async function join(label: string, clubRole?: string): Promise<Actor> {
    const s = await signUp(label);
    userIds.push(s.userId);
    const account = (await auth.api.addMember({ body: { userId: s.userId, organizationId: club, role: "member" } }))!;
    if (clubRole) await db.insert(clubRoles).values({ memberId: account.id, roleType: clubRole });
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
    return { ...s, memberId: account.id, clubMemberId: row.id };
  }
  const setSettings = (values: Partial<typeof clubSettings.$inferInsert>) =>
    db.insert(clubSettings).values({ clubId: club, ...values }).onConflictDoUpdate({ target: clubSettings.clubId, set: values });
  const request = (who: Actor, payload: object = {}) => call(who, "/club-exit-requests", { method: "POST", body: payload });
  const stored = (id: string) => db.query.clubMembers.findFirst({ where: eq(clubMembers.id, id) }).then((r) => r!);
  async function childMember(name = `Kind ${randomUUID().slice(0, 5)}`): Promise<Json> {
    const res = await call(founder, "/club-members", { method: "POST", body: { displayName: name, categoryKey: "jugend" } });
    expect(res.status).toBe(201);
    return data(res);
  }

  beforeAll(async () => {
    const f = await signUp("founder");
    const o = await signUp("outsider");
    userIds.push(f.userId, o.userId);
    const created = (await auth.api.createOrganization({ body: { name: `B6 ${suffix}`, slug: `b6-${suffix}`, userId: f.userId } }))!;
    club = created.id;
    clubSlug = `b6-${suffix}`;
    otherClub = (await auth.api.createOrganization({ body: { name: `B6 other ${suffix}`, slug: `b6-other-${suffix}`, userId: o.userId } }))!.id;
    const fm = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, f.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: fm.id, roleType: "vorsitz" });
    founder = { ...f, memberId: fm.id, clubMemberId: (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, fm.id) }))!.id };
    const om = (await db.query.member.findFirst({ where: and(eq(member.organizationId, otherClub), eq(member.userId, o.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: om.id, roleType: "vorsitz" });
    outsider = { ...o, memberId: om.id, clubMemberId: "" };
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, club));
    await db.delete(organization).where(eq(organization.id, otherClub));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  // --- club settings -------------------------------------------------------------------------

  describe("club settings", () => {
    it("GET gives every member exactly the three public values (defaults without a row)", async () => {
      const plain = await join("settings-reader");
      const res = await call(plain, "/club-settings");
      expect(res.status).toBe(200);
      expect((await body(res)).data).toEqual({ noticePeriodDays: null, noticeMode: null, allowSelfLoans: true });
    });

    it("PATCH needs members:write and validates the values", async () => {
      const plain = await join("settings-plain");
      expect((await call(plain, "/club-settings", { method: "PATCH", body: { allowSelfLoans: false } })).status).toBe(403);
      for (const bad of [{ noticePeriodDays: 366 }, { noticePeriodDays: -1 }, { noticePeriodDays: 1.5 }, { noticeMode: "weekly" }, { memberNumberPrefix: "a-b" }, { memberNumberPrefix: "ABCDEFGHIJK" }, { allowSelfLoans: "yes" }]) {
        expect((await call(founder, "/club-settings", { method: "PATCH", body: bad })).status, JSON.stringify(bad)).toBe(422);
      }
    });

    it("PATCH creates the row on demand, returns all four values, GET shows only the three, and the prefix drives new member numbers", async () => {
      const res = await call(founder, "/club-settings", { method: "PATCH", body: { noticePeriodDays: 30, noticeMode: "month_end", memberNumberPrefix: " tsv ", allowSelfLoans: false } });
      expect(res.status).toBe(200);
      expect((await body(res)).data).toEqual({ noticePeriodDays: 30, noticeMode: "month_end", memberNumberPrefix: "TSV", allowSelfLoans: false });
      const plain = await join("settings-after");
      expect((await body(await call(plain, "/club-settings"))).data).toEqual({ noticePeriodDays: 30, noticeMode: "month_end", allowSelfLoans: false });
      const created = await childMember();
      expect(created.memberNumber).toMatch(/^TSV-\d{4}$/);
      // partial update keeps the rest; null clears
      const partial = await call(founder, "/club-settings", { method: "PATCH", body: { allowSelfLoans: true, noticePeriodDays: null } });
      expect((await body(partial)).data).toMatchObject({ noticePeriodDays: null, noticeMode: "month_end", memberNumberPrefix: "TSV", allowSelfLoans: true });
      expect((await call(founder, "/club-settings", { method: "PATCH", body: {} })).status).toBe(200);
      expect(await db.query.auditLog.findFirst({ where: eq(auditLog.eventType, "club_settings.update") })).toBeTruthy();
    });

    it("is club-scoped", async () => {
      const other = await call(outsider, "/club-settings", { clubId: otherClub });
      expect((await body(other)).data).toEqual({ noticePeriodDays: null, noticeMode: null, allowSelfLoans: true });
    });
  });

  // --- preview ---------------------------------------------------------------------------

  describe("notice preview", () => {
    it("computes the earliest exit date from the club settings", async () => {
      await setSettings({ noticePeriodDays: 30, noticeMode: "month_end" });
      const plain = await join("preview");
      const res = await call(plain, "/club-exit-requests/preview");
      expect(res.status).toBe(200);
      expect((await body(res)).data).toEqual({
        requestedOn: today(),
        noticePeriodDays: 30,
        noticeMode: "month_end",
        earliestEffectiveOn: earliestExitDate(today(), { noticePeriodDays: 30, noticeMode: "month_end" }),
      });
      const future = addDays(today(), 400);
      const later = await data(await call(plain, `/club-exit-requests/preview?requestedOn=${future}`));
      expect(later.earliestEffectiveOn).toBe(earliestExitDate(future, { noticePeriodDays: 30, noticeMode: "month_end" }));
    });

    it("rejects dates in the past and malformed dates", async () => {
      const plain = await join("preview-bad");
      expect((await call(plain, `/club-exit-requests/preview?requestedOn=${addDays(today(), -1)}`)).status).toBe(422);
      expect((await call(plain, "/club-exit-requests/preview?requestedOn=soon")).status).toBe(422);
    });
  });

  // --- member cancellation ------------------------------------------------------------------

  describe("cancellation by the member", () => {
    let m1: Actor;
    let m2: Actor;
    let created: Json;
    beforeAll(async () => {
      await setSettings({ noticePeriodDays: 30, noticeMode: "month_end" });
      m1 = await join("m1");
      m2 = await join("m2");
    });

    it("creates a pending request, clamps a too early wish to the earliest date (and says so)", async () => {
      const earliest = earliestExitDate(today(), { noticePeriodDays: 30, noticeMode: "month_end" });
      const res = await request(m1, { desiredEffectiveOn: today(), reason: "Umzug nach Hamburg" });
      expect(res.status).toBe(201);
      created = await data(res);
      expect(created).toMatchObject({ kind: "cancellation", status: "pending", clubMemberId: m1.clubMemberId, requestedOn: today(), desiredEffectiveOn: today(), effectiveOn: null, earliestEffectiveOn: earliest, proposedEffectiveOn: earliest, adjustedToEarliest: true, reason: "Umzug nach Hamburg" });
      // the member keeps full access while the request is open
      expect((await call(m1, "/club-members/me")).status).toBe(200);
      expect((await stored(m1.clubMemberId)).leftAt).toBeNull();
    });

    it("a later wish is kept as proposal; no second open request (409); effectiveOn is board-only (422)", async () => {
      expect((await request(m1)).status).toBe(409);
      const m = await join("later");
      const wish = addDays(today(), 200);
      const ok = await data(await request(m, { desiredEffectiveOn: wish }));
      expect(ok.proposedEffectiveOn).toBe(wish);
      expect(ok.adjustedToEarliest).toBe(false);
      expect((await request(m2, { effectiveOn: today() })).status).toBe(422);
      expect((await request(m2, { kind: "exclusion", reason: "x" })).status).toBe(403);
      expect((await request(m2, { desiredEffectiveOn: addDays(today(), 5000) })).status).toBe(422);
    });

    it("two parallel submissions: exactly one is created (the other is 409)", async () => {
      const m = await join("parallel");
      const [a, b] = await Promise.all([request(m, {}), request(m, {})]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
    });

    it("/mine lists the own requests; detail only for requester, member concerned and the board", async () => {
      const mine = await body(await call(m1, "/club-exit-requests/mine"));
      expect(mine.data.map((r: Json) => r.id)).toEqual([created.id]);
      expect((await call(m1, `/club-exit-requests/${created.id}`)).status).toBe(200);
      expect((await call(m2, `/club-exit-requests/${created.id}`)).status).toBe(404);
      expect((await call(founder, `/club-exit-requests/${created.id}`)).status).toBe(200);
      expect((await call(m2, "/club-exit-requests/mine").then(body)).data).toEqual([]);
    });

    it("the board queue lists, filters and pages; plain members get 403; clubs are separated", async () => {
      expect((await call(m1, "/club-exit-requests")).status).toBe(403);
      const all = await body(await call(founder, "/club-exit-requests?status=pending&kind=cancellation&pageSize=1&page=1"));
      expect(all.data).toHaveLength(1);
      expect(all.total).toBeGreaterThanOrEqual(3);
      expect(all.page).toBe(1);
      expect(all.pageSize).toBe(1);
      expect(all.data[0]).toMatchObject({ kind: "cancellation", status: "pending" });
      expect(all.data[0].memberName).toBeTruthy();
      expect((await call(founder, "/club-exit-requests?status=bogus")).status).toBe(422);
      const foreign = await body(await call(outsider, "/club-exit-requests", { clubId: otherClub }));
      expect(foreign.total).toBe(0);
      expect((await call(outsider, `/club-exit-requests/${created.id}`, { clubId: otherClub })).status).toBe(404);
      expect((await call(outsider, `/club-exit-requests/${created.id}/approve`, { method: "POST", body: {}, clubId: otherClub })).status).toBe(404);
    });

    it("the return checklist is computed live from the account's open loans and key holder entries", async () => {
      const [item] = await db.insert(inventoryItems).values({ clubId: club, name: "Zelt B6", condition: "gut" }).returning();
      const [returned] = await db.insert(inventoryItems).values({ clubId: club, name: "Pumpe B6", condition: "gut" }).returning();
      const [loc] = await db.insert(locations).values({ clubId: club, name: "Vereinsheim B6" }).returning();
      await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: m1.memberId, dueAt: new Date(Date.now() - 86_400_000) });
      await db.insert(inventoryLoans).values({ itemId: returned!.id, memberId: m1.memberId, returnedAt: new Date(), status: "zurueckgegeben" });
      await db.insert(locationKeyHolders).values({ locationId: loc!.id, memberId: m1.memberId });
      const detail = await data(await call(founder, `/club-exit-requests/${created.id}`));
      expect(detail.checklist.isEmpty).toBe(false);
      expect(detail.checklist.openLoans).toHaveLength(1);
      expect(detail.checklist.openLoans[0]).toMatchObject({ itemName: "Zelt B6", overdue: true });
      expect(detail.checklist.keys).toEqual([expect.objectContaining({ locationName: "Vereinsheim B6" })]);
      // a return empties the loan part (live)
      await db.update(inventoryLoans).set({ returnedAt: new Date(), status: "zurueckgegeben" }).where(eq(inventoryLoans.itemId, item!.id));
      const after = await data(await call(m1, `/club-exit-requests/${created.id}`));
      expect(after.checklist.openLoans).toEqual([]);
      expect(after.checklist.keys).toHaveLength(1);
    });

    it("approve: the date cannot be earlier than the earliest date, default = proposal, the exit is scheduled (access continues)", async () => {
      const earliest = created.earliestEffectiveOn as string;
      expect((await call(m2, `/club-exit-requests/${created.id}/approve`, { method: "POST", body: {} })).status).toBe(403);
      const tooEarly = await call(founder, `/club-exit-requests/${created.id}/approve`, { method: "POST", body: { effectiveOn: addDays(earliest, -1) } });
      expect(tooEarly.status).toBe(422);
      expect(((await body(tooEarly)).error.details as Json).earliestEffectiveOn).toBe(earliest);

      const res = await call(founder, `/club-exit-requests/${created.id}/approve`, { method: "POST", body: { note: "Schade, alles Gute" } });
      expect(res.status).toBe(200);
      const approved = await body(res);
      expect(approved.data).toMatchObject({ status: "approved", effectiveOn: earliest, decisionNote: "Schade, alles Gute", decidedBy: founder.memberId });
      expect(approved.transition).toMatchObject({ kind: "scheduled_exit", toStatus: "ausgetreten", effectiveOn: earliest });
      const row = await stored(m1.clubMemberId);
      expect(row).toMatchObject({ status: "aktiv", leftAt: earliest, exitReason: "Umzug nach Hamburg" });
      expect((await call(m1, "/club-members/me")).status).toBe(200);
      expect((await call(m1, "/club-members/me").then(data)).effectiveStatus).toBe("aktiv");
      // decided once
      expect((await call(founder, `/club-exit-requests/${created.id}/approve`, { method: "POST", body: {} })).status).toBe(409);
      expect((await call(founder, `/club-exit-requests/${created.id}/reject`, { method: "POST", body: { note: "doch nicht" } })).status).toBe(409);
      // and another cancellation is refused while one is scheduled
      expect((await request(m1)).status).toBe(409);
    });

    it("withdraw takes the scheduled exit back (member or board), only once", async () => {
      const res = await call(m1, `/club-exit-requests/${created.id}/withdraw`, { method: "POST", body: {} });
      expect(res.status).toBe(200);
      expect((await data(res)).status).toBe("withdrawn");
      expect(await stored(m1.clubMemberId)).toMatchObject({ status: "aktiv", leftAt: null, exitReason: null });
      const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, m1.clubMemberId));
      expect(history.some((h) => h.reason === "Kündigung widerrufen")).toBe(true);
      expect((await call(m1, `/club-exit-requests/${created.id}/withdraw`, { method: "POST", body: {} })).status).toBe(409);
      // the member may file a new request afterwards
      expect((await request(m1)).status).toBe(201);
    });

    it("withdraw of a pending request: requester or board; a stranger gets 404", async () => {
      const m = await join("withdraw");
      const req = await data(await request(m));
      const stranger = await join("stranger");
      expect((await call(stranger, `/club-exit-requests/${req.id}/withdraw`, { method: "POST", body: {} })).status).toBe(404);
      const byBoard = await call(founder, `/club-exit-requests/${req.id}/withdraw`, { method: "POST", body: { note: "Auf Wunsch zurueckgezogen" } });
      expect(byBoard.status).toBe(200);
      expect((await data(byBoard)).status).toBe("withdrawn");
    });

    it("reject needs a note and leaves the member untouched", async () => {
      const m = await join("rejected");
      const req = await data(await request(m));
      expect((await call(founder, `/club-exit-requests/${req.id}/reject`, { method: "POST", body: {} })).status).toBe(422);
      expect((await call(founder, `/club-exit-requests/${req.id}/reject`, { method: "POST", body: { note: "  " } })).status).toBe(422);
      expect((await call(m, `/club-exit-requests/${req.id}/reject`, { method: "POST", body: { note: "selbst ablehnen" } })).status).toBe(403);
      const res = await call(founder, `/club-exit-requests/${req.id}/reject`, { method: "POST", body: { note: "Bitte erst Schluessel abgeben" } });
      expect(res.status).toBe(200);
      expect((await data(res)).status).toBe("rejected");
      expect(await stored(m.clubMemberId)).toMatchObject({ status: "aktiv", leftAt: null });
      expect((await call(m, "/club-members/me")).status).toBe(200);
    });

    it("parallel approve and reject: exactly one decision wins", async () => {
      const m = await join("race");
      const req = await data(await request(m));
      const [a, r] = await Promise.all([
        call(founder, `/club-exit-requests/${req.id}/approve`, { method: "POST", body: {} }),
        call(founder, `/club-exit-requests/${req.id}/reject`, { method: "POST", body: { note: "nein" } }),
      ]);
      expect([a.status, r.status].sort()).toEqual([200, 409]);
      const final = await db.query.clubExitRequests.findFirst({ where: eq(clubExitRequests.id, req.id) });
      expect(["approved", "rejected"]).toContain(final!.status);
      expect(((await stored(m.clubMemberId)).leftAt !== null)).toBe(final!.status === "approved");
    });

    it("writes audit entries without the free-text reason", async () => {
      const events = await db.select().from(auditLog).where(eq(auditLog.subjectId, created.id));
      expect(events.map((e) => e.eventType).sort()).toEqual(["club_exit_request.approve", "club_exit_request.create", "club_exit_request.withdraw"]);
      expect(JSON.stringify(events)).not.toContain("Umzug nach Hamburg");
    });
  });

  // --- access end -------------------------------------------------------------------------------

  describe("end of access", () => {
    beforeAll(async () => {
      await setSettings({ noticePeriodDays: 0, noticeMode: "immediate" });
    });

    it("a cancellation that takes effect today ends access: clubGuard 404, club hidden in /my-clubs, no /me, no /mine", async () => {
      const m = await join("leaver");
      expect((await body(await call(m, "/my-clubs"))).data.map((c: Json) => c.clubId)).toContain(club);
      const req = await data(await request(m, { reason: "Ende" }));
      expect(req.earliestEffectiveOn).toBe(today());
      const approved = await call(founder, `/club-exit-requests/${req.id}/approve`, { method: "POST", body: {} });
      expect((await body(approved)).transition).toMatchObject({ kind: "status", toStatus: "ausgetreten" });

      expect(await stored(m.clubMemberId)).toMatchObject({ status: "ausgetreten", leftAt: today() });
      for (const path of ["/club-members/me", "/club-exit-requests/mine", "/club-settings", "/club-members"]) {
        const res = await call(m, path);
        expect(res.status, path).toBe(404);
        expect((await body(res)).error.message).toBe("Club not found");
      }
      expect((await body(await call(m, "/my-clubs"))).data.map((c: Json) => c.clubId)).not.toContain(club);
      // the club keeps the records: the board still finds the former member
      const list = await body(await call(founder, "/club-members?status=ausgetreten&pageSize=100"));
      expect(list.data.map((x: Json) => x.id)).toContain(m.clubMemberId);
      // a withdrawn cancellation can no longer undo an effective exit
      expect((await call(founder, `/club-exit-requests/${req.id}/withdraw`, { method: "POST", body: {} })).status).toBe(409);
    });

    it("access ends by derivation the day left_at is reached (no job): a past left_at on a stored live status locks the member out", async () => {
      const m = await join("derived");
      expect((await call(m, "/club-members/me")).status).toBe(200);
      await db.update(clubMembers).set({ leftAt: addDays(today(), -1) }).where(eq(clubMembers.id, m.clubMemberId));
      expect((await call(m, "/club-members/me")).status).toBe(404);
      await db.update(clubMembers).set({ leftAt: addDays(today(), 1) }).where(eq(clubMembers.id, m.clubMemberId));
      expect((await call(m, "/club-members/me")).status).toBe(200);
      await db.update(clubMembers).set({ leftAt: today() }).where(eq(clubMembers.id, m.clubMemberId));
      expect((await call(m, "/club-members/me")).status).toBe(404);
    });

    it("re-joining: a former member re-applies and the board re-admits (reopen with reason); an excluded person is blocked", async () => {
      const m = await join("rejoiner");
      const req = await data(await request(m));
      await call(founder, `/club-exit-requests/${req.id}/approve`, { method: "POST", body: {} });
      expect((await call(m, "/club-members/me")).status).toBe(404);

      const apply = await app.request("/club-members/apply", {
        method: "POST",
        headers: { cookie: m.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
        body: JSON.stringify({ clubSlug, category: "passiv" }),
      });
      expect(apply.status).toBe(201);
      const application = (await data(apply)).application as Json;
      const approve = await call(founder, `/club-applications/${application.id}/approve`, { method: "POST" });
      expect(approve.status).toBe(200);
      const row = await stored(m.clubMemberId);
      expect(row).toMatchObject({ status: "aktiv", leftAt: null });
      expect((await call(m, "/club-members/me")).status).toBe(200);
      expect(await db.select({ n: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, m.memberId))).toHaveLength(1);
      const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, m.clubMemberId));
      expect(history.some((h) => h.reason === "Wiederaufnahme per Aufnahmeantrag")).toBe(true);

      // an applicant who is still a normal member cannot apply
      const again = await app.request("/club-members/apply", {
        method: "POST",
        headers: { cookie: m.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
        body: JSON.stringify({ clubSlug }),
      });
      expect(again.status).toBe(409);
    });
  });

  // --- board: cancellation for others, exclusion ---------------------------------------------------

  describe("board actions", () => {
    beforeAll(async () => {
      await setSettings({ noticePeriodDays: 14, noticeMode: "immediate" });
    });

    it("records a cancellation for a member without account (approved at once, scheduled), empty checklist", async () => {
      const child = await childMember();
      const res = await request(founder, { clubMemberId: child.id, kind: "cancellation", reason: "Eltern kuendigen per Brief" });
      expect(res.status).toBe(201);
      const out = await body(res);
      const earliest = addDays(today(), 14);
      expect(out.data).toMatchObject({ status: "approved", kind: "cancellation", effectiveOn: earliest, decidedBy: founder.memberId, requestedBy: founder.memberId, hasAccount: false });
      expect(out.transition).toMatchObject({ kind: "scheduled_exit", effectiveOn: earliest });
      expect(await stored(child.id)).toMatchObject({ status: "aktiv", leftAt: earliest });
      const detail = await data(await call(founder, `/club-exit-requests/${out.data.id}`));
      expect(detail.checklist).toEqual({ openLoans: [], keys: [], isEmpty: true });
      // not twice, and not before the earliest date
      expect((await request(founder, { clubMemberId: child.id, kind: "cancellation" })).status).toBe(409);
      const other = await childMember();
      const early = await request(founder, { clubMemberId: other.id, kind: "cancellation", effectiveOn: today() });
      expect(early.status).toBe(422);
      expect(((await body(early)).error.details as Json).earliestEffectiveOn).toBe(earliest);
      const later = await request(founder, { clubMemberId: other.id, kind: "cancellation", effectiveOn: addDays(today(), 60) });
      expect((await data(later)).effectiveOn).toBe(addDays(today(), 60));
      // the board can withdraw it again
      const withdrawn = await call(founder, `/club-exit-requests/${out.data.id}/withdraw`, { method: "POST", body: {} });
      expect((await data(withdrawn)).status).toBe("withdrawn");
      expect((await stored(child.id)).leftAt).toBeNull();
    });

    it("exclusion needs a reason, takes effect immediately and ends access; it cannot be withdrawn", async () => {
      const victim = await join("excluded");
      expect((await request(founder, { clubMemberId: victim.clubMemberId, kind: "exclusion" })).status).toBe(422);
      expect((await request(founder, { clubMemberId: victim.clubMemberId, kind: "exclusion", reason: "  " })).status).toBe(422);
      expect((await request(founder, { clubMemberId: victim.clubMemberId, kind: "exclusion", reason: "Vereinsschaedigung", effectiveOn: addDays(today(), 3) })).status).toBe(422);
      expect((await request(founder, { clubMemberId: founder.clubMemberId, kind: "exclusion", reason: "x" })).status).toBe(422);

      // a pending cancellation of the same member is superseded
      const pending = await data(await request(victim));
      const res = await request(founder, { clubMemberId: victim.clubMemberId, kind: "exclusion", reason: "Vereinsschaedigung" });
      expect(res.status).toBe(201);
      const out = await body(res);
      expect(out.data).toMatchObject({ kind: "exclusion", status: "approved", effectiveOn: today(), earliestEffectiveOn: null });
      expect(out.transition).toMatchObject({ kind: "status", toStatus: "ausgeschlossen" });
      expect(await stored(victim.clubMemberId)).toMatchObject({ status: "ausgeschlossen", leftAt: today(), exitReason: "Vereinsschaedigung" });
      expect((await call(victim, "/club-members/me")).status).toBe(404);
      const superseded = await db.query.clubExitRequests.findFirst({ where: eq(clubExitRequests.id, pending.id) });
      expect(superseded).toMatchObject({ status: "rejected", decisionNote: "Ersetzt durch Ausschluss" });

      expect((await call(founder, `/club-exit-requests/${out.data.id}/withdraw`, { method: "POST", body: {} })).status).toBe(409);
      // already left: neither a second exclusion nor a cancellation
      expect((await request(founder, { clubMemberId: victim.clubMemberId, kind: "exclusion", reason: "nochmal" })).status).toBe(409);
      expect((await request(founder, { clubMemberId: victim.clubMemberId, kind: "cancellation" })).status).toBe(409);
      // the history keeps the reason, the audit entry does not
      const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, victim.clubMemberId));
      expect(history.some((h) => h.toStatus === "ausgeschlossen" && h.reason === "Vereinsschaedigung")).toBe(true);
      const audit = await db.select().from(auditLog).where(eq(auditLog.subjectId, out.data.id));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit)).not.toContain("Vereinsschaedigung");

      // excluded persons cannot come back through an application
      const apply = await app.request("/club-members/apply", {
        method: "POST",
        headers: { cookie: victim.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
        body: JSON.stringify({ clubSlug }),
      });
      expect(apply.status).toBe(409);
      expect(((await body(apply)).error.details as Json).code).toBe("member_rejoin_blocked");
    });

    it("the member concerned can read but not withdraw a request the board created", async () => {
      const m = await join("subject");
      const rec = await data(await request(founder, { clubMemberId: m.clubMemberId, kind: "cancellation" }));
      expect((await call(m, `/club-exit-requests/${rec.id}`)).status).toBe(200);
      expect((await call(m, "/club-exit-requests/mine").then(body)).data.map((r: Json) => r.id)).toContain(rec.id);
      expect((await call(m, `/club-exit-requests/${rec.id}/withdraw`, { method: "POST", body: {} })).status).toBe(403);
    });

    it("unknown or foreign members are 404, non-uuid ids too", async () => {
      expect((await request(founder, { clubMemberId: randomUUID(), kind: "cancellation" })).status).toBe(404);
      const foreign = await join("foreign");
      expect((await call(outsider, "/club-exit-requests", { method: "POST", clubId: otherClub, body: { clubMemberId: foreign.clubMemberId, kind: "cancellation" } })).status).toBe(404);
      expect((await call(founder, "/club-exit-requests/not-a-uuid")).status).toBe(404);
    });
  });
});
