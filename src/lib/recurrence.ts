import { addDays, isValidTimezone } from "./club-time.js";
import { holidayOn } from "./holidays-de.js";

/**
 * Expansion of a series rule into occurrences (Wave 12, ADR-009): pure functions, no database. The rule is a subset of
 * RFC 5545 RRULE (FREQ DAILY/WEEKLY/MONTHLY, INTERVAL, BYDAY, BYSETPOS for "n-th weekday of the month", UNTIL/COUNT; weeks start on Monday).
 * Dates and times are LOCAL values of `timezone`, so a training at 18:00 stays at 18:00 across daylight saving switches; a local time that
 * does not exist (spring gap) moves forward, an ambiguous one (autumn) takes its first occurrence.
 *
 * Month rules follow RFC 5545: "monthly on the 31st" has no occurrence in months with 30 days (skipped, not clamped), and
 * "yearly Feb 29" is not offered. COUNT counts the occurrences the rule produces BEFORE holidays and exceptions are removed.
 */

export const RULE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RuleFrequency = (typeof RULE_FREQUENCIES)[number];
export const RULE_WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type RuleWeekday = (typeof RULE_WEEKDAYS)[number];

export interface SeriesRule {
  freq: RuleFrequency;
  /** Step in days / weeks / months (>= 1). */
  interval: number;
  /** Weekly: the days (default: weekday of `startDate`). Monthly with `bySetPos`: exactly one day. */
  byDay?: readonly RuleWeekday[] | null;
  /** Monthly: 1..4 or -1 (last) occurrence of the weekday in `byDay`; null = same day of the month as `startDate`. */
  bySetPos?: number | null;
  /** First possible local date (`YYYY-MM-DD`); the first occurrence is the first rule date on or after it. */
  startDate: string;
  /** Local `HH:MM` or `HH:MM:SS`; ignored for all-day. */
  startTime?: string | null;
  allDay: boolean;
  /** Timed: length in minutes (null = open end). */
  durationMinutes?: number | null;
  /** All-day: number of days (>= 1). */
  durationDays?: number | null;
  timezone: string;
  /** Inclusive last local date; mutually exclusive with `count`. */
  untilDate?: string | null;
  count?: number | null;
  skipHolidays?: boolean;
  /** Federal state for `skipHolidays`. */
  state?: string | null;
}

export interface Occurrence {
  /** The identity of the occurrence within its series (UTC instant the rule produced). */
  originalStartsAt: Date;
  startsAt: Date;
  endsAt: Date | null;
  /** Local date of the start. */
  localDate: string;
}

export interface SkippedOccurrence {
  originalStartsAt: Date;
  localDate: string;
  holiday: string;
}

export interface ExpandOptions {
  /** Last instant to generate (inclusive, on `startsAt`). */
  until: Date;
  /** Skip occurrences starting before this instant (they still count for COUNT). */
  from?: Date;
  /** Local dates (`YYYY-MM-DD` in the rule's zone) that must not be returned (dropped / overridden occurrences). A rule yields at most one occurrence per day, and matching by date survives a change of the time of day. */
  exceptions?: ReadonlySet<string>;
  /** Hard cap on returned occurrences (default 1000). */
  limit?: number;
}

export interface ExpandResult {
  occurrences: Occurrence[];
  /** Occurrences removed by `skipHolidays` (the caller may record them as exceptions of kind `feiertag`). */
  skippedHolidays: SkippedOccurrence[];
  /** True when the rule has no further occurrences (UNTIL/COUNT reached) rather than the horizon being hit. */
  finished: boolean;
  /** Rule occurrences considered up to the horizon (before `from`, exceptions and holidays removed anything): the base for COUNT bookkeeping when a series is split. */
  produced: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const MAX_SCAN_DAYS = 366 * 12;

/** Validation of a rule; returns human readable problems (empty = valid). */
export function validateRule(rule: SeriesRule): string[] {
  const problems: string[] = [];
  if (!RULE_FREQUENCIES.includes(rule.freq)) problems.push("freq must be daily, weekly or monthly");
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 99) problems.push("interval must be between 1 and 99");
  if (!DATE_RE.test(rule.startDate) || Number.isNaN(Date.parse(rule.startDate))) problems.push("startDate must be a valid date");
  if (!isValidTimezone(rule.timezone)) problems.push("timezone is not a valid IANA zone");
  if (!rule.allDay && !(rule.startTime && TIME_RE.test(rule.startTime))) problems.push("startTime (HH:MM) is required for timed series");
  if (rule.untilDate && rule.count) problems.push("untilDate and count are mutually exclusive");
  if (rule.untilDate && (!DATE_RE.test(rule.untilDate) || rule.untilDate < rule.startDate)) problems.push("untilDate must be a valid date on or after startDate");
  if (rule.count !== undefined && rule.count !== null && (!Number.isInteger(rule.count) || rule.count < 1 || rule.count > 1000)) problems.push("count must be between 1 and 1000");
  if (rule.durationMinutes !== undefined && rule.durationMinutes !== null && (!Number.isInteger(rule.durationMinutes) || rule.durationMinutes < 0)) problems.push("durationMinutes must be >= 0");
  if (rule.allDay && rule.durationDays !== undefined && rule.durationDays !== null && (!Number.isInteger(rule.durationDays) || rule.durationDays < 1 || rule.durationDays > 366)) problems.push("durationDays must be between 1 and 366");
  const by = rule.byDay ?? [];
  if (by.some((d) => !RULE_WEEKDAYS.includes(d))) problems.push("byDay holds an unknown weekday");
  if (new Set(by).size !== by.length) problems.push("byDay holds a weekday twice");
  if (rule.freq === "weekly" && rule.byDay && rule.byDay.length === 0) problems.push("byDay must not be empty");
  if (rule.freq !== "weekly" && rule.freq !== "monthly" && by.length > 0) problems.push("byDay only applies to weekly and monthly rules");
  if (rule.bySetPos !== undefined && rule.bySetPos !== null) {
    if (rule.freq !== "monthly") problems.push("bySetPos only applies to monthly rules");
    if (![1, 2, 3, 4, -1].includes(rule.bySetPos)) problems.push("bySetPos must be 1, 2, 3, 4 or -1");
    if (by.length !== 1) problems.push("bySetPos needs exactly one weekday in byDay");
  } else if (rule.freq === "monthly" && by.length > 0) {
    problems.push("a monthly rule with byDay needs bySetPos");
  }
  return problems;
}

// --- time zone arithmetic ---------------------------------------------------

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Offset of `timezone` from UTC at the instant `utcMs`, in ms (positive east of Greenwich). */
export function offsetAt(utcMs: number, timezone: string): number {
  let f = offsetFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    offsetFormatters.set(timezone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return local - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant of the local wall-clock time `date` + `time` in `timezone` (gap: moves forward; overlap: first occurrence). */
export function zonedToUtc(date: string, time: string, timezone: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi, s] = time.split(":").map(Number) as [number, number, number?];
  const guess = Date.UTC(y, mo - 1, d, h, mi, s ?? 0);
  const day = 86_400_000;
  const candidates = [...new Set([offsetAt(guess - day, timezone), offsetAt(guess + day, timezone)])].map((o) => ({ o, utc: guess - o }));
  const valid = candidates.filter((c) => offsetAt(c.utc, timezone) === c.o).map((c) => c.utc);
  if (valid.length > 0) return new Date(Math.min(...valid));
  // Gap (spring forward): the wall time does not exist; use the offset in force before it, which lands after the gap.
  return new Date(guess - offsetAt(guess - day, timezone));
}

// --- date helpers (pure calendar arithmetic on ISO dates) ------------------------

function parseDate(date: string): [number, number, number] {
  return date.split("-").map(Number) as [number, number, number];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Weekday index 0 = Monday .. 6 = Sunday. */
function weekdayIndex(date: string): number {
  const [y, m, d] = parseDate(date);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function daysBetweenDates(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = parseDate(s);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** Dates (ascending) of the rule, lazily, without UNTIL/COUNT handling. */
function* ruleDates(rule: SeriesRule): Generator<string> {
  const { startDate, interval } = rule;
  if (rule.freq === "daily") {
    for (let k = 0; ; k++) yield addDays(startDate, k * interval);
  } else if (rule.freq === "weekly") {
    const days = [...(rule.byDay && rule.byDay.length > 0 ? rule.byDay : [RULE_WEEKDAYS[weekdayIndex(startDate)]!])].map((d) => RULE_WEEKDAYS.indexOf(d)).sort((a, b) => a - b);
    const weekStart = addDays(startDate, -weekdayIndex(startDate));
    for (let k = 0; ; k++) {
      for (const day of days) {
        const date = addDays(weekStart, k * interval * 7 + day);
        if (date >= startDate) yield date;
      }
    }
  } else {
    const [sy, sm, sd] = parseDate(startDate);
    for (let k = 0; ; k++) {
      const total = sm - 1 + k * interval;
      const y = sy + Math.floor(total / 12);
      const m = (total % 12) + 1;
      let date: string | null = null;
      if (rule.bySetPos !== null && rule.bySetPos !== undefined) {
        const wd = RULE_WEEKDAYS.indexOf(rule.byDay![0]!);
        const dim = daysInMonth(y, m);
        const first = weekdayIndex(isoDate(y, m, 1));
        const firstDay = 1 + ((wd - first + 7) % 7);
        const day = rule.bySetPos > 0 ? firstDay + (rule.bySetPos - 1) * 7 : firstDay + Math.floor((dim - firstDay) / 7) * 7;
        if (day <= dim) date = isoDate(y, m, day);
      } else if (sd <= daysInMonth(y, m)) {
        date = isoDate(y, m, sd);
      }
      if (date !== null && date >= startDate) yield date;
    }
  }
}

function occurrenceOf(rule: SeriesRule, date: string): Occurrence {
  const { timezone } = rule;
  if (rule.allDay) {
    const startsAt = zonedToUtc(date, "00:00:00", timezone);
    const endsAt = zonedToUtc(addDays(date, Math.max(1, rule.durationDays ?? 1) - 1), "23:59:59", timezone);
    return { originalStartsAt: startsAt, startsAt, endsAt, localDate: date };
  }
  const startsAt = zonedToUtc(date, rule.startTime!, timezone);
  const endsAt = rule.durationMinutes === null || rule.durationMinutes === undefined ? null : new Date(startsAt.getTime() + rule.durationMinutes * 60_000);
  return { originalStartsAt: startsAt, startsAt, endsAt, localDate: date };
}

/**
 * Expands `rule` up to `options.until`. Throws `Error` for an invalid rule (callers validate first with `validateRule`).
 * The result is deterministic: the same rule and options always give the same list.
 */
export function expandSeries(rule: SeriesRule, options: ExpandOptions): ExpandResult {
  const problems = validateRule(rule);
  if (problems.length > 0) throw new Error(`invalid series rule: ${problems.join("; ")}`);
  const limit = options.limit ?? 1000;
  const occurrences: Occurrence[] = [];
  const skippedHolidays: SkippedOccurrence[] = [];
  const untilMs = options.until.getTime();
  const fromMs = options.from?.getTime() ?? -Infinity;
  let produced = 0;
  let finished = false;

  for (const date of ruleDates(rule)) {
    if ((rule.untilDate && date > rule.untilDate) || (rule.count && produced >= rule.count)) {
      finished = true;
      break;
    }
    if (daysBetweenDates(rule.startDate, date) > MAX_SCAN_DAYS * 3) break;
    const occ = occurrenceOf(rule, date);
    if (occ.startsAt.getTime() > untilMs) break;
    produced++;
    if (occ.startsAt.getTime() < fromMs) continue;
    if (options.exceptions?.has(date)) continue;
    const holiday = rule.skipHolidays ? holidayOn(date, rule.state) : null;
    if (holiday) {
      skippedHolidays.push({ originalStartsAt: occ.originalStartsAt, localDate: date, holiday });
      continue;
    }
    occurrences.push(occ);
    if (occurrences.length >= limit) break;
  }
  if (!finished && rule.count && produced >= rule.count) finished = true;
  return { occurrences, skippedHolidays, finished, produced };
}
