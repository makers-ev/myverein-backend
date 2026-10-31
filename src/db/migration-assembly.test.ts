import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MIGRATIONS, ScratchDatabases } from "./scratch-db.js";

/**
 * Wave 11 B2 migrations 0048/0049: invitees and attendance move from the account membership to `club_members`, legacy
 * proxies become `meeting_proxies`, free-text minutes become version 1 of `meeting_minutes`. A row whose account has no
 * club_members row stops the migration (nothing is changed). Needs a role that may CREATE DATABASE.
 */
const scratch = new ScratchDatabases(process.env.DATABASE_URL!);
let pool: Pool;
let broken: Pool;

const q = async (db: Pool, text: string, params: unknown[] = []) => (await db.query(text, params)).rows as Array<Record<string, unknown>>;

async function seed(db: Pool, withOrphan: boolean) {
  await q(db, `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ('u1', 'U1', 'u1@example.test', true, now(), now()), ('u2', 'U2', 'u2@example.test', true, now(), now()), ('u3', 'U3', 'u3@example.test', true, now(), now())`);
  await q(db, `INSERT INTO organization (id, name, slug, created_at) VALUES ('o1', 'Eins', 'eins', now())`);
  await q(db, `INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('m1', 'o1', 'u1', 'member', now()), ('m2', 'o1', 'u2', 'member', now()), ('m3', 'o1', 'u3', 'member', now())`);
  await q(db, `INSERT INTO club_members (club_id, member_id, display_name, joined_at) VALUES ('o1', 'm1', 'Eins', '2020-01-01'), ('o1', 'm2', 'Zwei', '2020-01-01'), ('o1', 'm3', 'Drei', '2020-01-01')`);
  await q(db, `INSERT INTO meetings (id, club_id, type, title, status, minutes, created_by) VALUES
    ('00000000-0000-0000-0000-0000000000a1', 'o1', 'mitgliederversammlung', 'MV 1', 'protokolliert', 'Protokoll eins', 'u1'),
    ('00000000-0000-0000-0000-0000000000a2', 'o1', 'sonstige', 'Treffen 2', 'geplant', '  ', 'u1'),
    ('00000000-0000-0000-0000-0000000000a3', 'o1', 'sonstige', 'Treffen 3', 'abgehalten', 'Entwurf drei', 'u1')`);
  await q(db, `INSERT INTO meeting_invitees (meeting_id, member_id, response) VALUES
    ('00000000-0000-0000-0000-0000000000a1', 'm1', 'zugesagt'), ('00000000-0000-0000-0000-0000000000a1', 'm2', 'ausstehend'), ('00000000-0000-0000-0000-0000000000a2', 'm1', 'ausstehend')`);
  await q(db, `INSERT INTO meeting_attendance (meeting_id, member_id, present, has_voting_right, proxy_for_member_id) VALUES
    ('00000000-0000-0000-0000-0000000000a1', 'm1', true, true, 'm3'), ('00000000-0000-0000-0000-0000000000a1', 'm2', false, false, NULL)`);
  if (withOrphan) await q(db, `DELETE FROM club_members WHERE member_id = 'm2'`);
}

beforeAll(async () => {
  const old = await scratch.migrationsUpTo(47);
  pool = await scratch.create("0048");
  await migrate(drizzle(pool), { migrationsFolder: old });
  await seed(pool, false);
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });

  broken = await scratch.create("0048x");
  await migrate(drizzle(broken), { migrationsFolder: old });
  await seed(broken, true);
}, 90_000);

afterAll(async () => {
  await scratch.cleanup();
});

describe("migrations 0048/0049", () => {
  it("moves invitees and attendance to club_members and keeps every row", async () => {
    const invitees = await q(pool, `SELECT cm.member_id AS account, i.response FROM meeting_invitees i JOIN club_members cm ON cm.id = i.club_member_id ORDER BY i.response, cm.member_id`);
    expect(invitees).toEqual([
      { account: "m1", response: "ausstehend" },
      { account: "m2", response: "ausstehend" },
      { account: "m1", response: "zugesagt" },
    ]);
    const attendance = await q(pool, `SELECT cm.member_id AS account, a.present, a.has_voting_right FROM meeting_attendance a JOIN club_members cm ON cm.id = a.club_member_id ORDER BY cm.member_id`);
    expect(attendance).toEqual([
      { account: "m1", present: true, has_voting_right: true },
      { account: "m2", present: false, has_voting_right: false },
    ]);
    const columns = await q(pool, `SELECT column_name FROM information_schema.columns WHERE table_name IN ('meeting_invitees', 'meeting_attendance') AND column_name IN ('member_id', 'proxy_for_member_id')`);
    expect(columns).toEqual([]);
  });

  it("turns a legacy proxy into a meeting proxy (grantor = proxied member, holder = attendee)", async () => {
    const proxies = await q(pool, `SELECT g.member_id AS grantor, h.member_id AS holder FROM meeting_proxies p JOIN club_members g ON g.id = p.grantor_club_member_id JOIN club_members h ON h.id = p.holder_club_member_id`);
    expect(proxies).toEqual([{ grantor: "m3", holder: "m1" }]);
  });

  it("migrates the free-text minutes: protocolled -> approved, other text -> draft, blank -> none", async () => {
    const rows = await q(pool, `SELECT m.title, mm.version, mm.status, mm.content, mm.content_hash FROM meeting_minutes mm JOIN meetings m ON m.id = mm.meeting_id ORDER BY m.title`);
    expect(rows).toEqual([
      { title: "MV 1", version: 1, status: "genehmigt", content: "Protokoll eins", content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      { title: "Treffen 3", version: 1, status: "entwurf", content: "Entwurf drei", content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    // The legacy text field stays.
    expect((await q(pool, `SELECT minutes FROM meetings WHERE title = 'MV 1'`))[0]!.minutes).toBe("Protokoll eins");
  });

  it("stops and changes nothing when a member has no club_members row", async () => {
    await expect(migrate(drizzle(broken), { migrationsFolder: MIGRATIONS })).rejects.toThrow();
    expect(Number((await q(broken, `SELECT count(*) AS n FROM meeting_invitees`))[0]!.n)).toBe(3);
    const stage = await q(broken, `SELECT column_name FROM information_schema.columns WHERE table_name = 'meeting_invitees' AND column_name = 'member_id'`);
    expect(stage).toHaveLength(1);
  });

  it("creates the secret vote table without any person reference or timestamp", async () => {
    const columns = await q(pool, `SELECT column_name FROM information_schema.columns WHERE table_name = 'ballot_votes_secret' ORDER BY column_name`);
    expect(columns.map((c) => c.column_name)).toEqual(["ballot_id", "id", "option_id"]);
    const refs = await q(pool, `SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid = 'ballot_votes_secret'::regclass AND contype = 'f' ORDER BY 1`);
    expect(refs.map((r) => r.target)).toEqual(["ballot_options", "ballot_options", "ballots"]);
  });
});
