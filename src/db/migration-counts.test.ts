import { readFile } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";
import { collectReport, formatReport } from "./verify-counts.js";

/**
 * Wave 7 B12: count check ("Zaehlpruefung") of migrations 0014-0021 on a realistic seeded dataset. A scratch database is
 * migrated to the pre-Wave-7 state (0000-0013), filled directly via SQL with ~300 accounts in 3 clubs and every table the
 * migrations touch, then migrated forward. Row counts, content fingerprints, derived values and idempotency are checked
 * before/after. The same checks (without personal data) run on a production copy via `npm run db:verify-counts`.
 */

const scratch = new ScratchDatabases(process.env.DATABASE_URL!);
let pool: Pool;

const q = async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => (await pool.query(text, params)).rows as T[];
const count = async (table: string): Promise<number> => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);

/** Tables whose rows must survive 0014-0021 unchanged in number. */
const PRESERVED = [
  "user", "organization", "member", "club_memberships", "guardian_links", "departments", "club_applications", "club_roles",
  "locations", "location_key_holders", "location_links", "location_wifi_networks", "inventory_items", "inventory_loans",
  "inventory_damage_reports", "meetings", "meeting_attendance", "meeting_invitees", "meeting_resolutions", "availability_slots",
  "availability_exceptions", "calendars", "calendar_visibility", "events", "event_attendees", "club_info_pages", "audit_log",
];

/** Columns that no migration touches, so the whole row content can be fingerprinted before and after. */
const FINGERPRINT: Record<string, string> = {
  location_key_holders: "location_id, member_id",
  inventory_loans: "id, item_id, member_id, borrowed_at, due_at, returned_at, status",
  meeting_attendance: "meeting_id, member_id, present, has_voting_right, proxy_for_member_id",
  meeting_invitees: "meeting_id, member_id, response",
  event_attendees: "event_id, member_id, status, responded_at",
  availability_slots: "member_id, weekday, start_time, end_time, note",
  availability_exceptions: "member_id, date, is_available, note",
  calendar_visibility: "calendar_id, member_id, role_type, department_id",
  club_memberships: "member_id, member_number, category, joined_at, left_at, birth_date, emergency_contact_name, emergency_contact_phone",
  club_roles: "member_id, role_type, department_id, term_ends_at",
  departments: "id, club_id, name, lead_member_id",
  club_applications: "id, user_id, club_id, category, birth_date, status, decided_by",
  "user": "id, name, email",
  member: "id, organization_id, user_id, role, created_at",
  meetings: "id, club_id, title, scheduled_at, status, created_by",
  meeting_resolutions: "id, meeting_id, description, votes_for, votes_against, votes_abstain, result",
};

async function fingerprint(table: string, columns: string): Promise<string> {
  const rows = await q<{ h: string }>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h FROM (SELECT ${columns} FROM "${table}") t`);
  return rows[0]!.h;
}

/** Dataset layout (deterministic): member i = 'm<i>' / user 'u<i>', i in 1..300; clubs o1 = 1..150, o2 = 151..250, o3 = 251..300. */
async function seed(): Promise<void> {
  await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Verein Eins', 'eins', now()), ('o2', 'Verein Zwei', 'zwei', now()), ('o3', 'Verein Drei', 'drei', now())`);
  // 300 member accounts + 20 extra applicant accounts. Edge cases: empty names (i%40), 800-char names (i%97), duplicate names (i%7).
  await q(`INSERT INTO "user" (id, name, email, email_verified)
    SELECT 'u' || i, CASE WHEN i % 40 = 0 THEN '' WHEN i % 97 = 0 THEN repeat('Lang', 200) WHEN i % 7 = 0 THEN 'Max Mustermann' ELSE 'Person ' || i END, 'u' || i || '@example.test', true
    FROM generate_series(1, 320) AS i`);
  await q(`INSERT INTO member (id, organization_id, user_id, role, created_at)
    SELECT 'm' || i, CASE WHEN i <= 150 THEN 'o1' WHEN i <= 250 THEN 'o2' ELSE 'o3' END, 'u' || i,
      CASE WHEN i IN (1, 151, 251) THEN 'owner' WHEN i % 10 = 0 THEN 'admin' WHEN i % 17 = 0 THEN 'guest' ELSE 'member' END,
      timestamp '2019-01-01 12:00' + (i || ' days')::interval
    FROM generate_series(1, 300) AS i`);
  // club_memberships for 3 of 4 members; missing number (i%5), birth date (i%3), past / boundary / future leftAt, varied free-text categories.
  await q(`INSERT INTO club_memberships (member_id, member_number, category, joined_at, left_at, birth_date, emergency_contact_name, emergency_contact_phone, created_at, updated_at)
    SELECT 'm' || i,
      CASE WHEN i % 5 = 0 THEN NULL ELSE 'V' || (i % 120) END,
      (ARRAY['aktiv', 'passiv', 'Fördernd', ' Sonderklasse ', '', 'ehrenmitglied', 'Jugend '])[1 + i % 7],
      date '2005-01-01' + i * 20,
      CASE WHEN i % 9 = 0 THEN date '2022-01-01' + i WHEN i % 31 = 0 THEN date '2999-12-31' WHEN i % 13 = 0 THEN CURRENT_DATE WHEN i % 11 = 0 THEN CURRENT_DATE + 1 ELSE NULL END,
      CASE WHEN i % 3 = 0 THEN date '1950-01-01' + i * 37 ELSE NULL END,
      CASE WHEN i % 4 = 1 THEN 'Notfall ' || i ELSE NULL END, CASE WHEN i % 4 = 1 THEN '0151' || i ELSE NULL END,
      timestamp '2020-01-01' + (i || ' hours')::interval, timestamp '2021-01-01' + (i || ' hours')::interval
    FROM generate_series(1, 300) AS i WHERE i % 4 <> 0`);
  // guardian links: 30 of them cross a club border (k..k+200), 10 stay inside o1.
  await q(`INSERT INTO guardian_links (guardian_member_id, ward_member_id) SELECT 'm' || k, 'm' || (k + 200) FROM generate_series(1, 30) AS k`);
  await q(`INSERT INTO guardian_links (guardian_member_id, ward_member_id) SELECT 'm' || k, 'm' || (k + 1) FROM generate_series(120, 129) AS k`);
  await q(`INSERT INTO departments (club_id, name, lead_member_id) SELECT CASE WHEN k <= 2 THEN 'o1' WHEN k <= 4 THEN 'o2' ELSE 'o3' END, 'Abteilung ' || k, CASE WHEN k = 6 THEN NULL ELSE 'm' || (CASE WHEN k <= 2 THEN k WHEN k <= 4 THEN 150 + k ELSE 250 + k END) END FROM generate_series(1, 6) AS k`);
  await q(`INSERT INTO club_roles (member_id, role_type, department_id) SELECT 'm' || k, CASE WHEN k % 3 = 0 THEN 'vorstand' WHEN k % 3 = 1 THEN 'kassenwart' ELSE 'schriftfuehrer' END, NULL FROM generate_series(1, 30) AS k`);
  await q(`INSERT INTO club_roles (member_id, role_type, department_id) SELECT 'm' || (40 + k), 'abteilungsleitung', (SELECT id FROM departments WHERE name = 'Abteilung ' || k) FROM generate_series(1, 2) AS k`);
  await q(`INSERT INTO club_applications (user_id, club_id, category, birth_date, status, decided_by)
    SELECT 'u' || (300 + k), 'o' || (1 + k % 3), 'aktiv', CASE WHEN k % 2 = 0 THEN date '1990-05-05' ELSE NULL END,
      (ARRAY['pending', 'approved', 'rejected'])[1 + k % 3], CASE WHEN k % 3 = 0 THEN NULL ELSE (SELECT 'm' || (k)) END
    FROM generate_series(1, 20) AS k`);
  await q(`INSERT INTO club_info_pages (club_id, slug, title, content_markdown) SELECT 'o' || k, 'impressum', 'Impressum', 'Text' FROM generate_series(1, 3) AS k`);

  // locations: photo_url variants (valid key / external URL / other club's key / /media path / traversal / bare prefix / null).
  await q(`INSERT INTO locations (club_id, name, photo_url)
    SELECT 'o' || (1 + (k - 1) % 3), 'Ort ' || k,
      CASE k % 7 WHEN 0 THEN 'o' || (1 + (k - 1) % 3) || '/abc-' || k || '.jpg' WHEN 1 THEN 'https://cdn.example.test/' || k || '.png' WHEN 2 THEN 'o' || (1 + k % 3) || '/fremd.jpg'
        WHEN 3 THEN '/media/o' || (1 + (k - 1) % 3) || '/x.jpg' WHEN 4 THEN 'o' || (1 + (k - 1) % 3) || '/../o2/x.jpg' WHEN 5 THEN 'o' || (1 + (k - 1) % 3) || '/' ELSE NULL END
    FROM generate_series(1, 14) AS k`);
  // key holders: one per member 1..45 on 9 locations (unique pair).
  await q(`INSERT INTO location_key_holders (location_id, member_id) SELECT (SELECT id FROM locations WHERE name = 'Ort ' || (1 + (k - 1) % 9)), 'm' || k FROM generate_series(1, 45) AS k`);
  await q(`INSERT INTO location_wifi_networks (location_id, label, ssid, password, visible_to_guests) SELECT (SELECT id FROM locations WHERE name = 'Ort ' || (1 + (k - 1) % 9)), 'WLAN ' || k, 'ssid' || k, CASE WHEN k % 2 = 0 THEN '' ELSE 'geheim' || k END, k % 3 = 0 FROM generate_series(1, 12) AS k`);
  await q(`INSERT INTO location_links (location_id, title, url, visible_to_guests) SELECT (SELECT id FROM locations WHERE name = 'Ort ' || (1 + (k - 1) % 9)), 'Link ' || k, 'https://example.test/' || k, k % 2 = 0 FROM generate_series(1, 12) AS k`);

  await q(`INSERT INTO inventory_items (club_id, name, condition) SELECT 'o' || (1 + (k - 1) % 3), 'Gegenstand ' || k, 'gut' FROM generate_series(1, 30) AS k`);
  await q(`INSERT INTO inventory_loans (item_id, member_id, borrowed_at, due_at, returned_at, status)
    SELECT (SELECT id FROM inventory_items WHERE name = 'Gegenstand ' || (1 + (k - 1) % 30)), 'm' || (1 + (k * 7) % 300), timestamp '2026-01-01' + (k || ' days')::interval, timestamp '2026-02-01' + (k || ' days')::interval,
      CASE WHEN k % 3 = 0 THEN timestamp '2026-01-20' + (k || ' days')::interval ELSE NULL END, CASE WHEN k % 3 = 0 THEN 'zurueckgegeben' ELSE 'ausgeliehen' END
    FROM generate_series(1, 80) AS k`);
  await q(`INSERT INTO inventory_damage_reports (item_id, reported_by, description, photo_url)
    SELECT (SELECT id FROM inventory_items WHERE name = 'Gegenstand ' || k), 'm' || k, 'Schaden ' || k,
      CASE k % 5 WHEN 0 THEN NULL WHEN 1 THEN 'o' || (1 + (k - 1) % 3) || '/schaden-' || k || '.jpg' WHEN 2 THEN 'http://example.test/s.jpg' WHEN 3 THEN 'o' || (1 + k % 3) || '/fremd.jpg' ELSE '/media/x.jpg' END
    FROM generate_series(1, 10) AS k`);

  await q(`INSERT INTO meetings (club_id, type, title, scheduled_at, status, created_by)
    SELECT 'o' || (1 + (k - 1) % 3), (ARRAY['Vorstandssitzung', 'Mitgliederversammlung', 'Jahreshauptversammlung', 'Stammtisch', '', 'Sitzung des Beirats', 'Workshop'])[1 + k % 7], 'Treffen ' || k,
      timestamp '2026-03-01' + (k || ' days')::interval, 'geplant', CASE (k - 1) % 3 WHEN 0 THEN 'u1' WHEN 1 THEN 'u151' ELSE 'u251' END
    FROM generate_series(1, 12) AS k`);
  await q(`INSERT INTO meeting_invitees (meeting_id, member_id, response) SELECT (SELECT id FROM meetings WHERE title = 'Treffen ' || k), 'm' || (1 + (k * 13 + j) % 300), 'offen' FROM generate_series(1, 12) AS k, generate_series(0, 9) AS j`);
  await q(`INSERT INTO meeting_attendance (meeting_id, member_id, present, has_voting_right, proxy_for_member_id) SELECT (SELECT id FROM meetings WHERE title = 'Treffen ' || k), 'm' || (1 + (k * 13 + j) % 300), j % 4 <> 0, j % 5 <> 0, CASE WHEN j = 7 THEN 'm1' ELSE NULL END FROM generate_series(1, 12) AS k, generate_series(0, 7) AS j`);
  await q(`INSERT INTO meeting_resolutions (meeting_id, description, votes_for, votes_against, votes_abstain, result) SELECT (SELECT id FROM meetings WHERE title = 'Treffen ' || k), 'Beschluss ' || k, k, 1, 0, 'angenommen' FROM generate_series(1, 6) AS k`);

  await q(`INSERT INTO availability_slots (member_id, weekday, start_time, end_time, note) SELECT 'm' || (1 + k * 4), k % 7, '17:00', '19:30', CASE WHEN k % 2 = 0 THEN 'Training' ELSE NULL END FROM generate_series(1, 60) AS k`);
  await q(`INSERT INTO availability_exceptions (member_id, date, is_available, note) SELECT 'm' || (1 + k * 4), date '2026-12-24' + k, k % 2 = 0, NULL FROM generate_series(1, 20) AS k`);
  await q(`INSERT INTO calendars (club_id, name, is_default, created_by) SELECT 'o' || k, 'Kalender ' || k, true, CASE k WHEN 1 THEN 'u1' WHEN 2 THEN 'u151' ELSE 'u251' END FROM generate_series(1, 3) AS k`);
  await q(`INSERT INTO events (calendar_id, title, starts_at, created_by) SELECT (SELECT id FROM calendars WHERE name = 'Kalender ' || (1 + (k - 1) % 3)), 'Termin ' || k, timestamp '2026-05-01' + (k || ' days')::interval, CASE (k - 1) % 3 WHEN 0 THEN 'u1' WHEN 1 THEN 'u151' ELSE 'u251' END FROM generate_series(1, 9) AS k`);
  await q(`INSERT INTO event_attendees (event_id, member_id, status, responded_at) SELECT (SELECT id FROM events WHERE title = 'Termin ' || k), 'm' || (1 + (k * 17 + j) % 300), (ARRAY['zugesagt', 'abgesagt', 'vielleicht'])[1 + j % 3], now() FROM generate_series(1, 9) AS k, generate_series(0, 9) AS j`);
  await q(`INSERT INTO calendar_visibility (calendar_id, member_id, role_type, department_id) SELECT (SELECT id FROM calendars WHERE name = 'Kalender ' || (1 + (k - 1) % 3)), CASE WHEN k % 2 = 0 THEN 'm' || k ELSE NULL END, CASE WHEN k % 2 = 1 THEN 'mitglied' ELSE NULL END, NULL FROM generate_series(1, 9) AS k`);
  await q(`INSERT INTO audit_log (event_type, subject_id, payload) SELECT 'legacy.test', 'm' || k, '{}'::jsonb FROM generate_series(1, 25) AS k`);
}

interface PreMember { id: string; organization_id: string; name: string; email: string; created: string; number: string | null; category: string | null; joined: string | null; left: string | null; birth: string | null; has_cm: boolean }

const normaliseKey = (c: string | null): string => {
  const base = (c ?? "").trim().toLowerCase();
  const key = base === "" ? "aktiv" : base;
  return key.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss");
};

describe("Wave 7 B12: migration count check on a realistic dataset (0014-0021)", () => {
  const before: Record<string, number> = {};
  const fpBefore: Record<string, string> = {};
  let preMembers: PreMember[] = [];
  let preGuardians: Array<{ guardian: string; ward: string }> = [];
  let preKeyHolders = 0;
  let preLocationPhotos: Array<{ name: string; club_id: string; photo_url: string | null }> = [];
  let preDamagePhotos: Array<{ description: string; club_id: string; photo_url: string | null }> = [];
  let preLinks: Array<{ title: string; visible_to_guests: boolean }> = [];
  let preMeetingTypes: Array<{ title: string; type: string }> = [];
  let preWifi: Array<{ label: string; password: string }> = [];
  let prePending: number;

  beforeAll(async () => {
    pool = await scratch.create("b12");
    await migrate(drizzle(pool), { migrationsFolder: await scratch.migrationsUpTo(13) });
    await seed();

    for (const t of PRESERVED) before[t] = await count(t);
    for (const [t, cols] of Object.entries(FINGERPRINT)) fpBefore[t] = await fingerprint(t, cols);
    preMembers = await q<PreMember>(`SELECT m.id, m.organization_id, u.name, u.email, m.created_at::date::text AS created, cm.member_number AS number, cm.category, cm.joined_at::text AS joined, cm.left_at::text AS "left", cm.birth_date::text AS birth, (cm.id IS NOT NULL) AS has_cm
      FROM member m JOIN "user" u ON u.id = m.user_id LEFT JOIN club_memberships cm ON cm.member_id = m.id ORDER BY m.id`);
    preGuardians = await q(`SELECT guardian_member_id AS guardian, ward_member_id AS ward FROM guardian_links ORDER BY 1, 2`);
    preKeyHolders = await count("location_key_holders");
    preLocationPhotos = await q(`SELECT name, club_id, photo_url FROM locations ORDER BY name`);
    preDamagePhotos = await q(`SELECT r.description, i.club_id, r.photo_url FROM inventory_damage_reports r JOIN inventory_items i ON i.id = r.item_id ORDER BY r.description`);
    preLinks = await q(`SELECT title, visible_to_guests FROM location_links ORDER BY title`);
    preMeetingTypes = await q(`SELECT title, type FROM meetings ORDER BY title`);
    preWifi = await q(`SELECT label, password FROM location_wifi_networks ORDER BY label`);
    prePending = await count("club_applications");

    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
  }, 120_000);

  afterAll(async () => {
    await scratch.cleanup();
  });

  it("seeded a realistic, edge-case-rich dataset", () => {
    expect(before.member).toBe(300);
    expect(before.club_memberships).toBe(225);
    expect(preMembers.filter((m) => !m.has_cm)).toHaveLength(75);
    expect(preMembers.some((m) => m.name === "")).toBe(true);
    expect(preMembers.some((m) => m.name.length === 800)).toBe(true);
    expect(preMembers.some((m) => m.left !== null && m.left > "2900")).toBe(true);
    expect(prePending).toBe(20);
  });

  it("keeps the row count of every preserved table (and prints the counts table)", async () => {
    const lines: string[] = ["table | before | after"];
    for (const t of PRESERVED) {
      const after = await count(t);
      lines.push(`${t} | ${before[t]} | ${after}`);
      expect(after, t).toBe(before[t]);
    }
    const newTables = ["club_members", "member_categories", "club_member_status_history", "club_member_departments", "club_exit_requests", "club_member_invites", "club_settings", "media_files", "location_key_history"];
    for (const t of newTables) lines.push(`${t} (new) | - | ${await count(t)}`);
    process.stdout.write(`\nB12 count table\n${lines.join("\n")}\n`);
    for (const t of ["club_exit_requests", "club_member_invites", "club_member_status_history", "media_files"]) expect(await count(t), t).toBe(0);
  });

  it("leaves untouched columns of every other table byte-identical (content fingerprints)", async () => {
    for (const [t, cols] of Object.entries(FINGERPRINT)) expect(await fingerprint(t, cols), t).toBe(fpBefore[t]);
  });

  it("gives every account member exactly one club_members row (no duplicates, unique member_id, same club)", async () => {
    const [c] = await q<{ cm: string; linked: string; distinct_linked: string; unlinked: string; wrong_club: string }>(
      `SELECT count(*) AS cm, count(member_id) AS linked, count(DISTINCT member_id) AS distinct_linked, count(*) FILTER (WHERE member_id IS NULL) AS unlinked,
        count(*) FILTER (WHERE member_id IS NOT NULL AND club_id <> (SELECT organization_id FROM member WHERE id = club_members.member_id)) AS wrong_club FROM club_members`,
    );
    expect(Number(c!.cm)).toBe(300);
    expect(Number(c!.linked)).toBe(300);
    expect(Number(c!.distinct_linked)).toBe(300);
    expect(Number(c!.unlinked)).toBe(0);
    expect(Number(c!.wrong_club)).toBe(0);
    const perClub = await q<{ club_id: string; n: string }>(`SELECT club_id, count(*) AS n FROM club_members GROUP BY club_id ORDER BY club_id`);
    expect(perClub.map((r) => [r.club_id, Number(r.n)])).toEqual([["o1", 150], ["o2", 100], ["o3", 50]]);
  });

  it("preserves master data, member numbers, join dates and maps leftAt to the status as the migration specifies", async () => {
    const rows = await q<{ member_id: string; club_id: string; display_name: string; contact_email: string; birth_date: string | null; member_number: string | null; status: string; joined_at: string; left_at: string | null; category_key: string; last_user_id: string; photo_key: string | null; account_unlinked_at: string | null }>(
      `SELECT c.member_id, c.club_id, c.display_name, c.contact_email, c.birth_date::text, c.member_number, c.status, c.joined_at::text, c.left_at::text, k.key AS category_key, c.last_user_id, c.photo_key, c.account_unlinked_at::text
       FROM club_members c JOIN member_categories k ON k.id = c.category_id ORDER BY c.member_id`,
    );
    expect(rows).toHaveLength(300);
    const byMember = new Map(rows.map((r) => [r.member_id, r]));
    const today = (await q<{ d: string }>(`SELECT CURRENT_DATE::text AS d`))[0]!.d;
    let ausgetreten = 0;
    let futureLeft = 0;
    let numbers = 0;
    for (const p of preMembers) {
      const r = byMember.get(p.id)!;
      expect(r, p.id).toBeDefined();
      expect(r.club_id).toBe(p.organization_id);
      expect(r.display_name).toBe(p.name);
      expect(r.contact_email).toBe(p.email);
      expect(r.member_number).toBe(p.number);
      expect(r.birth_date).toBe(p.birth);
      expect(r.joined_at).toBe(p.joined ?? p.created);
      expect(r.left_at).toBe(p.left);
      const expectedStatus = p.left !== null && p.left <= today ? "ausgetreten" : "aktiv";
      expect(r.status, p.id).toBe(expectedStatus);
      expect(r.category_key, p.id).toBe(p.has_cm ? normaliseKey(p.category) : "aktiv");
      expect(r.last_user_id).toBe(`u${p.id.slice(1)}`);
      expect(r.photo_key).toBeNull();
      expect(r.account_unlinked_at).toBeNull();
      if (expectedStatus === "ausgetreten") ausgetreten++;
      if (p.left !== null && p.left > today) futureLeft++;
      if (p.number !== null) numbers++;
    }
    // Spot checks that the edge cases really were exercised.
    expect(ausgetreten).toBeGreaterThan(20);
    expect(futureLeft).toBeGreaterThan(5);
    expect(numbers).toBeGreaterThan(100);
    expect(rows.filter((r) => r.status === "aktiv" && r.left_at !== null && r.left_at > today).length).toBe(futureLeft);
    expect(rows.some((r) => r.left_at === today && r.status === "ausgetreten")).toBe(true);
    // duplicate member numbers are kept (the column is deliberately not unique)
    const dup = await q<{ n: string }>(`SELECT count(*) AS n FROM (SELECT 1 FROM club_members WHERE member_number IS NOT NULL GROUP BY club_id, member_number HAVING count(*) > 1) d`);
    expect(Number(dup[0]!.n)).toBeGreaterThan(0);
  });

  it("creates the default categories per club, folds umlaut spellings and adds unknown free-text categories exactly once", async () => {
    const keys = await q<{ club_id: string; keys: string }>(`SELECT club_id, string_agg(key, ',' ORDER BY key) AS keys FROM member_categories GROUP BY club_id ORDER BY club_id`);
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(k.keys).toBe("aktiv,ehrenmitglied,foerdernd,jugend,passiv,sonderklasse");
    expect(await q(`SELECT 1 FROM member_categories WHERE key ~ '[äöüß]' OR key <> lower(btrim(key))`)).toHaveLength(0);
  });

  it("repoints guardian_links to club_members.id without dangling or lost links", async () => {
    expect(await count("guardian_links")).toBe(preGuardians.length);
    expect(await q(`SELECT 1 FROM guardian_links g LEFT JOIN club_members c ON c.id = g.ward_club_member_id WHERE c.id IS NULL`)).toHaveLength(0);
    expect((await q(`SELECT 1 FROM information_schema.columns WHERE table_name = 'guardian_links' AND column_name = 'ward_member_id'`))).toHaveLength(0);
    const after = await q<{ guardian: string; ward: string }>(`SELECT g.guardian_member_id AS guardian, c.member_id AS ward FROM guardian_links g JOIN club_members c ON c.id = g.ward_club_member_id ORDER BY 1, 2`);
    expect(after).toEqual(preGuardians);
    const fk = await q(`SELECT 1 FROM pg_constraint WHERE conname = 'guardian_links_ward_club_member_id_club_members_id_fk' AND convalidated`);
    expect(fk).toHaveLength(1);
  });

  it("validates every constraint and loses no loans, key holders or attendance (also checked via the production report)", async () => {
    expect(await q(`SELECT conname FROM pg_constraint WHERE NOT convalidated`)).toHaveLength(0);
    expect(await count("inventory_loans")).toBe(80);
    expect(await count("location_key_holders")).toBe(45);
    expect(await count("meeting_attendance")).toBe(96);
    expect(await count("meeting_invitees")).toBe(120);
    expect(await count("event_attendees")).toBe(90);
    const report = await collectReport(pool);
    expect(formatReport(report), formatReport(report)).toContain("RESULT: all checks passed");
    expect(report.ok).toBe(true);
    // the report contains no row content
    const text = formatReport(report);
    expect(text).not.toMatch(/example\.test|Person |Mustermann|Lang{2}/);
  });

  it("0016: maps legacy visibility and meeting types, keeps one row per link/network/meeting", async () => {
    const links = await q<{ title: string; visibility: string }>(`SELECT title, visibility FROM location_links ORDER BY title`);
    expect(links.map((l) => [l.title, l.visibility])).toEqual(preLinks.map((l) => [l.title, l.visible_to_guests ? "gast" : "mitglied"]));
    const types = await q<{ title: string; type: string }>(`SELECT title, type FROM meetings ORDER BY title`);
    expect(types).toHaveLength(preMeetingTypes.length);
    for (const [i, t] of types.entries()) {
      const old = preMeetingTypes[i]!.type.toLowerCase();
      const expected = old.includes("vorstand") || old.includes("sitzung") ? "vorstandssitzung" : old.includes("versammlung") ? "mitgliederversammlung" : "sonstige";
      expect(t.type, preMeetingTypes[i]!.type).toBe(expected);
    }
    expect(new Set(types.map((t) => t.type))).toEqual(new Set(["vorstandssitzung", "mitgliederversammlung", "sonstige"]));
  });

  it("0019/0020: keeps only own-club keys, clears external URLs, foreign-club keys, paths and traversal; registry stays empty", async () => {
    const own = (club: string, v: string | null) => (v !== null && v.startsWith(`${club}/`) && !v.includes("..") && v.length > club.length + 1 ? v : null);
    const locs = await q<{ name: string; photo_key: string | null }>(`SELECT name, photo_key FROM locations ORDER BY name`);
    expect(locs.map((l) => [l.name, l.photo_key])).toEqual(preLocationPhotos.map((l) => [l.name, own(l.club_id, l.photo_url)]));
    expect(locs.filter((l) => l.photo_key !== null).length).toBeGreaterThan(0);
    expect(locs.filter((l) => l.photo_key === null).length).toBeGreaterThan(0);
    const dmg = await q<{ description: string; photo_key: string | null }>(`SELECT description, photo_key FROM inventory_damage_reports ORDER BY description`);
    expect(dmg.map((d) => [d.description, d.photo_key])).toEqual(preDamagePhotos.map((d) => [d.description, own(d.club_id, d.photo_url)]));
    expect(dmg.filter((d) => d.photo_key !== null).length).toBeGreaterThan(0);
    expect(await count("media_files")).toBe(0);
  });

  it("0021: seeds one 'issued' history entry per key holder (names kept, even empty) and sets the wifi security type", async () => {
    expect(await count("location_key_history")).toBe(preKeyHolders);
    const mismatch = await q(`SELECT 1 FROM location_key_holders h LEFT JOIN location_key_history x ON x.location_id = h.location_id AND x.member_id = h.member_id AND x.action = 'issued'
      LEFT JOIN member m ON m.id = h.member_id LEFT JOIN "user" u ON u.id = m.user_id WHERE x.id IS NULL OR x.member_name <> coalesce(u.name, '')`);
    expect(mismatch).toHaveLength(0);
    const wifi = await q<{ label: string; security: string }>(`SELECT label, security FROM location_wifi_networks ORDER BY label`);
    expect(wifi.map((w) => [w.label, w.security])).toEqual(preWifi.map((w) => [w.label, w.password === "" ? "open" : "wpa"]));
  });

  it("is idempotent: re-running the 0014 backfill, the 0015 category fold, 0020 and the migrator changes nothing", async () => {
    const snapshot = async () => ({
      cm: await fingerprint("club_members", "id, club_id, member_id, display_name, member_number, category_id, status, joined_at, left_at, last_user_id"),
      cats: await fingerprint("member_categories", "id, club_id, key"),
      n: [await count("club_members"), await count("member_categories"), await count("guardian_links"), await count("club_member_status_history")],
      photos: await fingerprint("locations", "id, photo_key"),
    });
    const start = await snapshot();

    const sql14 = await readFile(path.join(MIGRATIONS, "0014_member-foundation.sql"), "utf8");
    const backfill = sql14.slice(sql14.indexOf("-- >>> backfill:club_members"), sql14.indexOf("-- <<< backfill:club_members")).split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => /\S/.test(s.replace(/^--.*$/gm, "")));
    expect(backfill.length).toBeGreaterThanOrEqual(4);
    for (const stmt of backfill) await pool.query(stmt);
    const sql15 = await readFile(path.join(MIGRATIONS, "0015_member-lifecycle.sql"), "utf8");
    for (const stmt of sql15.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => /^(UPDATE|DELETE)/.test(s))) await pool.query(stmt);
    const sql20 = await readFile(path.join(MIGRATIONS, "0020_media-legacy-photo-keys.sql"), "utf8");
    for (const stmt of sql20.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => /\S/.test(s.replace(/^--.*$/gm, "")))) await pool.query(stmt);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

    expect(await snapshot()).toEqual(start);
    expect(await count("club_members")).toBe(300);
  });

  it("has a strictly increasing journal and an unbroken snapshot chain; every migration is recorded as applied", async () => {
    const journal = JSON.parse(await readFile(path.join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
    for (let i = 1; i < journal.entries.length; i++) expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
    let prev: string | null = null;
    for (const e of journal.entries) {
      const snap = JSON.parse(await readFile(path.join(MIGRATIONS, "meta", `${String(e.idx).padStart(4, "0")}_snapshot.json`), "utf8")) as { id: string; prevId: string };
      if (prev !== null) expect(snap.prevId, e.tag).toBe(prev);
      prev = snap.id;
    }
    // Later migrations (Wave 8: 0022+) follow, so the B12 range is addressed by position, not as the tail of the journal.
    expect(journal.entries.slice(14, 22).map((e) => e.tag.slice(0, 4))).toEqual(["0014", "0015", "0016", "0017", "0018", "0019", "0020", "0021"]);
    const applied = await q<{ n: string }>(`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`);
    expect(Number(applied[0]!.n)).toBe(journal.entries.length);
  });
});
