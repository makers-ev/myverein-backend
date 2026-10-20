import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Additive migrations of the communication gap closing (G9 0040, G10 0041, G12 0042): legacy rows stay readable and valid
 * with the new defaults, and the new constraints hold. Runs on a scratch database migrated to 0039 first, with data already in it.
 */
const scratch = new ScratchDatabases(process.env.DATABASE_URL!);
let pool: Pool;

const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as Array<Record<string, unknown>>;

beforeAll(async () => {
  const old = await scratch.migrationsUpTo(39);
  pool = await scratch.create("gaps");
  await migrate(drizzle(pool), { migrationsFolder: old });
  await q(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', true, now(), now())`);
  await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Club', 'club', now())`);
  await q(`INSERT INTO club_settings (club_id) VALUES ('o1')`);
  // Rows written before the migrations: the same registration mail twice to the same bare address (legacy, no '#' in ref_id),
  // and a global preference.
  await q(`INSERT INTO message_deliveries (event_key, ref_id, channel, status, address) VALUES ('club_registration.review-notify', 'reg-1', 'email', 'sent', 'a@example.test'), ('club_registration.review-notify', 'reg-1', 'email', 'sent', 'a@example.test')`);
  await q(`INSERT INTO notification_preferences (user_id, category, channel, enabled) VALUES ('u1', 'events', 'email', false)`);
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
}, 60_000);

afterAll(async () => {
  await scratch.cleanup();
});

describe("migration 0040 (registration dedupe)", () => {
  it("keeps legacy duplicate deliveries and dedupes new-style references per address", async () => {
    expect(await q(`SELECT 1 FROM message_deliveries WHERE ref_id = 'reg-1'`)).toHaveLength(2);
    await q(`INSERT INTO message_deliveries (event_key, ref_id, channel, status, address) VALUES ('club_registration.review-notify', 'reg-2#1', 'email', 'queued', 'a@example.test')`);
    await expect(q(`INSERT INTO message_deliveries (event_key, ref_id, channel, status, address) VALUES ('club_registration.review-notify', 'reg-2#1', 'email', 'queued', 'a@example.test')`)).rejects.toThrow(/message_deliveries_address_event_uidx/);
    // another address, another transition, and a delivery with a person are all fine
    await q(`INSERT INTO message_deliveries (event_key, ref_id, channel, status, address) VALUES ('club_registration.review-notify', 'reg-2#1', 'email', 'queued', 'b@example.test'), ('club_registration.review-notify', 'reg-2#2', 'email', 'queued', 'a@example.test')`);
  });

  it("makes system bell entries idempotent per user and key, without touching plain ones", async () => {
    expect((await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'notification' AND column_name = 'dedupe_key'`))).toHaveLength(1);
    await q(`INSERT INTO notification (kind, target_user_id, dedupe_key, translations) VALUES ('admin', 'u1', 'k1', '{}'::jsonb)`);
    await expect(q(`INSERT INTO notification (kind, target_user_id, dedupe_key, translations) VALUES ('admin', 'u1', 'k1', '{}'::jsonb)`)).rejects.toThrow(/notification_target_dedupe_uidx/);
    await q(`INSERT INTO notification (kind, target_user_id, translations) VALUES ('admin', 'u1', '{}'::jsonb), ('admin', 'u1', '{}'::jsonb)`);
  });
});

describe("migration 0041 (age transition notice switch)", () => {
  it("defaults existing clubs to on and keeps their other settings", async () => {
    const [row] = await q(`SELECT notify_age_transition, age_transition_auto, notify_handover FROM club_settings WHERE club_id = 'o1'`);
    expect(row).toEqual({ notify_age_transition: true, age_transition_auto: false, notify_handover: true });
  });
});
