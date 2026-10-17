import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CATEGORIES } from "../lib/club-members.js";
import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/** Wave 8 migration 0024: `member_categories.applicant_selectable` (default closed) with a backfill of the standard categories. */
describe("migration 0024 form-applicant-categories", () => {
  const scratch = new ScratchDatabases(process.env.DATABASE_URL!);
  let pool: Pool;

  beforeAll(async () => {
    const old = await scratch.migrationsUpTo(23);
    pool = await scratch.create("0024");
    await migrate(drizzle(pool), { migrationsFolder: old });
  }, 60_000);

  afterAll(async () => {
    await scratch.cleanup();
  });

  it("opens aktiv/passiv/foerdernd/jugend for applicants, keeps ehrenmitglied and custom categories closed, and matches the code defaults", async () => {
    await pool.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'o1', 'eins', now())`);
    for (const [i, key] of ["aktiv", "passiv", "foerdernd", "ehrenmitglied", "jugend", "vorstandsrat"].entries()) {
      await pool.query(`INSERT INTO member_categories (club_id, key, name, sort_order) VALUES ('o1', $1, $1, $2)`, [key, i]);
    }
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
    const rows = (await pool.query(`SELECT key, applicant_selectable FROM member_categories WHERE club_id = 'o1'`)).rows as Array<{ key: string; applicant_selectable: boolean }>;
    const flags = Object.fromEntries(rows.map((r) => [r.key, r.applicant_selectable]));
    expect(flags).toEqual({ aktiv: true, passiv: true, foerdernd: true, ehrenmitglied: false, jugend: true, vorstandsrat: false });
    for (const def of DEFAULT_CATEGORIES) expect(flags[def.key], def.key).toBe(def.applicantSelectable);
  });
});
