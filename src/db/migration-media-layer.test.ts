import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Wave 7 B18/B13 migration 0019 (media_files, photo_key columns): bookkeeping of the migration folder (journal order,
 * snapshot chain, one SQL file per journal entry) and the data path on a scratch database migrated to the state before
 * it -- stored keys survive the column rename. Needs a role that may CREATE DATABASE.
 */

const MIGRATIONS = path.resolve("src/db/migrations");
const baseUrl = process.env.DATABASE_URL!;

describe("migration folder bookkeeping", () => {
  it("has a strictly increasing journal, one SQL file and one snapshot per entry, and an unbroken snapshot chain", async () => {
    const journal = JSON.parse(await readFile(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    expect(journal.entries.map((e) => `${e.tag}.sql`)).toEqual(files);
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
    for (let i = 1; i < journal.entries.length; i++) expect(journal.entries[i]!.when, journal.entries[i]!.tag).toBeGreaterThan(journal.entries[i - 1]!.when);
    expect(journal.entries.at(-1)!.tag).toMatch(/^\d{4}_/);

    let previousId: string | null = null;
    for (const entry of journal.entries) {
      const snapshot = JSON.parse(await readFile(path.join(MIGRATIONS, "meta", `${String(entry.idx).padStart(4, "0")}_snapshot.json`), "utf8")) as { id: string; prevId: string };
      if (previousId !== null) expect(snapshot.prevId, `${entry.tag} must chain to the previous snapshot`).toBe(previousId);
      previousId = snapshot.id;
    }
  });
});

describe("migration 0019 media-security-layer", () => {
  let admin: Pool;
  let pool: Pool;
  let tmpOld: string;
  let dbName: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl, max: 1 });
    tmpOld = await mkdtemp(path.join(os.tmpdir(), "mv-mig-0019-"));
    await cp(MIGRATIONS, tmpOld, { recursive: true });
    const journalPath = path.join(tmpOld, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter((e) => e.idx <= 18);
    await writeFile(journalPath, JSON.stringify(journal));

    dbName = `mv_mig_0019_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(baseUrl);
    url.pathname = `/${dbName}`;
    pool = new Pool({ connectionString: url.toString(), max: 2 });
    await migrate(drizzle(pool), { migrationsFolder: tmpOld });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
    await rm(tmpOld, { recursive: true, force: true });
  });

  it("keeps stored photo keys through the column rename and creates the registry and the member photo reference", async () => {
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u1', 'U', 'u1@example.com', true)`);
    await pool.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Eins', 'eins', now())`);
    await pool.query(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'o1', 'u1', 'owner', now())`);
    await pool.query(`INSERT INTO locations (club_id, name, photo_url) VALUES ('o1', 'Haus', 'o1/abc-haus.jpg'), ('o1', 'Ohne', NULL)`);
    const item = (await pool.query(`INSERT INTO inventory_items (club_id, name, condition) VALUES ('o1', 'Zelt', 'gut') RETURNING id`)).rows[0].id as string;
    await pool.query(`INSERT INTO inventory_damage_reports (item_id, reported_by, description, photo_url) VALUES ($1, 'm1', 'Riss', 'o1/def-riss.png')`, [item]);

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

    expect((await pool.query(`SELECT name, photo_key FROM locations ORDER BY name`)).rows).toEqual([{ name: "Haus", photo_key: "o1/abc-haus.jpg" }, { name: "Ohne", photo_key: null }]);
    expect((await pool.query(`SELECT photo_key FROM inventory_damage_reports`)).rows).toEqual([{ photo_key: "o1/def-riss.png" }]);
    const oldColumns = await pool.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'photo_url' AND table_schema = 'public'`);
    expect(oldColumns.rows).toHaveLength(0);

    const columns = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'media_files' ORDER BY column_name`)).rows.map((r) => r.column_name as string);
    expect(columns).toEqual(["club_id", "created_at", "deleted_at", "id", "kind", "mime_type", "original_filename", "owner_id", "owner_type", "sensitive", "sha256", "size_bytes", "storage_key", "uploaded_by", "visibility"]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM media_files`)).rows[0].n).toBe(0);

    // storage_key is unique and club_members.photo_key references it (SET NULL when the registry row is removed).
    await pool.query(`INSERT INTO media_files (club_id, storage_key, kind, mime_type, size_bytes, sha256, original_filename) VALUES ('o1', 'o1/x.png', 'image', 'image/png', 10, 'abc', 'x.png')`);
    await expect(pool.query(`INSERT INTO media_files (club_id, storage_key, kind, mime_type, size_bytes, sha256, original_filename) VALUES ('o1', 'o1/x.png', 'image', 'image/png', 10, 'abc', 'x.png')`)).rejects.toThrow();
    const cm = (await pool.query(`SELECT id FROM club_members WHERE member_id = 'm1'`)).rows[0]?.id as string | undefined;
    const memberId = cm ?? ((await pool.query(`INSERT INTO club_members (club_id, member_id, display_name, joined_at) VALUES ('o1', 'm1', 'U', '2020-01-01') RETURNING id`)).rows[0].id as string);
    await pool.query(`UPDATE club_members SET photo_key = 'o1/x.png' WHERE id = $1`, [memberId]);
    await expect(pool.query(`UPDATE club_members SET photo_key = 'o1/unregistered.png' WHERE id = $1`, [memberId])).rejects.toThrow();
    await pool.query(`DELETE FROM media_files WHERE storage_key = 'o1/x.png'`);
    expect((await pool.query(`SELECT photo_key FROM club_members WHERE id = $1`, [memberId])).rows[0].photo_key).toBeNull();
  });
});
