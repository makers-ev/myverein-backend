import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Wave 7 B7/B8/B17 migration 0016 on a scratch database migrated to the state before it: free-text meeting types are
 * mapped to the controlled values (ambiguous ones into the more restricted type), `visible_to_guests` becomes
 * `visibility` (true -> gast, false -> mitglied) and the column is dropped. Needs a role that may CREATE DATABASE.
 */

const MIGRATIONS = path.resolve("src/db/migrations");
const baseUrl = process.env.DATABASE_URL!;

describe("migration 0016 roles-scoping", () => {
  let admin: Pool;
  let pool: Pool;
  let tmpOld: string;
  let dbName: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: baseUrl, max: 1 });
    tmpOld = await mkdtemp(path.join(os.tmpdir(), "mv-mig-0016-"));
    await cp(MIGRATIONS, tmpOld, { recursive: true });
    const journalPath = path.join(tmpOld, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter((e) => e.idx <= 15);
    await writeFile(journalPath, JSON.stringify(journal));

    dbName = `mv_mig_0016_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  it("maps meeting types and wifi/link visibility without losing rows", async () => {
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u1', 'U', 'u1@example.com', true)`);
    await pool.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Eins', 'eins', now())`);
    const types = ["vorstandssitzung", "Vorstand", "Ausschusssitzung", "Mitgliederversammlung", "Jahresversammlung", "Stammtisch", ""];
    for (const t of types) {
      await pool.query(`INSERT INTO meetings (club_id, type, title, status, created_by) VALUES ('o1', $1, 'T', 'geplant', 'u1')`, [t]);
    }
    const loc = (await pool.query(`INSERT INTO locations (club_id, name) VALUES ('o1', 'Haus') RETURNING id`)).rows[0].id as string;
    await pool.query(
      `INSERT INTO location_wifi_networks (location_id, label, ssid, password, visible_to_guests) VALUES ($1, 'g', 's1', 'p', true), ($1, 'm', 's2', 'p', false)`,
      [loc],
    );
    await pool.query(
      `INSERT INTO location_links (location_id, title, url, visible_to_guests) VALUES ($1, 'g', 'https://a.example', true), ($1, 'm', 'https://b.example', false)`,
      [loc],
    );

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

    const mapped = (await pool.query(`SELECT type FROM meetings ORDER BY created_at, id`)).rows.map((r) => r.type as string).sort();
    expect(mapped).toEqual(["mitgliederversammlung", "mitgliederversammlung", "sonstige", "sonstige", "vorstandssitzung", "vorstandssitzung", "vorstandssitzung"]);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM meetings`)).rows[0].n)).toBe(types.length);

    const wifi = (await pool.query(`SELECT label, visibility FROM location_wifi_networks ORDER BY label`)).rows;
    expect(wifi).toEqual([{ label: "g", visibility: "gast" }, { label: "m", visibility: "mitglied" }]);
    const links = (await pool.query(`SELECT title, visibility FROM location_links ORDER BY title`)).rows;
    expect(links).toEqual([{ title: "g", visibility: "gast" }, { title: "m", visibility: "mitglied" }]);

    const dropped = await pool.query(`SELECT column_name FROM information_schema.columns WHERE column_name = 'visible_to_guests'`);
    expect(dropped.rows).toHaveLength(0);
    const resolutionCols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'meeting_resolutions' AND column_name LIKE 'correct%'`)).rows;
    expect(resolutionCols.map((r) => r.column_name).sort()).toEqual(["corrected_at", "corrected_by", "correction_note"]);
  });
});
