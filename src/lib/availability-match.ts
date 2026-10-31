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
