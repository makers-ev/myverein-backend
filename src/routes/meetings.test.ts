import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { meetingRoutes } from "./meetings.js";

/**
 * Integration test against a real Postgres (DATABASE_URL), following
 * club-members.test.ts's / availability.test.ts's pattern: real sign-up/
 * sign-in/createOrganization, no mocking. Covers permission gating
 * (meetings:write, granted via a directly-inserted club_roles row), cross-club
 * IDOR (404), the invitees self-service PATCH .../me deviation, the
 * meeting-scoped /overlap convenience endpoint, and the attendance batch
 * upsert's all-or-nothing validation.
 */

const app = new Hono();
app.route("/meetings", meetingRoutes);
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

describe("meetings routes", () => {
  let clubAId: string;
  let clubBId: string;
  let userAId: string;
  let userBId: string;
  let userSecondId: string;
  let cookieA: string;
  let cookieB: string;
  let cookieSecond: string;
  let memberAId: string;
  let memberBId: string;
  let memberSecondId: string;

  beforeAll(async () => {
    const a = await signUpAndVerify(`meetings-a-${suffix}@example.com`, "Founder A");
    const b = await signUpAndVerify(`meetings-b-${suffix}@example.com`, "Founder B");
    const second = await signUpAndVerify(`meetings-second-${suffix}@example.com`, "Second Member");
    userAId = a.userId;
    userBId = b.userId;
    userSecondId = second.userId;
    cookieA = a.cookie;
    cookieB = b.cookie;
    cookieSecond = second.cookie;

    const clubA = await auth.api.createOrganization({
      body: { name: `Meetings Club A ${suffix}`, slug: `meetings-club-a-${suffix}`, userId: userAId },
    });
    const clubB = await auth.api.createOrganization({
      body: { name: `Meetings Club B ${suffix}`, slug: `meetings-club-b-${suffix}`, userId: userBId },
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
    const memberB = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubBId), eq(m.userId, userBId)),
    });
    memberAId = memberA!.id;
    memberSecondId = memberSecond!.id;
    memberBId = memberB!.id;

    // Grants memberA meetings:write, so cookieA acts as the "board" caller
    // throughout; cookieSecond stays a plain member for 403 checks.
    await db.insert(clubRoles).values({ memberId: memberAId, roleType: "schriftfuehrer" });
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
    const res = await app.request(`/meetings?clubId=${clubAId}`);
    expect(res.status).toBe(401);
  });

  // --- Meeting CRUD ----------------------------------------------------------

  let meetingId: string;

  it("rejects POST / from a member without meetings:write", async () => {
    const res = await app.request(`/meetings?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieSecond, "content-type": "application/json" },
      body: JSON.stringify({ type: "vorstandssitzung", title: "Illegal meeting" }),
    });
    expect(res.status).toBe(403);
  });

  it("creates a meeting with meetings:write, defaulting status to terminfindung when scheduledAt is omitted", async () => {
    const res = await app.request(`/meetings?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ type: "vorstandssitzung", title: "Q3 Vorstandssitzung", agenda: "Budget" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; status: string } };
    expect(body.data.status).toBe("terminfindung");
    meetingId = body.data.id;
  });

  it("creates a scheduled meeting with status geplant when scheduledAt is given", async () => {
    const res = await app.request(`/meetings?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ type: "mitgliederversammlung", title: "MV 2026", scheduledAt: "2026-11-01T18:00:00Z" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("geplant");
  });

  it("lists the club's meetings", async () => {
    const res = await app.request(`/meetings?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((m) => m.id === meetingId)).toBe(true);
  });

  it("returns 404 (cross-club IDOR) for GET /:id under the wrong club", async () => {
    const res = await app.request(`/meetings/${meetingId}?clubId=${clubBId}`, { headers: { cookie: cookieB } });
    expect(res.status).toBe(404);
  });

  it("returns the meeting under its own club", async () => {
    const res = await app.request(`/meetings/${meetingId}?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(200);
  });

  it("rejects PATCH /:id from a member without meetings:write", async () => {
    const res = await app.request(`/meetings/${meetingId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieSecond, "content-type": "application/json" },
      body: JSON.stringify({ status: "abgehalten" }),
    });
    expect(res.status).toBe(403);
  });

  it("lets meetings:write update status/minutes freely, no state-machine enforcement", async () => {
    const res = await app.request(`/meetings/${meetingId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ status: "protokolliert", minutes: "Beschlossen: Budget +5%" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; minutes: string } };
    expect(body.data.status).toBe("protokolliert");
    expect(body.data.minutes).toBe("Beschlossen: Budget +5%");
  });

  // --- Invitees ----------------------------------------------------------------

  it("rejects POST /:id/invitees from a member without meetings:write", async () => {
    const res = await app.request(`/meetings/${meetingId}/invitees?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieSecond, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberSecondId }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 for an invitee memberId belonging to another club", async () => {
    const res = await app.request(`/meetings/${meetingId}/invitees?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberBId }),
    });
    expect(res.status).toBe(404);
  });

  it("invites a club member", async () => {
    const res = await app.request(`/meetings/${meetingId}/invitees?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberSecondId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { response: string; memberId: string } };
    expect(body.data.response).toBe("ausstehend");
    expect(body.data.memberId).toBe(memberSecondId);
  });

  it("rejects a duplicate invite with 409", async () => {
    const res = await app.request(`/meetings/${meetingId}/invitees?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberSecondId }),
    });
    expect(res.status).toBe(409);
  });

  it("lists invitees (any club member can read)", async () => {
    const res = await app.request(`/meetings/${meetingId}/invitees?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ memberId: string }> };
    expect(body.data.some((i) => i.memberId === memberSecondId)).toBe(true);
  });

  it("lets an invited member self-respond via PATCH /:id/invitees/me", async () => {
    const res = await app.request(`/meetings/${meetingId}/invitees/me?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieSecond, "content-type": "application/json" },
      body: JSON.stringify({ response: "zugesagt" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { response: string } };
    expect(body.data.response).toBe("zugesagt");
  });

  it("returns 404 from PATCH /:id/invitees/me for a member who was never invited", async () => {
    // cookieA's own membership (memberAId) was never added as an invitee.
    const res = await app.request(`/meetings/${meetingId}/invitees/me?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ response: "abgesagt" }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects DELETE /:id/invitees/:memberId from a member without meetings:write", async () => {
    const res = await app.request(`/meetings/${meetingId}/invitees/${memberSecondId}?clubId=${clubAId}`, {
      method: "DELETE",
      headers: { cookie: cookieSecond },
    });
    expect(res.status).toBe(403);
  });

  it("lets meetings:write remove an invitee", async () => {
    const res = await app.request(`/meetings/${meetingId}/invitees/${memberSecondId}?clubId=${clubAId}`, {
      method: "DELETE",
      headers: { cookie: cookieA },
    });
    expect(res.status).toBe(204);

    const listRes = await app.request(`/meetings/${meetingId}/invitees?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    const body = (await listRes.json()) as { data: Array<{ memberId: string }> };
    expect(body.data.some((i) => i.memberId === memberSecondId)).toBe(false);
  });

  // --- Overlap (Terminfindung convenience) --------------------------------------

  describe("GET /:id/overlap", () => {
    let overlapMeetingId: string;
    // 2026-09-21 is a Monday (schema weekday=0), same fixtures as availability.test.ts.
    const mondayMorning = "2026-09-21T10:00:00";
    const mondayAfternoon = "2026-09-21T15:00:00";
    const tuesdayMorning = "2026-09-22T10:00:00";

    beforeAll(async () => {
      const res = await app.request(`/meetings?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ type: "vorstandssitzung", title: "Overlap test meeting" }),
      });
      const body = (await res.json()) as { data: { id: string } };
      overlapMeetingId = body.data.id;

      await app.request(`/meetings/${overlapMeetingId}/invitees?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ memberId: memberAId }),
      });
      await app.request(`/meetings/${overlapMeetingId}/invitees?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ memberId: memberSecondId }),
      });

      // memberA: recurring Monday 09:00-12:00 slot.
      await db.insert(availabilitySlots).values({ memberId: memberAId, weekday: 0, startTime: "09:00", endTime: "12:00" });
      // memberSecond: no slots, but an explicit "available" exception for 2026-09-21.
      await db.insert(availabilityExceptions).values({ memberId: memberSecondId, date: "2026-09-21", isAvailable: true });
    });

    it("computes per-candidate availability for the meeting's own invitees, any club member can call it", async () => {
      const candidatesParam = [mondayMorning, mondayAfternoon, tuesdayMorning].join(",");
      const res = await app.request(`/meetings/${overlapMeetingId}/overlap?clubId=${clubAId}&candidates=${candidatesParam}`, {
        headers: { cookie: cookieSecond },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ candidate: string; availability: Array<{ memberId: string; available: boolean }> }>;
      };
      expect(body.data.length).toBe(3);

      const byMember = (entry: (typeof body.data)[number], memberId: string) =>
        entry.availability.find((a) => a.memberId === memberId)?.available;

      expect(byMember(body.data[0], memberAId)).toBe(true);
      expect(byMember(body.data[0], memberSecondId)).toBe(true);

      expect(byMember(body.data[1], memberAId)).toBe(false);
      expect(byMember(body.data[1], memberSecondId)).toBe(true);

      expect(byMember(body.data[2], memberAId)).toBe(false);
      expect(byMember(body.data[2], memberSecondId)).toBe(false);
    });

    it("rejects a missing candidates query param with 422", async () => {
      const res = await app.request(`/meetings/${overlapMeetingId}/overlap?clubId=${clubAId}`, { headers: { cookie: cookieA } });
      expect(res.status).toBe(422);
    });
  });

  // --- Attendance ----------------------------------------------------------------

  describe("PATCH /:id/attendance", () => {
    it("rejects a batch from a member without meetings:write", async () => {
      const res = await app.request(`/meetings/${meetingId}/attendance?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieSecond, "content-type": "application/json" },
        body: JSON.stringify([{ memberId: memberAId, present: true }]),
      });
      expect(res.status).toBe(403);
    });

    it("inserts attendance rows on the first batch call", async () => {
      const res = await app.request(`/meetings/${meetingId}/attendance?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify([
          { memberId: memberAId, present: true },
          { memberId: memberSecondId, present: false, hasVotingRight: false },
        ]),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ memberId: string; present: boolean; hasVotingRight: boolean }> };
      const a = body.data.find((r) => r.memberId === memberAId)!;
      const second = body.data.find((r) => r.memberId === memberSecondId)!;
      expect(a.present).toBe(true);
      expect(a.hasVotingRight).toBe(true); // defaulted, omitted on insert
      expect(second.present).toBe(false);
      expect(second.hasVotingRight).toBe(false);
    });

    it("updates existing attendance rows on a second batch call (upsert, not duplicate rows)", async () => {
      const res = await app.request(`/meetings/${meetingId}/attendance?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify([
          { memberId: memberAId, present: false },
          { memberId: memberSecondId, present: true, hasVotingRight: true, proxyForMemberId: memberAId },
        ]),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ memberId: string; present: boolean; hasVotingRight: boolean; proxyForMemberId: string | null }>;
      };
      expect(body.data.length).toBe(2);
      const a = body.data.find((r) => r.memberId === memberAId)!;
      const second = body.data.find((r) => r.memberId === memberSecondId)!;
      expect(a.present).toBe(false);
      expect(second.present).toBe(true);
      expect(second.hasVotingRight).toBe(true);
      expect(second.proxyForMemberId).toBe(memberAId);
    });

    it("rejects the whole batch (no partial write) when one entry references another club's member", async () => {
      const res = await app.request(`/meetings/${meetingId}/attendance?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify([
          { memberId: memberAId, present: true }, // would flip from false -> true if applied
          { memberId: memberBId, present: true }, // invalid: belongs to club B
        ]),
      });
      expect(res.status).toBe(404);

      const getRes = await app.request(`/meetings/${meetingId}/attendance?clubId=${clubAId}`, { headers: { cookie: cookieA } });
      const body = (await getRes.json()) as { data: Array<{ memberId: string; present: boolean }> };
      const a = body.data.find((r) => r.memberId === memberAId)!;
      // Still false from the previous (second) batch call -- the bad entry
      // must not have let memberA's row be updated either.
      expect(a.present).toBe(false);
    });
  });

  // --- Resolutions ---------------------------------------------------------------

  describe("resolutions", () => {
    it("rejects POST /:id/resolutions from a member without meetings:write", async () => {
      const res = await app.request(`/meetings/${meetingId}/resolutions?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieSecond, "content-type": "application/json" },
        body: JSON.stringify({ description: "Illegal", votesFor: 1, votesAgainst: 0, votesAbstain: 0, result: "angenommen" }),
      });
      expect(res.status).toBe(403);
    });

    it("creates a resolution with meetings:write and lists it", async () => {
      const res = await app.request(`/meetings/${meetingId}/resolutions?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ description: "Erhoehung Mitgliedsbeitrag", votesFor: 8, votesAgainst: 2, votesAbstain: 1, result: "angenommen" }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: { id: string; result: string } };
      expect(body.data.result).toBe("angenommen");

      const listRes = await app.request(`/meetings/${meetingId}/resolutions?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
      expect(listBody.data.some((r) => r.id === body.data.id)).toBe(true);
    });
  });

  // --- Delete ----------------------------------------------------------------

  describe("DELETE /:id", () => {
    let deleteMeetingId: string;

    beforeAll(async () => {
      const res = await app.request(`/meetings?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ type: "ausschusssitzung", title: "To be deleted" }),
      });
      const body = (await res.json()) as { data: { id: string } };
      deleteMeetingId = body.data.id;
    });

    it("rejects DELETE from a member without meetings:write", async () => {
      const res = await app.request(`/meetings/${deleteMeetingId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieSecond },
      });
      expect(res.status).toBe(403);
    });

    it("deletes with meetings:write", async () => {
      const res = await app.request(`/meetings/${deleteMeetingId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieA },
      });
      expect(res.status).toBe(204);

      const getRes = await app.request(`/meetings/${deleteMeetingId}?clubId=${clubAId}`, { headers: { cookie: cookieA } });
      expect(getRes.status).toBe(404);
    });
  });
});
