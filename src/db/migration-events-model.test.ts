import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Wave 12 B2 migration 0054 (additive): existing events and RSVPs survive unchanged (count check before/after), get the
 * new column defaults, and the identity check of `event_attendees` accepts exactly one identity. Needs a role that may CREATE DATABASE.
 */
const scratch = new ScratchDatabases(process.env.DATABASE_URL!);
let pool: Pool;

const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as Array<Record<string, unknown>>;
const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n);

const before: Record<string, number> = {};

beforeAll(async () => {
  pool = await scratch.create("0054");
  await migrate(drizzle(pool), { migrationsFolder: await scratch.migrationsUpTo(53) });
  await q(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'U1', 'u1@example.test', true, now(), now())`);
  await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Eins', 'eins', now())`);
  await q(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'o1', 'u1', 'member', now())`);
  await q(`INSERT INTO calendars (id, club_id, name, created_by) VALUES ('00000000-0000-0000-0000-0000000000c1', 'o1', 'Kal', 'u1')`);
  await q(`INSERT INTO events (id, calendar_id, title, starts_at) VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000c1', 'Training', now()), ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000c1', 'Fest', now())`);
  await q(`INSERT INTO event_attendees (event_id, member_id, status) VALUES ('00000000-0000-0000-0000-0000000000e1', 'm1', 'angemeldet')`);
  for (const t of ["events", "event_attendees"]) before[t] = await count(t);
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
}, 90_000);

afterAll(async () => {
  await scratch.cleanup();
});

describe("migration 0054", () => {
  it("keeps every event and RSVP and fills the new columns with neutral defaults", async () => {
    expect(await count("events")).toBe(before.events);
    expect(await count("event_attendees")).toBe(before.event_attendees);
    const rows = await q(`SELECT series_id, original_starts_at, is_override, attendance_tracking, all_day, public_registration_token_hash FROM events`);
    for (const r of rows) expect(r).toMatchObject({ series_id: null, original_starts_at: null, is_override: false, attendance_tracking: false, all_day: false, public_registration_token_hash: null });
    expect(await q(`SELECT party_size, club_member_id, guest_email FROM event_attendees`)).toEqual([{ party_size: 1, club_member_id: null, guest_email: null }]);
  });

  it("requires exactly one identity per registration", async () => {
    const ev = "00000000-0000-0000-0000-0000000000e2";
    await expect(q(`INSERT INTO event_attendees (event_id, status) VALUES ($1, 'angemeldet')`, [ev])).rejects.toThrow(/identity_chk/);
    await expect(q(`INSERT INTO event_attendees (event_id, member_id, guest_email, status) VALUES ($1, 'm1', 'a@example.test', 'angemeldet')`, [ev])).rejects.toThrow(/identity_chk/);
    await q(`INSERT INTO event_attendees (event_id, guest_name, guest_email, status) VALUES ($1, 'Gast', 'Gast@example.test', 'angemeldet')`, [ev]);
    await expect(q(`INSERT INTO event_attendees (event_id, guest_name, guest_email, status) VALUES ($1, 'Gast', 'gast@EXAMPLE.test', 'angemeldet')`, [ev])).rejects.toThrow(/guest_email_uidx/);
  });

  it("allows one occurrence per series and original start", async () => {
    const cal = "00000000-0000-0000-0000-0000000000c1";
    const [s] = await q(`INSERT INTO event_series (calendar_id, title, start_date, start_time, freq) VALUES ($1, 'Serie', '2031-01-06', '18:00', 'weekly') RETURNING id`, [cal]);
    const ins = () => q(`INSERT INTO events (calendar_id, title, starts_at, series_id, original_starts_at) VALUES ($1, 'Serie', '2031-01-06T17:00:00Z', $2, '2031-01-06T17:00:00Z')`, [cal, s!.id]);
    await ins();
    await expect(ins()).rejects.toThrow(/events_series_original_uidx/);
  });
});
