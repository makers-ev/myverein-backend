/**
 * Earliest effective date of a cancellation (Wave 7 B6): today + notice period, then rounded UP to the end of the
 * month / quarter / year according to the club's `notice_mode`. Pure and timezone-free: callers pass the Europe/Berlin
 * calendar day (`todayBerlin()`), all dates are `YYYY-MM-DD` strings.
 *
 * - `immediate` (and no mode at all): no rounding, the date is `requestedOn + noticePeriodDays`.
 * - `month_end` / `quarter_end` / `year_end`: the first month / quarter / year END on or after that date. A date that
 *   already is such an end stays as it is (a notice period ending on 30 June with `month_end` is effective on 30 June).
 */
import { NOTICE_MODES, type NoticeMode } from "../db/schema/club-settings.js";

export { NOTICE_MODES, type NoticeMode };

const pad = (n: number) => String(n).padStart(2, "0");
const parts = (date: string) => date.split("-").map(Number) as [number, number, number];

/** `date` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Last day of the given month (`month` is 1-12). */
export function lastDayOfMonth(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
}

export function earliestExitDate(requestedOn: string, settings: { noticePeriodDays: number | null; noticeMode: string | null }): string {
  const base = addDays(requestedOn, settings.noticePeriodDays ?? 0);
  const [y, m] = parts(base);
  switch (settings.noticeMode) {
    case "month_end":
      return lastDayOfMonth(y, m);
    case "quarter_end":
      return lastDayOfMonth(y, Math.ceil(m / 3) * 3);
    case "year_end":
      return lastDayOfMonth(y, 12);
    default:
      return base;
  }
}
