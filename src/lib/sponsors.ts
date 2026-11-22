import { and, asc, eq, inArray } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { sponsorContacts, sponsors, type SponsorContactRow, type SponsorRow } from "../db/schema/sponsors.js";
import { envInt } from "./rate-limits.js";
import { signedMediaUrls } from "./media.js";
import { NotFoundError } from "./errors.js";

/**
 * Sponsors and partners (Wave 15 B1). Status and "expiring soon" are derived at read time from the Berlin calendar day, so a
 * contract that ran out yesterday is `abgelaufen` today without any job. Billing is not part of MyVerein: these rows describe
 * the partnership, never an amount owed.
 */

export const SPONSOR_STATUSES = ["geplant", "aktiv", "abgelaufen"] as const;
export type SponsorStatus = (typeof SPONSOR_STATUSES)[number];

/** `owner_type` of sponsor logos in `media_files`. */
export const SPONSOR_LOGO_OWNER = "sponsor_logo";

/** Days before `ends_on` from which an active sponsor counts as "expiring soon" (`SPONSOR_EXPIRING_DAYS`, default 60). */
export const expiringWindowDays = (): number => envInt("SPONSOR_EXPIRING_DAYS", 60, 1, 365);

export function sponsorStatus(row: Pick<SponsorRow, "startsOn" | "endsOn">, today: string): SponsorStatus {
  if (row.startsOn && row.startsOn > today) return "geplant";
  if (row.endsOn && row.endsOn < today) return "abgelaufen";
  return "aktiv";
}

const DAY_MS = 86_400_000;
const dayDiff = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Days until the last day of the partnership (0 = ends today), null without an end date or when not active. */
export function daysLeft(row: Pick<SponsorRow, "startsOn" | "endsOn">, today: string): number | null {
  if (!row.endsOn || sponsorStatus(row, today) !== "aktiv") return null;
  return dayDiff(today, row.endsOn);
}

export function isExpiringSoon(row: Pick<SponsorRow, "startsOn" | "endsOn">, today: string, windowDays = expiringWindowDays()): boolean {
  const left = daysLeft(row, today);
  return left !== null && left <= windowDays;
}

export async function loadSponsor(clubId: string, id: string): Promise<SponsorRow> {
  const row = await db.query.sponsors.findFirst({ where: and(eq(sponsors.id, id), eq(sponsors.clubId, clubId)) });
  if (!row) throw new NotFoundError("Sponsor not found");
  return row;
}

export function shapeContact(c: SponsorContactRow) {
  return { id: c.id, name: c.name, role: c.role, email: c.email, phone: c.phone, isPrimary: c.isPrimary, createdAt: c.createdAt };
}

/**
 * The board view of sponsors (`sponsors:read`): everything incl. contacts and internal notes, the logo as a short-lived
 * signed URL. Call only after the permission check.
 */
export async function shapeSponsors(clubId: string, rows: SponsorRow[], today: string) {
  if (rows.length === 0) return [];
  const [urls, contacts, accounts] = await Promise.all([
    signedMediaUrls(clubId, rows.map((r) => r.logoKey), SPONSOR_LOGO_OWNER),
    db.select().from(sponsorContacts).where(inArray(sponsorContacts.sponsorId, rows.map((r) => r.id))).orderBy(asc(sponsorContacts.createdAt), asc(sponsorContacts.id)),
    linkedAccounts(rows),
  ]);
  const byId = new Map<string, SponsorContactRow[]>();
  for (const c of contacts) byId.set(c.sponsorId, [...(byId.get(c.sponsorId) ?? []), c]);
  const window = expiringWindowDays();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    website: r.website,
    description: r.description,
    consideration: r.consideration,
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    visibility: r.visibility,
    notes: r.notes,
    status: sponsorStatus(r, today),
    expiringSoon: isExpiringSoon(r, today, window),
    daysLeft: daysLeft(r, today),
    logoUrl: r.logoKey ? (urls.get(r.logoKey) ?? null) : null,
    contacts: (byId.get(r.id) ?? []).map(shapeContact),
    linkedAccount: r.linkedMemberId ? (accounts.get(r.linkedMemberId) ?? null) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** Name of the external login linked to a sponsor (Wave 15 B2); empty until one is linked. */
async function linkedAccounts(rows: SponsorRow[]): Promise<Map<string, { memberId: string; name: string }>> {
  const ids = [...new Set(rows.map((r) => r.linkedMemberId).filter((v): v is string => v !== null))];
  const out = new Map<string, { memberId: string; name: string }>();
  if (ids.length === 0) return out;
  const found = await db.select({ memberId: member.id, name: user.name }).from(member).innerJoin(user, eq(user.id, member.userId)).where(inArray(member.id, ids));
  for (const m of found) out.set(m.memberId, { memberId: m.memberId, name: m.name });
  return out;
}
