/**
 * Calendar helpers in a club's time zone (Wave 9, ADR-005: instants are stored as UTC, business logic counts days in
 * `club_settings.timezone`). Dates are ISO `YYYY-MM-DD` strings. Day arithmetic runs on the calendar date, never on
 * 24 h multiples, so a daylight saving switch (23 h / 25 h day) cannot move a reminder by a day.
 */

export const DEFAULT_TIMEZONE = "Europe/Berlin";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    formatters.set(timezone, f);
  }
  return f;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** An unknown/invalid stored zone falls back to the default instead of failing a whole sweep. */
export function safeTimezone(timezone: string | null | undefined): string {
  return timezone && isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
}

function parts(instant: Date, timezone: string): { date: string; hour: number } {
  const p = Object.fromEntries(formatterFor(timezone).formatToParts(instant).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

/** The calendar day of `instant` in `timezone`. */
export function localDate(instant: Date, timezone: string): string {
  return parts(instant, timezone).date;
}

/** The wall-clock hour (0-23) of `instant` in `timezone`. */
export function localHour(instant: Date, timezone: string): number {
  return parts(instant, timezone).hour;
}

/** `date` plus `days` (negative allowed) as calendar arithmetic. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative if `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Hour of the day (club time) from which date-based reminders and digests go out, so nobody is pinged at 00:15. */
export function digestHour(): number {
  const n = Number(process.env.REMINDER_DIGEST_HOUR);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 8;
}

/** True once the club's wall clock has reached the digest hour (every sweep afterwards the same day stays true; dedupe keys make the send once). */
export function isDigestTime(now: Date, timezone: string, hour: number = digestHour()): boolean {
  return localHour(now, timezone) >= hour;
}

/** The last second (23:59:59) of the calendar day `date` in `timezone`, as an instant; correct across daylight saving switches. */
export function endOfLocalDay(date: string, timezone: string): Date {
  const [y, m, d] = addDays(date, 1).split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, 0, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const offsetAt = (instant: number): number => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - instant;
  };
  let instant = wall;
  for (let i = 0; i < 3; i++) instant = wall - offsetAt(instant);
  return new Date(instant - 1000);
}
