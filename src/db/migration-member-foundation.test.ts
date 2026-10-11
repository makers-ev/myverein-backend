import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Wave 7 B2: migration 0014 (club_members foundation) against a scratch database that is first migrated to the
 * Wave 1-6 state (0000-0013), filled with legacy sample data, and then migrated forward. Uses its own database, so it
 * neither depends on nor disturbs the shared test database. Needs a role that may CREATE DATABASE (the CI/test
 * Postgres user is a superuser).
 */

const MIGRATIONS = path.resolve("src/db/migrations");
const baseUrl = process.env.DATABASE_URL!;
const dbName = `mv_migtest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const scratchUrl = (() => {
  const u = new URL(baseUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

let admin: Pool;
let pool: Pool;
let tmpOld: string;

async function rows<T extends Record<string, unknown>>(sqlText: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sqlText, params)).rows as T[];
}

/** The re-runnable data part of 0014 (between the backfill markers), split into its statements. */
async function backfillStatements(): Promise<string[]> {
  const sqlText = await readFile(path.join(MIGRATIONS, "0014_member-foundation.sql"), "utf8");
  const start = sqlText.indexOf("-- >>> backfill:club_members");
  const end = sqlText.indexOf("-- <<< backfill:club_members");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return sqlText
    .slice(start, end)
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => /\S/.test(s.replace(/^--.*$/gm, "")));
}

describe("migration 0014 member foundation (Wave 7 B2)", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: scratchUrl, max: 2 });

    // Wave 1-6 state = migrations 0000..0013.
    tmpOld = await mkdtemp(path.join(os.tmpdir(), "mv-mig-old-"));
    await cp(MIGRATIONS, tmpOld, { recursive: true });
    const journalPath = path.join(tmpOld, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter((e) => e.idx <= 13);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: tmpOld });

    // Legacy sample data.
    const q = (text: string, params: unknown[] = []) => pool.query(text, params);
    for (const [id, name] of [["u1", "Ada Vorsitz"], ["u2", "Bernd Ausgetreten"], ["u3", "Cora Kind-Elternteil"], ["u4", "Dora Ohne Stammdaten"]]) {
      await q(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`, [id, name, `${id}@example.com`]);
    }
    await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Demo Sportverein', 'demo-sportverein', now()), ('o2', 'Zweiter Verein', 'zweiter', now()), ('o3', 'Leerer Verein', 'leer', now())`);
    await q(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
      ('m1', 'o1', 'u1', 'owner', '2020-03-04T10:00:00Z'),
      ('m2', 'o1', 'u2', 'member', '2021-05-06T10:00:00Z'),
      ('m3', 'o1', 'u3', 'member', '2022-07-08T10:00:00Z'),
      ('m4', 'o2', 'u1', 'member', '2023-01-02T10:00:00Z'),
      ('m5', 'o2', 'u4', 'member', '2024-02-03T10:00:00Z')`);
    await q(`INSERT INTO club_memberships (member_id, member_number, category, joined_at, left_at, birth_date, emergency_contact_name, emergency_contact_phone) VALUES
      ('m1', 'DEMO-0001', 'aktiv', '2020-03-04', NULL, '1980-01-02', 'Notfall Eins', '0123'),
      ('m2', 'DEMO-0002', ' Sonderklasse ', '2021-05-06', '2022-01-01', NULL, NULL, NULL),
      ('m4', 'ZWEI-0001', 'passiv', '2023-01-02', '2999-12-31', NULL, NULL, NULL)`);
    await q(`INSERT INTO guardian_links (guardian_member_id, ward_member_id) VALUES ('m1', 'm3'), ('m1', 'm2')`);

    // Forward to the current schema.
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
    if (tmpOld) await rm(tmpOld, { recursive: true, force: true });
  });

  it("creates exactly one club_members row per member row and keeps club_memberships", async () => {
    const [counts] = await rows<{ members: string; club_members: string; linked: string; memberships: string }>(
      `SELECT (SELECT count(*) FROM member) AS members, (SELECT count(*) FROM club_members) AS club_members,
              (SELECT count(DISTINCT member_id) FROM club_members WHERE member_id IS NOT NULL) AS linked,
              (SELECT count(*) FROM club_memberships) AS memberships`,
    );
    expect(Number(counts!.members)).toBe(5);
    expect(Number(counts!.club_members)).toBe(5);
    expect(Number(counts!.linked)).toBe(5);
    expect(Number(counts!.memberships)).toBe(3);
  });

  it("takes master data from club_memberships, name/e-mail from the user, status from left_at", async () => {
    const byMember = async (memberId: string) =>
      (await rows<Record<string, unknown>>(
        `SELECT cm.*, mc.key AS category_key, mc.name AS category_name FROM club_members cm LEFT JOIN member_categories mc ON mc.id = cm.category_id WHERE cm.member_id = $1`,
        [memberId],
      ))[0]!;

    expect(await byMember("m1")).toMatchObject({
      club_id: "o1",
      display_name: "Ada Vorsitz",
      contact_email: "u1@example.com",
      member_number: "DEMO-0001",
      category_key: "aktiv",
      status: "aktiv",
      emergency_contact_name: "Notfall Eins",
      emergency_contact_phone: "0123",
    });
    expect(String((await byMember("m1")).birth_date)).toContain("1980");
    expect(await byMember("m2")).toMatchObject({ status: "ausgetreten", category_key: "sonderklasse", category_name: "Sonderklasse" });
    // Future leaving date: still a member today.
    expect(await byMember("m4")).toMatchObject({ status: "aktiv", category_key: "passiv" });
    expect(String((await byMember("m4")).left_at)).toContain("2999");
    // No club_memberships row: joined_at = member.created_at, category aktiv, no invented member number.
    const noStamm = await byMember("m5");
    expect(noStamm).toMatchObject({ display_name: "Dora Ohne Stammdaten", member_number: null, category_key: "aktiv", status: "aktiv" });
    expect(new Date(noStamm.joined_at as string | Date).getFullYear()).toBe(2024);
  });

  it("seeds the five default categories per club plus unknown legacy categories, with the right voting rights", async () => {
    const perClub = await rows<{ club_id: string; keys: string[] }>(`SELECT club_id, array_agg(key ORDER BY key) AS keys FROM member_categories GROUP BY club_id ORDER BY club_id`);
    expect(perClub).toEqual([
      { club_id: "o1", keys: ["aktiv", "ehrenmitglied", "foerdernd", "jugend", "passiv", "sonderklasse"] },
      { club_id: "o2", keys: ["aktiv", "ehrenmitglied", "foerdernd", "jugend", "passiv"] },
      { club_id: "o3", keys: ["aktiv", "ehrenmitglied", "foerdernd", "jugend", "passiv"] },
    ]);
    const voting = await rows<{ key: string; voting_right: boolean; name: string }>(`SELECT key, voting_right, name FROM member_categories WHERE club_id = 'o2' ORDER BY key`);
    expect(Object.fromEntries(voting.map((v) => [v.key, v.voting_right]))).toEqual({ aktiv: true, ehrenmitglied: true, foerdernd: false, jugend: false, passiv: true });
    expect(voting.find((v) => v.key === "foerdernd")?.name).toBe("Fördernd");
  });

  it("moves guardian_links wards to club_members.id and drops the old column", async () => {
    const links = await rows<{ guardian_member_id: string; ward_member_id: string }>(
      `SELECT gl.guardian_member_id, cm.member_id AS ward_member_id FROM guardian_links gl JOIN club_members cm ON cm.id = gl.ward_club_member_id ORDER BY cm.member_id`,
    );
    expect(links).toEqual([
      { guardian_member_id: "m1", ward_member_id: "m2" },
      { guardian_member_id: "m1", ward_member_id: "m3" },
    ]);
    const cols = await rows<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'guardian_links'`);
    expect(cols.map((c) => c.column_name)).toContain("ward_club_member_id");
    expect(cols.map((c) => c.column_name)).not.toContain("ward_member_id");
  });

  it("is idempotent: re-running the data migration changes nothing, and repairs a missing row", async () => {
    const statements = await backfillStatements();
    const snapshot = async () => rows(`SELECT id, member_id, member_number, status FROM club_members ORDER BY id`);
    const before = await snapshot();

    for (const stmt of statements) await pool.query(stmt);
    expect(await snapshot()).toEqual(before);

    // A member whose club_members row is missing (and who has no guardian link) is re-created.
    await pool.query(`DELETE FROM club_members WHERE member_id = 'm5'`);
    for (const stmt of statements) await pool.query(stmt);
    const [{ n }] = await rows<{ n: string }>(`SELECT count(*) AS n FROM club_members`);
    expect(Number(n)).toBe(5);
  });

  it("fails with a clear message when the count check detects a missing club_members row", async () => {
    const countCheck = (await backfillStatements()).find((s) => s.includes("count mismatch"));
    expect(countCheck).toBeDefined();
    await pool.query(`DELETE FROM club_members WHERE member_id = 'm5'`);
    await expect(pool.query(countCheck!)).rejects.toThrow(/club_members backfill count mismatch: 5 member rows vs 4 club_members rows/);
    // Put the row back so later tests (if any) see a consistent database.
    for (const stmt of await backfillStatements()) await pool.query(stmt);
  });
});
