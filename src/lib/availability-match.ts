/**
 * Pure Terminfindung (meeting-scheduling) overlap logic -- no DB access here,
 * see src/routes/availability.ts's GET /overlap for the DB-loading caller.
 */

export interface AvailabilityInput {
  memberId: string;
  slots: { weekday: number; startTime: string; endTime: string }[];
  exceptions: { date: string; isAvailable: boolean }[];
}

/** `HH:MM` or `HH:MM:SS` -> minutes since midnight, for a simple range check. */
function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/** `YYYY-MM-DD` local date, matching the candidate's calendar date, no timezone shift. */
function toDateString(candidate: Date): string {
  const y = candidate.getFullYear();
  const m = String(candidate.getMonth() + 1).padStart(2, "0");
  const d = String(candidate.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * `availability_slots.weekday` is documented (see src/db/schema/availability.ts)
 * as 0=Monday..6=Sunday. JS `Date.getDay()` is 0=Sunday..6=Saturday. Convert
 * getDay() into the schema's numbering: Sunday(0) -> 6, Monday(1) -> 0,
 * Tuesday(2) -> 1, ..., Saturday(6) -> 5. Equivalent to `(getDay() + 6) % 7`.
 */
function toSchemaWeekday(candidate: Date): number {
  return (candidate.getDay() + 6) % 7;
}

/** One member's availability for one candidate timestamp, per the precedence rules below. */
function isMemberAvailable(candidate: Date, input: AvailabilityInput): boolean {
  const dateStr = toDateString(candidate);
  const exception = input.exceptions.find((e) => e.date === dateStr);

  // Exceptions (Urlaub/Abwesenheit or explicit extra availability) override
  // regular slots entirely, in both directions.
  if (exception) return exception.isAvailable;

  const weekday = toSchemaWeekday(candidate);
  const minutes = candidate.getHours() * 60 + candidate.getMinutes();

  // Default-closed: no matching slot and no exception means "no data", not
  // "free all the time".
  return input.slots.some(
    (slot) => slot.weekday === weekday && minutes >= toMinutes(slot.startTime) && minutes < toMinutes(slot.endTime),
  );
}

export function computeAvailability(candidate: Date, members: AvailabilityInput[]): { memberId: string; available: boolean }[] {
  return members.map((m) => ({ memberId: m.memberId, available: isMemberAvailable(candidate, m) }));
}

export type WindowAvailability = "verfuegbar" | "nicht_verfuegbar" | "unbekannt";

/** Local calendar dates (`YYYY-MM-DD`) from `start` to `end` inclusive (wall-clock dates as `computeAvailability` reads them), at most 31. */
function datesBetween(start: Date, end: Date): string[] {
  const out: string[] = [];
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = toDateString(end);
  while (out.length < 31) {
    const d = toDateString(day);
    out.push(d);
    if (d >= last) break;
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/**
 * Wave 16 T6: one person's availability for a time window given as club-local wall-clock instants (`start`, `end` = last minute).
 * - An exception "nicht verfügbar" (holiday) on any day of the window -> `nicht_verfuegbar`.
 * - No weekly pattern: `verfuegbar` only if every day of the window has an exception "verfügbar", otherwise `unbekannt`
 *   (somebody who only entered a holiday has said nothing about other days -- missing data never reads as "not available").
 * - Otherwise the precedence rules of `computeAvailability` at the start and at the end of the window.
 */
export function windowAvailability(start: Date, end: Date, input: AvailabilityInput): WindowAvailability {
  const dates = datesBetween(start, end);
  const relevant = input.exceptions.filter((e) => dates.includes(e.date));
  if (relevant.some((e) => !e.isAvailable)) return "nicht_verfuegbar";
  if (input.slots.length === 0) return dates.every((d) => relevant.some((e) => e.date === d && e.isAvailable)) ? "verfuegbar" : "unbekannt";
  return isMemberAvailable(start, input) && isMemberAvailable(end, input) ? "verfuegbar" : "nicht_verfuegbar";
}
