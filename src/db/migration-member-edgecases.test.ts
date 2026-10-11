import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Wave 7 B2 edge cases of migrations 0014/0015 on scratch databases migrated to Wave 6 state first: legacy duplicate
 * member numbers, umlaut categories, empty slug, guardian links across clubs, re-running the real migrator, and an
 * atomic rollback when the migration fails half-way. Needs a role that may CREATE DATABASE.
 */

const baseUrl = process.env.DATABASE_URL!;

const scratch = new ScratchDatabases(baseUrl);
let tmpOld: string;

async function wave6Database(label: string, seed: (pool: Pool) => Promise<void>): Promise<Pool> {
  const pool = await scratch.create(label);
  await migrate(drizzle(pool), { migrationsFolder: tmpOld });
  await seed(pool);
  return pool;
}

describe("migrations 0014/0015 edge cases", () => {
  beforeAll(async () => {
    tmpOld = await scratch.migrationsUpTo(13);
  }, 30_000);

  afterAll(async () => {
    await scratch.cleanup();
  });

  const seedLegacy = async (pool: Pool) => {
    for (const id of ["u1", "u2", "u3", "u4"]) {
      await pool.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`, [id, `Name ${id}`, `${id}@example.com`]);
    }
    await pool.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Eins', 'eins', now()), ('o2', 'Leerer Slug', '', now())`);
    await pool.query(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES
      ('m1', 'o1', 'u1', 'owner', now()), ('m2', 'o1', 'u2', 'member', now()), ('m3', 'o1', 'u3', 'member', now()), ('m4', 'o2', 'u4', 'member', now())`);
    await pool.query(`INSERT INTO club_memberships (member_id, member_number, category, joined_at) VALUES
      ('m1', 'DUP-1', 'aktiv', '2020-01-01'), ('m2', 'DUP-1', 'Fördernd', '2020-01-02'), ('m3', 'EINS-0003', 'FÖRDERND', '2020-01-03'), ('m4', NULL, 'Sonderklasse', '2020-01-04')`);
    // guardian m4 (club o2) of ward m3 (club o1): a link across club borders
    await pool.query(`INSERT INTO guardian_links (guardian_member_id, ward_member_id) VALUES ('m4', 'm3'), ('m1', 'm2')`);
  };

  it("keeps legacy duplicate member numbers, folds umlaut categories into the default key, handles an empty slug and cross-club links", async () => {
    const pool = await wave6Database("edge", seedLegacy);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

    const q = async (text: string) => (await pool.query(text)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

    // all members migrated, duplicates survive (the DB has no unique index on the number)
    expect(await q(`SELECT member_number FROM club_members WHERE member_number = 'DUP-1'`)).toHaveLength(2);
    expect(Number((await q(`SELECT count(*) AS n FROM club_members`))[0]!.n)).toBe(4);

    // 'Fördernd' / 'FÖRDERND' use the existing key foerdernd; no separate umlaut category remains
    const keys = (await q(`SELECT key FROM member_categories WHERE club_id = 'o1' ORDER BY key`)).map((r) => r.key);
    expect(keys).toEqual(["aktiv", "ehrenmitglied", "foerdernd", "jugend", "passiv"]);
    const m2 = (await q(`SELECT mc.key FROM club_members cm JOIN member_categories mc ON mc.id = cm.category_id WHERE cm.member_id = 'm2'`))[0]!;
    expect(m2.key).toBe("foerdernd");
    expect(Number((await q(`SELECT count(*) AS n FROM club_members WHERE category_id IS NULL`))[0]!.n)).toBe(0);

    // club with an empty slug migrates (its custom category is kept)
    expect((await q(`SELECT key FROM member_categories WHERE club_id = 'o2' AND key = 'sonderklasse'`))).toHaveLength(1);
    expect((await q(`SELECT display_name FROM club_members WHERE club_id = 'o2'`))[0]!.display_name).toBe("Name u4");

    // cross-club guardian link is kept (no data loss; the migration only warns)
    const links = await q(`SELECT gl.guardian_member_id, cm.member_id AS ward FROM guardian_links gl JOIN club_members cm ON cm.id = gl.ward_club_member_id ORDER BY 1`);
    expect(links).toEqual([{ guardian_member_id: "m1", ward: "m2" }, { guardian_member_id: "m4", ward: "m3" }]);

    // last_user_id is filled for every linked member (needed to match a re-join)
    expect(Number((await q(`SELECT count(*) AS n FROM club_members WHERE member_id IS NOT NULL AND last_user_id IS NULL`))[0]!.n)).toBe(0);
  });

  it("re-running the real migrator is a no-op", async () => {
    const pool = await wave6Database("rerun", seedLegacy);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
    // Every journal entry is applied exactly once (the count follows the journal, so new migrations don't break this).
    const journalEntries = (JSON.parse(await readFile(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;
    const snapshot = async () => (await pool.query(`SELECT id, member_id, member_number, category_id, status FROM club_members ORDER BY id`)).rows;
    const before = await snapshot();
    const categories = (await pool.query(`SELECT count(*) AS n FROM member_categories`)).rows[0].n;
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
    expect(await snapshot()).toEqual(before);
    expect((await pool.query(`SELECT count(*) AS n FROM member_categories`)).rows[0].n).toBe(categories);
    expect((await pool.query(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)).rows[0].n).toBe(String(journalEntries));
  });

  it("rolls back completely when the migration fails half-way (nothing is left half-migrated)", async () => {
    const pool = await wave6Database("fail", seedLegacy);
    // A foreign relation with the name of an index 0014 creates makes the migration fail after tables and backfill ran.
    await pool.query(`CREATE TABLE club_members_club_id_idx (x int)`);
    await expect(migrate(drizzle(pool), { migrationsFolder: MIGRATIONS })).rejects.toThrow();

    expect((await pool.query(`SELECT to_regclass('public.club_members') AS t`)).rows[0].t).toBeNull();
    expect((await pool.query(`SELECT to_regclass('public.member_categories') AS t`)).rows[0].t).toBeNull();
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'guardian_links'`)).rows.map((r) => r.column_name);
    expect(cols).toContain("ward_member_id");
    expect(cols).not.toContain("ward_club_member_id");
    expect((await pool.query(`SELECT count(*) AS n FROM guardian_links`)).rows[0].n).toBe("2");
    expect((await pool.query(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)).rows[0].n).toBe("14");

    // after removing the obstacle the migration succeeds
    await pool.query(`DROP TABLE club_members_club_id_idx`);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
    expect((await pool.query(`SELECT count(*) AS n FROM club_members`)).rows[0].n).toBe("4");
  });
});
