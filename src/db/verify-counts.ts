import type { Pool } from "pg";

/**
 * Read-only count and integrity report for the Wave 7 migrations (0014-0021). Used by `npm run db:verify-counts`
 * (src/scripts/verify-counts.ts) against a production copy and by src/db/migration-counts.test.ts against a seeded
 * scratch database. It prints table names, counts and flags only -- never names, e-mail addresses, member numbers or
 * any other row content.
 */

export interface ReportLine {
  /** `count` lines are comparable before/after a migration (diff the output); `check` lines carry a pass/fail flag. */
  kind: "count" | "check" | "info";
  name: string;
  value: number | string;
  ok?: boolean;
}

export interface VerifyReport {
  lines: ReportLine[];
  /** True when every `check` line passed. */
  ok: boolean;
}

type Row = Record<string, string | number | null>;

async function exists(client: Pool, relation: string): Promise<boolean> {
  const res = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${relation}`]);
  return res.rows[0].present === true;
}

async function columnExists(client: Pool, table: string, column: string): Promise<boolean> {
  const res = await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, column]);
  return res.rowCount === 1;
}

async function scalar(client: Pool, sqlText: string): Promise<number> {
  const res = await client.query(sqlText);
  return Number((res.rows[0] as Row).n);
}

export async function collectReport(client: Pool): Promise<VerifyReport> {
  const lines: ReportLine[] = [];
  const check = (name: string, value: number, ok: boolean) => lines.push({ kind: "check", name, value, ok });
  const zero = (name: string, value: number) => check(name, value, value === 0);

  // Everything runs in one READ ONLY transaction on a single connection: no write can happen, even by mistake.
  const conn = await client.connect();
  const ro = conn as unknown as Pool;
  try {
    await conn.query("BEGIN READ ONLY");

    const tables = (await conn.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r: { tablename: string }) => r.tablename);
    for (const t of tables) lines.push({ kind: "count", name: `rows.${t}`, value: await scalar(ro, `SELECT count(*)::int AS n FROM "public"."${t}"`) });

    const applied = (await conn.query(`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`)).rows[0].present === true;
    if (applied) lines.push({ kind: "info", name: "drizzle.migrations_applied", value: await scalar(ro, `SELECT count(*)::int AS n FROM "drizzle"."__drizzle_migrations"`) });

    const unvalidated = await scalar(ro, `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace ns ON ns.oid = c.connamespace WHERE ns.nspname = 'public' AND NOT c.convalidated`);
    zero("constraints.not_validated", unvalidated);

    if (!(await exists(ro, "club_members"))) {
      lines.push({ kind: "info", name: "state", value: "pre-Wave-7 (club_members does not exist yet); only row counts are reported" });
      return { lines, ok: lines.every((l) => l.kind !== "check" || l.ok === true) };
    }

    // Invariant: every account membership has exactly one club_members row.
    lines.push({ kind: "info", name: "state", value: "Wave 7 schema present" });
    zero("club_members.member_rows_without_club_member", await scalar(ro, `SELECT count(*)::int AS n FROM "member" m WHERE NOT EXISTS (SELECT 1 FROM "club_members" c WHERE c."member_id" = m."id")`));
    zero("club_members.duplicate_member_id", await scalar(ro, `SELECT count(*)::int AS n FROM (SELECT "member_id" FROM "club_members" WHERE "member_id" IS NOT NULL GROUP BY "member_id" HAVING count(*) > 1) d`));
    zero("club_members.club_differs_from_account_club", await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" c JOIN "member" m ON m."id" = c."member_id" WHERE m."organization_id" <> c."club_id"`));
    zero("club_members.linked_minus_member_rows", await scalar(ro, `SELECT ((SELECT count(*) FROM "club_members" WHERE "member_id" IS NOT NULL) - (SELECT count(*) FROM "member"))::int AS n`));
    lines.push({ kind: "count", name: "club_members.without_account", value: await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" WHERE "member_id" IS NULL`) });
    for (const row of (await conn.query(`SELECT "status", count(*)::int AS n FROM "club_members" GROUP BY "status" ORDER BY "status"`)).rows as Row[]) {
      lines.push({ kind: "count", name: `club_members.status.${row.status}`, value: Number(row.n) });
    }
    lines.push({ kind: "count", name: "club_members.with_member_number", value: await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" WHERE "member_number" IS NOT NULL`) });
    lines.push({ kind: "count", name: "club_members.with_birth_date", value: await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" WHERE "birth_date" IS NOT NULL`) });
    lines.push({ kind: "count", name: "club_members.with_left_at", value: await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" WHERE "left_at" IS NOT NULL`) });
    lines.push({ kind: "info", name: "club_members.duplicate_member_number_groups (legacy data may contain duplicates)", value: await scalar(ro, `SELECT count(*)::int AS n FROM (SELECT 1 FROM "club_members" WHERE "member_number" IS NOT NULL GROUP BY "club_id", "member_number" HAVING count(*) > 1) d`) });
    lines.push({ kind: "info", name: "club_members.left_at_in_future_but_aktiv (leaves effective later)", value: await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" WHERE "left_at" > CURRENT_DATE AND "status" = 'aktiv'`) });
    zero("club_members.ausgetreten_without_left_at", await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" WHERE "status" = 'ausgetreten' AND "left_at" IS NULL`));
    zero("club_members.without_category", await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" WHERE "category_id" IS NULL AND "member_id" IS NOT NULL`));
    zero("club_members.linked_without_last_user_id", await scalar(ro, `SELECT count(*)::int AS n FROM "club_members" WHERE "member_id" IS NOT NULL AND "last_user_id" IS NULL`));

    zero("member_categories.umlaut_or_unnormalised_keys", await scalar(ro, `SELECT count(*)::int AS n FROM "member_categories" WHERE "key" <> lower(btrim("key")) OR "key" ~ '[äöüß]'`));
    zero("member_categories.clubs_missing_default_categories", await scalar(ro, `SELECT count(*)::int AS n FROM "organization" o WHERE (SELECT count(*) FROM "member_categories" c WHERE c."club_id" = o."id" AND c."key" IN ('aktiv','passiv','foerdernd','ehrenmitglied','jugend')) < 5`));

    // guardian_links: ward side is club_members.id (0014), none dangling.
    if (await columnExists(ro, "guardian_links", "ward_club_member_id")) {
      zero("guardian_links.dangling_ward", await scalar(ro, `SELECT count(*)::int AS n FROM "guardian_links" g LEFT JOIN "club_members" c ON c."id" = g."ward_club_member_id" WHERE c."id" IS NULL`));
      lines.push({ kind: "info", name: "guardian_links.cross_club (kept, please review)", value: await scalar(ro, `SELECT count(*)::int AS n FROM "guardian_links" g JOIN "member" gm ON gm."id" = g."guardian_member_id" JOIN "club_members" w ON w."id" = g."ward_club_member_id" WHERE gm."organization_id" <> w."club_id"`) });
    }
    zero("guardian_links.legacy_column_ward_member_id_still_present", (await columnExists(ro, "guardian_links", "ward_member_id")) ? 1 : 0);

    // 0019/0020: photo_key columns only hold '<ownClubId>/<file>' keys.
    zero("locations.photo_key_not_own_club_key", await scalar(ro, `SELECT count(*)::int AS n FROM "locations" WHERE "photo_key" IS NOT NULL AND (left("photo_key", length("club_id") + 1) <> "club_id" || '/' OR "photo_key" LIKE '%..%' OR length("photo_key") <= length("club_id") + 1)`));
    zero("inventory_damage_reports.photo_key_not_own_club_key", await scalar(ro, `SELECT count(*)::int AS n FROM "inventory_damage_reports" r JOIN "inventory_items" i ON i."id" = r."item_id" WHERE r."photo_key" IS NOT NULL AND (left(r."photo_key", length(i."club_id") + 1) <> i."club_id" || '/' OR r."photo_key" LIKE '%..%' OR length(r."photo_key") <= length(i."club_id") + 1)`));

    // 0021: key history. On a fresh migration 'issued' entries >= key holders; later activity only adds entries.
    const holders = await scalar(ro, `SELECT count(*)::int AS n FROM "location_key_holders"`);
    const issued = await scalar(ro, `SELECT count(*)::int AS n FROM "location_key_history" WHERE "action" = 'issued'`);
    const backfilled = await scalar(ro, `SELECT count(*)::int AS n FROM "location_key_history" WHERE "note" = 'Bestand bei Einführung der Schlüsselhistorie'`);
    lines.push({ kind: "count", name: "location_key_history.backfilled_entries", value: backfilled });
    check("location_key_history.issued_entries_cover_key_holders", issued - holders, issued >= holders);
    zero("location_key_holders.holder_without_any_history_entry", await scalar(ro, `SELECT count(*)::int AS n FROM "location_key_holders" h WHERE NOT EXISTS (SELECT 1 FROM "location_key_history" x WHERE x."location_id" = h."location_id" AND x."member_id" = h."member_id")`));
    zero("location_wifi_networks.open_with_password", await scalar(ro, `SELECT count(*)::int AS n FROM "location_wifi_networks" WHERE "security" = 'open' AND "password" <> ''`));
    zero("meetings.type_outside_controlled_values", await scalar(ro, `SELECT count(*)::int AS n FROM "meetings" WHERE "type" NOT IN ('vorstandssitzung','mitgliederversammlung','sonstige')`));

    // Wave 10 (0043): privacy foundation.
    if (await exists(ro, "consent_purposes")) {
      zero("consent_purposes.clubs_missing_system_purposes", await scalar(ro, `SELECT count(*)::int AS n FROM "organization" o WHERE (SELECT count(*) FROM "consent_purposes" p WHERE p."club_id" = o."id" AND p."system") < 5`));
      zero("consent_purposes.active_without_published_text", await scalar(ro, `SELECT count(*)::int AS n FROM "consent_purposes" p WHERE p."active" AND NOT EXISTS (SELECT 1 FROM "consent_texts" t WHERE t."purpose_id" = p."id" AND t."published_at" IS NOT NULL)`));
      zero("guardian_links.unconfirmed_legacy_links", await scalar(ro, `SELECT count(*)::int AS n FROM "guardian_links" WHERE "confirmed_at" IS NULL AND "created_at" < (SELECT coalesce(min("created_at"), now()) FROM "consent_purposes")`));
      zero("audit_log.payload_club_id_not_copied", await scalar(ro, `SELECT count(*)::int AS n FROM "audit_log" WHERE "club_id" IS NULL AND jsonb_typeof("payload") = 'object' AND jsonb_typeof("payload"->'clubId') = 'string'`));
      lines.push({ kind: "count", name: "audit_log.without_club_id", value: await scalar(ro, `SELECT count(*)::int AS n FROM "audit_log" WHERE "club_id" IS NULL`) });
    }

    // Wave 13 (0055): every info page has a version row for its current version (the migration copies each page as version 1).
    if (await exists(ro, "club_info_page_versions")) {
      zero("club_info_pages.without_version_row", await scalar(ro, `SELECT count(*)::int AS n FROM "club_info_pages" p WHERE NOT EXISTS (SELECT 1 FROM "club_info_page_versions" v WHERE v."page_id" = p."id" AND v."version_no" = p."current_version")`));
    }
  } finally {
    await conn.query("ROLLBACK").catch(() => undefined);
    conn.release();
  }
  return { lines, ok: lines.every((l) => l.kind !== "check" || l.ok === true) };
}

export function formatReport(report: VerifyReport): string {
  const out = report.lines.map((l) => {
    const flag = l.kind === "check" ? (l.ok ? "OK   " : "FAIL ") : l.kind === "count" ? "     " : "info ";
    return `${flag}${l.name} = ${l.value}`;
  });
  out.push(report.ok ? "RESULT: all checks passed" : "RESULT: at least one check FAILED");
  return out.join("\n");
}
