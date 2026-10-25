import { zValidator } from "@hono/zod-validator";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { eventSeries, type EventSeriesRow } from "../db/schema/event-series.js";
import { events } from "../db/schema/events.js";
import { locations } from "../db/schema/locations.js";
import { writeAudit } from "../lib/audit.js";
import { getVisibleCalendarIds, isCalendarVisible } from "../lib/calendar-visibility.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { loadClubSettings } from "../lib/club-settings.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { assertValidRule, createSeries, editAll, editedSeries, editOccurrence, editThisAndFollowing, initialHorizon, lockSeries, removeScoped, ruleOf, type OccurrenceEdit, type SeriesEdit, type SeriesEditResult } from "../lib/event-series.js";
import { expandSeries, RULE_FREQUENCIES, RULE_WEEKDAYS } from "../lib/recurrence.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Event series (Wave 12 B5, ADR-009): a rule plus a template; every occurrence is a row in `events`. Reading follows the
 * calendar visibility, writing needs `calendars:write` (club scope, like events). Edit and delete take a scope:
 * `this` (one occurrence becomes an override), `this_and_following` (the series is split) or `all` (future, not overridden occurrences).
 */
export const eventSeriesRoutes = new Hono<ClubEnv>();

eventSeriesRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
eventSeriesRoutes.use("*", sessionGuard);
eventSeriesRoutes.use("*", clubGuard);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be YYYY-MM-DD" });
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "must be HH:MM" });

const templateShape = {
  title: z.string().trim().min(1).max(300),
  description: z.string().nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  capacity: z.number().int().positive().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
  allDay: z.boolean().optional(),
  startTime: timeStr.optional(),
  durationMinutes: z.number().int().min(0).max(60 * 24 * 14).nullable().optional(),
  durationDays: z.number().int().min(1).max(366).optional(),
};

const ruleShape = {
  freq: z.enum(RULE_FREQUENCIES),
  interval: z.number().int().min(1).max(99).optional(),
  byDay: z.array(z.enum(RULE_WEEKDAYS)).max(7).nullable().optional(),
  bySetPos: z.number().int().nullable().optional(),
  untilDate: dateStr.nullable().optional(),
  count: z.number().int().min(1).max(1000).nullable().optional(),
  skipHolidays: z.boolean().optional(),
};

const createSchema = z.object({ calendarId: z.string().uuid(), ...templateShape, startDate: dateStr, ...ruleShape });
const previewSchema = createSchema.extend({ calendarId: z.string().uuid().optional() });

const SCOPES = ["this", "this_and_following", "all"] as const;
const scopeSchema = z.enum(SCOPES);

const patchSchema = z.object({ ...templateShape, ...ruleShape }).partial().extend({
  scope: scopeSchema,
  /** The occurrence the edit starts from (required for `this` and `this_and_following`). */
  eventId: z.string().uuid().optional(),
  /** Reason shown for occurrences that become "abgesagt" because the new rule no longer produces them. */
  reason: z.string().trim().max(500).optional(),
  notify: z.boolean().optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
});

const invalid = (result: { success: boolean; error?: { issues: unknown[] } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error!.issues });
};

function requireWrite(roleTypes: readonly string[]): void {
  if (!hasClubPermission(roleTypes, "calendars:write")) throw new ForbiddenError("Missing calendars:write permission");
}

async function loadClubCalendar(calendarId: string, clubId: string) {
  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, calendarId), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Calendar not found");
  return calendar;
}

async function assertClubLocation(locationId: string, clubId: string): Promise<void> {
  const [row] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.id, locationId), eq(locations.clubId, clubId)));
  if (!row) throw new NotFoundError("Location not found");
}

/** Loads a series of the caller's club (404 otherwise, indistinguishable from unknown). */
async function loadClubSeries(id: string, clubId: string): Promise<{ series: EventSeriesRow; calendar: Awaited<ReturnType<typeof loadClubCalendar>> }> {
  const series = await db.query.eventSeries.findFirst({ where: eq(eventSeries.id, id) });
  if (!series) throw new NotFoundError("Series not found");
  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, series.calendarId), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Series not found");
  return { series, calendar };
}

function seriesInput(body: z.infer<typeof previewSchema>) {
  return {
    title: body.title,
    description: body.description ?? null,
    category: body.category ?? null,
    capacity: body.capacity ?? null,
    locationId: body.locationId ?? null,
    allDay: body.allDay ?? false,
    startDate: body.startDate,
    startTime: body.startTime ?? null,
    durationMinutes: body.durationMinutes ?? null,
    durationDays: body.durationDays ?? 1,
    freq: body.freq,
    intervalCount: body.interval ?? 1,
    byDay: body.byDay ?? null,
    bySetPos: body.bySetPos ?? null,
    untilDate: body.untilDate ?? null,
    count: body.count ?? null,
    skipHolidays: body.skipHolidays ?? false,
  };
}

/** Preview of the next occurrences for the editor (nothing is stored). */
eventSeriesRoutes.post("/preview", zValidator("json", previewSchema, invalid), async (c) => {
  requireWrite(c.get("clubRoleTypes"));
  const body = c.req.valid("json");
  const settings = await loadClubSettings(db, c.get("clubId"));
  const input = seriesInput(body);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 10) || 10, 1), 50);
  const probe = editedSeries({ ...input, id: "preview", calendarId: "preview", timezone: settings.timezone, horizonUntil: new Date(), splitFromSeriesId: null, createdBy: null, createdAt: new Date(), updatedAt: new Date() } as EventSeriesRow, {});
  const rule = ruleOf(probe, settings.state);
  assertValidRule(rule);
  const result = expandSeries(rule, { until: initialHorizon(input.startDate, settings.timezone, new Date()), limit });
  return c.json({
    data: {
      occurrences: result.occurrences.map((o) => ({ startsAt: o.startsAt, endsAt: o.endsAt, localDate: o.localDate })),
      skippedHolidays: result.skippedHolidays.filter((s) => result.occurrences.length === 0 || s.originalStartsAt <= result.occurrences[result.occurrences.length - 1]!.startsAt).map((s) => ({ localDate: s.localDate, holiday: s.holiday })),
      finished: result.finished,
    },
  });
});

eventSeriesRoutes.post("/", zValidator("json", createSchema, invalid), async (c) => {
  requireWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  await loadClubCalendar(body.calendarId, clubId);
  if (body.locationId) await assertClubLocation(body.locationId, clubId);
  const settings = await loadClubSettings(db, clubId);

  const result = await db.transaction(async (tx) => {
    const created = await createSeries(tx, { ...seriesInput(body), calendarId: body.calendarId, timezone: settings.timezone, createdBy: c.get("user").id }, settings.state, new Date());
    await writeAudit(tx, { eventType: "event_series.create", subjectId: created.series.id, payload: { clubId, calendarId: body.calendarId, occurrences: created.created } });
    return created;
  });
  return c.json({ data: { series: result.series, occurrencesCreated: result.created, skippedHolidays: result.skippedHolidays.map((s) => ({ localDate: s.localDate, holiday: s.holiday })) } }, 201);
});

eventSeriesRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const calendarIds = await getVisibleCalendarIds(clubId, c.get("membership").id, c.get("clubRoleTypes"));
  const wanted = c.req.query("calendarId");
  const ids = wanted ? calendarIds.filter((id) => id === wanted) : calendarIds;
  if (ids.length === 0) return c.json({ data: [] });
  const rows = await db.select().from(eventSeries).where(inArray(eventSeries.calendarId, ids)).orderBy(eventSeries.title);
  const upcoming = rows.length === 0 ? [] : await db.select({ seriesId: events.seriesId, n: count() }).from(events).where(and(inArray(events.seriesId, rows.map((r) => r.id)), gte(events.startsAt, new Date()))).groupBy(events.seriesId);
  const byId = new Map(upcoming.map((u) => [u.seriesId, u.n]));
  return c.json({ data: rows.map((r) => ({ ...r, upcomingCount: byId.get(r.id) ?? 0 })) });
});

eventSeriesRoutes.get("/:id", async (c) => {
  const { series, calendar } = await loadClubSeries(c.req.param("id"), c.get("clubId"));
  if (!(await isCalendarVisible(calendar.id, c.get("membership").id, c.get("clubRoleTypes")))) throw new NotFoundError("Series not found");
  const [totals] = await db
    .select({ total: count(), upcoming: sql<number>`count(*) filter (where ${events.startsAt} >= now())::int` })
    .from(events)
    .where(eq(events.seriesId, series.id));
  return c.json({ data: { ...series, occurrences: { total: totals?.total ?? 0, upcoming: totals?.upcoming ?? 0 } } });
});

const OCCURRENCE_FIELDS = new Set(["title", "description", "category", "capacity", "locationId", "allDay", "startsAt", "endsAt"]);
const CONTROL_FIELDS = new Set(["scope", "eventId", "reason", "notify"]);

eventSeriesRoutes.patch("/:id", zValidator("json", patchSchema, invalid), async (c) => {
  requireWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const body = c.req.valid("json") as Record<string, unknown> & { scope: (typeof SCOPES)[number]; eventId?: string; reason?: string };
  const { series: found } = await loadClubSeries(c.req.param("id"), clubId);
  const changed = Object.keys(body).filter((k) => !CONTROL_FIELDS.has(k) && body[k] !== undefined);
  if (changed.length === 0) throw new ValidationError("No changes given");
  if (body.scope === "this") {
    const forbidden = changed.filter((k) => !OCCURRENCE_FIELDS.has(k));
    if (forbidden.length > 0) throw new ValidationError(`Scope "this" cannot change ${forbidden.join(", ")}`);
  } else if (changed.includes("startsAt") || changed.includes("endsAt")) {
    throw new ValidationError('startsAt / endsAt only apply to scope "this"; use startTime and durationMinutes for the series');
  }
  if (body.scope !== "all" && !body.eventId) throw new ValidationError('eventId is required for scope "this" and "this_and_following"');
  if (typeof body.locationId === "string") await assertClubLocation(body.locationId, clubId);
  const settings = await loadClubSettings(db, clubId);

  const out = await db.transaction(async (tx) => {
    const series = await lockSeries(tx, found.id);
    if (!series) throw new NotFoundError("Series not found");
    const now = new Date();
    const event = body.eventId ? await tx.query.events.findFirst({ where: and(eq(events.id, body.eventId), eq(events.seriesId, series.id)) }) : undefined;
    if (body.eventId && !event) throw new NotFoundError("Occurrence not found");

    let result: SeriesEditResult;
    if (body.scope === "this") {
      const edit = occurrenceEdit(body);
      const startsAt = edit.startsAt ?? event!.startsAt;
      const endsAt = edit.endsAt === undefined ? event!.endsAt : edit.endsAt;
      if (endsAt && endsAt.getTime() < startsAt.getTime()) throw new ValidationError("endsAt must not be before startsAt");
      result = { series, event: await editOccurrence(tx, event!, edit, now) };
    } else if (body.scope === "all") {
      result = await editAll(tx, series, seriesEdit(body), settings.state, now, body.reason ?? null, now);
    } else {
      result = await editThisAndFollowing(tx, series, event!, seriesEdit(body), settings.state, body.reason ?? null, now);
    }
    const rec = result.reconcile;
    await writeAudit(tx, {
      eventType: "event_series.update",
      subjectId: series.id,
      payload: { clubId, scope: body.scope, changedFields: changed, split: result.previousSeries !== undefined, updated: rec?.updated ?? 1, created: rec?.created ?? 0, removed: rec?.removed.deleted.length ?? 0, cancelled: rec?.removed.cancelled.length ?? 0 },
    });
    return result;
  });

  const rec = out.reconcile;
  return c.json({
    data: {
      series: out.series,
      previousSeries: out.previousSeries ?? null,
      event: out.event ?? null,
      affected: { updated: rec?.updated ?? (out.event ? 1 : 0), created: rec?.created ?? 0, removed: rec?.removed.deleted.length ?? 0, cancelled: rec?.removed.cancelled.length ?? 0 },
    },
  });
});

eventSeriesRoutes.delete("/:id", async (c) => {
  requireWrite(c.get("clubRoleTypes"));
  const clubId = c.get("clubId");
  const parsed = scopeSchema.safeParse(c.req.query("scope"));
  if (!parsed.success) throw new ValidationError("scope must be this, this_and_following or all");
  const scope = parsed.data;
  const eventId = c.req.query("eventId");
  if (scope !== "all" && !(eventId && z.string().uuid().safeParse(eventId).success)) throw new ValidationError('eventId is required for scope "this" and "this_and_following"');
  const reason = c.req.query("reason")?.trim().slice(0, 500) || null;
  const { series: found } = await loadClubSeries(c.req.param("id"), clubId);

  const result = await db.transaction(async (tx) => {
    const series = await lockSeries(tx, found.id);
    if (!series) throw new NotFoundError("Series not found");
    const event = eventId ? await tx.query.events.findFirst({ where: and(eq(events.id, eventId), eq(events.seriesId, series.id)) }) : undefined;
    if (eventId && !event) throw new NotFoundError("Occurrence not found");
    const removal = await removeScoped(tx, series, scope, event ?? null, reason, new Date());
    await writeAudit(tx, { eventType: "event_series.delete", subjectId: series.id, payload: { clubId, scope, deleted: removal.removed.deleted.length, cancelled: removal.removed.cancelled.length, seriesDeleted: removal.seriesDeleted } });
    return removal;
  });
  return c.json({ data: { deleted: result.removed.deleted.length, cancelled: result.removed.cancelled.length, seriesDeleted: result.seriesDeleted } });
});

function occurrenceEdit(body: Record<string, unknown>): OccurrenceEdit {
  const edit: OccurrenceEdit = {};
  for (const key of ["title", "description", "category", "capacity", "locationId", "allDay"] as const) if (body[key] !== undefined) (edit as Record<string, unknown>)[key] = body[key];
  if (typeof body.startsAt === "string") edit.startsAt = new Date(body.startsAt);
  if (body.endsAt !== undefined) edit.endsAt = body.endsAt === null ? null : new Date(body.endsAt as string);
  return edit;
}

function seriesEdit(body: Record<string, unknown>): SeriesEdit {
  const edit: Record<string, unknown> = {};
  for (const key of ["title", "description", "category", "capacity", "locationId", "allDay", "startTime", "durationMinutes", "durationDays", "freq", "interval", "byDay", "bySetPos", "untilDate", "count", "skipHolidays"]) if (body[key] !== undefined) edit[key] = body[key];
  return edit as SeriesEdit;
}
