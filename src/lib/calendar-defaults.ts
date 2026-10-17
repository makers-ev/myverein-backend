import { and, asc, count, eq, ilike, isNull, ne, sql } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import { calendars, type CalendarRow } from "../db/schema/calendars.js";
import type { DbExecutor } from "./club-members.js";
import { IMPLICIT_ROLE_TYPE } from "./club-permissions.js";

/**
 * Standard club calendar (Wave 8 follow-up): every club owns a club-wide default calendar, so events can be created
 * from day one. Migration `0027` backfills exactly this shape for existing clubs; new clubs get it on creation
 * (approval flow, `seed:club`) and lazily via `ensureClubHasCalendar`.
 *
 * It carries ONE visibility grant, `roleType = mitglied`: every account member (the implicit role) sees it, while an
 * external guest (who does not hold `mitglied`, see `clubGuard`) does not -- a calendar without any grant would be
 * visible to guests, too (rule 1 of `calendar-visibility.ts`). Former members never reach the route (`clubGuard`).
 * The board (`calendars:write`) manages it like any other calendar.
 */
export const DEFAULT_CALENDAR_NAME = "Vereinskalender";

export type CalendarDefaultSource = "club_creation" | "lazy";

/** Serialises every writer that decides about the default / the number of calendars of one club (transaction-scoped). */
export async function lockClubCalendars(executor: DbExecutor, clubId: string): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`calendar-defaults:${clubId}`}, 0))`);
}

/** The account that is recorded as creator of a system-created calendar: the club's owner, else its earliest real member (never an external guest). */
async function founderUserId(executor: DbExecutor, clubId: string): Promise<string | null> {
  const rows = await executor
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, clubId), ne(member.role, "guest")))
    .orderBy(asc(member.createdAt), asc(member.id));
  return (rows.find((r) => r.role === "owner") ?? rows[0])?.userId ?? null;
}

/**
 * Idempotently gives the club a default calendar and returns it (null only for a club without any member, which has
 * nobody to record as creator). Atomic and race-safe: runs in one transaction under an advisory lock per club, so
 * parallel callers serialise and exactly one default exists afterwards. An existing default is left untouched; a club
 * that has calendars but no default promotes its club-wide calendar named "Vereinskalender" if there is one (no
 * duplicate name, its visibility stays as configured), otherwise a new one is created. Without a transaction handle
 * this opens one.
 */
export async function ensureDefaultCalendar(
  clubId: string,
  opts: { createdBy?: string; source?: CalendarDefaultSource; executor?: DbExecutor } = {},
): Promise<CalendarRow | null> {
  const executor = opts.executor ?? db;
  if (executor === db) return db.transaction((tx) => ensureDefaultCalendar(clubId, { ...opts, executor: tx }));
  await lockClubCalendars(executor, clubId);

  const [existing] = await executor.select().from(calendars).where(and(eq(calendars.clubId, clubId), eq(calendars.isDefault, true))).limit(1);
  if (existing) return existing;

  const [promotable] = await executor
    .select()
    .from(calendars)
    .where(and(eq(calendars.clubId, clubId), isNull(calendars.departmentId), ilike(calendars.name, DEFAULT_CALENDAR_NAME)))
    .orderBy(asc(calendars.createdAt), asc(calendars.id))
    .limit(1);
  if (promotable) {
    const [promoted] = await executor.update(calendars).set({ isDefault: true }).where(eq(calendars.id, promotable.id)).returning();
    await executor.insert(auditLog).values({ eventType: "calendar.default_create", subjectId: promotable.id, payload: { clubId, calendarId: promotable.id, source: opts.source ?? "lazy", promoted: true } });
    return promoted!;
  }

  const createdBy = (await founderUserId(executor, clubId)) ?? opts.createdBy ?? null;
  if (!createdBy) return null;
  const [created] = await executor.insert(calendars).values({ clubId, name: DEFAULT_CALENDAR_NAME, isDefault: true, createdBy }).returning();
  await executor.insert(calendarVisibility).values({ calendarId: created!.id, roleType: IMPLICIT_ROLE_TYPE });
  await executor.insert(auditLog).values({ eventType: "calendar.default_create", subjectId: created!.id, payload: { clubId, calendarId: created!.id, source: opts.source ?? "lazy" } });
  return created!;
}

/**
 * Lazy path for clubs that never got a calendar (created before the default existed, or by a path that skips it):
 * does nothing when the club has at least one calendar, else creates the default. Cheap check first, the locked
 * re-check happens inside `ensureDefaultCalendar`.
 */
export async function ensureClubHasCalendar(clubId: string, opts: { createdBy?: string; executor?: DbExecutor } = {}): Promise<void> {
  const executor = opts.executor ?? db;
  const [row] = await executor.select({ n: count() }).from(calendars).where(eq(calendars.clubId, clubId));
  if ((row?.n ?? 0) > 0) return;
  if (executor === db) {
    await db.transaction(async (tx) => {
      await lockClubCalendars(tx, clubId);
      const [again] = await tx.select({ n: count() }).from(calendars).where(eq(calendars.clubId, clubId));
      if ((again?.n ?? 0) === 0) await ensureDefaultCalendar(clubId, { ...opts, source: "lazy", executor: tx });
    });
    return;
  }
  await lockClubCalendars(executor, clubId);
  const [again] = await executor.select({ n: count() }).from(calendars).where(eq(calendars.clubId, clubId));
  if ((again?.n ?? 0) === 0) await ensureDefaultCalendar(clubId, { ...opts, source: "lazy", executor });
}
