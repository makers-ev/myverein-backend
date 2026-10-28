import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Wave 13 B2 migration 0055 (additive): every existing club_info_pages row becomes version 1 of its history without loss
 * (count and content check before/after), club_settings keeps its rows with neutral branding/quota defaults, and the
 * document tables enforce their invariants. Needs a role that may CREATE DATABASE.
 */
const scratch = new ScratchDatabases(process.env.DATABASE_URL!);
let pool: Pool;

const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as Array<Record<string, unknown>>;
const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`))[0]!.n);

let pagesBefore = 0;

beforeAll(async () => {
  pool = await scratch.create("0055");
  await migrate(drizzle(pool), { migrationsFolder: await scratch.migrationsUpTo(54) });
  await q(`INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Eins', 'eins', now()), ('o2', 'Zwei', 'zwei', now())`);
  await q(`INSERT INTO club_settings (club_id) VALUES ('o1')`);
  await q(
    `INSERT INTO club_info_pages (club_id, slug, title, content_markdown, external_url, updated_at) VALUES
      ('o1', 'satzung', 'Satzung', '# Satzung\n\nParagraph 1', NULL, '2026-01-02T10:00:00Z'),
      ('o1', 'leitbild', 'Leitbild', NULL, 'https://example.org/leitbild', '2026-02-03T10:00:00Z'),
      ('o2', 'satzung', 'Satzung Zwei', 'Inhalt', NULL, '2026-03-04T10:00:00Z')`,
  );
  pagesBefore = await count("club_info_pages");
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
}, 90_000);

afterAll(async () => {
  await scratch.cleanup();
});

describe("migration 0055", () => {
  it("keeps every info page and copies it losslessly as version 1", async () => {
    expect(await count("club_info_pages")).toBe(pagesBefore);
    expect(await count("club_info_page_versions")).toBe(pagesBefore);
    const rows = await q(
      `SELECT p.slug, p.title, p.content_markdown, p.external_url, p.current_version, v.version_no, v.title AS v_title, v.content_markdown AS v_content, v.external_url AS v_url, v.created_at = p.updated_at AS same_time
         FROM club_info_pages p JOIN club_info_page_versions v ON v.page_id = p.id ORDER BY p.club_id, p.slug`,
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ current_version: 1, version_no: 1, same_time: true });
      expect(r.v_title).toBe(r.title);
      expect(r.v_content).toBe(r.content_markdown);
      expect(r.v_url).toBe(r.external_url);
    }
  });

  it("gives existing club settings neutral branding and quota defaults", async () => {
    expect(await q(`SELECT brand_logo_key, brand_primary_color, storage_quota_bytes, storage_notice_level FROM club_settings`)).toEqual([
      { brand_logo_key: null, brand_primary_color: null, storage_quota_bytes: null, storage_notice_level: 0 },
    ]);
  });

  it("checks the scope of a document and the subject of a folder permission", async () => {
    const [m] = await q(`INSERT INTO club_members (club_id, display_name, joined_at) VALUES ('o1', 'Test', '2026-01-01') RETURNING id`);
    await expect(q(`INSERT INTO documents (club_id, scope, kind, title) VALUES ('o1', 'person', 'hochgeladen', 'x')`)).rejects.toThrow(/documents_scope_chk/);
    await expect(q(`INSERT INTO documents (club_id, scope, kind, title, owner_club_member_id) VALUES ('o1', 'verein', 'hochgeladen', 'x', $1)`, [m!.id])).rejects.toThrow(/documents_scope_chk/);
    await q(`INSERT INTO documents (club_id, scope, kind, title, owner_club_member_id) VALUES ('o1', 'person', 'erzeugt', 'x', $1)`, [m!.id]);
    const [f] = await q(`INSERT INTO document_folders (club_id, name) VALUES ('o1', 'Vorstand') RETURNING id`);
    await expect(q(`INSERT INTO document_permissions (club_id, folder_id, subject_type, level) VALUES ('o1', $1, 'rolle', 'lesen')`, [f!.id])).rejects.toThrow(/subject_chk/);
    await q(`INSERT INTO document_permissions (club_id, folder_id, subject_type, role_type, level) VALUES ('o1', $1, 'rolle', 'trainer', 'lesen')`, [f!.id]);
    await expect(q(`INSERT INTO document_permissions (club_id, folder_id, subject_type, role_type, level) VALUES ('o1', $1, 'rolle', 'trainer', 'schreiben')`, [f!.id])).rejects.toThrow(/role_uidx/);
  });
});
