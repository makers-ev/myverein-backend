/**
 * Club KPIs (Wave 7 B11): pure aggregation over already loaded rows so the numbers can be tested against reference
 * data with a fixed `today`. The output holds counts only -- never a name, id of a person or birth date.
 *
 * Counting rules (documented in the README):
 * - A member counts independent of whether they have an account (ADR-003).
 * - `members.total` = members whose EFFECTIVE status is probe, aktiv or ruhend ("Mitgliederzahl"); interessent and
 *   everybody who left are not counted. `byStatus` lists all seven effective statuses (zeros included) for the whole
 *   history of the club. byCategory/byDepartment/ageBuckets describe the counted population.
 * - Effective status = stored status, except `left_at <= today` => `ausgetreten` (see member-lifecycle.ts).
 */
import { COUNTED_STATUSES, ageOn, effectiveStatus, isLeftStatus } from "./member-lifecycle.js";
import { MEMBER_STATUSES } from "../db/schema/club-members.js";

export const AGE_BUCKETS = [
  { label: "0–5", max: 5 },
  { label: "6–12", max: 12 },
  { label: "13–17", max: 17 },
  { label: "18–29", max: 29 },
  { label: "30–49", max: 49 },
  { label: "50–64", max: 64 },
  { label: "65+", max: Infinity },
] as const;

export interface StatsMember {
  id: string;
  memberId: string | null;
  status: string;
  joinedAt: string;
  leftAt: string | null;
  birthDate: string | null;
  categoryId: string | null;
}

export interface ClubStatsInput {
  members: StatsMember[];
  categories: Array<{ id: string; key: string; name: string; archivedAt: Date | null }>;
  departments: Array<{ id: string; name: string }>;
  assignments: Array<{ clubMemberId: string; departmentId: string; until: string | null }>;
  /** History rows whose target status is a "left" status (exits), used for members who were reopened later. */
  exits: Array<{ clubMemberId: string; effectiveOn: string }>;
}

export interface ClubStats {
  members: { total: number; active: number; withAccount: number; withoutAccount: number };
  byStatus: Record<string, number>;
  byCategory: Array<{ key: string; name: string; count: number }>;
  byDepartment: Array<{ id: string; name: string; count: number }>;
  ageBuckets: Array<{ label: string; count: number }>;
  ageUnknown: number;
  movement: Array<{ month: string; joined: number; left: number }>;
}

/** The last `count` months ending with the month of `today`, oldest first, as `YYYY-MM`. */
export function lastMonths(today: string, count = 12): string[] {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

export function computeClubStats(input: ClubStatsInput, today: string): ClubStats {
  const byStatus: Record<string, number> = Object.fromEntries(MEMBER_STATUSES.map((s) => [s, 0]));
  const counted = new Map<string, StatsMember>();
  const currentlyLeft = new Set<string>();

  for (const m of input.members) {
    const status = effectiveStatus(m, today);
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if ((COUNTED_STATUSES as readonly string[]).includes(status)) counted.set(m.id, m);
    if (isLeftStatus(status)) currentlyLeft.add(m.id);
  }

  let withAccount = 0;
  for (const m of counted.values()) if (m.memberId !== null) withAccount += 1;

  const categoryCounts = new Map<string, number>();
  const ageCounts = AGE_BUCKETS.map(() => 0);
  let ageUnknown = 0;
  for (const m of counted.values()) {
    if (m.categoryId) categoryCounts.set(m.categoryId, (categoryCounts.get(m.categoryId) ?? 0) + 1);
    if (m.birthDate === null) {
      ageUnknown += 1;
    } else {
      const age = Math.max(0, ageOn(m.birthDate, today));
      ageCounts[AGE_BUCKETS.findIndex((b) => age <= b.max)]! += 1;
    }
  }

  const departmentMembers = new Map<string, Set<string>>();
  for (const a of input.assignments) {
    if (!counted.has(a.clubMemberId)) continue;
    if (a.until !== null && a.until <= today) continue;
    const set = departmentMembers.get(a.departmentId) ?? new Set<string>();
    set.add(a.clubMemberId);
    departmentMembers.set(a.departmentId, set);
  }

  const months = lastMonths(today);
  const first = months[0]!;
  const movement = new Map(months.map((month) => [month, { month, joined: 0, left: 0 }]));
  const bump = (date: string, field: "joined" | "left") => {
    if (date > today) return;
    const row = movement.get(date.slice(0, 7));
    if (row && date.slice(0, 7) >= first) row[field] += 1;
  };
  for (const m of input.members) {
    if (m.status !== "interessent") bump(m.joinedAt, "joined");
    if (currentlyLeft.has(m.id) && m.leftAt) bump(m.leftAt, "left");
  }
  // Exits of members who were reopened afterwards are no longer visible in left_at; the history keeps them.
  for (const e of input.exits) if (!currentlyLeft.has(e.clubMemberId)) bump(e.effectiveOn, "left");

  return {
    members: { total: counted.size, active: byStatus["aktiv"] ?? 0, withAccount, withoutAccount: counted.size - withAccount },
    byStatus,
    byCategory: input.categories
      .map((c) => ({ key: c.key, name: c.name, count: categoryCounts.get(c.id) ?? 0, archived: c.archivedAt !== null }))
      .filter((c) => !c.archived || c.count > 0)
      .map(({ key, name, count }) => ({ key, name, count })),
    byDepartment: input.departments.map((d) => ({ id: d.id, name: d.name, count: departmentMembers.get(d.id)?.size ?? 0 })),
    ageBuckets: AGE_BUCKETS.map((b, i) => ({ label: b.label, count: ageCounts[i]! })),
    ageUnknown,
    movement: months.map((month) => movement.get(month)!),
  };
}
