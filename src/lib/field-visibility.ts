import { inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { memberFieldVisibility } from "../db/schema/privacy.js";

/**
 * Visibility per field (Wave 10 B12, minimal): a person (or the guardian of a child) chooses who besides the board may see
 * their phone, e-mail, address and photo. Default and fallback is the most restrictive level `nur_vorstand`: without a row
 * nothing changes compared to before (only the person themself, `members:write` and `members:read_sensitive` see the data).
 *
 * - `nur_vorstand`: nobody besides the board and the person
 * - `trainer`: additionally trainers / department leads
 * - `mitglieder`: additionally every club member (and the guardians of children in the same department, for trainer contacts)
 */
export const VISIBILITY_FIELDS = ["phone", "email", "address", "photo"] as const;
export type VisibilityField = (typeof VISIBILITY_FIELDS)[number];
export const VISIBILITY_LEVELS = ["nur_vorstand", "trainer", "mitglieder"] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];
export type FieldLevels = Record<VisibilityField, VisibilityLevel>;

/** Who is looking: `trainer` also covers department leads; guests (guardians) are `member` only for their ward's trainers. */
export type Viewer = "member" | "trainer";

const NEED: Record<VisibilityLevel, number> = { nur_vorstand: 3, trainer: 2, mitglieder: 1 };
const HAS: Record<Viewer, number> = { trainer: 2, member: 1 };

export function levelAllows(level: VisibilityLevel, viewer: Viewer | undefined): boolean {
  return viewer !== undefined && HAS[viewer] >= NEED[level];
}

export const DEFAULT_LEVELS: FieldLevels = { phone: "nur_vorstand", email: "nur_vorstand", address: "nur_vorstand", photo: "nur_vorstand" };

/** Levels of the given club members (restrictive default for fields without a row). */
export async function levelsOf(clubMemberIds: string[]): Promise<Map<string, FieldLevels>> {
  const out = new Map<string, FieldLevels>();
  if (clubMemberIds.length === 0) return out;
  const rows = await db.select().from(memberFieldVisibility).where(inArray(memberFieldVisibility.clubMemberId, clubMemberIds));
  for (const row of rows) {
    const levels = out.get(row.clubMemberId) ?? { ...DEFAULT_LEVELS };
    levels[row.field as VisibilityField] = row.level as VisibilityLevel;
    out.set(row.clubMemberId, levels);
  }
  return out;
}

export async function levelsFor(clubMemberId: string): Promise<FieldLevels> {
  return (await levelsOf([clubMemberId])).get(clubMemberId) ?? { ...DEFAULT_LEVELS };
}
