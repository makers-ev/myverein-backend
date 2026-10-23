import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { emptyAssemblyRules } from "../lib/assembly-rules.js";
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

// The in-memory rate limiter keys on x-forwarded-for; give every request its own bucket.
const realRequest = app.request.bind(app);
app.request = ((input: Parameters<typeof realRequest>[0], init?: RequestInit) =>
  realRequest(input, { ...init, headers: { "x-forwarded-for": randomUUID(), ...(init?.headers as Record<string, string> | undefined) } })) as typeof app.request;

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
    // Statute parameters (Wave 11): the voting right and proxies are derived from them.
    const rules = { ...emptyAssemblyRules(), votingStatuses: ["aktiv" as const], votingMinAge: 0, proxyAllowed: true, maxProxiesPerPerson: 2 };
    await db.insert(clubSettings).values({ clubId: clubAId, assemblyRules: rules }).onConflictDoUpdate({ target: clubSettings.clubId, set: { assemblyRules: rules } });
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

    it("rejects vote counts above 100000 or below 0 (422)", async () => {
      for (const votes of [{ votesFor: 100001, votesAgainst: 0, votesAbstain: 0 }, { votesFor: 0, votesAgainst: 100001, votesAbstain: 0 }, { votesFor: 0, votesAgainst: 0, votesAbstain: -1 }]) {
        const res = await app.request(`/meetings/${meetingId}/resolutions?clubId=${clubAId}`, {
          method: "POST",
          headers: { cookie: cookieA, "content-type": "application/json" },
          body: JSON.stringify({ description: "Zu viele Stimmen", result: "angenommen", ...votes }),
        });
        expect(res.status).toBe(422);
      }
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

      const listRes = await app.request(`/meetings/${meetingId}/resolutions?clubId=${clubAId}`, { headers: { cookie: cookieA } });
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
      expect(listBody.data.some((r) => r.id === body.data.id)).toBe(true);
    });
  });

  // --- Type validation (B8/B17) -------------------------------------------------

  it("rejects a free-text meeting type with 422 (controlled values only)", async () => {
    const res = await app.request(`/meetings?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ type: "ausschusssitzung", title: "Free text type" }),
    });
    expect(res.status).toBe(422);
  });

  // --- Read scoping (B8) ----------------------------------------------------------

  describe("read scoping of Vorstandssitzungen", () => {
    let mvId: string;
    let sonstigeId: string;
    let boardOnlyId: string;

    async function post(path: string, cookie: string, method: string, body?: unknown) {
      return app.request(`/meetings${path}?clubId=${clubAId}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }

    beforeAll(async () => {
      const mv = await post("", cookieA, "POST", { type: "mitgliederversammlung", title: "Scoping MV" });
      mvId = ((await mv.json()) as { data: { id: string } }).data.id;
      const other = await post("", cookieA, "POST", { type: "sonstige", title: "Scoping Sonstige" });
      sonstigeId = ((await other.json()) as { data: { id: string } }).data.id;
      const board = await post("", cookieA, "POST", { type: "vorstandssitzung", title: "Scoping Vorstand (nobody invited)" });
      boardOnlyId = ((await board.json()) as { data: { id: string } }).data.id;
    });

    it("hides a Vorstandssitzung from a plain member with 404 on detail and every sub-resource", async () => {
      for (const path of ["", "/invitees", "/attendance", "/resolutions", "/overlap?candidates=2026-11-02T18:00:00Z"]) {
        const sep = path.includes("?") ? "&" : "?";
        const res = await app.request(`/meetings/${boardOnlyId}${path}${sep}clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
        expect(res.status, path).toBe(404);
      }
      const rsvp = await post(`/${boardOnlyId}/invitees/me`, cookieSecond, "PATCH", { response: "zugesagt" });
      expect(rsvp.status).toBe(404);
    });

    it("filters the list: plain member sees Mitgliederversammlung + sonstige but no Vorstandssitzung", async () => {
      const res = await app.request(`/meetings?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as { data: Array<{ id: string; type: string }> }).data;
      expect(ids.some((m) => m.id === mvId)).toBe(true);
      expect(ids.some((m) => m.id === sonstigeId)).toBe(true);
      expect(ids.some((m) => m.id === boardOnlyId)).toBe(false);
    });

    it("lets a plain member read a Mitgliederversammlung incl. attendance/resolutions", async () => {
      for (const path of ["", "/attendance", "/resolutions", "/invitees"]) {
        const res = await app.request(`/meetings/${mvId}${path}?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
        expect(res.status, path).toBe(200);
      }
    });

    it("shows the meeting writer everything and an invited member their invited Vorstandssitzung", async () => {
      const writerList = await app.request(`/meetings?clubId=${clubAId}`, { headers: { cookie: cookieA } });
      const writerIds = ((await writerList.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
      expect(writerIds).toContain(boardOnlyId);

      const invite = await post(`/${boardOnlyId}/invitees`, cookieA, "POST", { memberId: memberSecondId });
      expect(invite.status).toBe(201);

      const detail = await app.request(`/meetings/${boardOnlyId}?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
      expect(detail.status).toBe(200);
      const list = await app.request(`/meetings?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
      expect(((await list.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toContain(boardOnlyId);
      const rsvp = await post(`/${boardOnlyId}/invitees/me`, cookieSecond, "PATCH", { response: "zugesagt" });
      expect(rsvp.status).toBe(200);

      const removed = await app.request(`/meetings/${boardOnlyId}/invitees/${memberSecondId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieA },
      });
      expect(removed.status).toBe(204);
      const again = await app.request(`/meetings/${boardOnlyId}?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
      expect(again.status).toBe(404);
    });

    it("lets meetings:read_board (beisitzer) read Vorstandssitzungen without writing", async () => {
      await db.insert(clubRoles).values({ memberId: memberSecondId, roleType: "beisitzer" });
      try {
        const detail = await app.request(`/meetings/${boardOnlyId}?clubId=${clubAId}`, { headers: { cookie: cookieSecond } });
        expect(detail.status).toBe(200);
        const res = await post(`/${boardOnlyId}`, cookieSecond, "PATCH", { title: "nope" });
        expect(res.status).toBe(403);
      } finally {
        await db.delete(clubRoles).where(eq(clubRoles.memberId, memberSecondId));
      }
    });

    it("does not leak a meeting of another club (404)", async () => {
      const res = await app.request(`/meetings/${boardOnlyId}?clubId=${clubBId}`, { headers: { cookie: cookieB } });
      expect(res.status).toBe(404);
    });
  });

  // --- Attendance: partial update + proxy (B17) ---------------------------------------

  describe("attendance partial updates and proxies", () => {
    let attMeetingId: string;
    const att = (body: unknown, cookie = cookieA) =>
      app.request(`/meetings/${attMeetingId}/attendance?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const load = async () =>
      ((await (await app.request(`/meetings/${attMeetingId}/attendance?clubId=${clubAId}`, { headers: { cookie: cookieA } })).json()) as {
        data: Array<{ memberId: string; present: boolean; hasVotingRight: boolean; proxyForMemberId: string | null }>;
      }).data;

    beforeAll(async () => {
      const res = await app.request(`/meetings?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ type: "mitgliederversammlung", title: "Attendance partial" }),
      });
      attMeetingId = ((await res.json()) as { data: { id: string } }).data.id;
    });

    it("returns stored attendance on GET and only touches the members/fields that are sent", async () => {
      expect((await att([{ memberId: memberAId, present: true, hasVotingRight: false }, { memberId: memberSecondId, present: true }])).status).toBe(200);
      // Re-save only one member, only the present flag: the other member and the voting right stay untouched.
      expect((await att([{ memberId: memberSecondId, present: false }])).status).toBe(200);

      const rows = await load();
      const a = rows.find((r) => r.memberId === memberAId)!;
      const second = rows.find((r) => r.memberId === memberSecondId)!;
      expect(a).toMatchObject({ present: true, hasVotingRight: false });
      expect(second).toMatchObject({ present: false, hasVotingRight: true });
    });

    it("keeps an existing proxy when it is omitted, sets it, and clears it with null", async () => {
      expect((await att([{ memberId: memberAId, proxyForMemberId: memberSecondId }])).status).toBe(200);
      expect((await load()).find((r) => r.memberId === memberAId)).toMatchObject({ present: true, proxyForMemberId: memberSecondId });

      expect((await att([{ memberId: memberAId, present: true }])).status).toBe(200);
      expect((await load()).find((r) => r.memberId === memberAId)!.proxyForMemberId).toBe(memberSecondId);

      expect((await att([{ memberId: memberAId, proxyForMemberId: null }])).status).toBe(200);
      expect((await load()).find((r) => r.memberId === memberAId)!.proxyForMemberId).toBeNull();
    });

    it("rejects a self-proxy (422), a proxy from another club (404) and non-writers (403)", async () => {
      expect((await att([{ memberId: memberAId, proxyForMemberId: memberAId }])).status).toBe(422);
      expect((await att([{ memberId: memberAId, proxyForMemberId: memberBId }])).status).toBe(404);
      expect((await att([{ memberId: memberAId, present: true }], cookieSecond)).status).toBe(403);
    });
  });

  // --- Resolution correction (B17) -------------------------------------------------------

  describe("PATCH /:id/resolutions/:rid", () => {
    let resId: string;
    const patchRes = (body: unknown, cookie = cookieA, rid = resId) =>
      app.request(`/meetings/${meetingId}/resolutions/${rid}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    beforeAll(async () => {
      const res = await app.request(`/meetings/${meetingId}/resolutions?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ description: "Satzungsaenderung", votesFor: 5, votesAgainst: 3, votesAbstain: 0, result: "abgelehnt" }),
      });
      resId = ((await res.json()) as { data: { id: string } }).data.id;
    });

    it("requires meetings:write (403), a correction note and at least one changed field (422)", async () => {
      expect((await patchRes({ result: "angenommen", correctionNote: "Zaehlfehler" }, cookieSecond)).status).toBe(403);
      expect((await patchRes({ result: "angenommen" })).status).toBe(422);
      expect((await patchRes({ correctionNote: "nur Vermerk" })).status).toBe(422);
      expect((await patchRes({ result: "angenommen", correctionNote: "Zaehlfehler" }, cookieA, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    });

    it("rejects vote counts above 100000 in a correction (422)", async () => {
      expect((await patchRes({ votesAbstain: 100001, correctionNote: "Tippfehler" })).status).toBe(422);
      expect((await patchRes({ votesFor: 100000, correctionNote: "Grenzwert" })).status).toBe(200);
      expect((await patchRes({ votesFor: 5, correctionNote: "Zurueck" })).status).toBe(200);
    });

    it("corrects the resolution, stamps the Berichtigungsvermerk and audits the previous values", async () => {
      const res = await patchRes({ votesFor: 6, votesAgainst: 2, result: "angenommen", correctionNote: "Zaehlfehler im Protokoll" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { votesFor: number; result: string; correctionNote: string; correctedAt: string; correctedBy: string; description: string };
      };
      expect(body.data).toMatchObject({ votesFor: 6, result: "angenommen", correctionNote: "Zaehlfehler im Protokoll", correctedBy: userAId });
      expect(body.data.description).toBe("Satzungsaenderung");
      expect(body.data.correctedAt).toBeTruthy();

      const audit = await db.query.auditLog.findFirst({ where: (a, { and, eq }) => and(eq(a.eventType, "meeting_resolution.correct"), eq(a.subjectId, resId)) });
      const payload = audit!.payload as Record<string, unknown> & { changedFields: string[] };
      expect(payload.changedFields).toEqual(expect.arrayContaining(["votesFor"]));
      expect(JSON.stringify(payload)).not.toContain("Zaehlfehler");
      expect(payload).not.toHaveProperty("before");
    });
  });

  // --- scheduledAt via PATCH ---------------------------------------------------------------

  it("lets meetings:write change scheduledAt via PATCH and rejects a plain member", async () => {
    const res = await app.request(`/meetings/${meetingId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieA, "content-type": "application/json" },
      body: JSON.stringify({ scheduledAt: "2027-01-15T19:00:00Z" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { scheduledAt: string } }).data.scheduledAt).toBe("2027-01-15T19:00:00.000Z");
    const denied = await app.request(`/meetings/${meetingId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieSecond, "content-type": "application/json" },
      body: JSON.stringify({ scheduledAt: "2027-01-16T19:00:00Z" }),
    });
    expect(denied.status).toBe(403);
  });

  // --- Delete ----------------------------------------------------------------

  describe("DELETE /:id", () => {
    let deleteMeetingId: string;

    beforeAll(async () => {
      const res = await app.request(`/meetings?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieA, "content-type": "application/json" },
        body: JSON.stringify({ type: "sonstige", title: "To be deleted" }),
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
  describe("members without an account (Wave 11 B2)", () => {
    let meetingIdLocal: string;
    let guestlessId: string;
    const req = (cookie: string, path: string, init: { method?: string; body?: object } = {}) =>
      app.request(`${path}?clubId=${clubAId}`, { method: init.method ?? "GET", headers: { cookie, "content-type": "application/json" }, body: init.body ? JSON.stringify(init.body) : undefined });

    beforeAll(async () => {
      const category = await db.query.memberCategories.findFirst({ where: (cat, { and: a, eq: e }) => a(e(cat.clubId, clubAId), e(cat.key, "aktiv")) });
      const [row] = await db.insert(clubMembers).values({ clubId: clubAId, displayName: "Kind Ohne Konto", categoryId: category!.id, joinedAt: "2020-01-01" }).returning();
      guestlessId = row!.id;
      const res = await req(cookieA, "/meetings", { method: "POST", body: { type: "vorstandssitzung", title: "Ohne Konto" } });
      meetingIdLocal = ((await res.json()) as { data: { id: string } }).data.id;
    });

    it("invites a member without account by club member id, shows the name only to meeting managers", async () => {
      const res = await req(cookieA, `/meetings/${meetingIdLocal}/invitees`, { method: "POST", body: { clubMemberId: guestlessId, notify: false } });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { data: Record<string, unknown> }).data).toMatchObject({ clubMemberId: guestlessId, memberId: null, displayName: "Kind Ohne Konto", response: "ausstehend" });
      const duplicate = await req(cookieA, `/meetings/${meetingIdLocal}/invitees`, { method: "POST", body: { clubMemberId: guestlessId } });
      expect(duplicate.status).toBe(409);
      // The second account is a plain member and not invited to this board meeting: 404, not 403.
      expect((await req(cookieSecond, `/meetings/${meetingIdLocal}/invitees`)).status).toBe(404);
    });

    it("still accepts the account membership id as an alias and rejects other clubs", async () => {
      const alias = await req(cookieA, `/meetings/${meetingIdLocal}/invitees`, { method: "POST", body: { memberId: memberSecondId, notify: false } });
      expect(alias.status).toBe(201);
      const aliasBody = ((await alias.json()) as { data: Record<string, unknown> }).data;
      expect(aliasBody).toMatchObject({ memberId: memberSecondId });
      // Now invited: the member reads the invitee list but without names.
      const list = ((await (await req(cookieSecond, `/meetings/${meetingIdLocal}/invitees`)).json()) as { data: Array<Record<string, unknown>> }).data;
      expect(list).toHaveLength(2);
      expect(list.every((i) => !("displayName" in i))).toBe(true);
      const foreign = await req(cookieA, `/meetings/${meetingIdLocal}/invitees`, { method: "POST", body: { memberId: memberBId } });
      expect(foreign.status).toBe(404);
    });

    it("removes an invitee by club member id", async () => {
      expect((await req(cookieA, `/meetings/${meetingIdLocal}/invitees/${guestlessId}`, { method: "DELETE" })).status).toBe(204);
      expect((await req(cookieA, `/meetings/${meetingIdLocal}/invitees/${guestlessId}`, { method: "DELETE" })).status).toBe(404);
    });

    it("records attendance for a member without account and exposes proxies as a list", async () => {
      const res = await req(cookieA, `/meetings/${meetingIdLocal}/attendance`, { method: "PATCH", body: [{ clubMemberId: guestlessId, present: true }, { memberId: memberSecondId, present: true }] });
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
      expect(rows.find((r) => r.clubMemberId === guestlessId)).toMatchObject({ present: true, memberId: null, proxyFor: [], checkInMethod: "schriftfuehrer", hasVotingRight: true });
      expect(rows.find((r) => r.clubMemberId === guestlessId)!.checkedInAt).toBeTruthy();
      // Somebody who is present cannot give a proxy; once they left, the clerk can record it for them.
      const blocked = await req(cookieA, `/meetings/${meetingIdLocal}/attendance`, { method: "PATCH", body: [{ memberId: memberSecondId, proxyForClubMemberId: guestlessId }] });
      expect(blocked.status).toBe(409);
      expect(((await blocked.json()) as { error: { details: { code: string } } }).error.details.code).toBe("grantor_present");
      const left = await req(cookieA, `/meetings/${meetingIdLocal}/attendance`, { method: "PATCH", body: [{ clubMemberId: guestlessId, present: false }, { memberId: memberSecondId, proxyForClubMemberId: guestlessId }] });
      expect(left.status).toBe(200);
      const after = ((await left.json()) as { data: Array<Record<string, unknown>> }).data;
      expect(after.find((r) => r.clubMemberId === guestlessId)).toMatchObject({ present: false, proxyFor: [] });
      expect(after.find((r) => r.clubMemberId === guestlessId)!.leftAt).toBeTruthy();
      expect(after.find((r) => r.memberId === memberSecondId)).toMatchObject({ proxyFor: [guestlessId] });
      // Whoever gave a proxy cannot be checked in without withdrawing it.
      const again = await req(cookieA, `/meetings/${meetingIdLocal}/attendance`, { method: "PATCH", body: [{ clubMemberId: guestlessId, present: true }] });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: { details: { code: string } } }).error.details.code).toBe("proxy_granted");
    });
  });
});
