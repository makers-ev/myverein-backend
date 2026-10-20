import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Wave 9 B3 migration 0031 (communication + job queue): additive on top of 0030 -- existing events/club_settings rows
 * stay readable with the new defaults, and the new constraints (XOR subject, unique dedupe key / push token) hold.
 * Needs a role that may CREATE DATABASE.
 */
const scratch = new ScratchDatabases(process.env.DATABASE_URL!);
let pool: Pool;

const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as Array<Record<string, unknown>>;

beforeAll(async () => {
  const old = await scratch.migrationsUpTo(30);
  pool = await scratch.create("0031");
  await migrate(drizzle(pool), { migrationsFolder: old });
  await q(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', true, now(), now())`);
  await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Club', 'club', now())`);
  await q(`INSERT INTO calendars (id, club_id, name, created_by) VALUES ('11111111-1111-1111-1111-111111111111', 'o1', 'Cal', 'u1')`);
  await q(`INSERT INTO events (calendar_id, title, starts_at) VALUES ('11111111-1111-1111-1111-111111111111', 'Training', now())`);
  await q(`INSERT INTO club_settings (club_id) VALUES ('o1')`);
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
}, 60_000);

afterAll(async () => {
  await scratch.cleanup();
});

describe("migration 0031", () => {
  it("keeps existing events and club_settings rows with backwards-compatible defaults", async () => {
    const [event] = await q(`SELECT title, cancelled_at, cancel_reason FROM events`);
    expect(event).toEqual({ title: "Training", cancelled_at: null, cancel_reason: null });
    const [settings] = await q(`SELECT * FROM club_settings WHERE club_id = 'o1'`);
    expect(settings).toMatchObject({ timezone: "Europe/Berlin", age_transition_auto: false, reminder_event_enabled: true, reminder_event_lead_hours: 24, sender_name: null, reply_to: null });
  });

  it("enforces exactly one subject on notification_preferences", async () => {
    await q(`INSERT INTO club_members (id, club_id, display_name, joined_at) VALUES ('22222222-2222-2222-2222-222222222222', 'o1', 'M', now())`);
    await expect(q(`INSERT INTO notification_preferences (category, channel, enabled) VALUES ('events', 'email', false)`)).rejects.toThrow(/subject_chk/);
    await expect(
      q(`INSERT INTO notification_preferences (user_id, club_member_id, category, channel, enabled) VALUES ('u1', '22222222-2222-2222-2222-222222222222', 'events', 'email', false)`),
    ).rejects.toThrow(/subject_chk/);
    await q(`INSERT INTO notification_preferences (user_id, category, channel, enabled) VALUES ('u1', 'events', 'email', false)`);
    await q(`INSERT INTO notification_preferences (club_member_id, category, channel, enabled) VALUES ('22222222-2222-2222-2222-222222222222', 'events', 'email', false)`);
    await expect(q(`INSERT INTO notification_preferences (user_id, category, channel, enabled) VALUES ('u1', 'events', 'email', true)`)).rejects.toThrow(/uidx/);
  });

  it("makes dedupe_key and push token unique", async () => {
    await q(`INSERT INTO jobs (type, dedupe_key) VALUES ('t', 'k1'), ('t', NULL), ('t', NULL)`);
    await expect(q(`INSERT INTO jobs (type, dedupe_key) VALUES ('t', 'k1')`)).rejects.toThrow(/jobs_dedupe_key_uidx/);
    await q(`INSERT INTO push_tokens (user_id, token, platform) VALUES ('u1', 'ExponentPushToken[x]', 'ios')`);
    await expect(q(`INSERT INTO push_tokens (user_id, token, platform) VALUES ('u1', 'ExponentPushToken[x]', 'android')`)).rejects.toThrow(/push_tokens_token_uidx/);
  });

  it("allows one delivery per announcement, member and channel", async () => {
    const [a] = await q(`INSERT INTO club_announcements (club_id, title, body) VALUES ('o1', 'T', 'B') RETURNING id, status, audience`);
    expect(a).toMatchObject({ status: "draft", audience: { all: true } });
    const ins = `INSERT INTO message_deliveries (club_id, announcement_id, club_member_id, channel) VALUES ('o1', $1, '22222222-2222-2222-2222-222222222222', 'email')`;
    await q(ins, [a!.id]);
    await expect(q(ins, [a!.id])).rejects.toThrow(/uidx/);
  });
});
