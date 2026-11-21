import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubPlatformStatus } from "../db/schema/club-platform.js";
import { AppError } from "./errors.js";

/**
 * Platform suspension of a club (Wave 15 B7). `clubGuard` calls `assertClubNotSuspended` for every club route; the public
 * endpoints (club page, lead form, search, guest event links, calendar feeds) treat a suspended club as non-existent.
 */

export interface Suspension {
  suspendedAt: Date;
  note: string | null;
}

export async function suspensionOf(clubId: string): Promise<Suspension | null> {
  const [row] = await db.select({ suspendedAt: clubPlatformStatus.suspendedAt, note: clubPlatformStatus.suspensionNote }).from(clubPlatformStatus).where(eq(clubPlatformStatus.clubId, clubId)).limit(1);
  return row?.suspendedAt ? { suspendedAt: row.suspendedAt, note: row.note } : null;
}

export async function isClubSuspended(clubId: string): Promise<boolean> {
  return (await suspensionOf(clubId)) !== null;
}

/** Ids of the given clubs that are suspended (one query for lists). */
export async function suspendedClubIds(clubIds: readonly string[]): Promise<Set<string>> {
  if (clubIds.length === 0) return new Set();
  const rows = await db
    .select({ clubId: clubPlatformStatus.clubId })
    .from(clubPlatformStatus)
    .where(and(inArray(clubPlatformStatus.clubId, [...clubIds]), isNotNull(clubPlatformStatus.suspendedAt)));
  return new Set(rows.map((r) => r.clubId));
}

export class ClubSuspendedError extends AppError {
  constructor(suspension: Suspension) {
    super("CLUB_SUSPENDED", 403, "This club has been suspended by the platform", { details: { code: "club_suspended", suspendedAt: suspension.suspendedAt.toISOString(), note: suspension.note } });
    this.name = "ClubSuspendedError";
  }
}

/** `403 CLUB_SUSPENDED` (with the member-facing note) while the club is suspended. */
export async function assertClubNotSuspended(clubId: string): Promise<void> {
  const suspension = await suspensionOf(clubId);
  if (suspension) throw new ClubSuspendedError(suspension);
}

/** Manual check link to the register portal (E4): no automatic register query, the admin compares by hand. */
export const DEFAULT_REGISTER_PORTAL_URL = "https://www.handelsregister.de/rp_web/erweitertesuche.xhtml";

/** `REGISTER_PORTAL_URL` if it is a well-formed `https:` URL, otherwise (unset, `http:`, `javascript:`, garbage) the default. */
export function registerPortalUrl(): string {
  const raw = process.env.REGISTER_PORTAL_URL?.trim();
  if (!raw) return DEFAULT_REGISTER_PORTAL_URL;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname ? url.toString() : DEFAULT_REGISTER_PORTAL_URL;
  } catch {
    return DEFAULT_REGISTER_PORTAL_URL;
  }
}

export function registerCheckOf(reg: { registerCourt: string | null; registerNumber: string | null } | null | undefined) {
  if (!reg || (!reg.registerCourt && !reg.registerNumber)) return null;
  return { portalUrl: registerPortalUrl(), court: reg.registerCourt, number: reg.registerNumber };
}
