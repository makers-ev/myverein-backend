import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { events } from "../db/schema/events.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { jobs } from "../db/schema/jobs.js";
import { toAppError } from "../lib/errors.js";
import { eventRoutes } from "./events.js";

/** Gap 11: `GET /events/:id/cancel-preview` shows how many people a cancellation would reach (counts only, same right as the cancellation). */

const app = new Hono();
app.route("/events", eventRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `cpv-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: label } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("cancel preview", () => {
  let clubId: string;
  let otherClubId: string;
  let generalCalendar: string;
  let teamCalendar: string;
  const people: Record<string, { userId: string; cookie: string; accountId: string; clubMemberId: string }> = {};
  const userIds: string[] = [];

  const call = (who: string, url: string, club = clubId) =>
    app.request(`${url}?clubId=${club}`, { headers: { cookie: people[who]!.cookie, "x-forwarded-for": randomUUID() } });
  const newEvent = async (calendarId: string, extra: Partial<typeof events.$inferInsert> = {}) =>
    (await db.insert(events).values({ calendarId, title: "Training", startsAt: new Date("2030-06-01T16:00:00.000Z"), createdBy: people.board!.userId, ...extra }).returning())[0]!;
  const preview = async (who: string, eventId: string) => {
    const res = await call(who, `/events/${eventId}/cancel-preview`);
    expect(res.status).toBe(200);
    return ((await res.json()) as Json).data as Json;
  };

  beforeAll(async () => {
    const labels = ["board", "plain", "m1", "m2", "teamer", "parent", "outsider"];
    for (const label of labels) {
      const s = await signUp(label);
      userIds.push(s.userId);
      people[label] = { ...s, accountId: "", clubMemberId: "" };
    }
    clubId = (await auth.api.createOrganization({ body: { name: `Cpv Club ${suffix}`, slug: `cpv-club-${suffix}`, userId: people.board!.userId } }))!.id;
    otherClubId = (await auth.api.createOrganization({ body: { name: `Cpv Other ${suffix}`, slug: `cpv-other-${suffix}`, userId: people.outsider!.userId } }))!.id;
    for (const label of ["plain", "m1", "m2", "teamer", "parent"]) await auth.api.addMember({ body: { userId: people[label]!.userId, organizationId: clubId, role: "member" } });
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    for (const label of ["board", "plain", "m1", "m2", "teamer", "parent"]) {
      const account = accounts.find((a) => a.userId === people[label]!.userId)!;
      people[label]!.accountId = account.id;
      people[label]!.clubMemberId = (await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, account.id)))[0]!.id;
    }
    await db.insert(clubRoles).values({ memberId: people.board!.accountId, roleType: "vorsitz" });
    const outsiderAccount = (await db.query.member.findFirst({ where: (m, { and: both, eq: same }) => both(same(m.organizationId, otherClubId), same(m.userId, people.outsider!.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: outsiderAccount.id, roleType: "vorsitz" });
    const [dept] = await db.insert(departments).values({ clubId, name: "Jugend" }).returning();
    await db.insert(clubMemberDepartments).values({ clubMemberId: people.teamer!.clubMemberId, departmentId: dept!.id });
    await db.insert(guardianLinks).values({ guardianMemberId: people.parent!.accountId, wardClubMemberId: people.teamer!.clubMemberId });
    generalCalendar = (await db.insert(calendars).values({ clubId, name: "Allgemein", createdBy: people.board!.userId }).returning())[0]!.id;
    teamCalendar = (await db.insert(calendars).values({ clubId, departmentId: dept!.id, name: "Jugend", createdBy: people.board!.userId }).returning())[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    await db.delete(organization).where(eq(organization.id, otherClubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("counts attendees and waitlist of a club-wide event, numbers only", async () => {
    const event = await newEvent(generalCalendar, { capacity: 1 });
    await db.insert(eventAttendees).values([
      { eventId: event.id, memberId: people.m1!.accountId, status: "angemeldet" },
      { eventId: event.id, memberId: people.m2!.accountId, status: "warteliste" },
    ]);
    const body = await preview("board", event.id);
    expect(body).toEqual({
      alreadyCancelled: false,
      confirmed: 1,
      waitlisted: 1,
      departmentCalendar: false,
      audience: { total: 2, reachable: 2, inApp: 2, email: 2, emailOnly: 0, unreachable: 0, sharedAddress: 0, tooLarge: false },
    });
    expect(JSON.stringify(body)).not.toContain("example.com");
  });

  it("a department calendar adds the department members and their guardians", async () => {
    const event = await newEvent(teamCalendar);
    await db.insert(eventAttendees).values({ eventId: event.id, memberId: people.m1!.accountId, status: "angemeldet" });
    const body = await preview("board", event.id);
    expect(body.departmentCalendar).toBe(true);
    expect(body.audience).toMatchObject({ total: 3, inApp: 3, email: 3 }); // m1 + the teamer + the teamer's parent
  });

  it("an event nobody signed up for has an empty audience; a cancelled event is flagged; the preview changes nothing", async () => {
    const empty = await newEvent(generalCalendar);
    expect((await preview("board", empty.id)).audience).toMatchObject({ total: 0, reachable: 0 });
    const cancelled = await newEvent(generalCalendar, { cancelledAt: new Date() });
    expect((await preview("board", cancelled.id)).alreadyCancelled).toBe(true);
    expect(await db.select().from(jobs).where(sql`${jobs.payload}->>'clubId' = ${clubId}`)).toHaveLength(0);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.subjectId, empty.id)))).toHaveLength(0);
  });

  it("needs calendars:write, is club-scoped and 404s for unknown ids", async () => {
    const event = await newEvent(generalCalendar);
    expect((await call("plain", `/events/${event.id}/cancel-preview`)).status).toBe(403);
    expect((await call("outsider", `/events/${event.id}/cancel-preview`, otherClubId)).status).toBe(404);
    expect((await call("board", `/events/${randomUUID()}/cancel-preview`)).status).toBe(404);
    expect((await app.request(`/events/${event.id}/cancel-preview?clubId=${clubId}`)).status).toBe(401);
  });
});
