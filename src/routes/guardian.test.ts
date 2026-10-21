import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { absenceReports, wardEventResponses } from "../db/schema/absences.js";
import { auditLog } from "../db/schema/audit-log.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import { calendars } from "../db/schema/calendars.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { events } from "../db/schema/events.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { toAppError } from "../lib/errors.js";
import { makePng } from "../lib/media-fixtures.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { absenceRoutes } from "./absences.js";
import { clubMemberRoutes } from "./club-members.js";
import { eventRoutes } from "./events.js";
import { guardianRoutes, myWardsRoutes } from "./guardian.js";
import { inventoryItemRoutes } from "./inventory-items.js";
import { locationRoutes } from "./locations.js";
import { mediaRoutes } from "./media.js";
import { meetingRoutes } from "./meetings.js";

/**
 * Wave 10 B4 + B5 + B12: guardian access bound to the ward (IDOR, expiry without a job, no club-wide read paths), events and
 * answers for wards without account, trainer contacts, absence reports (rights, department scope, no health data in the
 * notification) and the per-field visibility.
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/my-wards", myWardsRoutes);
app.route("/guardian", guardianRoutes);
app.route("/absences", absenceRoutes);
app.route("/events", eventRoutes);
app.route("/meetings", meetingRoutes);
app.route("/media", mediaRoutes);
app.route("/locations", locationRoutes);
app.route("/inventory-items", inventoryItemRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; memberId: string; clubMemberId: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `guardian-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Guardian ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}
const json = async (res: Response) => (await res.json()) as Json;
const plusDays = (days: number) => new Date(Date.now() + days * 86_400_000);
const dayPlus = (days: number) => plusDays(days).toISOString().slice(0, 10);

describe("guardian access, absences and field visibility (B4, B5, B12)", () => {
  let clubId: string;
  let otherClubId: string;
  let board: Actor;
  let trainer1: Actor; // trains department 1
  let trainer2: Actor; // trains department 2
  let plain: Actor;
  let g1: Actor; // guardian of child1 + child2
  let g2: Actor; // guardian of child3
  let g3: Actor; // guest without any link
  let outsider: Actor;
  let teen: Actor; // ward with an account (child4)
  let child1: string; // department 1
  let child2: string; // department 2
  let child3: string; // department 1, other guardian
  let adultWard: string; // turned 18: link ended by age
  let dept1: string;
  let dept2: string;
  let cal1: string; // department calendar of dept 1 (visibility grant)
  let cal2: string;
  let calClub: string; // club-wide default calendar without grants
  let event1: string;
  let event2: string;
  let eventClub: string;
  let eventCap: string; // capacity 1 on cal1
  const userIds: string[] = [];

  const call = (who: Actor, url: string, init: { method?: string; json?: object; club?: string } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${init.club ?? clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), ...(init.json ? { "content-type": "application/json" } : {}) },
      body: init.json ? JSON.stringify(init.json) : undefined,
    });

  async function resolve(s: { userId: string; cookie: string }, club: string): Promise<Actor> {
    const m = await db.query.member.findFirst({ where: (t, { and: a, eq: e }) => a(e(t.organizationId, club), e(t.userId, s.userId)) });
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) });
    return { ...s, memberId: m!.id, clubMemberId: cm!.id };
  }
  async function join(label: string, role: "member" | "guest" = "member", birthDate?: string): Promise<Actor> {
    const s = await signUp(label);
    userIds.push(s.userId);
    await auth.api.addMember({ body: { userId: s.userId, organizationId: clubId, role } });
    const actor = await resolve(s, clubId);
    if (birthDate) await db.update(clubMembers).set({ birthDate }).where(eq(clubMembers.id, actor.clubMemberId));
    return actor;
  }
  async function child(name: string, birthDate: string, dept?: string): Promise<string> {
    const res = await json(await call(board, "/club-members", { method: "POST", json: { displayName: name, categoryKey: "jugend", birthDate } }));
    if (dept) await db.insert(clubMemberDepartments).values({ clubMemberId: res.data.id, departmentId: dept });
    return res.data.id;
  }
  const link = (ward: string, guardian: Actor, terms: object = {}) => call(board, `/club-members/${ward}/guardians`, { method: "POST", json: { guardianMemberId: guardian.clubMemberId, ...terms } });
  const newEvent = async (calendarId: string, extra: Partial<typeof events.$inferInsert> = {}) => {
    const [row] = await db.insert(events).values({ calendarId, title: "Training", startsAt: plusDays(3), ...extra }).returning();
    return row!.id;
  };

  beforeAll(async () => {
    const founder = await signUp("board");
    userIds.push(founder.userId);
    clubId = (await auth.api.createOrganization({ body: { name: `Guardian Club ${suffix}`, slug: `guardian-club-${suffix}`, userId: founder.userId } }))!.id;
    const out = await signUp("outsider");
    userIds.push(out.userId);
    otherClubId = (await auth.api.createOrganization({ body: { name: `Guardian Other ${suffix}`, slug: `guardian-other-${suffix}`, userId: out.userId } }))!.id;
    board = await resolve(founder, clubId);
    await db.insert(clubRoles).values({ memberId: board.memberId, roleType: "vorsitz" });
    outsider = await resolve(out, otherClubId);
    await db.insert(clubRoles).values({ memberId: outsider.memberId, roleType: "vorsitz" });

    [dept1, dept2] = (await db.insert(departments).values([{ clubId, name: "Jugend A" }, { clubId, name: "Jugend B" }]).returning()).map((d) => d.id) as [string, string];
    trainer1 = await join("trainer1");
    trainer2 = await join("trainer2");
    plain = await join("plain");
    teen = await join("teen", "member", "2012-02-02");
    await db.insert(clubRoles).values([
      { memberId: trainer1.memberId, roleType: "trainer", departmentId: dept1 },
      { memberId: trainer2.memberId, roleType: "trainer", departmentId: dept2 },
    ]);
    g1 = await join("g1", "guest");
    g2 = await join("g2", "guest");
    g3 = await join("g3", "guest");

    child1 = await child("Kind Eins", "2016-01-01", dept1);
    child2 = await child("Kind Zwei", "2015-06-06", dept2);
    child3 = await child("Kind Drei", "2017-03-03", dept1);
    adultWard = await child("Schon Volljährig", "2000-01-01", dept1);
    await db.insert(clubMemberDepartments).values({ clubMemberId: teen.clubMemberId, departmentId: dept1 });

    expect((await link(child1, g1, { relationship: "Mutter" })).status).toBe(201);
    expect((await link(child2, g1, { canReportAbsence: false })).status).toBe(201);
    expect((await link(child3, g2)).status).toBe(201);
    expect((await link(adultWard, g1)).status).toBe(201);
    expect((await link(teen.clubMemberId, g1)).status).toBe(201);

    [cal1, cal2] = (await db.insert(calendars).values([{ clubId, name: "Jugend A Kalender", departmentId: dept1 }, { clubId, name: "Jugend B Kalender", departmentId: dept2 }]).returning()).map((c) => c.id) as [string, string];
    calClub = (await db.insert(calendars).values({ clubId, name: "Vereinskalender Neu" }).returning())[0]!.id;
    await db.insert(calendarVisibility).values([{ calendarId: cal1, departmentId: dept1 }, { calendarId: cal2, departmentId: dept2 }]);
    event1 = await newEvent(cal1, { title: "Training A" });
    event2 = await newEvent(cal2, { title: "Training B" });
    eventClub = await newEvent(calClub, { title: "Sommerfest" });
    eventCap = await newEvent(cal1, { title: "Turnier", capacity: 1 });
  }, 90_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    await db.delete(organization).where(eq(organization.id, otherClubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("guardian links (B4)", () => {
    it("gives an external guest the role erziehungsberechtigt with the link and takes it away with the last one", async () => {
      const roles = async (a: Actor) => (await db.select().from(clubRoles).where(eq(clubRoles.memberId, a.memberId))).map((r) => r.roleType);
      expect(await roles(g1)).toEqual(["erziehungsberechtigt"]);
      const solo = await join("solo", "guest");
      const soloChild = await child("Solo Kind", "2018-01-01");
      const created = await link(soloChild, solo, { relationship: "Vater", hasCustody: false, canConsent: false, validUntil: dayPlus(100) });
      expect(created.status).toBe(201);
      expect((await json(created)).data).toMatchObject({ relationship: "Vater", hasCustody: false, canConsent: false, canReportAbsence: true, validUntil: dayPlus(100) });
      expect(await roles(solo)).toEqual(["erziehungsberechtigt"]);
      const patched = await json(await call(board, `/club-members/${soloChild}/guardians/${solo.clubMemberId}`, { method: "PATCH", json: { canConsent: true, validUntil: null } }));
      expect(patched.data).toMatchObject({ canConsent: true, validUntil: null });
      expect((await call(board, `/club-members/${soloChild}/guardians/${solo.clubMemberId}`, { method: "PATCH", json: { validUntil: "2000-01-01" } })).status).toBe(422);
      expect((await call(plain, `/club-members/${soloChild}/guardians/${solo.clubMemberId}`, { method: "PATCH", json: { canConsent: false } })).status).toBe(403);
      expect((await call(board, `/club-members/${soloChild}/guardians/${solo.clubMemberId}`, { method: "DELETE" })).status).toBe(204);
      expect(await roles(solo)).toEqual([]);
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubId), eq(auditLog.subjectId, soloChild)));
      expect(audits.map((a) => a.eventType).filter((t) => t.startsWith("guardian_link.")).sort()).toEqual(["guardian_link.create", "guardian_link.delete", "guardian_link.update"]);
    });
  });

  describe("my wards and the ward scope (IDOR)", () => {
    it("lists exactly the live wards of the caller, grouped by club (adult ward and foreign children excluded)", async () => {
      const mine = await json(await app.request("/my-wards", { headers: { cookie: g1.cookie, "x-forwarded-for": randomUUID() } }));
      expect(mine.data).toHaveLength(1);
      expect(mine.data[0]).toMatchObject({ clubId, clubName: `Guardian Club ${suffix}` });
      const ids = mine.data[0].wards.map((w: Json) => w.wardId).sort();
      expect(ids).toEqual([child1, child2, teen.clubMemberId].sort());
      expect(mine.data[0].wards.find((w: Json) => w.wardId === child1)).toMatchObject({ relationship: "Mutter", canConsent: true, canReportAbsence: true });
      const other = await json(await app.request("/my-wards", { headers: { cookie: g2.cookie } }));
      expect(other.data[0].wards.map((w: Json) => w.wardId)).toEqual([child3]);
      expect((await json(await app.request("/my-wards", { headers: { cookie: g3.cookie } }))).data).toEqual([]);
      expect((await app.request("/my-wards")).status).toBe(401);
    });

    it("answers 404 for every other child, other club, malformed id, expired, unconfirmed and age-ended link", async () => {
      for (const sub of ["overview", "events", "contacts", "consents", "absences"]) {
        expect((await call(g1, `/guardian/wards/${child1}/${sub}`)).status, `own ${sub}`).toBe(200);
        expect((await call(g1, `/guardian/wards/${child3}/${sub}`)).status, `foreign child ${sub}`).toBe(404);
        expect((await call(g1, `/guardian/wards/${randomUUID()}/${sub}`)).status).toBe(404);
        expect((await call(g1, `/guardian/wards/not-a-uuid/${sub}`)).status).toBe(404);
        expect((await call(g1, `/guardian/wards/${adultWard}/${sub}`)).status, `ward of age ${sub}`).toBe(404);
        expect((await call(g3, `/guardian/wards/${child1}/${sub}`)).status, `no link ${sub}`).toBe(404);
        expect((await call(plain, `/guardian/wards/${child1}/${sub}`)).status, `plain member ${sub}`).toBe(404);
        expect((await call(g1, `/guardian/wards/${child1}/${sub}`, { club: otherClubId })).status, `other club ${sub}`).toBe(404);
        expect((await call(outsider, `/guardian/wards/${child1}/${sub}`, { club: otherClubId })).status).toBe(404);
        expect((await call(outsider, `/guardian/wards/${child1}/${sub}`)).status, `not a member of the club ${sub}`).toBe(404);
      }
      // Expiry and confirmation are read-time rules: no job ran.
      await db.update(guardianLinks).set({ validUntil: "2020-01-01" }).where(and(eq(guardianLinks.guardianMemberId, g2.memberId), eq(guardianLinks.wardClubMemberId, child3)));
      expect((await call(g2, `/guardian/wards/${child3}/overview`)).status).toBe(404);
      expect((await json(await app.request("/my-wards", { headers: { cookie: g2.cookie } }))).data).toEqual([]);
      await db.update(guardianLinks).set({ validUntil: null, confirmedAt: null }).where(and(eq(guardianLinks.guardianMemberId, g2.memberId), eq(guardianLinks.wardClubMemberId, child3)));
      expect((await call(g2, `/guardian/wards/${child3}/overview`)).status).toBe(404);
      await db.update(guardianLinks).set({ confirmedAt: new Date(), validFrom: dayPlus(5) }).where(and(eq(guardianLinks.guardianMemberId, g2.memberId), eq(guardianLinks.wardClubMemberId, child3)));
      expect((await call(g2, `/guardian/wards/${child3}/overview`)).status).toBe(404);
      await db.update(guardianLinks).set({ validFrom: "2020-01-01" }).where(and(eq(guardianLinks.guardianMemberId, g2.memberId), eq(guardianLinks.wardClubMemberId, child3)));
      expect((await call(g2, `/guardian/wards/${child3}/overview`)).status).toBe(200);
    });

    it("gives the overview of the ward and nothing about other members", async () => {
      const res = await json(await call(g1, `/guardian/wards/${child1}/overview`));
      expect(res.data.ward).toMatchObject({ id: child1, name: "Kind Eins", departments: [{ id: dept1, name: "Jugend A" }] });
      expect(res.data.link).toMatchObject({ relationship: "Mutter", canConsent: true });
      expect(JSON.stringify(res.data)).not.toMatch(/Kind Zwei|Kind Drei/);
    });

    it("has no implicit mitglied role: no club-wide read path opens for a guardian", async () => {
      for (const url of ["/club-members", "/meetings"]) {
        const res = await call(g1, url);
        expect([403, 404], `${url} -> ${res.status}`).toContain(res.status);
      }
      // Member rows of other people, also by id.
      expect([403, 404]).toContain((await call(g1, `/club-members/${child3}`)).status);
      expect([403, 404]).toContain((await call(g1, `/club-members/${child3}/consents`)).status);
    });
  });

  describe("events and answers for wards without account (B4)", () => {
    it("shows only the calendars of the ward's departments, never the club calendar or other departments", async () => {
      const list = await json(await call(g1, `/guardian/wards/${child1}/events`));
      const titles = list.data.map((e: Json) => e.title);
      expect(titles).toContain("Training A");
      expect(titles).toContain("Turnier");
      expect(titles).not.toContain("Training B");
      expect(titles).not.toContain("Sommerfest");
      expect(list.data.find((e: Json) => e.title === "Training A")).toMatchObject({ canRespond: true, response: null, calendarName: "Jugend A Kalender" });
      const two = await json(await call(g1, `/guardian/wards/${child2}/events`));
      expect(two.data.map((e: Json) => e.title)).toEqual(["Training B"]);
      expect((await call(g1, `/guardian/wards/${child1}/events?from=2020-01-01&to=2022-01-01`)).status).toBe(422); // > 366 days
    });

    it("lets the guardian answer for the child; capacity and waitlist count, a freed seat is taken by the next one", async () => {
      const put = (ward: Actor, wardId: string, eventId: string, status: string) => call(ward, `/guardian/wards/${wardId}/events/${eventId}/response`, { method: "PUT", json: { status } });
      expect((await json(await put(g1, child1, event1, "angemeldet"))).data.status).toBe("angemeldet");
      expect((await json(await put(g1, child1, event1, "abgesagt"))).data.status).toBe("abgesagt");
      expect((await json(await call(g1, `/guardian/wards/${child1}/events`))).data.find((e: Json) => e.id === event1).response).toBe("abgesagt");

      expect((await json(await put(g1, child1, eventCap, "angemeldet"))).data.status).toBe("angemeldet");
      expect((await json(await put(g2, child3, eventCap, "angemeldet"))).data.status).toBe("warteliste");
      // The account RSVP of a member counts against the same capacity.
      expect((await call(g1, `/guardian/wards/${child1}/events/${eventCap}/response`, { method: "DELETE" })).status).toBe(204);
      const promoted = await db.select().from(wardEventResponses).where(and(eq(wardEventResponses.eventId, eventCap), eq(wardEventResponses.wardClubMemberId, child3)));
      expect(promoted[0]?.status).toBe("angemeldet");
      expect((await call(g1, `/guardian/wards/${child1}/events/${eventCap}/response`, { method: "DELETE" })).status).toBe(404);
      const rsvp = await call(trainer1, `/events/${eventCap}/rsvp`, { method: "POST" });
      expect((await json(rsvp)).data.status).toBe("warteliste");
    });

    it("refuses events of other children / calendars (404), wards with an account (409) and cancelled events (409)", async () => {
      const put = (who: Actor, wardId: string, eventId: string) => call(who, `/guardian/wards/${wardId}/events/${eventId}/response`, { method: "PUT", json: { status: "angemeldet" } });
      expect((await put(g1, child1, event2)).status).toBe(404); // other department
      expect((await put(g1, child1, eventClub)).status).toBe(404); // club calendar
      expect((await put(g1, child1, "nope")).status).toBe(404);
      expect((await put(g2, child1, event1)).status).toBe(404); // foreign ward
      expect((await put(g3, child1, event1)).status).toBe(404);
      const res = await put(g1, teen.clubMemberId, event1);
      expect(res.status).toBe(409);
      expect((await json(res)).error.details.code).toBe("ward_has_account");
      const cancelled = await newEvent(cal1, { cancelledAt: new Date(), cancelReason: "Wetter" });
      expect((await put(g1, child1, cancelled)).status).toBe(409);
      expect((await call(g1, `/guardian/wards/${child1}/events/${event1}/response`, { method: "PUT", json: { status: "vielleicht" } })).status).toBe(422);
    });
  });

  describe("trainer contacts and field visibility (B4, B12)", () => {
    it("shows the name of the trainers of the ward's departments and no contact way until they opened one", async () => {
      const first = await json(await call(g1, `/guardian/wards/${child1}/contacts`));
      expect(first.data).toHaveLength(1);
      expect(first.data[0]).toMatchObject({ clubMemberId: trainer1.clubMemberId, roleType: "trainer", department: { id: dept1 }, phone: null, email: null });
      await db.update(clubMembers).set({ phone: "+49 170 1234567" }).where(eq(clubMembers.id, trainer1.clubMemberId));

      // Level `trainer` is not for guardians; `mitglieder` is.
      expect((await call(trainer1, `/club-members/${trainer1.clubMemberId}/visibility`, { method: "PUT", json: { phone: "trainer" } })).status).toBe(200);
      expect((await json(await call(g1, `/guardian/wards/${child1}/contacts`))).data[0].phone).toBeNull();
      expect((await call(trainer1, `/club-members/${trainer1.clubMemberId}/visibility`, { method: "PUT", json: { phone: "mitglieder" } })).status).toBe(200);
      expect((await json(await call(g1, `/guardian/wards/${child1}/contacts`))).data[0].phone).toBe("+49 170 1234567");
      // Other departments' trainers never show up for this ward.
      expect(JSON.stringify((await json(await call(g1, `/guardian/wards/${child1}/contacts`))).data)).not.toContain(trainer2.clubMemberId);
    });

    it("decides who may change the levels: the person, a guardian with custody, the board; nobody else", async () => {
      const url = `/club-members/${child1}/visibility`;
      expect((await json(await call(g1, url))).data.levels).toEqual({ phone: "nur_vorstand", email: "nur_vorstand", address: "nur_vorstand", photo: "nur_vorstand" });
      expect((await call(g1, url, { method: "PUT", json: { address: "trainer", photo: "mitglieder" } })).status).toBe(200);
      expect((await json(await call(board, url))).data.levels).toMatchObject({ address: "trainer", photo: "mitglieder" });
      expect((await call(g2, url)).status).toBe(403);
      expect((await call(g2, url, { method: "PUT", json: { phone: "mitglieder" } })).status).toBe(403);
      expect((await call(plain, url, { method: "PUT", json: { phone: "mitglieder" } })).status).toBe(403);
      expect((await call(g1, url, { method: "PUT", json: {} })).status).toBe(422);
      expect((await call(g1, url, { method: "PUT", json: { phone: "alle" } })).status).toBe(422);
      expect((await call(outsider, url, { method: "PUT", json: { phone: "mitglieder" }, club: otherClubId })).status).toBe(404);
      // A guardian without custody may read but not change.
      await db.update(guardianLinks).set({ hasCustody: false }).where(and(eq(guardianLinks.guardianMemberId, g2.memberId), eq(guardianLinks.wardClubMemberId, child3)));
      expect((await call(g2, `/club-members/${child3}/visibility`)).status).toBe(200);
      expect((await call(g2, `/club-members/${child3}/visibility`, { method: "PUT", json: { phone: "mitglieder" } })).status).toBe(403);
      await db.update(guardianLinks).set({ hasCustody: true }).where(eq(guardianLinks.guardianMemberId, g2.memberId));
    });

    it("applies the chosen level in the member list: restrictive by default, wider only on the person's choice", async () => {
      await db.update(clubMembers).set({ phone: "+49 30 555", street: "Weg 1", postalCode: "10115", city: "Berlin" }).where(eq(clubMembers.id, child1));
      const asPlain = async () => (await json(await call(plain, `/club-members/${child1}`))).data;
      const asTrainer = async () => (await json(await call(trainer1, `/club-members/${child1}`))).data;
      const closed = await asPlain();
      expect(closed.phone).toBeUndefined();
      expect(closed.street).toBeUndefined();
      // address -> trainer (set above): the trainer sees it, the plain member does not.
      const t = await asTrainer();
      expect(t).toMatchObject({ street: "Weg 1", city: "Berlin" });
      expect(t.phone).toBeUndefined();
      expect((await asPlain()).street).toBeUndefined();
      expect((await call(g1, `/club-members/${child1}/visibility`, { method: "PUT", json: { phone: "mitglieder", address: "nur_vorstand" } })).status).toBe(200);
      expect((await asPlain()).phone).toBe("+49 30 555");
      expect((await asTrainer()).street).toBeUndefined();
      // The list applies the same filter.
      const list = await json(await call(plain, "/club-members?pageSize=100"));
      const row = list.data.find((m: Json) => m.id === child1);
      expect(row.phone).toBe("+49 30 555");
      expect(list.data.find((m: Json) => m.id === child2).phone).toBeUndefined();
    });
  });

  describe("photo level (B12, media layer)", () => {
    it("streams and signs the photo of a child only for the groups the guardian opened it for", async () => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(makePng(true))], "kid.png", { type: "image/png" }));
      expect((await app.request(`/club-members/${child1}/photo?clubId=${clubId}`, { method: "PUT", headers: { cookie: board.cookie, "x-forwarded-for": randomUUID() }, body: form })).status).toBe(200);
      expect((await call(g1, `/club-members/${child1}/visibility`, { method: "PUT", json: { photo: "nur_vorstand" } })).status).toBe(200);
      expect((await call(plain, `/club-members/${child1}/photo`)).status).toBe(404);
      expect((await json(await call(plain, `/club-members/${child1}`))).data.photoUrl).toBeNull();
      expect((await call(g1, `/club-members/${child1}/visibility`, { method: "PUT", json: { photo: "trainer" } })).status).toBe(200);
      expect((await call(plain, `/club-members/${child1}/photo`)).status).toBe(404);
      expect((await call(trainer1, `/club-members/${child1}/photo`)).status).toBe(200);
      expect((await call(g1, `/club-members/${child1}/visibility`, { method: "PUT", json: { photo: "mitglieder" } })).status).toBe(200);
      const res = await call(plain, `/club-members/${child1}/photo`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect((await json(await call(plain, `/club-members/${child1}`))).data.photoUrl).toContain("/media/");
      // A guest who is not the child's guardian never gets it, whatever the level is.
      expect((await call(g2, `/club-members/${child1}/photo`)).status).toBe(404);
    });
  });

  describe("absences (B5)", () => {
    let own: string;
    let ward1: string;

    it("members report for themselves: validation, no diagnosis field, withdrawal", async () => {
      const post = (json_: object) => call(teen, "/absences", { method: "POST", json: json_ });
      const ok = await post({ kind: "krank", startsOn: dayPlus(0), endsOn: dayPlus(2), note: "Erkältung, zurück am Montag", diagnose: "Grippe" });
      expect(ok.status).toBe(201);
      const created = (await json(ok)).data;
      own = created.id;
      expect(Object.keys(created).sort()).toEqual(["clubMemberId", "createdAt", "endsOn", "id", "kind", "note", "reportedByKind", "startsOn", "updatedAt", "withdrawnAt"].sort());
      expect(created).toMatchObject({ kind: "krank", reportedByKind: "self", note: "Erkältung, zurück am Montag" });
      expect(JSON.stringify(await db.select().from(absenceReports).where(eq(absenceReports.id, own)))).not.toContain("Grippe");
      expect((await post({ kind: "krank", startsOn: dayPlus(2), endsOn: dayPlus(1) })).status).toBe(422);
      expect((await post({ kind: "krank", startsOn: dayPlus(-30), endsOn: dayPlus(1) })).status).toBe(422);
      expect((await post({ kind: "krank", startsOn: dayPlus(0), endsOn: dayPlus(400) })).status).toBe(422);
      expect((await post({ kind: "krank", startsOn: dayPlus(0), endsOn: dayPlus(1), note: "x".repeat(201) })).status).toBe(422);
      expect((await post({ kind: "schwanger", startsOn: dayPlus(0), endsOn: dayPlus(1) })).status).toBe(422);

      const patched = await json(await call(teen, `/absences/${own}`, { method: "PATCH", json: { endsOn: dayPlus(4), note: null } }));
      expect(patched.data).toMatchObject({ endsOn: dayPlus(4), note: null });
      expect((await call(plain, `/absences/${own}`, { method: "PATCH", json: { note: "fremd" } })).status).toBe(404);
      expect((await call(plain, `/absences/${own}`, { method: "DELETE" })).status).toBe(404);
      expect((await call(teen, "/absences/not-a-uuid", { method: "DELETE" })).status).toBe(404);
      expect((await json(await call(teen, "/absences"))).data.map((a: Json) => a.id)).toContain(own);
    });

    it("guests (guardians) have no absences of their own; guardians report for the ward within their link", async () => {
      expect((await call(g1, "/absences", { method: "POST", json: { kind: "abwesend", startsOn: dayPlus(0), endsOn: dayPlus(1) } })).status).toBe(403);
      expect((await call(g1, "/absences")).status).toBe(403);

      const made = await call(g1, `/guardian/wards/${child1}/absences`, { method: "POST", json: { kind: "krank", startsOn: dayPlus(1), endsOn: dayPlus(3), note: "Fieber" } });
      expect(made.status).toBe(201);
      const madeBody = await json(made);
      ward1 = madeBody.data.id;
      expect(madeBody.data.reportedByKind).toBe("guardian");
      expect((await json(await call(g1, `/guardian/wards/${child1}/absences`))).data.map((a: Json) => a.id)).toContain(ward1);
      expect((await call(g1, `/guardian/wards/${child1}/absences/${ward1}`, { method: "PATCH", json: { endsOn: dayPlus(4) } })).status).toBe(200);
      // No right on this link, foreign child, foreign absence.
      const noRight = await call(g1, `/guardian/wards/${child2}/absences`, { method: "POST", json: { kind: "krank", startsOn: dayPlus(1), endsOn: dayPlus(2) } });
      expect(noRight.status).toBe(403);
      expect((await json(noRight)).error.details.code).toBe("guardian_cannot_report_absence");
      expect((await call(g1, `/guardian/wards/${child2}/absences`)).status).toBe(200); // reading stays allowed
      expect((await call(g2, `/guardian/wards/${child1}/absences`, { method: "POST", json: { kind: "krank", startsOn: dayPlus(1), endsOn: dayPlus(2) } })).status).toBe(404);
      expect((await call(g2, `/guardian/wards/${child3}/absences/${ward1}`, { method: "PATCH", json: { note: "x" } })).status).toBe(404);
      expect((await call(g2, `/guardian/wards/${child3}/absences/${ward1}`, { method: "DELETE" })).status).toBe(404);
    });

    it("lets only absences:read holders read, trainers only for the members of their own departments", async () => {
      const q = `?from=${dayPlus(0)}&to=${dayPlus(10)}`;
      expect((await call(plain, `/absences/club${q}`)).status).toBe(403);
      expect((await call(g1, `/absences/club${q}`)).status).toBe(403);
      expect((await call(teen, `/absences/club${q}`)).status).toBe(403);
      const forTrainer1 = await json(await call(trainer1, `/absences/club${q}`));
      const names1 = forTrainer1.data.map((a: Json) => a.displayName);
      expect(names1).toContain("Kind Eins");
      expect(forTrainer1.data.find((a: Json) => a.displayName === "Kind Eins").note).toBe("Fieber");
      expect(forTrainer1.data.map((a: Json) => a.clubMemberId)).toContain(teen.clubMemberId); // teen is in dept 1
      // A report for a child of department 2 is invisible for the trainer of department 1.
      await db.insert(absenceReports).values({ clubId, clubMemberId: child2, kind: "krank", startsOn: dayPlus(0), endsOn: dayPlus(1), reportedByKind: "guardian" });
      expect((await json(await call(trainer1, `/absences/club${q}`))).data.map((a: Json) => a.displayName)).not.toContain("Kind Zwei");
      const forTrainer2 = await json(await call(trainer2, `/absences/club${q}`));
      expect(forTrainer2.data.map((a: Json) => a.displayName)).toEqual(["Kind Zwei"]);
      const all = (await json(await call(board, `/absences/club${q}`))).data.map((a: Json) => a.displayName);
      expect(all).toEqual(expect.arrayContaining(["Kind Eins", "Kind Zwei"]));
      expect((await call(trainer1, `/absences/club?departmentId=${dept2}${q.replace("?", "&")}`)).status).toBe(200);
      expect((await json(await call(trainer1, `/absences/club?departmentId=${dept2}${q.replace("?", "&")}`))).data).toEqual([]);
      expect((await call(outsider, `/absences/club${q}`, { club: clubId })).status).toBe(404);
      expect((await call(trainer1, `/absences/club?from=2030-02-01&to=2030-01-01`)).status).toBe(422);
    });

    it("overlays the absences on an event: only the caller's scope, without the note", async () => {
      const day = new Date().toISOString().slice(0, 10);
      const eventToday = await newEvent(cal1, { title: "Heute", startsAt: new Date(`${day}T20:00:00Z`) });
      const overlay = await json(await call(trainer1, `/absences/event/${eventToday}`));
      // Today: the teen (department 1, own report) and Kind Zwei (department 2); the trainer of department 1 sees only the first.
      expect(overlay.data.map((a: Json) => a.displayName)).toEqual(["Guardian teen"]);
      expect(JSON.stringify(overlay.data)).not.toMatch(/Fieber|note|kind\b/);
      // The trainer of department 2 cannot even see the calendar of department 1; on the own calendar the scope shows Kind Zwei only.
      expect((await call(trainer2, `/absences/event/${eventToday}`)).status).toBe(404);
      const eventToday2 = await newEvent(cal2, { title: "Heute B", startsAt: new Date(`${day}T20:00:00Z`) });
      expect((await json(await call(trainer2, `/absences/event/${eventToday2}`))).data.map((a: Json) => a.displayName)).toEqual(["Kind Zwei"]);
      expect((await call(plain, `/absences/event/${eventToday}`)).status).toBe(403);
      expect((await call(trainer1, `/absences/event/${randomUUID()}`)).status).toBe(404);
      expect((await call(trainer1, `/absences/event/nope`)).status).toBe(404);
    });

    it("tells the trainers of the member's departments through notify(), without any health detail", async () => {
      const rows = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, "absence.reported")));
      const byUser = (userId: string) => rows.filter((r) => r.userId === userId);
      // Child 1 (guardian report) and the teen (self report) are in department 1: trainer 1 is told, trainer 2 is not.
      expect(byUser(trainer1.userId).length).toBeGreaterThanOrEqual(2);
      expect(byUser(trainer2.userId)).toHaveLength(0);
      expect(byUser(g1.userId)).toHaveLength(0);
      expect(byUser(plain.userId)).toHaveLength(0);
      const text = JSON.stringify(rows.map((r) => r.content));
      expect(text).toContain("Neue Abwesenheitsmeldung");
      expect(text).toContain("Kind Eins");
      expect(text).not.toMatch(/Fieber|Erkältung|krank|Grippe|Montag/i);
      expect(new Set(rows.map((r) => `${r.channel}`))).toEqual(new Set(["in_app", "push"]));
      const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubId), eq(auditLog.eventType, "absence.create")));
      expect(JSON.stringify(audits.map((a) => a.payload))).not.toMatch(/Fieber|Erkältung/);
    });

    it("withdraws (zurückziehen): the report disappears from the lists, repeating is harmless, changing is refused", async () => {
      expect((await call(teen, `/absences/${own}`, { method: "DELETE" })).status).toBe(204);
      expect((await call(teen, `/absences/${own}`, { method: "DELETE" })).status).toBe(204);
      expect((await call(teen, `/absences/${own}`, { method: "PATCH", json: { note: "x" } })).status).toBe(409);
      expect((await json(await call(teen, "/absences"))).data.map((a: Json) => a.id)).not.toContain(own);
      expect((await json(await call(teen, "/absences?includeWithdrawn=true"))).data.map((a: Json) => a.id)).toContain(own);
      expect((await call(g1, `/guardian/wards/${child1}/absences/${ward1}`, { method: "DELETE" })).status).toBe(204);
      const club = await json(await call(trainer1, `/absences/club?from=${dayPlus(0)}&to=${dayPlus(10)}`));
      expect(club.data.map((a: Json) => a.id)).not.toContain(ward1);
      const withdrawn = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, "absence.withdrawn")));
      expect(withdrawn.length).toBeGreaterThan(0);
      expect(todayBerlin()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
