import { addDays, localDate } from "./club-time.js";
import { expandSeries, offsetAt, zonedToUtc, type RuleWeekday, type SeriesRule } from "./recurrence.js";

/**
 * Hand-built RFC 5545 writer -- no npm dependency (the repo has none for ICS). Single events are written in UTC (all-day
 * events as `VALUE=DATE`); event series become ONE master `VEVENT` with `RRULE` + `EXDATE` in the series' time zone
 * (`TZID` + generated `VTIMEZONE`, so "18:00" stays 18:00 across daylight saving in the subscriber's calendar app), and
 * overridden or cancelled occurrences become `VEVENT`s with the same `UID` and a `RECURRENCE-ID`. A series whose stored
 * occurrences no longer follow its current rule (e.g. the rule was changed for the future only) is exported as individual
 * events instead, so the feed never shows days that do not exist in MyVerein. Lines are folded at 75 octets.
 */

export interface IcsEventInput {
  id: string;
  title: string;
  description?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  cancelled?: boolean;
  allDay?: boolean;
  /** Plain text of the place (name, address); never access notes. */
  location?: string | null;
  updatedAt?: Date;
  /** Series occurrence: the rule instant and whether it was edited on its own. */
  seriesId?: string | null;
  originalStartsAt?: Date | null;
  isOverride?: boolean;
}

export interface IcsSeriesInput {
  id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  timezone: string;
  allDay: boolean;
  startDate: string;
  startTime: string | null;
  durationMinutes: number | null;
  durationDays: number;
  freq: string;
  interval: number;
  byDay: string[] | null;
  bySetPos: number | null;
  untilDate: string | null;
  count: number | null;
  skipHolidays: boolean;
  horizonUntil: Date;
  updatedAt?: Date;
  /** Rule instants that do not take place (dropped or holiday-skipped). */
  excluded: Date[];
}

export interface IcsOptions {
  series?: IcsSeriesInput[];
  /** Used for DTSTAMP (default: now). The feed passes the latest change so the output is stable between changes. */
  stamp?: Date;
  calendarName?: string;
  /** Zone for all-day single events (their dates are club-local). */
  timezone?: string;
}

const CRLF = "\r\n";

/** Escapes text values per RFC 5545 §3.3.11 (backslash, comma, semicolon, newlines incl. a lone CR). */
export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\r\n|\r|\n/g, "\\n");
}

/** Folds a content line at 75 octets (UTF-8), never inside a multi-byte character; continuation lines start with one space. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > limit) {
      parts.push(current);
      current = "";
      bytes = 0;
      limit = 74; // the leading space of a continuation line counts
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join(CRLF + " ");
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function utc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function compactDate(date: string): string {
  return date.replace(/-/g, "");
}

const localFormatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYYMMDDTHHMMSS` of the instant on the wall clock of `timezone`. */
function local(date: Date, timezone: string): string {
  let f = localFormatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    localFormatters.set(timezone, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${pad2(Number(p.hour) % 24)}${p.minute}${p.second}`;
}

function offsetText(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const abs = Math.abs(ms) / 60_000;
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

const vtimezoneCache = new Map<string, string[]>();

/**
 * `VTIMEZONE` with the zone's offset changes from last year to ten years ahead as explicit observances (found by scanning the
 * zone's offset weekly and bisecting to the minute), so it works for every IANA zone without a rule table.
 */
export function vtimezone(timezone: string, now: Date = new Date()): string[] {
  const year = now.getUTCFullYear();
  const key = `${timezone}:${year}`;
  const cached = vtimezoneCache.get(key);
  if (cached) return cached;
  const start = Date.UTC(year - 1, 0, 1);
  const end = Date.UTC(year + 10, 0, 1);
  const week = 7 * 86_400_000;
  const nameFormatter = new Intl.DateTimeFormat("de-DE", { timeZone: timezone, timeZoneName: "short" });
  const nameAt = (ms: number) => nameFormatter.formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName")?.value ?? timezone;
  const base = offsetAt(start, timezone);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${timezone}`];
  const transitions: Array<{ at: number; from: number; to: number }> = [];
  let prevMs = start;
  let prevOffset = base;
  for (let t = start + week; t <= end; t += week) {
    const o = offsetAt(t, timezone);
    if (o !== prevOffset) {
      let lo = prevMs;
      let hi = t;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(mid, timezone) === prevOffset) lo = mid;
        else hi = mid;
      }
      transitions.push({ at: hi, from: prevOffset, to: o });
      prevOffset = o;
    }
    prevMs = t;
  }
  // The offset in force at the start of the scan (valid "forever before" the first transition).
  lines.push("BEGIN:STANDARD", `DTSTART:${local(new Date(start), timezone)}`, `TZOFFSETFROM:${offsetText(base)}`, `TZOFFSETTO:${offsetText(base)}`, `TZNAME:${nameAt(start)}`, "END:STANDARD");
  for (const tr of transitions) {
    const daylight = tr.to > tr.from;
    const kind = daylight ? "DAYLIGHT" : "STANDARD";
    // DTSTART is the local time BEFORE the switch (offset `from`).
    const wall = local(new Date(tr.at + tr.from), "UTC");
    lines.push(`BEGIN:${kind}`, `DTSTART:${wall}`, `TZOFFSETFROM:${offsetText(tr.from)}`, `TZOFFSETTO:${offsetText(tr.to)}`, `TZNAME:${nameAt(tr.at + 1000)}`, `END:${kind}`);
  }
  lines.push("END:VTIMEZONE");
  vtimezoneCache.set(key, lines);
  return lines;
}

function rruleOf(s: IcsSeriesInput): string {
  const parts = [`FREQ=${s.freq.toUpperCase()}`];
  if (s.interval > 1) parts.push(`INTERVAL=${s.interval}`);
  if (s.freq === "weekly") {
    parts.push(`BYDAY=${(s.byDay ?? []).join(",")}`, "WKST=MO");
  } else if (s.freq === "monthly") {
    if (s.bySetPos !== null && s.byDay && s.byDay[0]) parts.push(`BYDAY=${s.bySetPos}${s.byDay[0]}`);
    else parts.push(`BYMONTHDAY=${Number(s.startDate.slice(8, 10))}`);
  }
  // With skipped holidays the rule must not run past the days that were checked, or the holidays beyond the horizon reappear.
  const limit = s.skipHolidays && !s.count ? s.horizonUntil : null;
  if (s.count) parts.push(`COUNT=${s.count}`);
  else if (s.untilDate || limit) {
    const untilDay = s.untilDate ? zonedToUtc(s.untilDate, "23:59:59", s.timezone) : null;
    const upTo = untilDay && limit ? (untilDay < limit ? untilDay : limit) : (untilDay ?? limit)!;
    parts.push(s.allDay ? `UNTIL=${compactDate(localDate(upTo, s.timezone))}` : `UNTIL=${utc(upTo)}`);
  }
  return parts.join(";");
}

function seriesRule(s: IcsSeriesInput): SeriesRule {
  return { freq: s.freq as SeriesRule["freq"], interval: s.interval, byDay: s.byDay as RuleWeekday[] | null, bySetPos: s.bySetPos, startDate: s.startDate, startTime: s.startTime, allDay: s.allDay, durationMinutes: s.durationMinutes, durationDays: s.durationDays, timezone: s.timezone, untilDate: s.untilDate, count: s.count };
}

/** Whether the stored occurrences of `s` are exactly what its rule produces (minus excluded days), so a single RRULE tells the truth. */
function followsRule(s: IcsSeriesInput, stored: IcsEventInput[]): { first: Date } | null {
  const instants = stored.flatMap((e) => (e.originalStartsAt ? [e.originalStartsAt.getTime()] : []));
  if (instants.length === 0) return null;
  const last = Math.max(...instants);
  const expected = expandSeries(seriesRule(s), { until: new Date(last), limit: 5000 }).occurrences.map((o) => o.originalStartsAt.getTime());
  const excluded = new Set(s.excluded.map((d) => d.getTime()));
  const want = expected.filter((t) => !excluded.has(t));
  const have = [...new Set(instants)].sort((a, b) => a - b);
  if (want.length !== have.length || want.some((t, i) => t !== have[i])) return null;
  const first = expandSeries(seriesRule(s), { until: new Date(Math.max(last, s.horizonUntil.getTime())), limit: 1 }).occurrences[0];
  return first ? { first: first.originalStartsAt } : null;
}

function prop(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

function singleEvent(e: IcsEventInput, stamp: string, timezone: string, extra: string[] = [], uid = `${e.id}@myverein`): string[] {
  const lines = ["BEGIN:VEVENT", prop("UID", uid), `DTSTAMP:${stamp}`, ...extra];
  if (e.allDay) {
    const startDay = localDate(e.startsAt, timezone);
    const lastDay = e.endsAt ? localDate(e.endsAt, timezone) : startDay;
    lines.push(`DTSTART;VALUE=DATE:${compactDate(startDay)}`, `DTEND;VALUE=DATE:${compactDate(addDays(lastDay < startDay ? startDay : lastDay, 1))}`);
  } else {
    lines.push(`DTSTART:${utc(e.startsAt)}`);
    if (e.endsAt) lines.push(`DTEND:${utc(e.endsAt)}`);
  }
  if (e.updatedAt) lines.push(`LAST-MODIFIED:${utc(e.updatedAt)}`);
  if (e.cancelled) lines.push("STATUS:CANCELLED");
  lines.push(prop("SUMMARY", escapeIcsText(e.title)));
  if (e.description) lines.push(prop("DESCRIPTION", escapeIcsText(e.description)));
  if (e.location) lines.push(prop("LOCATION", escapeIcsText(e.location)));
  lines.push("END:VEVENT");
  return lines;
}

function dateTimeProp(name: string, instantLocal: string, s: { timezone: string; allDay: boolean }, valueDate: string): string {
  return s.allDay ? `${name};VALUE=DATE:${valueDate}` : `${name};TZID=${s.timezone}:${instantLocal}`;
}

function masterEvent(s: IcsSeriesInput, first: Date, stamp: string): string[] {
  const firstLocal = local(first, s.timezone);
  const firstDay = localDate(first, s.timezone);
  const lines = ["BEGIN:VEVENT", prop("UID", `series-${s.id}@myverein`), `DTSTAMP:${stamp}`, dateTimeProp("DTSTART", firstLocal, s, compactDate(firstDay))];
  if (s.allDay) lines.push(`DTEND;VALUE=DATE:${compactDate(addDays(firstDay, Math.max(1, s.durationDays)))}`);
  else if (s.durationMinutes !== null) lines.push(`DTEND;TZID=${s.timezone}:${local(new Date(first.getTime() + s.durationMinutes * 60_000), s.timezone)}`);
  lines.push(prop("RRULE", rruleOf(s)));
  const ex = [...new Set(s.excluded.map((d) => d.getTime()))].sort((a, b) => a - b).filter((t) => t >= first.getTime());
  if (ex.length > 0) {
    const values = ex.map((t) => (s.allDay ? compactDate(localDate(new Date(t), s.timezone)) : local(new Date(t), s.timezone)));
    lines.push(foldLine(`${s.allDay ? "EXDATE;VALUE=DATE" : `EXDATE;TZID=${s.timezone}`}:${values.join(",")}`));
  }
  if (s.updatedAt) lines.push(`LAST-MODIFIED:${utc(s.updatedAt)}`);
  lines.push(prop("SUMMARY", escapeIcsText(s.title)));
  if (s.description) lines.push(prop("DESCRIPTION", escapeIcsText(s.description)));
  if (s.location) lines.push(prop("LOCATION", escapeIcsText(s.location)));
  lines.push("END:VEVENT");
  return lines;
}

export function buildIcs(events: IcsEventInput[], options: IcsOptions = {}): string {
  const stamp = utc(options.stamp ?? new Date());
  const clubZone = options.timezone ?? "Europe/Berlin";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MyVerein//DE", "CALSCALE:GREGORIAN"];
  if (options.calendarName) lines.push(prop("X-WR-CALNAME", escapeIcsText(options.calendarName)));

  const seriesById = new Map((options.series ?? []).map((s) => [s.id, s]));
  const bySeries = new Map<string, IcsEventInput[]>();
  const singles: IcsEventInput[] = [];
  for (const e of events) {
    if (e.seriesId && seriesById.has(e.seriesId)) bySeries.set(e.seriesId, [...(bySeries.get(e.seriesId) ?? []), e]);
    else singles.push(e);
  }

  const zones = new Set<string>();
  const body: string[] = [];
  for (const [seriesId, stored] of bySeries) {
    const s = seriesById.get(seriesId)!;
    const rule = followsRule(s, stored);
    if (!rule) {
      // The stored occurrences diverge from the current rule: honest individual events.
      singles.push(...stored);
      continue;
    }
    zones.add(s.timezone);
    body.push(...masterEvent(s, rule.first, stamp));
    for (const e of stored) {
      if (!e.isOverride && !e.cancelled) continue;
      const orig = e.originalStartsAt!;
      const recurrence = dateTimeProp("RECURRENCE-ID", local(orig, s.timezone), s, compactDate(localDate(orig, s.timezone)));
      body.push(...singleEvent(e, stamp, s.timezone, [recurrence], `series-${s.id}@myverein`));
    }
  }
  singles.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  for (const e of singles) body.push(...singleEvent(e, stamp, clubZone));

  for (const zone of zones) lines.push(...vtimezone(zone));
  lines.push(...body, "END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}
