import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { ensureDefaultCalendar } from "../lib/calendar-defaults.js";
import { toAppError } from "../lib/errors.js";
import { calendarRoutes } from "./calendars.js";
import { eventRoutes } from "./events.js";

/**
 * The standard club calendar: lazy creation for calendar-less clubs, visibility (member yes, guest no, former member
 * no), idempotency under parallel ensure, one default per club, and protection of the only calendar.
 */

const app = new Hono();
app.route("/calendars", calendarRoutes);
app.route("/events", eventRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUp(tag: string) {
  const email = `cald-${tag}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Cal ${tag}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

type Actor = Awaited<ReturnType<typeof signUp>>;

describe("default club calendar", () => {
  let clubId: string;
  let board: Actor;
  let plain: Actor;
  let guest: Actor;
  let former: Actor;
  let formerMemberId: string;
  const userIds: string[] = [];

  const call = (who: Actor, path: string, init: { method?: string; body?: object } = {}) =>
    app.request(`${path}${path.includes("?") ? "&" : "?"}clubId=${clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "content-type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const clubCalendars = () => db.select().from(calendars).where(eq(calendars.clubId, clubId));

  beforeAll(async () => {
    [board, plain, guest, former] = await Promise.all([signUp("board"), signUp("plain"), signUp("guest"), signUp("former")]);
    userIds.push(board.userId, plain.userId, guest.userId, former.userId);
    const club = await auth.api.createOrganization({ body: { name: `Cal Default ${suffix}`, slug: `cal-default-${suffix}`, userId: board.userId } });
    clubId = club!.id;
    await auth.api.addMember({ body: { userId: plain.userId, organizationId: clubId, role: "member" } });
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: clubId, role: "guest" } });
    await auth.api.addMember({ body: { userId: former.userId, organizationId: clubId, role: "member" } });
    const boardMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubId), eq(m.userId, board.userId)) });
    await db.insert(clubRoles).values({ memberId: boardMember!.id, roleType: "vorsitz" });
    formerMemberId = (await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubId), eq(m.userId, former.userId)) }))!.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("starts calendar-less (createOrganization skips the approval flow) and creates the standard calendar lazily, exactly once, in parallel too", async () => {
    expect(await clubCalendars()).toHaveLength(0);
    const results = await Promise.all([
      call(plain, "/calendars"),
      call(board, "/calendars"),
      call(plain, "/events"),
      call(board, "/calendars"),
      call(plain, "/calendars"),
      call(board, "/events"),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const rows = await clubCalendars();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Vereinskalender", isDefault: true, departmentId: null, createdBy: board.userId });
    const audits = await db.select().from(auditLog).where(eq(auditLog.subjectId, rows[0]!.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ eventType: "calendar.default_create", payload: { clubId, calendarId: rows[0]!.id, source: "lazy" } });
  });

  it("parallel ensureDefaultCalendar on a fresh club yields one default and the same row", async () => {
    const club = await auth.api.createOrganization({ body: { name: `Cal Race ${suffix}`, slug: `cal-race-${suffix}`, userId: board.userId } });
    try {
      const results = await Promise.all(Array.from({ length: 12 }, () => ensureDefaultCalendar(club!.id)));
      expect(new Set(results.map((r) => r!.id)).size).toBe(1);
      const rows = await db.select().from(calendars).where(eq(calendars.clubId, club!.id));
      expect(rows).toHaveLength(1);
      expect(await db.select().from(calendarVisibility).where(eq(calendarVisibility.calendarId, rows[0]!.id))).toHaveLength(1);
    } finally {
      await db.delete(organization).where(eq(organization.id, club!.id));
    }
  });

  it("the standard calendar is visible to plain members and the board, not to external guests, and a former member loses the club", async () => {
    const [def] = await clubCalendars();
    const grants = await db.select().from(calendarVisibility).where(eq(calendarVisibility.calendarId, def!.id));
    expect(grants.map((g) => g.roleType)).toEqual(["mitglied"]);

    for (const who of [plain, board]) {
      const list = (await (await call(who, "/calendars")).json()) as { data: Array<{ id: string }> };
      expect(list.data.map((c) => c.id)).toContain(def!.id);
      expect((await call(who, `/calendars/${def!.id}`)).status).toBe(200);
    }
    const guestList = (await (await call(guest, "/calendars")).json()) as { data: Array<{ id: string }> };
    expect(guestList.data.map((c) => c.id)).not.toContain(def!.id);
    expect((await call(guest, `/calendars/${def!.id}`)).status).toBe(404);

    expect((await call(former, "/calendars")).status).toBe(200);
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.memberId, formerMemberId));
    expect((await call(former, "/calendars")).status).toBe(404);
    expect((await call(former, `/calendars/${def!.id}`)).status).toBe(404);
  });

  it("events can be created on the standard calendar and a plain member sees them", async () => {
    const [def] = await clubCalendars();
    const created = await call(board, "/events", { method: "POST", body: { calendarId: def!.id, title: "Vereinsfest", startsAt: "2030-06-01T10:00:00+02:00" } });
    expect(created.status).toBe(201);
    const list = (await (await call(plain, "/events")).json()) as { data: Array<{ title: string }> };
    expect(list.data.map((e) => e.title)).toContain("Vereinsfest");
    const guestEvents = (await (await call(guest, "/events")).json()) as { data: unknown[] };
    expect(guestEvents.data).toHaveLength(0);
  });

  it("protects the default calendar while it is the only one, and 'make another default' still works", async () => {
    const [def] = await clubCalendars();
    const del = await call(board, `/calendars/${def!.id}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(((await del.json()) as { error: { details: { code: string } } }).error.details.code).toBe("default_calendar_required");
    const unset = await call(board, `/calendars/${def!.id}`, { method: "PATCH", body: { isDefault: false } });
    expect(unset.status).toBe(409);
    expect(((await unset.json()) as { error: { details: { code: string } } }).error.details.code).toBe("default_calendar_required");
    expect((await call(board, `/calendars/${def!.id}`, { method: "PATCH", body: { name: "Unser Kalender" } })).status).toBe(200);
    expect((await clubCalendars())).toHaveLength(1);

    const second = (await (await call(board, "/calendars", { method: "POST", body: { name: "Jugend" } })).json()) as { data: { id: string; isDefault: boolean } };
    expect(second.data.isDefault).toBe(false);
    const promote = await call(board, `/calendars/${second.data.id}`, { method: "PATCH", body: { isDefault: true } });
    expect(promote.status).toBe(200);
    const after = await clubCalendars();
    expect(after.filter((c) => c.isDefault).map((c) => c.id)).toEqual([second.data.id]);

    // The former default can now be deleted (another calendar exists); the new default is the only calendar's guard again.
    expect((await call(board, `/calendars/${def!.id}`, { method: "DELETE" })).status).toBe(204);
    const guard = await call(board, `/calendars/${second.data.id}`, { method: "DELETE" });
    expect(guard.status).toBe(409);
  });

  it("the database refuses a second default per club, and parallel 'make default' requests keep exactly one", async () => {
    await expect(db.insert(calendars).values({ clubId, name: "Zweiter Standard", isDefault: true, createdBy: board.userId })).rejects.toThrow();
    const ids = await Promise.all(Array.from({ length: 4 }, (_, i) => call(board, "/calendars", { method: "POST", body: { name: `Par ${i}`, isDefault: true } }).then((r) => r.status)));
    expect(ids).toEqual([201, 201, 201, 201]);
    expect((await clubCalendars()).filter((c) => c.isDefault)).toHaveLength(1);
  });

  it("the first calendar a board member creates in a calendar-less club becomes the standard calendar plus the custom one", async () => {
    const club = await auth.api.createOrganization({ body: { name: `Cal First ${suffix}`, slug: `cal-first-${suffix}`, userId: board.userId } });
    try {
      const m = await db.query.member.findFirst({ where: (mm, { and, eq }) => and(eq(mm.organizationId, club!.id), eq(mm.userId, board.userId)) });
      await db.insert(clubRoles).values({ memberId: m!.id, roleType: "vorsitz" });
      const res = await app.request(`/calendars?clubId=${club!.id}`, {
        method: "POST",
        headers: { cookie: board.cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Jugendkalender" }),
      });
      expect(res.status).toBe(201);
      const rows = await db.select().from(calendars).where(eq(calendars.clubId, club!.id));
      expect(rows.map((r) => [r.name, r.isDefault]).sort()).toEqual([["Jugendkalender", false], ["Vereinskalender", true]]);
    } finally {
      await db.delete(organization).where(eq(organization.id, club!.id));
    }
  });

  it("a club that has calendars but no default promotes its club-wide 'Vereinskalender' instead of duplicating it", async () => {
    const club = await auth.api.createOrganization({ body: { name: `Cal Promote ${suffix}`, slug: `cal-promote-${suffix}`, userId: board.userId } });
    try {
      const [manual] = await db.insert(calendars).values({ clubId: club!.id, name: "vereinskalender", createdBy: board.userId }).returning();
      const ensured = await ensureDefaultCalendar(club!.id);
      expect(ensured!.id).toBe(manual!.id);
      expect(ensured!.isDefault).toBe(true);
      expect(await db.select().from(calendars).where(eq(calendars.clubId, club!.id))).toHaveLength(1);
    } finally {
      await db.delete(organization).where(eq(organization.id, club!.id));
    }
  });
});
