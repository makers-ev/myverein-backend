import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Migration 0027 (standard club calendar + one default per club): backfill for clubs with/without calendars and with a
 * manually created default, dedupe of legacy double defaults, idempotency, count check, partial unique index.
 */

const baseUrl = process.env.DATABASE_URL!;

describe("migration 0027 default-calendars", () => {
  const scratch = new ScratchDatabases(baseUrl);
  let pool: Pool;
  let tmpOld: string;

  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

  beforeAll(async () => {
    tmpOld = await scratch.migrationsUpTo(26);
    pool = await scratch.create("0027");
    await migrate(drizzle(pool), { migrationsFolder: tmpOld });
  }, 60_000);

  afterAll(async () => {
    await scratch.cleanup();
  });

  it("backfills every club lacking a default exactly once and leaves manual defaults alone", async () => {
    await q(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('uo', 'Olga', 'uo@example.com', true), ('um', 'Max', 'um@example.com', true)`);
    for (const id of ["none", "manual", "nodefault", "promote", "dupes", "empty", "ownerlast"]) {
      await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, $1, now())`, [id]);
    }
    // Every club except "empty" has members; the owner is the creator -- also when a plain member joined earlier.
    for (const id of ["none", "manual", "nodefault", "promote", "dupes"]) {
      await q(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, 'uo', 'owner', now())`, [`${id}-o`, id]);
    }
    await q(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('ol-m', 'ownerlast', 'um', 'member', now() - interval '1 day'), ('ol-o', 'ownerlast', 'uo', 'owner', now())`);

    await q(`INSERT INTO calendars (club_id, name, is_default, created_by) VALUES ('manual', 'Mein Kalender', true, 'um')`);
    await q(`INSERT INTO calendars (club_id, name, is_default, created_by) VALUES ('nodefault', 'Jugend', false, 'um')`);
    await q(`INSERT INTO calendars (club_id, name, is_default, created_by) VALUES ('promote', 'VEREINSKALENDER', false, 'um'), ('promote', 'Jugend', false, 'um')`);
    await q(`INSERT INTO calendars (club_id, name, is_default, created_by, created_at) VALUES ('dupes', 'Alt', true, 'um', now() - interval '2 day'), ('dupes', 'Neu', true, 'um', now() - interval '1 day')`);
    const clubs = (await q(`SELECT count(*)::int AS n FROM organization`))[0].n as number;

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

    const defaults = await q(`SELECT club_id, name, created_by FROM calendars WHERE is_default ORDER BY club_id`);
    // Every club with at least one member has exactly one default; the member-less club has none (nobody to credit).
    expect(defaults.map((d) => d.club_id)).toEqual(["dupes", "manual", "nodefault", "none", "ownerlast", "promote"]);
    expect(defaults.length).toBe(clubs - 1);
    const byClub = Object.fromEntries(defaults.map((d) => [d.club_id, d]));
    expect(byClub.manual).toMatchObject({ name: "Mein Kalender", created_by: "um" }); // untouched
    expect(byClub.dupes.name).toBe("Neu"); // most recent default kept, the other one unset
    expect(byClub.promote.name).toBe("VEREINSKALENDER"); // promoted instead of duplicated
    for (const id of ["none", "nodefault", "ownerlast"]) expect(byClub[id]).toMatchObject({ name: "Vereinskalender", created_by: "uo" });

    expect((await q(`SELECT count(*)::int AS n FROM calendars WHERE club_id = 'promote'`))[0].n).toBe(2);
    expect((await q(`SELECT count(*)::int AS n FROM calendars WHERE club_id = 'nodefault'`))[0].n).toBe(2);
    expect((await q(`SELECT count(*)::int AS n FROM calendars WHERE club_id = 'empty'`))[0].n).toBe(0);

    // Created calendars are club-wide and carry exactly the `mitglied` grant; manual/promoted ones got none.
    const grants = await q(`SELECT c.club_id, v.role_type, v.member_id, v.department_id FROM calendar_visibility v JOIN calendars c ON c.id = v.calendar_id ORDER BY c.club_id`);
    expect(grants).toEqual(["nodefault", "none", "ownerlast"].map((club_id) => ({ club_id, role_type: "mitglied", member_id: null, department_id: null })));
    expect((await q(`SELECT count(*)::int AS n FROM calendars WHERE department_id IS NOT NULL`))[0].n).toBe(0);

    const audits = await q(`SELECT payload FROM audit_log WHERE event_type = 'calendar.default_create' ORDER BY payload->>'clubId'`);
    expect(audits.map((a) => a.payload.clubId)).toEqual(["nodefault", "none", "ownerlast"]);
    expect(Object.keys(audits[0].payload).sort()).toEqual(["calendarId", "clubId", "source"]);
  });

  it("is idempotent: running the data statements again changes nothing", async () => {
    const before = await q(`SELECT id, club_id, name, is_default FROM calendars ORDER BY id`);
    const sqlText = await readFile(path.join(MIGRATIONS, "0027_default-calendars.sql"), "utf8");
    for (const stmt of sqlText.split("--> statement-breakpoint").filter((s) => !/CREATE UNIQUE INDEX/.test(s))) await pool.query(stmt);
    expect(await q(`SELECT id, club_id, name, is_default FROM calendars ORDER BY id`)).toEqual(before);
    expect((await q(`SELECT count(*)::int AS n FROM calendar_visibility`))[0].n).toBe(3);
  });

  it("enforces at most one default per club in the database", async () => {
    await expect(pool.query(`INSERT INTO calendars (club_id, name, is_default, created_by) VALUES ('manual', 'Noch einer', true, 'um')`)).rejects.toThrow(/calendars_one_default_per_club_uidx/);
    await pool.query(`INSERT INTO calendars (club_id, name, is_default, created_by) VALUES ('manual', 'Normal', false, 'um'), ('manual', 'Normal 2', false, 'um')`);
  });
});
