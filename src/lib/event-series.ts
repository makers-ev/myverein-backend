import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";

import { wardEventResponses } from "../db/schema/absences.js";
import { eventAttendanceSheets } from "../db/schema/event-attendance.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { helperStations } from "../db/schema/event-helpers.js";
import { eventSeriesExceptions } from "../db/schema/event-series-exceptions.js";
import { eventSeries, type EventSeriesRow, type NewEventSeriesRow } from "../db/schema/event-series.js";
import { events, type EventRow } from "../db/schema/events.js";
import type { DbExecutor } from "./club-members.js";
import { addDays, localDate } from "./club-time.js";
import { ValidationError } from "./errors.js";
import { expandSeries, validateRule, zonedToUtc, type Occurrence, type RuleWeekday, type SeriesRule, type SkippedOccurrence } from "./recurrence.js";

/**
 * Series service (Wave 12 B5, ADR-009): occurrences are materialized rows in `events`. Everything here runs inside the
 * caller's transaction with the series row locked (`lockSeries`), so two parallel edits of one series run one after the other.
 * Occurrences keep their `events.id` (RSVPs, attendance and helper plans hang on it) whenever the edit can be applied in place.
 */

/** How far ahead occurrences are materialized. */
export const HORIZON_MONTHS = 12;

export type SeriesScope = "this" | "this_and_following" | "all";

export function addMonthsUtc(from: Date, months: number): Date {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** Locks the series row; undefined when it does not exist. */
export async function lockSeries(tx: DbExecutor, id: string): Promise<EventSeriesRow | undefined> {
  const [row] = await tx.select().from(eventSeries).where(eq(eventSeries.id, id)).for("update");
  return row;
}

export function ruleOf(series: Pick<EventSeriesRow, "freq" | "intervalCount" | "byDay" | "bySetPos" | "startDate" | "startTime" | "allDay" | "durationMinutes" | "durationDays" | "timezone" | "untilDate" | "count" | "skipHolidays">, state: string | null): SeriesRule {
  return {
    freq: series.freq as SeriesRule["freq"],
    interval: series.intervalCount,
    byDay: (series.byDay as RuleWeekday[] | null) ?? null,
    bySetPos: series.bySetPos,
    startDate: series.startDate,
    startTime: series.startTime,
    allDay: series.allDay,
    durationMinutes: series.durationMinutes,
    durationDays: series.durationDays,
    timezone: series.timezone,
    untilDate: series.untilDate,
    count: series.count,
    skipHolidays: series.skipHolidays,
    state,
  };
}

export function assertValidRule(rule: SeriesRule): void {
  const problems = validateRule(rule);
  if (problems.length > 0) throw new ValidationError("Invalid recurrence rule", { details: problems });
}

/** First instant occurrences can exist, so a series that starts in two years still gets its first 12 months. */
export function initialHorizon(startDate: string, timezone: string, now: Date): Date {
  const first = zonedToUtc(startDate, "00:00:00", timezone);
  return addMonthsUtc(first.getTime() > now.getTime() ? first : now, HORIZON_MONTHS);
}

function occurrenceValues(series: EventSeriesRow, occ: Occurrence) {
  return {
    calendarId: series.calendarId,
    title: series.title,
    description: series.description,
    category: series.category,
    capacity: series.capacity,
    locationId: series.locationId,
    allDay: series.allDay,
    startsAt: occ.startsAt,
    endsAt: occ.endsAt,
    seriesId: series.id,
    originalStartsAt: occ.originalStartsAt,
    createdBy: series.createdBy,
  };
}

/** Inserts occurrences idempotently (unique `(series_id, original_starts_at)`); returns how many were new. */
export async function insertOccurrences(tx: DbExecutor, series: EventSeriesRow, occs: Occurrence[]): Promise<number> {
  if (occs.length === 0) return 0;
  const inserted = await tx
    .insert(events)
    .values(occs.map((o) => occurrenceValues(series, o)))
    .onConflictDoNothing({ target: [events.seriesId, events.originalStartsAt], where: sql`${events.seriesId} IS NOT NULL` })
    .returning({ id: events.id });
  return inserted.length;
}

async function recordHolidays(tx: DbExecutor, seriesId: string, skipped: SkippedOccurrence[]): Promise<void> {
  if (skipped.length === 0) return;
  await tx
    .insert(eventSeriesExceptions)
    .values(skipped.map((s) => ({ seriesId, originalStartsAt: s.originalStartsAt, kind: "feiertag" })))
    .onConflictDoNothing();
}

/** Local dates (series zone) of the series' exceptions: dropped, moved and holiday-skipped occurrences. */
async function exceptionDates(tx: DbExecutor, series: Pick<EventSeriesRow, "id" | "timezone">): Promise<Set<string>> {
  const rows = await tx.select({ at: eventSeriesExceptions.originalStartsAt }).from(eventSeriesExceptions).where(eq(eventSeriesExceptions.seriesId, series.id));
  return new Set(rows.map((r) => localDate(r.at, series.timezone)));
}

/**
 * Materializes the occurrences from the series' `horizon_until` up to `target` (idempotent: existing occurrences, dropped
 * ones and holidays are skipped) and moves `horizon_until` forward. `fromScratch` starts at the first occurrence.
 */
export async function extendHorizon(tx: DbExecutor, series: EventSeriesRow, state: string | null, target: Date, fromScratch = false): Promise<{ created: number; skippedHolidays: SkippedOccurrence[] }> {
  if (!fromScratch && target.getTime() <= series.horizonUntil.getTime()) return { created: 0, skippedHolidays: [] };
  const exceptions = await exceptionDates(tx, series);
  const result = expandSeries(ruleOf(series, state), { until: target, ...(fromScratch ? {} : { from: series.horizonUntil }), exceptions });
  const created = await insertOccurrences(tx, series, result.occurrences);
  await recordHolidays(tx, series.id, result.skippedHolidays);
  await tx.update(eventSeries).set({ horizonUntil: target, updatedAt: new Date() }).where(eq(eventSeries.id, series.id));
  series.horizonUntil = target;
  return { created, skippedHolidays: result.skippedHolidays };
}

const emptyRuleDefaults = { intervalCount: 1, byDay: null, bySetPos: null, startTime: null, allDay: false, durationMinutes: null, durationDays: 1, untilDate: null, count: null, skipHolidays: false, timezone: "Europe/Berlin" };

export interface CreateSeriesInput extends Omit<NewEventSeriesRow, "id" | "horizonUntil" | "createdAt" | "updatedAt" | "splitFromSeriesId"> {
  startDate: string;
  freq: string;
}

export async function createSeries(tx: DbExecutor, input: CreateSeriesInput, state: string | null, now: Date): Promise<{ series: EventSeriesRow; created: number; skippedHolidays: SkippedOccurrence[] }> {
  const timezone = input.timezone ?? "Europe/Berlin";
  // Store the weekday explicitly so the rule never depends on `start_date` implicitly.
  const byDay = input.byDay && input.byDay.length > 0 ? input.byDay : input.freq === "weekly" ? [weekdayCode(input.startDate)] : null;
  const values = { ...input, timezone, byDay, startTime: input.allDay ? null : input.startTime ?? null, durationMinutes: input.allDay ? null : input.durationMinutes ?? null, durationDays: input.allDay ? input.durationDays ?? 1 : 1 };
  assertValidRule(ruleOf({ ...emptyRuleDefaults, ...values } as EventSeriesRow, state));
  const [row] = await tx
    .insert(eventSeries)
    .values({ ...values, horizonUntil: initialHorizon(input.startDate, timezone, now) })
    .returning();
  const series = row!;
  const { created, skippedHolidays } = await extendHorizon(tx, series, state, series.horizonUntil, true);
  return { series, created, skippedHolidays };
}

const WEEKDAY_CODES: RuleWeekday[] = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** Weekday code of a `YYYY-MM-DD` date. */
export function weekdayCode(date: string): RuleWeekday {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return WEEKDAY_CODES[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7]!;
}

// --- occurrences with participation: cancel instead of delete --------------------------------------------------

/** Ids among `ids` that carry data people created (RSVPs, ward answers, attendance list, helper plan). */
export async function withParticipation(tx: DbExecutor, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const [a, w, s, h] = await Promise.all([
    tx.selectDistinct({ id: eventAttendees.eventId }).from(eventAttendees).where(inArray(eventAttendees.eventId, ids)),
    tx.selectDistinct({ id: wardEventResponses.eventId }).from(wardEventResponses).where(inArray(wardEventResponses.eventId, ids)),
    tx.selectDistinct({ id: eventAttendanceSheets.eventId }).from(eventAttendanceSheets).where(inArray(eventAttendanceSheets.eventId, ids)),
    tx.selectDistinct({ id: helperStations.eventId }).from(helperStations).where(inArray(helperStations.eventId, ids)),
  ]);
  return new Set([...a, ...w, ...s, ...h].map((r) => r.id));
}

export interface RemovalResult {
  deleted: EventRow[];
  /** Occurrences that stay visible as "abgesagt" because people signed up. */
  cancelled: EventRow[];
}

/** Removes occurrences: those with participation are cancelled (kept, with reason), the others deleted. Already cancelled ones stay as they are. */
export async function removeOccurrences(tx: DbExecutor, rows: EventRow[], reason: string | null, now: Date): Promise<RemovalResult> {
  const used = await withParticipation(tx, rows.map((r) => r.id));
  const toCancel = rows.filter((r) => used.has(r.id) && r.cancelledAt === null);
  const toDelete = rows.filter((r) => !used.has(r.id));
  let cancelled: EventRow[] = [];
  if (toCancel.length > 0) {
    cancelled = await tx
      .update(events)
      .set({ cancelledAt: now, cancelReason: reason, updatedAt: now })
      .where(inArray(events.id, toCancel.map((r) => r.id)))
      .returning();
  }
  if (toDelete.length > 0) await tx.delete(events).where(inArray(events.id, toDelete.map((r) => r.id)));
  return { deleted: toDelete, cancelled };
}

// --- reconcile: bring the occurrences from `from` on in line with the (changed) rule --------------------------

export interface ReconcileResult {
  updated: number;
  created: number;
  removed: RemovalResult;
  /** Occurrences whose date or time changed (id, before/after) -- for the change notification. */
  moved: Array<{ before: EventRow; after: EventRow }>;
}

/**
 * Applies the current series (rule + template) to its occurrences with `original_starts_at >= from`. Overrides and cancelled
 * occurrences are never touched. An occurrence whose instant the rule still produces keeps its row; the others are paired in
 * order with the instants the rule newly produces and moved IN PLACE (same `events.id`); surplus rows are removed (cancelled
 * when they carry participation), surplus instants are inserted.
 */
export async function reconcileOccurrences(tx: DbExecutor, series: EventSeriesRow, state: string | null, from: Date, reason: string | null, now: Date): Promise<ReconcileResult> {
  // Holiday skips depend on the rule; recompute them from `from` on (dropped occurrences stay dropped).
  await tx.delete(eventSeriesExceptions).where(and(eq(eventSeriesExceptions.seriesId, series.id), eq(eventSeriesExceptions.kind, "feiertag"), gte(eventSeriesExceptions.originalStartsAt, from)));
  const existing = await tx.select().from(events).where(and(eq(events.seriesId, series.id), gte(events.originalStartsAt, from))).orderBy(asc(events.originalStartsAt));
  const fixed = existing.filter((e) => e.isOverride || e.cancelledAt !== null);
  const movable = existing.filter((e) => !e.isOverride && e.cancelledAt === null);
  // Dropped, moved, overridden and cancelled occurrences block their DAY, so a changed time of day does not resurrect them.
  const blocked = await exceptionDates(tx, series);
  for (const e of fixed) blocked.add(localDate(e.originalStartsAt!, series.timezone));

  const target = expandSeries(ruleOf(series, state), { from, until: series.horizonUntil, exceptions: blocked });
  await recordHolidays(tx, series.id, target.skippedHolidays);

  const targetByInstant = new Map(target.occurrences.map((o) => [o.originalStartsAt.getTime(), o]));
  const pairs: Array<{ row: EventRow; occ: Occurrence }> = [];
  const oldLeft: EventRow[] = [];
  for (const row of movable) {
    const occ = targetByInstant.get(row.originalStartsAt!.getTime());
    if (occ) {
      pairs.push({ row, occ });
      targetByInstant.delete(row.originalStartsAt!.getTime());
    } else {
      oldLeft.push(row);
    }
  }
  const newLeft = [...targetByInstant.values()].sort((a, b) => a.originalStartsAt.getTime() - b.originalStartsAt.getTime());
  const reassigned = Math.min(oldLeft.length, newLeft.length);
  for (let i = 0; i < reassigned; i++) pairs.push({ row: oldLeft[i]!, occ: newLeft[i]! });
  const surplus = oldLeft.slice(reassigned);
  const fresh = newLeft.slice(reassigned);

  // Two phases keep the unique key `(series_id, original_starts_at)` free while instants shuffle.
  const shifting = pairs.filter((p) => p.row.originalStartsAt!.getTime() !== p.occ.originalStartsAt.getTime());
  if (shifting.length > 0) await tx.update(events).set({ originalStartsAt: null }).where(inArray(events.id, shifting.map((p) => p.row.id)));
  const moved: ReconcileResult["moved"] = [];
  let updated = 0;
  for (const { row, occ } of pairs) {
    const values = occurrenceValues(series, occ);
    const [after] = await tx
      .update(events)
      .set({ title: values.title, description: values.description, category: values.category, capacity: values.capacity, locationId: values.locationId, allDay: values.allDay, startsAt: values.startsAt, endsAt: values.endsAt, originalStartsAt: values.originalStartsAt, seriesId: series.id, updatedAt: now })
      .where(eq(events.id, row.id))
      .returning();
    updated++;
    if (row.startsAt.getTime() !== after!.startsAt.getTime() || (row.endsAt?.getTime() ?? null) !== (after!.endsAt?.getTime() ?? null) || row.locationId !== after!.locationId) moved.push({ before: row, after: after! });
  }
  const removed = await removeOccurrences(tx, surplus, reason, now);
  const created = await insertOccurrences(tx, series, fresh);
  return { updated, created, removed, moved };
}

/** Local calendar date of an instant in the series' zone. */
export function seriesLocalDate(series: Pick<EventSeriesRow, "timezone">, instant: Date): string {
  return localDate(instant, series.timezone);
}

// --- scoped edit / removal ---------------------------------------------------------------------------------------

/** Template, timing and rule fields of a series edit (scope `all` / `this_and_following`). */
export interface SeriesEdit {
  title?: string;
  description?: string | null;
  category?: string | null;
  capacity?: number | null;
  locationId?: string | null;
  allDay?: boolean;
  startTime?: string;
  durationMinutes?: number | null;
  durationDays?: number;
  freq?: SeriesRule["freq"];
  interval?: number;
  byDay?: RuleWeekday[] | null;
  bySetPos?: number | null;
  untilDate?: string | null;
  count?: number | null;
  skipHolidays?: boolean;
}

/** Fields of one occurrence (scope `this`). */
export interface OccurrenceEdit {
  title?: string;
  description?: string | null;
  category?: string | null;
  capacity?: number | null;
  locationId?: string | null;
  allDay?: boolean;
  startsAt?: Date;
  endsAt?: Date | null;
}

/** The series row after `edit` (not persisted), with the rule kept consistent (weekday default, UNTIL xor COUNT, all-day fields). */
export function editedSeries(series: EventSeriesRow, edit: SeriesEdit): EventSeriesRow {
  const next: EventSeriesRow = { ...series };
  if (edit.title !== undefined) next.title = edit.title;
  if (edit.description !== undefined) next.description = edit.description;
  if (edit.category !== undefined) next.category = edit.category;
  if (edit.capacity !== undefined) next.capacity = edit.capacity;
  if (edit.locationId !== undefined) next.locationId = edit.locationId;
  if (edit.allDay !== undefined) next.allDay = edit.allDay;
  if (edit.startTime !== undefined) next.startTime = edit.startTime;
  if (edit.durationMinutes !== undefined) next.durationMinutes = edit.durationMinutes;
  if (edit.durationDays !== undefined) next.durationDays = edit.durationDays;
  if (edit.freq !== undefined) next.freq = edit.freq;
  if (edit.interval !== undefined) next.intervalCount = edit.interval;
  if (edit.byDay !== undefined) next.byDay = edit.byDay;
  if (edit.bySetPos !== undefined) next.bySetPos = edit.bySetPos;
  if (edit.skipHolidays !== undefined) next.skipHolidays = edit.skipHolidays;
  if (edit.untilDate !== undefined) {
    next.untilDate = edit.untilDate;
    if (edit.untilDate !== null && edit.count === undefined) next.count = null;
  }
  if (edit.count !== undefined) {
    next.count = edit.count;
    if (edit.count !== null && edit.untilDate === undefined) next.untilDate = null;
  }
  if (next.allDay) {
    next.startTime = null;
    next.durationMinutes = null;
  } else {
    next.durationDays = 1;
  }
  if (next.freq === "daily") next.byDay = null;
  if (next.freq === "daily" || (next.freq === "monthly" && edit.bySetPos === undefined && edit.byDay === undefined && series.freq !== "monthly")) next.bySetPos = null;
  if (next.freq === "weekly") {
    next.bySetPos = null;
    if (!next.byDay || next.byDay.length === 0) next.byDay = [weekdayCode(next.startDate)];
  }
  if (next.freq === "monthly" && next.bySetPos === null) next.byDay = null;
  return next;
}

async function persistSeries(tx: DbExecutor, next: EventSeriesRow): Promise<EventSeriesRow> {
  const now = new Date();
  const [row] = await tx
    .update(eventSeries)
    .set({
      title: next.title, description: next.description, category: next.category, capacity: next.capacity, locationId: next.locationId, allDay: next.allDay,
      startTime: next.startTime, durationMinutes: next.durationMinutes, durationDays: next.durationDays, freq: next.freq, intervalCount: next.intervalCount,
      byDay: next.byDay, bySetPos: next.bySetPos, untilDate: next.untilDate, count: next.count, skipHolidays: next.skipHolidays, updatedAt: now,
    })
    .where(eq(eventSeries.id, next.id))
    .returning();
  return row!;
}

/** Edits one occurrence on its own: it becomes an override (a later "all" edit leaves it alone); a changed time is recorded as exception `verschoben`. */
export async function editOccurrence(tx: DbExecutor, event: EventRow, edit: OccurrenceEdit, now: Date): Promise<EventRow> {
  const timeChanged = (edit.startsAt !== undefined && edit.startsAt.getTime() !== event.startsAt.getTime()) || (edit.endsAt !== undefined && (edit.endsAt?.getTime() ?? null) !== (event.endsAt?.getTime() ?? null));
  const [row] = await tx
    .update(events)
    .set({
      ...(edit.title !== undefined ? { title: edit.title } : {}),
      ...(edit.description !== undefined ? { description: edit.description } : {}),
      ...(edit.category !== undefined ? { category: edit.category } : {}),
      ...(edit.capacity !== undefined ? { capacity: edit.capacity } : {}),
      ...(edit.locationId !== undefined ? { locationId: edit.locationId } : {}),
      ...(edit.allDay !== undefined ? { allDay: edit.allDay } : {}),
      ...(edit.startsAt !== undefined ? { startsAt: edit.startsAt } : {}),
      ...(edit.endsAt !== undefined ? { endsAt: edit.endsAt } : {}),
      isOverride: true,
      updatedAt: now,
    })
    .where(eq(events.id, event.id))
    .returning();
  if (timeChanged && event.seriesId && event.originalStartsAt) {
    await tx
      .insert(eventSeriesExceptions)
      .values({ seriesId: event.seriesId, originalStartsAt: event.originalStartsAt, kind: "verschoben", eventId: event.id })
      .onConflictDoUpdate({ target: [eventSeriesExceptions.seriesId, eventSeriesExceptions.originalStartsAt], set: { kind: "verschoben", eventId: event.id } });
  }
  return row!;
}

export interface SeriesEditResult {
  /** The series the edit ended up on (the NEW series after a split). */
  series: EventSeriesRow;
  /** Set for scope `this_and_following` when the series was split. */
  previousSeries?: EventSeriesRow;
  event?: EventRow;
  reconcile?: ReconcileResult;
}

/** Scope `all`: template and rule of the whole series; future, not overridden occurrences follow IN PLACE. */
export async function editAll(tx: DbExecutor, series: EventSeriesRow, edit: SeriesEdit, state: string | null, from: Date, reason: string | null, now: Date): Promise<SeriesEditResult> {
  const next = editedSeries(series, edit);
  assertValidRule(ruleOf(next, state));
  const saved = await persistSeries(tx, next);
  const reconcile = await reconcileOccurrences(tx, saved, state, from, reason, now);
  return { series: saved, reconcile };
}

/** Scope `this_and_following`: the series is split at `event`; the old series ends the day before, the new one carries the edit. */
export async function editThisAndFollowing(tx: DbExecutor, series: EventSeriesRow, event: EventRow, edit: SeriesEdit, state: string | null, reason: string | null, now: Date): Promise<SeriesEditResult> {
  const at = event.originalStartsAt!;
  const day = seriesLocalDate(series, at);
  // The first occurrence of the series: nothing to split off, the whole series is edited.
  if (day <= series.startDate) return editAll(tx, series, edit, state, at, reason, now);

  const before = expandSeries(ruleOf(series, state), { until: new Date(at.getTime() - 1) });
  const [previous] = await tx
    .update(eventSeries)
    .set({ untilDate: addDays(day, -1), count: null, updatedAt: now })
    .where(eq(eventSeries.id, series.id))
    .returning();
  const remaining = series.count === null ? null : series.count - before.produced;
  const base: EventSeriesRow = { ...series, id: crypto.randomUUID(), startDate: day, count: remaining, splitFromSeriesId: series.id, createdAt: now, updatedAt: now };
  const next = editedSeries(base, edit);
  assertValidRule(ruleOf(next, state));
  const [created] = await tx.insert(eventSeries).values(next).returning();
  const fresh = created!;
  await tx.update(events).set({ seriesId: fresh.id }).where(and(eq(events.seriesId, series.id), gte(events.originalStartsAt, at)));
  await tx.update(eventSeriesExceptions).set({ seriesId: fresh.id }).where(and(eq(eventSeriesExceptions.seriesId, series.id), gte(eventSeriesExceptions.originalStartsAt, at)));
  const reconcile = await reconcileOccurrences(tx, fresh, state, at, reason, now);
  return { series: fresh, previousSeries: previous!, reconcile };
}

export interface SeriesRemovalResult {
  removed: RemovalResult;
  /** True when the series row itself is gone. */
  seriesDeleted: boolean;
}

/** Removal with a scope; occurrences with participation are cancelled (kept as "abgesagt"), the others deleted. */
export async function removeScoped(tx: DbExecutor, series: EventSeriesRow, scope: SeriesScope, event: EventRow | null, reason: string | null, now: Date): Promise<SeriesRemovalResult> {
  if (scope === "this") {
    const removed = await removeOccurrences(tx, [event!], reason, now);
    if (removed.deleted.length > 0 && event!.originalStartsAt) {
      await tx
        .insert(eventSeriesExceptions)
        .values({ seriesId: series.id, originalStartsAt: event!.originalStartsAt, kind: "entfaellt" })
        .onConflictDoUpdate({ target: [eventSeriesExceptions.seriesId, eventSeriesExceptions.originalStartsAt], set: { kind: "entfaellt", eventId: null } });
    }
    return { removed, seriesDeleted: false };
  }

  const from = scope === "all" ? now : event!.originalStartsAt!;
  const rows = await tx.select().from(events).where(and(eq(events.seriesId, series.id), gte(events.originalStartsAt, from)));
  const removed = await removeOccurrences(tx, rows, reason, now);
  await tx.delete(eventSeriesExceptions).where(and(eq(eventSeriesExceptions.seriesId, series.id), gte(eventSeriesExceptions.originalStartsAt, from)));
  const remaining = await tx.select({ id: events.id }).from(events).where(eq(events.seriesId, series.id)).limit(1);
  if (remaining.length === 0) {
    await tx.delete(eventSeries).where(eq(eventSeries.id, series.id));
    return { removed, seriesDeleted: true };
  }
  // Something stays (past occurrences, cancelled ones with participation): the series just ends before `from`.
  const lastDay = addDays(seriesLocalDate(series, from), -1);
  await tx
    .update(eventSeries)
    .set({ untilDate: lastDay < series.startDate ? series.startDate : lastDay, count: null, updatedAt: now })
    .where(eq(eventSeries.id, series.id));
  return { removed, seriesDeleted: false };
}

/** A single `PATCH /events/:id` on a series occurrence: flag it as override and record a moved time as exception `verschoben`. */
export async function markOverride(tx: DbExecutor, before: EventRow, after: EventRow): Promise<void> {
  if (!before.seriesId) return;
  if (!after.isOverride) await tx.update(events).set({ isOverride: true }).where(eq(events.id, after.id));
  const moved = before.startsAt.getTime() !== after.startsAt.getTime() || (before.endsAt?.getTime() ?? null) !== (after.endsAt?.getTime() ?? null);
  if (moved && before.originalStartsAt) {
    await tx
      .insert(eventSeriesExceptions)
      .values({ seriesId: before.seriesId, originalStartsAt: before.originalStartsAt, kind: "verschoben", eventId: before.id })
      .onConflictDoUpdate({ target: [eventSeriesExceptions.seriesId, eventSeriesExceptions.originalStartsAt], set: { kind: "verschoben", eventId: before.id } });
  }
}

/** Before an occurrence row is deleted: remember that the rule's instant was dropped, so the refill does not recreate it. */
export async function recordDroppedOccurrence(tx: DbExecutor, event: EventRow): Promise<void> {
  if (!event.seriesId || !event.originalStartsAt) return;
  await tx
    .insert(eventSeriesExceptions)
    .values({ seriesId: event.seriesId, originalStartsAt: event.originalStartsAt, kind: "entfaellt" })
    .onConflictDoUpdate({ target: [eventSeriesExceptions.seriesId, eventSeriesExceptions.originalStartsAt], set: { kind: "entfaellt", eventId: null } });
}
