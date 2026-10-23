import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_FORMS, ensureDefaultForms, LEGACY_DEFAULT_APPLICATION_FIELDS } from "../lib/form-defaults.js";
import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Wave 8 B2 migration 0022 (forms, form_versions, form_submissions, form_submission_files, member_field_*, additive
 * columns on club_applications / club_exit_requests): the standard forms are seeded for every existing club exactly
 * once, mirror `src/lib/form-defaults.ts`, legacy applications stay untouched, the partial unique indexes hold.
 */

const baseUrl = process.env.DATABASE_URL!;

describe("migration 0022 configurable-forms", () => {
  const scratch = new ScratchDatabases(baseUrl);
  let pool: Pool;
  let tmpOld: string;

  beforeAll(async () => {
    tmpOld = await scratch.migrationsUpTo(21);
    pool = await scratch.create("0022");
    await migrate(drizzle(pool), { migrationsFolder: tmpOld });
  }, 60_000);

  afterAll(async () => {
    await scratch.cleanup();
  });

  it("seeds one published v1 aufnahme and austritt form per club, keeps legacy applications and is rerunnable", async () => {
    await pool.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('u1', 'Anna', 'u1@example.com', true)`);
    for (const [id, slug] of [["o1", "eins"], ["o2", "zwei"], ["o3", "drei"]] as const) {
      await pool.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, $2, now())`, [id, slug]);
    }
    await pool.query(`INSERT INTO club_applications (user_id, club_id, category, birth_date) VALUES ('u1', 'o1', 'jugend', '2012-05-01')`);
    const clubsBefore = (await pool.query(`SELECT count(*)::int AS n FROM organization`)).rows[0].n as number;

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

    const forms = (await pool.query(`SELECT f.club_id, f.purpose, v.version, v.status, v.fields, v.privacy_notice FROM forms f JOIN form_versions v ON v.form_id = f.id ORDER BY f.club_id, f.purpose`)).rows;
    expect(forms).toHaveLength(clubsBefore * 2);
    for (const purpose of ["aufnahme", "austritt"] as const) {
      const def = DEFAULT_FORMS.find((d) => d.purpose === purpose)!;
      const rows = forms.filter((r) => r.purpose === purpose);
      expect(rows).toHaveLength(clubsBefore);
      for (const row of rows) {
        expect(row.version).toBe(1);
        expect(row.status).toBe("published");
        // The migration seeded the definition of its time (with a mandatory consent); Wave 10 B11 replaces it lazily (see form-defaults).
        expect(row.fields).toEqual(JSON.parse(JSON.stringify(purpose === "aufnahme" ? LEGACY_DEFAULT_APPLICATION_FIELDS : def.fields)));
        expect(row.privacy_notice).toBe(def.privacyNotice);
      }
    }

    const app = (await pool.query(`SELECT category, birth_date::text AS birth_date, form_submission_id, club_member_id FROM club_applications`)).rows;
    expect(app).toEqual([{ category: "jugend", birth_date: "2012-05-01", form_submission_id: null, club_member_id: null }]);
  });

  it("enforces one active aufnahme form per club, one draft per version chain and unique version numbers", async () => {
    const form = (await pool.query(`SELECT id FROM forms WHERE club_id = 'o1' AND purpose = 'aufnahme'`)).rows[0].id as string;
    await expect(pool.query(`INSERT INTO forms (club_id, purpose, name) VALUES ('o1', 'aufnahme', 'Zweites')`)).rejects.toThrow(/forms_club_singleton_purpose_uidx/);
    await pool.query(`INSERT INTO forms (club_id, purpose, name) VALUES ('o1', 'umfrage', 'A'), ('o1', 'umfrage', 'B')`);
    await expect(pool.query(`INSERT INTO form_versions (form_id, version, status) VALUES ($1, 1, 'draft')`, [form])).rejects.toThrow(/form_versions_form_version_uidx/);
    await expect(pool.query(`INSERT INTO form_versions (form_id, version, status) VALUES ($1, 2, 'published')`, [form])).rejects.toThrow(/form_versions_one_published_uidx/);
    await pool.query(`INSERT INTO form_versions (form_id, version, status) VALUES ($1, 2, 'draft')`, [form]);
    await expect(pool.query(`INSERT INTO form_versions (form_id, version, status) VALUES ($1, 3, 'draft')`, [form])).rejects.toThrow(/form_versions_one_draft_uidx/);
  });

  it("ensureDefaultForms is idempotent and restores a missing standard form", async () => {
    const db = drizzle(pool);
    await pool.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o9', 'Neun', 'neun', now())`);
    await ensureDefaultForms("o9", db as never);
    await ensureDefaultForms("o9", db as never);
    const rows = (await pool.query(`SELECT f.purpose, count(v.id)::int AS versions FROM forms f LEFT JOIN form_versions v ON v.form_id = f.id WHERE f.club_id = 'o9' GROUP BY f.purpose ORDER BY f.purpose`)).rows;
    expect(rows).toEqual([{ purpose: "aufnahme", versions: 1 }, { purpose: "austritt", versions: 1 }]);
  });
});
