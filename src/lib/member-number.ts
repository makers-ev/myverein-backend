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
 * transaction that inserts the `club_memberships` row.
 */
export async function nextMemberNumber(tx: DbTransaction, clubId: string): Promise<string> {
  const locked = await tx.execute<{ slug: string | null }>(sql`SELECT slug FROM organization WHERE id = ${clubId} FOR UPDATE`);
  const slug = locked.rows[0]?.slug ?? null;

  const abbr = clubAbbreviation(slug);

  // Highest numeric suffix already handed out ("DEMO-0007" -> 7) or the plain row count, whichever is larger: the
  // count alone would repeat a number once a membership with a lower number was deleted.
  const stats = await tx.execute<{ count: string; max_suffix: string | null }>(sql`
    SELECT count(*)::text AS count,
           max(substring(cm.member_number FROM '^' || ${abbr} || '-([0-9]+)$')::int)::text AS max_suffix
    FROM club_memberships cm
    INNER JOIN member m ON m.id = cm.member_id
    WHERE m.organization_id = ${clubId}
  `);
  const count = Number(stats.rows[0]?.count ?? 0);
  const maxSuffix = Number(stats.rows[0]?.max_suffix ?? 0);

  return `${abbr}-${String(Math.max(count, maxSuffix) + 1).padStart(4, "0")}`;
}
