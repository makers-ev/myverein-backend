import { sql } from "drizzle-orm";

import type { db } from "../db/client.js";

/** The transaction handle type `db.transaction(async (tx) => ...)` passes in. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** First 4 alphanumeric characters of the club slug, uppercased ("demo-sportverein" -> "DEMO"). Falls back to "CLUB". */
export function clubAbbreviation(slug: string | null | undefined): string {
  const abbr = (slug ?? "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
  return abbr || "CLUB";
}

/**
 * Next sequential member number for a club, e.g. "DEMO-0001".
 *
 * Locks the club's `organization` row (`FOR UPDATE`) for the rest of the
 * transaction so two concurrent approvals/first-time upserts can't read the
 * same number and hand out the same number. Must be called inside the same
 * transaction that inserts the `club_members` row.
 */
export async function nextMemberNumber(tx: DbTransaction, clubId: string): Promise<string> {
  const locked = await tx.execute<{ slug: string | null }>(sql`SELECT slug FROM organization WHERE id = ${clubId} FOR UPDATE`);
  const slug = locked.rows[0]?.slug ?? null;

  // A prefix from the club settings (letters/digits only, validated on write) wins over the slug abbreviation.
  const settings = await tx.execute<{ prefix: string | null }>(sql`SELECT member_number_prefix AS prefix FROM club_settings WHERE club_id = ${clubId}`);
  const configured = settings.rows[0]?.prefix?.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const abbr = configured || clubAbbreviation(slug);

  // Highest numeric suffix already handed out ("DEMO-0007" -> 7; at most 9 digits, longer suffixes are manual numbers and ignored so the cast can never overflow) or the plain `club_members` row count (account-less members included), whichever is larger: the
  // count alone would repeat a number once a member with a lower number was deleted.
  const stats = await tx.execute<{ count: string; max_suffix: string | null }>(sql`
    SELECT count(*)::text AS count,
           max(substring(cm.member_number FROM '^' || ${abbr} || '-([0-9]{1,9})$')::bigint)::text AS max_suffix
    FROM club_members cm
    WHERE cm.club_id = ${clubId}
  `);
  const count = Number(stats.rows[0]?.count ?? 0);
  const maxSuffix = Number(stats.rows[0]?.max_suffix ?? 0);

  return `${abbr}-${String(Math.max(count, maxSuffix) + 1).padStart(4, "0")}`;
}

/**
 * True if `number` has the automatic format of the club ("PREFIX-NNNN": `club_settings.member_number_prefix` or the slug
 * abbreviation, 1-9 digits). Used as a heuristic by the account merge: such a number was handed out by the system and may be
 * discarded, a manual or differently formatted number is data of the board.
 */
export async function isAutomaticMemberNumber(tx: DbTransaction | typeof db, clubId: string, number: string | null | undefined): Promise<boolean> {
  if (!number) return false;
  const org = await tx.execute<{ slug: string | null }>(sql`SELECT slug FROM organization WHERE id = ${clubId}`);
  const settings = await tx.execute<{ prefix: string | null }>(sql`SELECT member_number_prefix AS prefix FROM club_settings WHERE club_id = ${clubId}`);
  const configured = settings.rows[0]?.prefix?.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const abbr = configured || clubAbbreviation(org.rows[0]?.slug ?? null);
  return new RegExp(`^${abbr.replace(/[^A-Z0-9]/g, "")}-[0-9]{1,9}$`).test(number);
}
