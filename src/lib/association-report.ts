/**
 * Association report (Wave 15 B6, "Verbandsmeldung"): the member count of a club on a reference day, split by department
 * (Sparte), age group, gender and category, for the annual stock report to a sports federation. Pure aggregation over the
 * rows `loadClubStatsInput` already loads (so the counting basis is the one of `GET /club-stats`), plus the gender values
 * of one member custom field. The output holds counts only -- never a name, an id of a person or a birth date.
 *
 * Counting rules (README "Association report"):
 * - A member counts on the reference day if they joined on or before it, were not `interessent` and had not left by then
 *   (`left_at <= stichtag` means left, like the effective status of `member-lifecycle.ts`). Probe, aktiv and ruhend count.
 * - Department: an assignment counts when `since <= stichtag` and it had not ended (`until > stichtag` or open). A member in
 *   two departments counts in both when `department` is a column; `total` always counts every member once.
 * - Age: `jahrgang` = reference year minus birth year, `stichtag` = completed years on the reference day.
 */
import { ageOn, isLeftStatus } from "./member-lifecycle.js";
import type { ClubStatsInput } from "./club-stats.js";

export const REPORT_COLUMNS = ["department", "ageGroup", "gender", "category"] as const;
export type ReportColumn = (typeof REPORT_COLUMNS)[number];
export const AGE_MODES = ["jahrgang", "stichtag"] as const;
export type AgeMode = (typeof AGE_MODES)[number];

export const DEFAULT_COLUMNS: readonly ReportColumn[] = ["department", "ageGroup"];
export const DEFAULT_AGE_BANDS: readonly number[] = [6, 14, 18, 26, 40, 60];
export const UNKNOWN = "unbekannt";
export const NO_DEPARTMENT = "ohne Abteilung";
export const NO_CATEGORY = "ohne Kategorie";
const MAX_GENDER_LENGTH = 40;

export interface ReportRow {
  department?: string;
  ageGroup?: string;
  gender?: string;
  category?: string;
  count: number;
}

export interface AssociationReport {
  stichtag: string;
  columns: ReportColumn[];
  ageGroups: string[];
  ageMode: AgeMode;
  rows: ReportRow[];
  total: number;
  note: string;
}

export interface ReportOptions {
  stichtag: string;
  columns: readonly ReportColumn[];
  ageBands: readonly number[];
  ageMode: AgeMode;
  /** clubMemberId -> display value of the gender field (only needed for the `gender` column; missing = unbekannt). */
  genders?: ReadonlyMap<string, string>;
}

/** Labels of the age groups for ascending upper bounds, e.g. [6,14] -> `0-6`, `7-14`, `15+`. */
export function ageGroupLabels(bands: readonly number[]): string[] {
  const labels: string[] = [];
  let from = 0;
  for (const upper of bands) {
    labels.push(`${from}-${upper}`);
    from = upper + 1;
  }
  labels.push(`${from}+`);
  return labels;
}

/** Index of the age group `age` falls into. */
export function ageGroupIndex(age: number, bands: readonly number[]): number {
  const i = bands.findIndex((upper) => age <= upper);
  return i === -1 ? bands.length : i;
}

function ageFor(birthDate: string, stichtag: string, mode: AgeMode): number {
  const age = mode === "jahrgang" ? Number(stichtag.slice(0, 4)) - Number(birthDate.slice(0, 4)) : ageOn(birthDate, stichtag);
  return Math.max(0, age);
}

/** Normalises a gender cell value (free text / select value) for grouping. */
export function normalizeGender(value: string): string {
  const text = value.trim().replace(/\s+/g, " ").slice(0, MAX_GENDER_LENGTH);
  return text === "" ? UNKNOWN : text;
}

const collator = new Intl.Collator("de");

export function computeAssociationReport(input: ClubStatsInput, options: ReportOptions): AssociationReport {
  const { stichtag, ageBands, ageMode } = options;
  // Keep the order the caller asked for (column order in JSON and CSV).
  const ordered = [...new Set(options.columns)];
  const groups = ageGroupLabels(ageBands);
  const categoryNames = new Map(input.categories.map((c) => [c.id, c.name]));
  const categoryOrder = new Map(input.categories.map((c, i) => [c.name, i]));
  const deptNames = new Map(input.departments.map((d) => [d.id, d.name]));

  const present = input.members.filter((m) => m.status !== "interessent" && m.joinedAt <= stichtag && (m.leftAt === null ? !isLeftStatus(m.status) : m.leftAt > stichtag));

  const deptsOf = new Map<string, string[]>();
  if (ordered.includes("department")) {
    for (const a of input.assignments) {
      if ((a.since ?? "0000-01-01") > stichtag) continue;
      if (a.until !== null && a.until <= stichtag) continue;
      const name = deptNames.get(a.departmentId);
      if (name === undefined) continue;
      const list = deptsOf.get(a.clubMemberId) ?? [];
      if (!list.includes(name)) list.push(name);
      deptsOf.set(a.clubMemberId, list);
    }
  }

  const buckets = new Map<string, ReportRow>();
  for (const m of present) {
    const ageGroup = m.birthDate === null ? UNKNOWN : groups[ageGroupIndex(ageFor(m.birthDate, stichtag, ageMode), ageBands)]!;
    const gender = options.genders?.get(m.id) ?? UNKNOWN;
    const category = m.categoryId ? (categoryNames.get(m.categoryId) ?? NO_CATEGORY) : NO_CATEGORY;
    const departments = ordered.includes("department") ? (deptsOf.get(m.id) ?? [NO_DEPARTMENT]) : [undefined];
    for (const department of departments) {
      const row: ReportRow = { count: 0 };
      for (const col of ordered) {
        if (col === "department") row.department = department;
        if (col === "ageGroup") row.ageGroup = ageGroup;
        if (col === "gender") row.gender = gender;
        if (col === "category") row.category = category;
      }
      const key = ordered.map((col) => row[col] ?? "").join("\u0000");
      const bucket = buckets.get(key) ?? row;
      bucket.count += 1;
      buckets.set(key, bucket);
    }
  }

  const rank = (col: ReportColumn, row: ReportRow): [number, string] => {
    const v = row[col] ?? "";
    if (col === "ageGroup") return [v === UNKNOWN ? groups.length : groups.indexOf(v), ""];
    if (col === "category") return [categoryOrder.get(v) ?? Number.MAX_SAFE_INTEGER, v];
    return [v === UNKNOWN || v === NO_DEPARTMENT ? 1 : 0, v];
  };
  const rows = [...buckets.values()].sort((a, b) => {
    for (const col of ordered) {
      const [ra, sa] = rank(col, a);
      const [rb, sb] = rank(col, b);
      if (ra !== rb) return ra - rb;
      const cmp = collator.compare(sa, sb);
      if (cmp !== 0) return cmp;
    }
    return 0;
  });

  const note = ordered.includes("department")
    ? "Nur Zähldaten, keine Namen. Wer in mehreren Abteilungen ist, wird in jeder Abteilung gezählt; die Gesamtzahl zählt jedes Mitglied einmal."
    : "Nur Zähldaten, keine Namen. Die Gesamtzahl zählt jedes Mitglied einmal.";
  return { stichtag, columns: ordered, ageGroups: groups, ageMode, rows, total: present.length, note };
}

const HEADERS: Record<ReportColumn, string> = { department: "Abteilung", ageGroup: "Altersgruppe", gender: "Geschlecht", category: "Kategorie" };

/** Header and rows of the CSV (German headers, `Anzahl`, closing `Summe` row); cells are escaped by `buildCsv`. */
export function reportToCsvTable(report: AssociationReport): { header: string[]; rows: Array<Array<string | number>> } {
  const header = [...report.columns.map((c) => HEADERS[c]), "Anzahl"];
  const rows: Array<Array<string | number>> = report.rows.map((r) => [...report.columns.map((c) => r[c] ?? ""), r.count]);
  const sum: Array<string | number> = report.columns.map((_, i) => (i === 0 ? "Summe" : ""));
  sum.push(report.total);
  rows.push(sum);
  return { header, rows };
}
