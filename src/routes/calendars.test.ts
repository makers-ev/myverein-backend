import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { toAppError } from "../lib/errors.js";
import { calendarRoutes } from "./calendars.js";

/**
 * Integration test against a real Postgres (DATABASE_URL). Covers the
 * calendar visibility algorithm (src/lib/calendar-visibility.ts) and the
 * usual club-scoping IDOR case -- pattern copied from club-members.test.ts.
 */

const app = new Hono();
app.route("/calendars", calendarRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUpAndVerify(email: string, name: string) {
  const { user: created } = await auth.api.createUser({
    body: { email, password: "test-password-123!", name },
  });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  const cookie = signIn.headers.get("set-cookie") ?? "";
  return { userId: created.id, cookie: cookie.split(";")[0] };
}

describe("calendars visibility and scoping", () => {
  let clubAId: string;
  let clubBId: string;
  let cookieBoard: string; // vorsitz in club A -- calendars:write
  let cookiePlain: string; // plain member of club A, no roles
  let cookieGranted: string; // plain member of club A, granted member-specific visibility
  let cookieRoleHolder: string; // holds "trainer" club_roles in club A
  let cookieDeptLead: string; // holds "abteilungsleitung" club_roles scoped to a department in club A
  let cookieClubB: string;
  let memberPlainId: string;
  let memberGrantedId: string;
  let departmentId: string;
  let otherClubDepartmentId: string;
  let userIds: string[] = [];

  beforeAll(async () => {
    const board = await signUpAndVerify(`cal-board-${suffix}@example.com`, "Board Founder");
    const plain = await signUpAndVerify(`cal-plain-${suffix}@example.com`, "Plain Member");
    const granted = await signUpAndVerify(`cal-granted-${suffix}@example.com`, "Granted Member");
    const roleHolder = await signUpAndVerify(`cal-role-${suffix}@example.com`, "Trainer Member");
    const deptLead = await signUpAndVerify(`cal-dept-${suffix}@example.com`, "Dept Lead Member");
    const clubBFounder = await signUpAndVerify(`cal-clubb-${suffix}@example.com`, "Club B Founder");
    userIds = [board.userId, plain.userId, granted.userId, roleHolder.userId, deptLead.userId, clubBFounder.userId];

    cookieBoard = board.cookie;
    cookiePlain = plain.cookie;
    cookieGranted = granted.cookie;
    cookieRoleHolder = roleHolder.cookie;
    cookieDeptLead = deptLead.cookie;
    cookieClubB = clubBFounder.cookie;

    const clubA = await auth.api.createOrganization({ body: { name: `Cal Club A ${suffix}`, slug: `cal-club-a-${suffix}`, userId: board.userId } });
    const clubB = await auth.api.createOrganization({ body: { name: `Cal Club B ${suffix}`, slug: `cal-club-b-${suffix}`, userId: clubBFounder.userId } });
    clubAId = clubA!.id;
    clubBId = clubB!.id;

    await auth.api.addMember({ body: { userId: plain.userId, organizationId: clubAId, role: "member" } });
    await auth.api.addMember({ body: { userId: granted.userId, organizationId: clubAId, role: "member" } });
    await auth.api.addMember({ body: { userId: roleHolder.userId, organizationId: clubAId, role: "member" } });
    await auth.api.addMember({ body: { userId: deptLead.userId, organizationId: clubAId, role: "member" } });

    const boardMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, board.userId)) });
    const plainMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, plain.userId)) });
    const grantedMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, granted.userId)) });
    const roleHolderMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, roleHolder.userId)) });
    const deptLeadMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, deptLead.userId)) });
    memberPlainId = plainMember!.id;
    memberGrantedId = grantedMember!.id;

    await db.insert(clubRoles).values({ memberId: boardMember!.id, roleType: "vorsitz" });
    await db.insert(clubRoles).values({ memberId: roleHolderMember!.id, roleType: "trainer" });

    const [dept] = await db.insert(departments).values({ clubId: clubAId, name: `Fußball ${suffix}` }).returning();
    departmentId = dept.id;
    await db.insert(clubRoles).values({ memberId: deptLeadMember!.id, roleType: "abteilungsleitung", departmentId });

    const [deptB] = await db.insert(departments).values({ clubId: clubBId, name: `Other Club Dept ${suffix}` }).returning();
    otherClubDepartmentId = deptB.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubAId));
    await db.delete(organization).where(eq(organization.id, clubBId));
    for (const id of userIds) {
      await db.delete(user).where(eq(user.id, id));
    }
    await closeDatabase();
  });

  it("rejects calendar creation from a caller without calendars:write", async () => {
    const res = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookiePlain, "content-type": "application/json" },
      body: JSON.stringify({ name: "No Permission Calendar" }),
    });
    expect(res.status).toBe(403);
  });

  it("zero visibility rows means club-wide default visible to every member", async () => {
    const createRes = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Default Calendar" }),
    });
    expect(createRes.status).toBe(201);
    const { data: calendar } = (await createRes.json()) as { data: { id: string } };

    const listRes = await app.request(`/calendars?clubId=${clubAId}`, { headers: { cookie: cookiePlain } });
    const { data: list } = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(list.some((c) => c.id === calendar.id)).toBe(true);

    const getRes = await app.request(`/calendars/${calendar.id}?clubId=${clubAId}`, { headers: { cookie: cookiePlain } });
    expect(getRes.status).toBe(200);
  });

  it("member-specific grant: visible to the granted member, hidden from another plain member, and gone from their GET /calendars list", async () => {
    const createRes = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Member-Grant Calendar" }),
    });
    const { data: calendar } = (await createRes.json()) as { data: { id: string } };

    const grantRes = await app.request(`/calendars/${calendar.id}/visibility?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberGrantedId }),
    });
    expect(grantRes.status).toBe(201);

    const visibleRes = await app.request(`/calendars/${calendar.id}?clubId=${clubAId}`, { headers: { cookie: cookieGranted } });
    expect(visibleRes.status).toBe(200);

    const hiddenRes = await app.request(`/calendars/${calendar.id}?clubId=${clubAId}`, { headers: { cookie: cookiePlain } });
    expect(hiddenRes.status).toBe(404);

    const listRes = await app.request(`/calendars?clubId=${clubAId}`, { headers: { cookie: cookiePlain } });
    const { data: list } = (await listRes.json()) as { data: Array<{ id: string }> };
    expect(list.some((c) => c.id === calendar.id)).toBe(false);
  });

  it("role-based grant: visible to a caller holding the matching club_roles roleType", async () => {
    const createRes = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Role-Grant Calendar" }),
    });
    const { data: calendar } = (await createRes.json()) as { data: { id: string } };

    await app.request(`/calendars/${calendar.id}/visibility?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ roleType: "trainer" }),
    });

    const visibleRes = await app.request(`/calendars/${calendar.id}?clubId=${clubAId}`, { headers: { cookie: cookieRoleHolder } });
    expect(visibleRes.status).toBe(200);

    const hiddenRes = await app.request(`/calendars/${calendar.id}?clubId=${clubAId}`, { headers: { cookie: cookiePlain } });
    expect(hiddenRes.status).toBe(404);
  });

  it("department-based grant: visible to a caller holding a department-scoped club_roles row for that department", async () => {
    const createRes = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Department-Grant Calendar" }),
    });
    const { data: calendar } = (await createRes.json()) as { data: { id: string } };

    await app.request(`/calendars/${calendar.id}/visibility?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ departmentId }),
    });

    const visibleRes = await app.request(`/calendars/${calendar.id}?clubId=${clubAId}`, { headers: { cookie: cookieDeptLead } });
    expect(visibleRes.status).toBe(200);

    // Rule 4's documented limitation: a rank-and-file member with no
    // department-scoped club_roles row can never match it.
    const hiddenRes = await app.request(`/calendars/${calendar.id}?clubId=${clubAId}`, { headers: { cookie: cookiePlain } });
    expect(hiddenRes.status).toBe(404);
  });

  it("rejects a body with none or more than one of memberId/roleType/departmentId", async () => {
    const createRes = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Refine Test Calendar" }),
    });
    const { data: calendar } = (await createRes.json()) as { data: { id: string } };

    const emptyRes = await app.request(`/calendars/${calendar.id}/visibility?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(emptyRes.status).toBe(422);

    const bothRes = await app.request(`/calendars/${calendar.id}/visibility?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberPlainId, roleType: "trainer" }),
    });
    expect(bothRes.status).toBe(422);
  });

  it("a calendars:write caller sees ALL club calendars regardless of visibility grants", async () => {
    const res = await app.request(`/calendars?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    const { data: list } = (await res.json()) as { data: unknown[] };
    // At least the 5 calendars created across the tests above.
    expect(list.length).toBeGreaterThanOrEqual(5);
  });

  it("enforces exactly one default calendar per club on create", async () => {
    const first = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Default One", isDefault: true }),
    });
    const { data: firstCal } = (await first.json()) as { data: { id: string; isDefault: boolean } };
    expect(firstCal.isDefault).toBe(true);

    const second = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Default Two", isDefault: true }),
    });
    const { data: secondCal } = (await second.json()) as { data: { id: string; isDefault: boolean } };
    expect(secondCal.isDefault).toBe(true);

    const refetchFirst = await app.request(`/calendars/${firstCal.id}?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    const { data: refetched } = (await refetchFirst.json()) as { data: { isDefault: boolean } };
    expect(refetched.isDefault).toBe(false);
  });

  it("returns 404 (not another club's calendar) for cross-club IDOR", async () => {
    const createRes = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "IDOR Target Calendar" }),
    });
    const { data: calendar } = (await createRes.json()) as { data: { id: string } };

    const res = await app.request(`/calendars/${calendar.id}?clubId=${clubBId}`, { headers: { cookie: cookieClubB } });
    expect(res.status).toBe(404);
  });

  it("404s creating a calendar with a departmentId belonging to a different club", async () => {
    const res = await app.request(`/calendars?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ name: "Cross-club dept calendar", departmentId: otherClubDepartmentId }),
    });
    expect(res.status).toBe(404);
  });
});
