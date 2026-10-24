import { addDays, localDate, localHour } from "../../lib/club-time.js";
import { subtractYears, todayBerlin } from "../../lib/member-lifecycle.js";

/**
 * Shared state and small helpers of the demo club seed (`npm run seed:demo`). The seed is split into one module per feature
 * area; every module reads and extends the same `DemoCtx`.
 */

export const DEFAULT_DEMO_SLUG = "demo-sportverein-wiesbach";
export const DEFAULT_DEMO_NAME = "Demo Sportverein Wiesbach e.V.";
export const DEFAULT_DEMO_DOMAIN = "demo.myverein.local";
export const DEFAULT_DEMO_PASSWORD = "Demo-Verein-2026!";
/** Value of `organization.metadata.demoSeed`: only a club carrying it is ever deleted or rewritten by the seed. */
export const DEMO_MARKER = "demoSeed";

export interface DemoOptions {
  slug: string;
  clubName: string;
  /** E-mail domain of every demo account (`vorsitz@<domain>`). */
  emailDomain: string;
  password: string;
  /** Delete the demo club (and only it) before seeding again. */
  reset: boolean;
  /** Allow running with NODE_ENV=production. */
  force: boolean;
  /** Suppress the progress log (tests). */
  quiet: boolean;
  /** Also create the one platform-level row of the seed (a draft processor agreement). Tests switch it off. */
  platformData: boolean;
}

/** One demo account (Better Auth user) and what it stands for. */
export interface Person {
  key: string;
  email: string;
  name: string;
  /** Short description of the purpose of this login for the summary table / README. */
  purpose: string;
  /** `member.role` of the account membership; null = no membership in the demo club (platform admin, applicants). */
  orgRole: "owner" | "admin" | "member" | "guest" | null;
  /** Platform role (`user.role`). */
  platformRole: "admin" | "user";
  userId: string;
  /** `member.id` (account membership); empty without a membership. */
  memberId: string;
  /** `club_members.id`; empty without a membership. */
  clubMemberId: string;
}

export interface DemoCtx {
  opts: DemoOptions;
  clubId: string;
  /** ISO date of the seed run (Europe/Berlin). */
  today: string;
  now: Date;
  /** Accounts by key (`vorsitz`, `trainer`, ...). */
  people: Record<string, Person>;
  /** Club members by key (accounts and account-less members): `club_members.id`. */
  cm: Record<string, string>;
  /** Departments by key: `departments.id`. */
  dept: Record<string, string>;
  /** Member categories by key: `member_categories.id`. */
  cat: Record<string, string>;
  /** Locations by key: `locations.id`. */
  loc: Record<string, string>;
  /** Calendars by key: `calendars.id`. */
  cal: Record<string, string>;
  /** Events by key: `events.id`. */
  ev: Record<string, string>;
  /** Meetings by key: `meetings.id`. */
  meeting: Record<string, string>;
  /** Progress output (silent in tests). */
  log: (msg: string) => void;
}

export const accountOf = (ctx: DemoCtx, key: string): Person => {
  const p = ctx.people[key];
  if (!p) throw new Error(`demo account "${key}" is not defined`);
  return p;
};

export const clubMemberOf = (ctx: DemoCtx, key: string): string => {
  const id = ctx.cm[key];
  if (!id) throw new Error(`demo club member "${key}" is not defined`);
  return id;
};

export const emailOf = (opts: DemoOptions, localPart: string): string => `${localPart}@${opts.emailDomain}`;

export const todayIso = (now: Date = new Date()): string => todayBerlin(now);

/** ISO date `days` after (negative: before) the given ISO date. */
export const shiftDays = (date: string, days: number): string => addDays(date, days);

/** ISO date of `years` years and `extraDays` days before `today` (birth dates, entry dates). */
export const yearsAgo = (today: string, years: number, extraDays = 0): string => addDays(subtractYears(today, years), -extraDays);

/** ISO date that is `months` calendar months before `today` (day clamped). */
export function monthsAgo(today: string, months: number): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** The instant of `date` at `hhmm` wall-clock time in Europe/Berlin (DST aware). */
export function berlinTime(date: string, hhmm: string): Date {
  const [hh] = hhmm.split(":").map(Number) as [number];
  for (const offset of ["+01:00", "+02:00"]) {
    const candidate = new Date(`${date}T${hhmm}:00${offset}`);
    if (localDate(candidate, "Europe/Berlin") === date && localHour(candidate, "Europe/Berlin") === hh) return candidate;
  }
  return new Date(`${date}T${hhmm}:00+01:00`);
}

/** `date` plus `days` as an ISO weekday number (1 = Monday ... 7 = Sunday). */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The first date on or after `from` that falls on `weekday` (1 = Monday ... 7 = Sunday). */
export function nextWeekday(from: string, weekday: number): string {
  const diff = (weekday - isoWeekday(from) + 7) % 7;
  return addDays(from, diff);
}
