import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { events } from "../db/schema/events.js";
import { toAppError } from "../lib/errors.js";
import { calendarRoutes } from "./calendars.js";
import { eventRoutes } from "./events.js";
import { guardianRoutes } from "./guardian.js";

/**
 * Shared fixture of the Wave 12 event tests (attendance, registration, helpers, ...): one club with two departments, a
 * calendar per department plus a club-wide one, a board member (vorsitz), a trainer and an abteilungsleitung of department A,
 * two plain members, a founder of a second club, and helpers to create account-less members and events. Not a test file.
 */

export interface TestUser {
  userId: string;
  memberId: string;
  clubMemberId: string;
  cookie: string;
}

export interface EventFixture {
  app: Hono;
  clubId: string;
  otherClubId: string;
  deptA: string;
  deptB: string;
  calA: string;
  calB: string;
  calClub: string;
  otherCalendar: string;
  users: { board: TestUser; trainerA: TestUser; leaderA: TestUser; member1: TestUser; member2: TestUser; outsider: TestUser };
  req: (who: { cookie: string }, path: string, init?: { method?: string; body?: unknown; club?: string }) => Promise<Response>;
  json: <T = any>(res: Response) => Promise<T>; // eslint-disable-line @typescript-eslint/no-explicit-any
  addEvent: (values: Partial<typeof events.$inferInsert> & { calendarId: string }) => Promise<typeof events.$inferSelect>;
  addAccountless: (name: string, opts?: { birthDate?: string; departmentId?: string }) => Promise<string>;
  addAccount: (label: string) => Promise<TestUser>;
  /** An external guest (`member.role = guest`, e.g. a guardian account without club member row of its own). */
  addGuest: (label: string) => Promise<TestUser>;
  cleanup: () => Promise<void>;
}

export const HOUR = 3_600_000;

export async function createEventFixture(label: string, extraRoutes: Array<[string, Hono<any>]> = []): Promise<EventFixture> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const suffix = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const app = new Hono();
  app.route("/calendars", calendarRoutes);
  app.route("/events", eventRoutes);
  app.route("/guardian", guardianRoutes);
  for (const [path, router] of extraRoutes) app.route(path, router);
  app.onError((err, c) => {
    const appError = toAppError(err);
    return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
  });

  const userIds: string[] = [];
  async function signUp(name: string) {
    const email = `${label}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}@example.com`;
    const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name } });
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
    const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
    userIds.push(created.id);
    return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
  }
  async function joined(clubId: string, name: string, role: "member" | "guest" = "member"): Promise<TestUser> {
    const u = await signUp(name);
    await auth.api.addMember({ body: { userId: u.userId, organizationId: clubId, role: role as "member" } });
    const m = await db.query.member.findFirst({ where: (t, { and, eq: e }) => and(e(t.organizationId, clubId), e(t.userId, u.userId)) });
    let cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) });
    if (!cm) {
      [cm] = await db.insert(clubMembers).values({ clubId, memberId: m!.id, displayName: name, status: "aktiv", joinedAt: "2020-01-01" }).returning();
    }
    return { userId: u.userId, memberId: m!.id, clubMemberId: cm!.id, cookie: u.cookie };
  }

  const founder = await signUp("Board");
  const outsiderFounder = await signUp("Outsider");
  const club = await auth.api.createOrganization({ body: { name: `Evt Club ${suffix}`, slug: `evt-${suffix}`.toLowerCase(), userId: founder.userId } });
  const other = await auth.api.createOrganization({ body: { name: `Evt Other ${suffix}`, slug: `evt-o-${suffix}`.toLowerCase(), userId: outsiderFounder.userId } });
  const clubId = club!.id;
  const otherClubId = other!.id;
  const boardMember = await db.query.member.findFirst({ where: (t, { and, eq: e }) => and(e(t.organizationId, clubId), e(t.userId, founder.userId)) });
  let boardCm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, boardMember!.id) });
  if (!boardCm) [boardCm] = await db.insert(clubMembers).values({ clubId, memberId: boardMember!.id, displayName: "Board", status: "aktiv", joinedAt: "2020-01-01" }).returning();
  await db.insert(clubRoles).values({ memberId: boardMember!.id, roleType: "vorsitz" });
  const outsiderMember = await db.query.member.findFirst({ where: (t, { and, eq: e }) => and(e(t.organizationId, otherClubId), e(t.userId, outsiderFounder.userId)) });
  await db.insert(clubRoles).values({ memberId: outsiderMember!.id, roleType: "vorsitz" });

  const [deptA] = await db.insert(departments).values({ clubId, name: "Abteilung A" }).returning();
  const [deptB] = await db.insert(departments).values({ clubId, name: "Abteilung B" }).returning();
  const [calA] = await db.insert(calendars).values({ clubId, departmentId: deptA!.id, name: "Kalender A", createdBy: founder.userId }).returning();
  const [calB] = await db.insert(calendars).values({ clubId, departmentId: deptB!.id, name: "Kalender B", createdBy: founder.userId }).returning();
  const [calClub] = await db.insert(calendars).values({ clubId, name: "Verein", createdBy: founder.userId }).returning();
  const [otherCal] = await db.insert(calendars).values({ clubId: otherClubId, name: "Fremd", createdBy: outsiderFounder.userId }).returning();

  const trainerA = await joined(clubId, "Trainer A");
  const leaderA = await joined(clubId, "Leiter A");
  const member1 = await joined(clubId, "Mitglied Eins");
  const member2 = await joined(clubId, "Mitglied Zwei");
  await db.insert(clubRoles).values([
    { memberId: trainerA.memberId, roleType: "trainer", departmentId: deptA!.id },
    { memberId: leaderA.memberId, roleType: "abteilungsleitung", departmentId: deptA!.id },
  ]);
  const board: TestUser = { userId: founder.userId, memberId: boardMember!.id, clubMemberId: boardCm!.id, cookie: founder.cookie };
  const outsider: TestUser = { userId: outsiderFounder.userId, memberId: outsiderMember!.id, clubMemberId: "", cookie: outsiderFounder.cookie };

  return {
    app,
    clubId,
    otherClubId,
    deptA: deptA!.id,
    deptB: deptB!.id,
    calA: calA!.id,
    calB: calB!.id,
    calClub: calClub!.id,
    otherCalendar: otherCal!.id,
    users: { board, trainerA, leaderA, member1, member2, outsider },
    req: async (who, path, init = {}) =>
      app.request(`${path}${path.includes("?") ? "&" : "?"}clubId=${init.club ?? clubId}`, {
        method: init.method ?? "GET",
        headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    json: async (res) => (await res.json()) as never,
    addEvent: async (values) => {
      const [row] = await db.insert(events).values({ title: "Training", startsAt: new Date(Date.now() + 24 * HOUR), createdBy: founder.userId, ...values }).returning();
      return row!;
    },
    addAccountless: async (name, opts = {}) => {
      const [cm] = await db.insert(clubMembers).values({ clubId, displayName: name, status: "aktiv", joinedAt: "2020-01-01", birthDate: opts.birthDate ?? null }).returning();
      if (opts.departmentId) await db.insert(clubMemberDepartments).values({ clubMemberId: cm!.id, departmentId: opts.departmentId, since: "2020-01-01" });
      return cm!.id;
    },
    addAccount: (name) => joined(clubId, name),
    addGuest: async (name) => {
      const guest = await joined(clubId, name, "guest");
      // A guardian account has no club member row of its own.
      await db.delete(clubMembers).where(eq(clubMembers.id, guest.clubMemberId));
      return { ...guest, clubMemberId: "" };
    },
    cleanup: async () => {
      await db.delete(organization).where(eq(organization.id, clubId));
      await db.delete(organization).where(eq(organization.id, otherClubId));
      for (const id of userIds) await db.delete(user).where(eq(user.id, id));
      await closeDatabase();
    },
  };
}
