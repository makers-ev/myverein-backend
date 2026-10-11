import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Wave 7 B14 migration 0021 (location_key_history, location_wifi_networks.security, location_key_holders.key_label):
 * data path on a scratch database migrated to the state before it. Needs a role that may CREATE DATABASE. The folder
 * bookkeeping (journal order, snapshot chain) is covered by migration-media-layer.test.ts for every entry.
 */

const baseUrl = process.env.DATABASE_URL!;

describe("migration 0021 key-history-wifi-security", () => {
  const scratch = new ScratchDatabases(baseUrl);
  let pool: Pool;
  let tmpOld: string;

  beforeAll(async () => {
    tmpOld = await scratch.migrationsUpTo(20);
    pool = await scratch.create("0021");
    await migrate(drizzle(pool), { migrationsFolder: tmpOld });
  }, 60_000);

  afterAll(async () => {
    await scratch.cleanup();
  });

  it("marks password-less networks open, keeps the rest wpa, and seeds the history from the current key holders", async () => {
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u1', 'Hanna Holder', 'u1@example.com', true)`);
    await pool.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Eins', 'eins', now())`);
    await pool.query(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'o1', 'u1', 'member', now())`);
    const loc = (await pool.query(`INSERT INTO locations (club_id, name) VALUES ('o1', 'Haus') RETURNING id`)).rows[0].id as string;
    await pool.query(`INSERT INTO location_wifi_networks (location_id, label, ssid, password) VALUES ($1, 'A', 'a', 'geheim'), ($1, 'B', 'b', '')`, [loc]);
    await pool.query(`INSERT INTO location_key_holders (location_id, member_id) VALUES ($1, 'm1')`, [loc]);

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

    const wifi = (await pool.query(`SELECT label, security FROM location_wifi_networks ORDER BY label`)).rows;
    expect(wifi).toEqual([{ label: "A", security: "wpa" }, { label: "B", security: "open" }]);
    const history = (await pool.query(`SELECT action, member_id, member_name, key_label FROM location_key_history`)).rows;
    expect(history).toEqual([{ action: "issued", member_id: "m1", member_name: "Hanna Holder", key_label: null }]);
    expect((await pool.query(`SELECT key_label FROM location_key_holders`)).rows).toEqual([{ key_label: null }]);

    // Deleting the member keeps the history entry (member_id SET NULL, name snapshot stays); deleting the location removes it.
    await pool.query(`DELETE FROM member WHERE id = 'm1'`);
    expect((await pool.query(`SELECT member_id, member_name FROM location_key_history`)).rows).toEqual([{ member_id: null, member_name: "Hanna Holder" }]);
    await pool.query(`DELETE FROM locations WHERE id = $1`, [loc]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM location_key_history`)).rows[0].n).toBe(0);
  });
});
