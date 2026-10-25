import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { jobs } from "../db/schema/jobs.js";
import { refillSeries } from "../lib/event-series-refill.js";
import { eventSeries } from "../db/schema/event-series.js";
import { eventSeriesExceptions } from "../db/schema/event-series-exceptions.js";
import { events } from "../db/schema/events.js";
import { toAppError } from "../lib/errors.js";
import { calendarRoutes } from "./calendars.js";
import { eventSeriesRoutes } from "./event-series.js";
import { eventRoutes } from "./events.js";

/** Integration test (real Postgres): series creation, DST-stable occurrences, the three edit/delete scopes, RSVP survival, parallel edits, IDOR. */

const app = new Hono();
app.route("/calendars", calendarRoutes);
app.route("/event-series", eventSeriesRoutes);
app.route("/events", eventRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUp(email: string, name: string) {
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("event series", () => {
  let clubA: string;
  let clubB: string;
  let board: string;
  let member: string;
  let outsider: string;
  let memberAccountId: string;
  let calendarId: string;
  const userIds: string[] = [];

  const call = (cookie: string, path: string, init: { method?: string; body?: unknown } = {}, club = clubA) =>
    app.request(`${path}${path.includes("?") ? "&" : "?"}clubId=${club}`, { method: init.method ?? "GET", headers: { cookie, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });

  const weekly = (startDate: string, extra: Record<string, unknown> = {}) => ({ calendarId, title: "Training", startDate, startTime: "18:00", durationMinutes: 90, freq: "weekly", ...extra });
  type Created = { data: { series: { id: string }; occurrencesCreated: number } };
  const create = async (body: Record<string, unknown>) => {
    const res = await call(board, "/event-series", { method: "POST", body });
    expect(res.status).toBe(201);
    return ((await res.json()) as Created).data;
  };
  const occurrences = (seriesId: string) => db.select().from(events).where(eq(events.seriesId, seriesId)).orderBy(asc(events.originalStartsAt));

  beforeAll(async () => {
    const b = await signUp(`ser-board-${suffix}@example.com`, "Series Board");
    const m = await signUp(`ser-member-${suffix}@example.com`, "Series Member");
    const o = await signUp(`ser-outsider-${suffix}@example.com`, "Series Outsider");
    userIds.push(b.userId, m.userId, o.userId);
    board = b.cookie;
    member = m.cookie;
    outsider = o.cookie;
    memberAccountId = m.userId;
    clubA = (await auth.api.createOrganization({ body: { name: `Series A ${suffix}`, slug: `series-a-${suffix}`, userId: b.userId } }))!.id;
    clubB = (await auth.api.createOrganization({ body: { name: `Series B ${suffix}`, slug: `series-b-${suffix}`, userId: o.userId } }))!.id;
    await auth.api.addMember({ body: { userId: m.userId, organizationId: clubA, role: "member" } });
    const boardMember = await db.query.member.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.organizationId, clubA), e(x.userId, b.userId)) });
    await db.insert(clubRoles).values({ memberId: boardMember!.id, roleType: "vorsitz" });
    const res = await call(board, "/calendars", { method: "POST", body: { name: "Serien" } });
    calendarId = ((await res.json()) as { data: { id: string } }).data.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubA));
    await db.delete(organization).where(eq(organization.id, clubB));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("creates occurrences for the horizon with a stable local time across daylight saving", async () => {
    const { series, occurrencesCreated } = await create(weekly("2031-03-17", { count: 4 }));
    expect(occurrencesCreated).toBe(4);
    const rows = await occurrences(series.id);
    expect(rows.map((r) => r.startsAt.toISOString())).toEqual(["2031-03-17T17:00:00.000Z", "2031-03-24T17:00:00.000Z", "2031-03-31T16:00:00.000Z", "2031-04-07T16:00:00.000Z"]);
    expect(rows[0]!.endsAt!.toISOString()).toBe("2031-03-17T18:30:00.000Z");
    expect(rows.every((r) => r.originalStartsAt?.getTime() === r.startsAt.getTime() && !r.isOverride)).toBe(true);
  });

  it("denies writing to plain members, hides foreign clubs and validates the rule", async () => {
    expect((await call(member, "/event-series", { method: "POST", body: weekly("2031-05-05") })).status).toBe(403);
    expect((await call(member, "/event-series/preview", { method: "POST", body: weekly("2031-05-05") })).status).toBe(403);
    const { series } = await create(weekly("2031-05-05", { count: 2 }));
    expect((await call(outsider, `/event-series/${series.id}`, {}, clubB)).status).toBe(404);
    expect((await call(outsider, `/event-series/${series.id}`, { method: "DELETE" }, clubB)).status).toBe(403);
    expect((await call(board, "/event-series", { method: "POST", body: weekly("2031-05-05", { interval: 0 }) })).status).toBe(422);
    expect((await call(board, "/event-series", { method: "POST", body: weekly("2031-05-05", { count: 3, untilDate: "2031-09-01" }) })).status).toBe(422);
    expect((await call(board, "/event-series", { method: "POST", body: { ...weekly("2031-05-05"), calendarId: "00000000-0000-4000-8000-000000000001" } })).status).toBe(404);
    expect((await call(member, `/event-series/${series.id}`)).status).toBe(200);
  });

  it("previews the next occurrences and the skipped holidays without storing anything", async () => {
    const before = await db.select().from(eventSeries).where(eq(eventSeries.calendarId, calendarId));
    const res = await call(board, "/event-series/preview?limit=3", { method: "POST", body: { ...weekly("2031-04-07"), skipHolidays: true } });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { occurrences: Array<{ localDate: string }>; skippedHolidays: Array<{ localDate: string; holiday: string }> } };
    expect(data.occurrences.map((o) => o.localDate)).toEqual(["2031-04-07", "2031-04-21", "2031-04-28"]);
    expect(data.skippedHolidays).toEqual([{ localDate: "2031-04-14", holiday: "Ostermontag" }]);
    expect((await db.select().from(eventSeries).where(eq(eventSeries.calendarId, calendarId))).length).toBe(before.length);
  });

  it("skips holidays and keeps them out when the horizon is extended", async () => {
    const { series } = await create(weekly("2031-04-07", { count: 4, skipHolidays: true }));
    const rows = await occurrences(series.id);
    expect(rows.map((r) => r.startsAt.toISOString().slice(0, 10))).toEqual(["2031-04-07", "2031-04-21", "2031-04-28"]);
    const ex = await db.select().from(eventSeriesExceptions).where(eq(eventSeriesExceptions.seriesId, series.id));
    expect(ex.map((e) => e.kind)).toEqual(["feiertag"]);
  });

  describe("scopes", () => {
    it("all: changes title and time of future occurrences IN PLACE (RSVPs survive), leaves overrides alone", async () => {
      const { series } = await create(weekly("2031-06-02", { count: 4, capacity: 5 }));
      const before = await occurrences(series.id);
      const memberRow = await db.query.member.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.organizationId, clubA), e(x.userId, memberAccountId)) });
      await db.insert(eventAttendees).values({ eventId: before[1]!.id, memberId: memberRow!.id, status: "angemeldet" });
      const solo = await call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "this", eventId: before[2]!.id, title: "Sonder", startsAt: "2031-06-18T10:00:00Z", endsAt: "2031-06-18T11:00:00Z" } });
      expect(solo.status).toBe(200);

      const res = await call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "all", title: "Neu", startTime: "19:30" } });
      expect(res.status).toBe(200);
      const after = await occurrences(series.id);
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      expect(after[0]!.title).toBe("Neu");
      expect(after[0]!.startsAt.toISOString()).toBe("2031-06-02T17:30:00.000Z");
      expect(after[1]!.originalStartsAt!.toISOString()).toBe("2031-06-09T17:30:00.000Z");
      expect(after[2]!.title).toBe("Sonder");
      expect(after[2]!.isOverride).toBe(true);
      expect(after[2]!.startsAt.toISOString()).toBe("2031-06-18T10:00:00.000Z");
      const rsvp = await db.query.eventAttendees.findFirst({ where: eq(eventAttendees.eventId, before[1]!.id) });
      expect(rsvp?.status).toBe("angemeldet");
      const exceptions = await db.select().from(eventSeriesExceptions).where(eq(eventSeriesExceptions.seriesId, series.id));
      expect(exceptions.map((e) => e.kind)).toEqual(["verschoben"]);
    });

    it("all with a rule change moves the rows along and removes surplus rows (cancelled when somebody signed up)", async () => {
      const { series } = await create(weekly("2031-07-07", { count: 4 }));
      const before = await occurrences(series.id);
      const memberRow = await db.query.member.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.organizationId, clubA), e(x.userId, memberAccountId)) });
      await db.insert(eventAttendees).values({ eventId: before[3]!.id, memberId: memberRow!.id, status: "angemeldet" });
      const res = await call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "all", count: 2, reason: "Ferien" } });
      const { data } = (await res.json()) as { data: { affected: { removed: number; cancelled: number } } };
      expect(data.affected).toMatchObject({ removed: 1, cancelled: 1 });
      const after = await occurrences(series.id);
      expect(after.map((r) => r.id)).toEqual([before[0]!.id, before[1]!.id, before[3]!.id]);
      expect(after[2]).toMatchObject({ cancelReason: "Ferien" });
      expect(after[2]!.cancelledAt).not.toBeNull();
    });

    it("this_and_following: splits the series, keeps ids and moves the following occurrences", async () => {
      const { series } = await create(weekly("2031-08-04", { count: 6 }));
      const before = await occurrences(series.id);
      const res = await call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "this_and_following", eventId: before[3]!.id, startTime: "20:00", title: "Spaet" } });
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { series: { id: string; count: number; splitFromSeriesId: string; startDate: string }; previousSeries: { untilDate: string; count: number | null } } };
      expect(data.previousSeries.untilDate).toBe("2031-08-24");
      expect(data.series).toMatchObject({ splitFromSeriesId: series.id, count: 3, startDate: "2031-08-25" });
      const oldRows = await occurrences(series.id);
      const newRows = await occurrences(data.series.id);
      expect(oldRows.map((r) => r.id)).toEqual(before.slice(0, 3).map((r) => r.id));
      expect(newRows.map((r) => r.id)).toEqual(before.slice(3).map((r) => r.id));
      expect(newRows[0]).toMatchObject({ title: "Spaet" });
      expect(newRows[0]!.startsAt.toISOString()).toBe("2031-08-25T18:00:00.000Z");
      expect(oldRows[0]!.title).toBe("Training");
    });

    it("rejects inconsistent scope input", async () => {
      const { series } = await create(weekly("2031-09-01", { count: 3 }));
      const rows = await occurrences(series.id);
      const patch = (body: Record<string, unknown>) => call(board, `/event-series/${series.id}`, { method: "PATCH", body });
      expect((await patch({ scope: "this", title: "x" })).status).toBe(422);
      expect((await patch({ scope: "this", eventId: rows[0]!.id, freq: "daily" })).status).toBe(422);
      expect((await patch({ scope: "all", startsAt: "2031-09-01T10:00:00Z" })).status).toBe(422);
      expect((await patch({ scope: "all" })).status).toBe(422);
      expect((await patch({ scope: "this", eventId: "00000000-0000-4000-8000-000000000001", title: "x" })).status).toBe(404);
      expect((await patch({ scope: "this", eventId: rows[0]!.id, startsAt: "2031-09-02T10:00:00Z", endsAt: "2031-09-02T09:00:00Z" })).status).toBe(422);
      expect((await call(member, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "all", title: "x" } })).status).toBe(403);
    });

    it("delete this: deletes a plain occurrence for good, cancels one with RSVPs", async () => {
      const { series } = await create(weekly("2031-10-06", { count: 3 }));
      const rows = await occurrences(series.id);
      const memberRow = await db.query.member.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.organizationId, clubA), e(x.userId, memberAccountId)) });
      await db.insert(eventAttendees).values({ eventId: rows[1]!.id, memberId: memberRow!.id, status: "angemeldet" });

      const plain = await call(board, `/event-series/${series.id}?scope=this&eventId=${rows[0]!.id}`, { method: "DELETE" });
      expect(((await plain.json()) as { data: { deleted: number } }).data.deleted).toBe(1);
      const used = await call(board, `/event-series/${series.id}?scope=this&eventId=${rows[1]!.id}&reason=Platz%20gesperrt`, { method: "DELETE" });
      expect(((await used.json()) as { data: { cancelled: number } }).data.cancelled).toBe(1);

      const left = await occurrences(series.id);
      expect(left.map((r) => r.id)).toEqual([rows[1]!.id, rows[2]!.id]);
      expect(left[0]).toMatchObject({ cancelReason: "Platz gesperrt" });
      const ex = await db.select().from(eventSeriesExceptions).where(eq(eventSeriesExceptions.seriesId, series.id));
      expect(ex.map((e) => e.kind)).toEqual(["entfaellt"]);
    });

    it("a plain DELETE /events/:id of an occurrence is remembered as dropped; a PATCH makes it an override", async () => {
      const { series } = await create(weekly("2031-11-03", { count: 3 }));
      const rows = await occurrences(series.id);
      const patched = await call(board, `/events/${rows[0]!.id}`, { method: "PATCH", body: { title: "Einzeln" } });
      expect(((await patched.json()) as { data: { isOverride: boolean } }).data.isOverride).toBe(true);
      expect((await call(board, `/events/${rows[1]!.id}`, { method: "DELETE" })).status).toBe(204);
      const ex = await db.select().from(eventSeriesExceptions).where(and(eq(eventSeriesExceptions.seriesId, series.id), eq(eventSeriesExceptions.kind, "entfaellt")));
      expect(ex).toHaveLength(1);
      expect((await call(board, `/events/${rows[0]!.id}`, { method: "PATCH", body: { calendarId: "00000000-0000-4000-8000-000000000001" } })).status).toBe(404);
    });

    it("delete all / this_and_following: removes the future, ends the series or deletes it when nothing stays", async () => {
      const { series } = await create(weekly("2031-12-01", { count: 5 }));
      const rows = await occurrences(series.id);
      const cut = await call(board, `/event-series/${series.id}?scope=this_and_following&eventId=${rows[2]!.id}`, { method: "DELETE" });
      expect(((await cut.json()) as { data: { deleted: number; seriesDeleted: boolean } }).data).toMatchObject({ deleted: 3, seriesDeleted: false });
      const shortened = await db.query.eventSeries.findFirst({ where: eq(eventSeries.id, series.id) });
      expect(shortened).toMatchObject({ untilDate: "2031-12-14", count: null });
      const all = await call(board, `/event-series/${series.id}?scope=all`, { method: "DELETE" });
      expect(((await all.json()) as { data: { seriesDeleted: boolean } }).data.seriesDeleted).toBe(true);
      expect(await db.query.eventSeries.findFirst({ where: eq(eventSeries.id, series.id) })).toBeUndefined();
      expect((await call(board, `/event-series/${series.id}`)).status).toBe(404);
    });
  });

  it("parallel edits of one series run one after the other without duplicate or lost occurrences", async () => {
    const { series } = await create(weekly("2032-01-05", { count: 6 }));
    const before = await occurrences(series.id);
    const responses = await Promise.all([
      call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "all", startTime: "17:00" } }),
      call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "all", title: "Parallel" } }),
      call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "all", startTime: "16:00" } }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const after = await occurrences(series.id);
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(new Set(after.map((r) => r.originalStartsAt!.getTime())).size).toBe(6);
    const stored = await db.query.eventSeries.findFirst({ where: eq(eventSeries.id, series.id) });
    expect(after.every((r) => r.title === stored!.title)).toBe(true);
  });

  describe("horizon refill and notifications", () => {
    it("the refill job tops the horizon up idempotently, also in parallel, and never recreates dropped days", async () => {
      const { series } = await create(weekly("2033-01-03"));
      const initial = await occurrences(series.id);
      expect(initial.length).toBeGreaterThanOrEqual(52);
      const dropped = initial[3]!;
      expect((await call(board, `/events/${dropped.id}`, { method: "DELETE" })).status).toBe(204);

      // Pretend the last run was long ago: the horizon shrinks to 3 months after the start, then two runs race.
      await db.delete(events).where(and(eq(events.seriesId, series.id), sql`${events.originalStartsAt} > '2033-04-04T00:00:00Z'`));
      await db.update(eventSeries).set({ horizonUntil: new Date("2033-04-04T00:00:00Z") }).where(eq(eventSeries.id, series.id));
      const target = new Date(initial.at(-1)!.startsAt.getTime() + 1000);
      const runs = await Promise.all([refillSeries({ clubId: clubA, target }), refillSeries({ clubId: clubA, target })]);
      expect(runs[0]!.series + runs[1]!.series).toBeGreaterThanOrEqual(1);
      const after = await occurrences(series.id);
      expect(new Set(after.map((r) => r.originalStartsAt!.getTime())).size).toBe(after.length);
      expect(after.map((r) => r.id)).not.toContain(dropped.id);
      expect(after.length).toBe(initial.length - 1);
      const again = await refillSeries({ clubId: clubA, target });
      expect(again.created).toBe(0);
    });

    it("reading a range beyond the horizon fills it without a worker", async () => {
      const { series } = await create(weekly("2034-01-03", { count: 80 }));
      const first = await occurrences(series.id);
      const lastBefore = first.at(-1)!.startsAt;
      const to = new Date(lastBefore.getTime() + 60 * 86_400_000);
      const res = await call(member, `/events?from=${lastBefore.toISOString()}&to=${to.toISOString()}`);
      expect(res.status).toBe(200);
      const after = await occurrences(series.id);
      expect(after.length).toBeGreaterThan(first.length);
    });

    it("moving or cancelling occurrences with sign-ups queues one notification each, notify:false none", async () => {
      const { series } = await create(weekly("2035-02-05", { count: 3 }));
      const rows = await occurrences(series.id);
      const memberRow = await db.query.member.findFirst({ where: (x, { and: a, eq: e }) => a(e(x.organizationId, clubA), e(x.userId, memberAccountId)) });
      await db.insert(eventAttendees).values([
        { eventId: rows[0]!.id, memberId: memberRow!.id, status: "angemeldet" },
        { eventId: rows[1]!.id, memberId: memberRow!.id, status: "angemeldet" },
      ]);
      const queued = async (eventId: string) => (await db.select().from(jobs).where(and(eq(jobs.type, "notify_event_changed"), sql`${jobs.payload}->>'refId' = ${eventId}`))).length;

      await call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "this", eventId: rows[0]!.id, startsAt: "2035-02-05T19:00:00Z", endsAt: "2035-02-05T20:00:00Z" } });
      expect(await queued(rows[0]!.id)).toBe(1);
      await call(board, `/event-series/${series.id}`, { method: "PATCH", body: { scope: "this", eventId: rows[1]!.id, startsAt: "2035-02-12T19:00:00Z", endsAt: "2035-02-12T20:00:00Z", notify: false } });
      expect(await queued(rows[1]!.id)).toBe(0);
      await call(board, `/event-series/${series.id}?scope=this&eventId=${rows[1]!.id}&reason=Halle`, { method: "DELETE" });
      expect(await queued(rows[1]!.id)).toBe(1);
    });
  });

  it("GET /event-series lists the visible series with upcoming counts", async () => {
    const res = await call(member, `/event-series?calendarId=${calendarId}`);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ calendarId: string; upcomingCount: number }> };
    expect(data.length).toBeGreaterThan(0);
    expect(data.every((s) => s.calendarId === calendarId)).toBe(true);
  });
});
