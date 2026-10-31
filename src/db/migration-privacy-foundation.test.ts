import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";
import { collectReport } from "./verify-counts.js";

/**
 * Wave 10 B1 migration 0043 (privacy foundation): additive on top of 0042. Existing guardian links become confirmed with
 * valid_from = created_at, audit rows get club_id/actor from their payload, every club gets the five inactive system
 * purposes, and re-running the data steps changes nothing. Needs a role that may CREATE DATABASE.
 */
const scratch = new ScratchDatabases(process.env.DATABASE_URL!);
let pool: Pool;

const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as Array<Record<string, unknown>>;
const count = async (table: string) => Number((await q(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);

const CM_WARD = "00000000-0000-0000-0000-0000000000a2";

beforeAll(async () => {
  const old = await scratch.migrationsUpTo(42);
  pool = await scratch.create("0043");
  await migrate(drizzle(pool), { migrationsFolder: old });
  await q(`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'U', 'u1@example.test', true, now(), now())`);
  await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Eins', 'eins', now()), ('o2', 'Zwei', 'zwei', now())`);
  await q(`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'o1', 'u1', 'guest', now())`);
  await q(`INSERT INTO club_members (id, club_id, display_name, joined_at) VALUES ('${CM_WARD}', 'o1', 'Kind', '2020-01-01')`);
  await q(`INSERT INTO guardian_links (guardian_member_id, ward_club_member_id, created_at) VALUES ('m1', '${CM_WARD}', '2024-03-05 10:00:00+00')`);
  await q(`INSERT INTO audit_log (event_type, subject_id, payload) VALUES
    ('session.create', 'u1', '{"sessionId":"s1"}'),
    ('event.create', 'e1', '{"clubId":"o1"}'),
    ('member_field.write', '${CM_WARD}', '{"clubId":"o1","clubMemberId":"${CM_WARD}"}'),
    ('odd.payload', NULL, '{"clubId":42}'),
    ('no.payload', NULL, NULL)`);
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
}, 60_000);

afterAll(async () => {
  await scratch.cleanup();
});

describe("migration 0043", () => {
  it("confirms existing guardian links and keeps their rows", async () => {
    expect(await count("guardian_links")).toBe(1);
    const [link] = await q(`SELECT valid_from::text AS valid_from, valid_until, confirmed_at IS NOT NULL AS confirmed, has_custody, can_consent, can_report_absence FROM guardian_links`);
    expect(link).toEqual({ valid_from: "2024-03-05", valid_until: null, confirmed: true, has_custody: true, can_consent: true, can_report_absence: true });
  });

  it("backfills audit_log club, actor and member from the payload without touching other rows", async () => {
    expect(await count("audit_log")).toBe(5);
    const rows = await q(`SELECT event_type, club_id, actor_user_id, subject_member_id FROM audit_log ORDER BY event_type`);
    expect(rows).toEqual([
      { event_type: "event.create", club_id: "o1", actor_user_id: null, subject_member_id: null },
      { event_type: "member_field.write", club_id: "o1", actor_user_id: null, subject_member_id: CM_WARD },
      { event_type: "no.payload", club_id: null, actor_user_id: null, subject_member_id: null },
      { event_type: "odd.payload", club_id: null, actor_user_id: null, subject_member_id: null },
      { event_type: "session.create", club_id: null, actor_user_id: "u1", subject_member_id: null },
    ]);
  });

  it("seeds the five inactive system purposes per club", async () => {
    const rows = await q(`SELECT club_id, count(*)::int AS n, bool_and(system) AS system, bool_or(active) AS any_active, bool_or(requested) AS any_requested FROM consent_purposes GROUP BY club_id ORDER BY club_id`);
    expect(rows).toEqual([
      { club_id: "o1", n: 5, system: true, any_active: false, any_requested: false },
      { club_id: "o2", n: 5, system: true, any_active: false, any_requested: false },
    ]);
  });

  it("adds club_settings defaults and the club member/application privacy-notice columns", async () => {
    await q(`INSERT INTO club_settings (club_id) VALUES ('o1')`);
    expect((await q(`SELECT consent_age_limit, consent_both_guardians, privacy_contact FROM club_settings`))[0]).toEqual({ consent_age_limit: 18, consent_both_guardians: false, privacy_contact: null });
    const [cm] = await q(`SELECT privacy_notice_sent_at, privacy_notice_version_id FROM club_members WHERE id = '${CM_WARD}'`);
    expect(cm).toEqual({ privacy_notice_sent_at: null, privacy_notice_version_id: null });
    const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'club_applications' AND column_name LIKE 'privacy_notice%' ORDER BY 1`);
    expect(cols.map((c) => c.column_name)).toEqual(["privacy_notice_acknowledged_at", "privacy_notice_version_id"]);
  });

  it("enforces the consent record rules (paper proof needs date and source, unique purpose per club)", async () => {
    const [purpose] = await q(`SELECT id FROM consent_purposes WHERE club_id = 'o1' AND key = 'foto_video'`);
    const [text] = await q(`INSERT INTO consent_texts (purpose_id, version, body, sha256) VALUES ($1, 1, 'Text', 'abc') RETURNING id`, [purpose!.id]);
    const base = `INSERT INTO consent_records (club_id, club_member_id, purpose_id, text_version_id, action, given_by`;
    await expect(q(`${base}) VALUES ('o1', '${CM_WARD}', $1, $2, 'granted', 'board_paper')`, [purpose!.id, text!.id])).rejects.toThrow(/paper_proof_chk/);
    await expect(q(`${base}) VALUES ('o1', '${CM_WARD}', $1, $2, 'maybe', 'self')`, [purpose!.id, text!.id])).rejects.toThrow(/action_chk/);
    await q(`${base}, proof_date, proof_source) VALUES ('o1', '${CM_WARD}', $1, $2, 'granted', 'board_paper', '2026-01-02', 'Papierformular')`, [purpose!.id, text!.id]);
    await expect(q(`INSERT INTO consent_purposes (club_id, key, name) VALUES ('o1', 'foto_video', 'Doppelt')`)).rejects.toThrow(/club_key_uidx/);
  });

  it("is idempotent: running the data steps again changes no counts and the report passes", async () => {
    const before = { purposes: await count("consent_purposes"), audit: await count("audit_log"), links: await count("guardian_links") };
    await q(`UPDATE "guardian_links" SET "valid_from" = "created_at"::date, "confirmed_at" = "created_at" WHERE "confirmed_at" IS NULL`);
    await q(`UPDATE "audit_log" SET "club_id" = "payload"->>'clubId' WHERE "club_id" IS NULL AND jsonb_typeof("payload") = 'object' AND jsonb_typeof("payload"->'clubId') = 'string'`);
    await q(`INSERT INTO consent_purposes (club_id, key, name, system) SELECT id, 'foto_video', 'x', true FROM organization ON CONFLICT (club_id, key) DO NOTHING`);
    expect({ purposes: await count("consent_purposes"), audit: await count("audit_log"), links: await count("guardian_links") }).toEqual(before);
    const report = await collectReport(pool);
    // The tiny dataset does not satisfy the Wave 7 invariants; only the Wave 10 checks are asserted here.
    const wave10 = report.lines.filter((l) => /^(consent_purposes|guardian_links\.unconfirmed|audit_log)/.test(l.name));
    expect(wave10.length).toBeGreaterThanOrEqual(4);
    expect(wave10.filter((l) => l.kind === "check" && l.ok !== true)).toEqual([]);
  });
});
