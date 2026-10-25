/**
 * Public holidays in Germany, computed in code (Wave 12, ADR-009 (e)): the nationwide ones plus the holidays of a federal
 * state. Dates are ISO `YYYY-MM-DD` strings (calendar dates, no time zone involved). School holidays are deliberately not covered.
 * Holidays that only apply to parts of a state (e.g. Fronleichnam in some municipalities of Saxony / Thuringia, Mariä Himmelfahrt
 * in Bavaria's non-catholic municipalities) follow the common rule: the state counts as a whole when the majority is affected.
 */

export const GERMAN_STATES = ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"] as const;
export type GermanState = (typeof GERMAN_STATES)[number];

export function isGermanState(value: string): value is GermanState {
  return (GERMAN_STATES as readonly string[]).includes(value);
}

/** Easter Sunday of `year` (Gregorian, Meeus/Jones/Butcher). */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(year, month, day);
}

function iso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function shift(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return iso(y, m, d + days);
}

/** Buß- und Bettag: the Wednesday before 23 November. */
function bussUndBettag(year: number): string {
  const nov23 = new Date(Date.UTC(year, 10, 23));
  const back = ((nov23.getUTCDay() - 3 + 7) % 7) || 7;
  return iso(year, 11, 23 - back);
}

/** Holidays of `year` as `date -> name` (German names, shown in the series preview). `state` null/unknown = nationwide only. */
export function holidaysOf(year: number, state?: string | null): Map<string, string> {
  const st = state && isGermanState(state) ? state : null;
  const easter = easterSunday(year);
  const out = new Map<string, string>([
    [iso(year, 1, 1), "Neujahr"],
    [shift(easter, -2), "Karfreitag"],
    [shift(easter, 1), "Ostermontag"],
    [iso(year, 5, 1), "Tag der Arbeit"],
    [shift(easter, 39), "Christi Himmelfahrt"],
    [shift(easter, 50), "Pfingstmontag"],
    [iso(year, 10, 3), "Tag der Deutschen Einheit"],
    [iso(year, 12, 25), "1. Weihnachtstag"],
    [iso(year, 12, 26), "2. Weihnachtstag"],
  ]);
  if (!st) return out;
  const add = (states: readonly GermanState[], date: string, name: string) => {
    if (states.includes(st)) out.set(date, name);
  };
  add(["BW", "BY", "ST"], iso(year, 1, 6), "Heilige Drei Könige");
  add(["BE", "MV"], iso(year, 3, 8), "Internationaler Frauentag");
  add(["BB"], easter, "Ostersonntag");
  add(["BB"], shift(easter, 49), "Pfingstsonntag");
  add(["BW", "BY", "HE", "NW", "RP", "SL"], shift(easter, 60), "Fronleichnam");
  add(["BY", "SL"], iso(year, 8, 15), "Mariä Himmelfahrt");
  add(["TH"], iso(year, 9, 20), "Weltkindertag");
  add(["BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"], iso(year, 10, 31), "Reformationstag");
  add(["BW", "BY", "NW", "RP", "SL"], iso(year, 11, 1), "Allerheiligen");
  add(["SN"], bussUndBettag(year), "Buß- und Bettag");
  return out;
}

/** Name of the holiday on `date` (`YYYY-MM-DD`) or null. */
export function holidayOn(date: string, state?: string | null): string | null {
  return holidaysOf(Number(date.slice(0, 4)), state).get(date) ?? null;
}
