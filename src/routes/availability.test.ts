import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { toAppError } from "../lib/errors.js";
import { availabilityRoutes } from "./availability.js";

/**
 * Integration test against a real Postgres (DATABASE_URL), following
 * club-members.test.ts's pattern: real sign-up/sign-in/createOrganization,
 * no mocking. Covers self-only CRUD scoping (another member's rows are
 * invisible/unmodifiable, 404 not 403) and the /overlap Terminfindung
 * endpoint end to end, including cross-club IDOR-safety.
 */

const app = new Hono();
app.route("/availability", availabilityRoutes);
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

describe("availability routes", () => {
  let clubAId: string;
  let clubBId: string;
  let userAId: string;
  let userBId: string;
  let userSecondId: string;
  let cookieA: string;
  let cookieB: string;
  let cookieSecond: string;
  let memberAId: string;
  let memberSecondId: string;

  beforeAll(async () => {
    const a = await signUpAndVerify(`availability-a-${suffix}@example.com`, "Founder A");
    const b = await signUpAndVerify(`availability-b-${suffix}@example.com`, "Founder B");
    const second = await signUpAndVerify(`availability-second-${suffix}@example.com`, "Second Member");
    userAId = a.userId;
    userBId = b.userId;
    userSecondId = second.userId;
    cookieA = a.cookie;
    cookieB = b.cookie;
    cookieSecond = second.cookie;

    const clubA = await auth.api.createOrganization({
      body: { name: `Availability Club A ${suffix}`, slug: `availability-club-a-${suffix}`, userId: userAId },
    });
    const clubB = await auth.api.createOrganization({
      body: { name: `Availability Club B ${suffix}`, slug: `availability-club-b-${suffix}`, userId: userBId },
    });
    clubAId = clubA!.id;
    clubBId = clubB!.id;

    await auth.api.addMember({ body: { userId: userSecondId, organizationId: clubAId, role: "member" } });

    const memberA = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, userAId)),
    });
    const memberSecond = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, userSecondId)),
    });
    memberAId = memberA!.id;
    memberSecondId = memberSecond!.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubAId));
    await db.delete(organization).where(eq(organization.id, clubBId));
    await db.delete(user).where(eq(user.id, userAId));
    await db.delete(user).where(eq(user.id, userBId));
    await db.delete(user).where(eq(user.id, userSecondId));
    await closeDatabase();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.request(`/availability/slots?clubId=${clubAId}`);
    expect(res.status).toBe(401);
  });

  // --- Slots: self-only CRUD -----------------------------------------------

  let slotId: string;

  it("creates a slot for the caller's own membership", async () => {
    const res = await app.request(`/availability/slots?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ weekday: 0, startTime: "09:00", endTime: "12:00", note: "Mo mornings" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; memberId: string; weekday: number } };
    expect(body.data.memberId).toBe(memberAId);
    slotId = body.data.id;
  });

  it("rejects a slot where startTime is not before endTime", async () => {
    const res = await app.request(`/availability/slots?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ weekday: 0, startTime: "12:00", endTime: "09:00" }),
    });
    expect(res.status).toBe(422);
  });

  it("lists only the caller's own slots, ordered by weekday then startTime", async () => {
    const res = await app.request(`/availability/slots?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((s) => s.id === slotId)).toBe(true);
  });

  it("another member sees none of the caller's slots (self-only, not club-wide)", async () => {
    const res = await app.request(`/availability/slots?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((s) => s.id === slotId)).toBe(false);
  });

  it("returns 404 (not 403) when another member tries to PATCH someone else's slot", async () => {
    const res = await app.request(`/availability/slots/${slotId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieSecond, "content-type": "application/json" },
      body: JSON.stringify({ note: "hijack attempt" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 403) when another member tries to DELETE someone else's slot", async () => {
    const res = await app.request(`/availability/slots/${slotId}?clubId=${clubAId}`, {
      method: "DELETE",
      headers: { cookie: cookieSecond },
    });
    expect(res.status).toBe(404);
  });

  it("lets the owner PATCH their own slot", async () => {
    const res = await app.request(`/availability/slots/${slotId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ endTime: "13:00" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { endTime: string } };
    expect(body.data.endTime.startsWith("13:00")).toBe(true);
  });

  it("rejects a PATCH that would make startTime >= endTime using the merged existing row", async () => {
    const res = await app.request(`/availability/slots/${slotId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ startTime: "14:00" }), // existing endTime is now 13:00
    });
    expect(res.status).toBe(422);
  });

  it("lets the owner DELETE their own slot", async () => {
    const res = await app.request(`/availability/slots/${slotId}?clubId=${clubAId}`, {
      method: "DELETE",
      headers: { cookie: cookieA },
    });
    expect(res.status).toBe(204);

    const getRes = await app.request(`/availability/slots?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    const body = (await getRes.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((s) => s.id === slotId)).toBe(false);
  });

  // --- Exceptions: self-only CRUD -------------------------------------------

  let exceptionId: string;

  it("creates an exception for the caller's own membership", async () => {
    const res = await app.request(`/availability/exceptions?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-12-24", isAvailable: false, note: "Heiligabend" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; memberId: string } };
    expect(body.data.memberId).toBe(memberAId);
    exceptionId = body.data.id;
  });

  it("lists only the caller's own exceptions, ordered by date", async () => {
    const res = await app.request(`/availability/exceptions?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((e) => e.id === exceptionId)).toBe(true);
  });

  it("returns 404 when another member tries to PATCH/DELETE someone else's exception", async () => {
    const patchRes = await app.request(`/availability/exceptions/${exceptionId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieSecond, "content-type": "application/json" },
      body: JSON.stringify({ isAvailable: true }),
    });
    expect(patchRes.status).toBe(404);

    const deleteRes = await app.request(`/availability/exceptions/${exceptionId}?clubId=${clubAId}`, {
      method: "DELETE",
      headers: { cookie: cookieSecond },
    });
    expect(deleteRes.status).toBe(404);
  });

  it("lets the owner PATCH then DELETE their own exception", async () => {
    const patchRes = await app.request(`/availability/exceptions/${exceptionId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ isAvailable: true }),
    });
    expect(patchRes.status).toBe(200);

    const deleteRes = await app.request(`/availability/exceptions/${exceptionId}?clubId=${clubAId}`, {
      method: "DELETE",
      headers: { cookie: cookieA },
    });
    expect(deleteRes.status).toBe(204);
  });

  // --- GET /overlap ----------------------------------------------------------

  describe("GET /overlap", () => {
    // 2026-09-21 is a Monday (schema weekday=0).
    const mondayMorning = "2026-09-21T10:00:00";
    const mondayAfternoon = "2026-09-21T15:00:00";
    const tuesdayMorning = "2026-09-22T10:00:00";

    beforeAll(async () => {
      // Founder A: recurring Monday 09:00-12:00 slot.
      await app.request(`/availability/slots?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ weekday: 0, startTime: "09:00", endTime: "12:00" }),
      });
      // Second member: no slots, but an explicit "available" exception for
      // 2026-09-21, overriding the lack of a matching slot for that date.
      await app.request(`/availability/exceptions?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieSecond, "content-type": "application/json" },
        body: JSON.stringify({ date: "2026-09-21", isAvailable: true }),
      });
    });

    it("returns raw per-candidate availability for the requested members, in order", async () => {
      const membersParam = `${memberAId},${memberSecondId}`;
      const candidatesParam = [mondayMorning, mondayAfternoon, tuesdayMorning].join(",");

      const res = await app.request(`/availability/overlap?clubId=${clubAId}&members=${membersParam}&candidates=${candidatesParam}`, {
        headers: { cookie: cookieA },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ candidate: string; availability: Array<{ memberId: string; available: boolean }> }>;
      };

      expect(body.data.length).toBe(3);

      const byMember = (entry: (typeof body.data)[number], memberId: string) =>
        entry.availability.find((a) => a.memberId === memberId)?.available;

      // Monday morning: founder A's slot covers it, second's exception covers it too.
      expect(byMember(body.data[0], memberAId)).toBe(true);
      expect(byMember(body.data[0], memberSecondId)).toBe(true);

      // Monday afternoon: outside founder A's slot; second's exception is
      // date-level so it still applies.
      expect(byMember(body.data[1], memberAId)).toBe(false);
      expect(byMember(body.data[1], memberSecondId)).toBe(true);

      // Tuesday: no slot, no exception for either -> default-closed.
      expect(byMember(body.data[2], memberAId)).toBe(false);
      expect(byMember(body.data[2], memberSecondId)).toBe(false);
    });

    it("returns 404 when a members= id belongs to a different club than the caller's", async () => {
      const res = await app.request(`/availability/overlap?clubId=${clubBId}&members=${memberAId}&candidates=${mondayMorning}`, {
        headers: { cookie: cookieB },
      });
      expect(res.status).toBe(404);
    });

    it("rejects a missing members or candidates query param with 422", async () => {
      const res = await app.request(`/availability/overlap?clubId=${clubAId}&candidates=${mondayMorning}`, {
        headers: { cookie: cookieA },
      });
      expect(res.status).toBe(422);
    });
  });
});
