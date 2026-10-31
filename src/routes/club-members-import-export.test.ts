import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { CSV_BOM } from "../lib/member-csv.js";
import { clubMemberRoutes } from "./club-members.js";

// The per-user CSV limiter (default 10/min) would throttle this test file; read at import time of the routes.
vi.hoisted(() => {
  process.env.MEMBER_CSV_RATE_LIMIT_PER_MINUTE = "1000";
});

/** `Response.text()` strips a leading BOM; this keeps it so the test can assert on it. */
const rawText = async (res: Response) => Buffer.from(await res.arrayBuffer()).toString("utf8");

/** Wave 7 B10: CSV import (dry run, confirm token, commit) and export (columns, rights, formula escaping, audit). */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; memberId?: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string): Promise<Actor> {
  const email = `cm-b10-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `B10 ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

let club: string;
function call(who: Actor, url: string, init: { method?: string; body?: object } = {}) {
  return app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}
const json = async (res: Response) => (await res.json()) as Json;

describe("member CSV import and export (B10)", () => {
  let founder: Actor; // vorsitz: members:write + members:read_sensitive
  let leader: Actor; // schriftfuehrer: members:write only
  let treasurer: Actor; // kassenwart: members:read_sensitive only
  let plain: Actor;
  let guest: Actor;
  const userIds: string[] = [];

  const dry = (who: Actor, csv: string, extra: Json = {}) => call(who, "/club-members/import", { method: "POST", body: { csv, ...extra } });
  const commit = (who: Actor, csv: string, confirmToken: string, extra: Json = {}) => call(who, "/club-members/import", { method: "POST", body: { csv, dryRun: false, confirmToken, ...extra } });
  const countMembers = async () => (await db.select().from(clubMembers).where(eq(clubMembers.clubId, club))).length;

  beforeAll(async () => {
    [founder, leader, treasurer, plain, guest] = await Promise.all(["founder", "leader", "treasurer", "plain", "guest"].map(signUp));
    userIds.push(founder.userId, leader.userId, treasurer.userId, plain.userId, guest.userId);
    club = (await auth.api.createOrganization({ body: { name: `B10 ${suffix}`, slug: `b10-${suffix}`, userId: founder.userId } }))!.id;
    for (const [actor, role] of [[leader, "member"], [treasurer, "member"], [plain, "member"], [guest, "guest"]] as const) {
      await auth.api.addMember({ body: { userId: actor.userId, organizationId: club, role } });
    }
    const roles: Array<[Actor, string]> = [[founder, "vorsitz"], [leader, "schriftfuehrer"], [treasurer, "kassenwart"]];
    for (const [actor, roleType] of roles) {
      const m = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, actor.userId)) }))!;
      await db.insert(clubRoles).values({ memberId: m.id, roleType });
    }
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, club));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("rights", () => {
    it("denies import, template and export to plain members, guests and (import) read-only roles", async () => {
      for (const who of [plain, guest, treasurer]) {
        // Denied before the body is even looked at: an invalid body must not turn into a 422.
        expect((await call(who, "/club-members/import", { method: "POST", body: {} })).status).toBe(403);
        expect((await call(who, "/club-members/import-template")).status).toBe(403);
      }
      for (const who of [plain, guest]) expect((await call(who, "/club-members/export")).status).toBe(403);
    });

    it("lets the template be downloaded by members:write as a BOM/semicolon CSV that the importer understands", async () => {
      const res = await call(leader, "/club-members/import-template");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("cache-control")).toContain("private");
      const text = await rawText(res);
      expect(text.startsWith(CSV_BOM)).toBe(true);
      expect(text.split("\r\n")[0]).toContain("Mitgliedsnummer;Name;Vorname;Nachname;Geburtsdatum");
      const check = await dry(leader, text);
      expect(check.status).toBe(200);
      expect((await json(check)).data.summary).toMatchObject({ rows: 1, ok: 1, errors: 0 });
    });
  });

  describe("dry run", () => {
    it("reports required fields, invalid dates/categories/status/e-mail per row without writing anything", async () => {
      const before = await countMembers();
      const csv = [
        "Vorname;Nachname;Geburtsdatum;Kategorie;Status;E-Mail",
        "Anna;Alt;01.02.1990;aktiv;aktiv;anna@example.com", // ok
        ";;01.02.1990;aktiv;aktiv;", // 3: name missing
        "Bad;Date;31.02.1990;aktiv;aktiv;", // 4: invalid date
        "Bad;Cat;01.01.1990;gibtsnicht;aktiv;", // 5: unknown category
        "Bad;Status;01.01.1990;aktiv;ausgetreten;", // 6: left status not importable
        "Bad;Mail;01.01.1990;aktiv;aktiv;kein-mail", // 7: invalid e-mail
        "Future;Born;01.01.2999;aktiv;aktiv;", // 8: birth date in the future
      ].join("\r\n");
      const res = await dry(founder, csv);
      expect(res.status).toBe(200);
      const { data } = await json(res);
      expect(data).toMatchObject({ dryRun: true, committable: false, delimiter: ";", summary: { rows: 7, ok: 1, errors: 6, duplicates: 0 } });
      expect(typeof data.confirmToken).toBe("string");
      const byLine = Object.fromEntries((data.rows as Json[]).map((r) => [r.line, r]));
      expect(byLine[2].status).toBe("ok");
      expect(byLine[3].issues[0]).toMatchObject({ field: "displayName", code: "required" });
      expect(byLine[4].issues[0]).toMatchObject({ field: "birthDate", code: "invalid_date" });
      expect(byLine[5].issues[0]).toMatchObject({ field: "category", code: "invalid_category" });
      expect(byLine[6].issues[0]).toMatchObject({ field: "status", code: "invalid_status" });
      expect(byLine[7].issues[0]).toMatchObject({ field: "contactEmail", code: "invalid_email" });
      expect(byLine[8].issues[0]).toMatchObject({ field: "birthDate", code: "invalid_date" });
      // The report never echoes cell values (names, e-mail addresses).
      expect(JSON.stringify(data)).not.toMatch(/Anna|anna@example|kein-mail/);
      expect(await countMembers()).toBe(before + 0);
    });

    it("detects duplicates by name+birth date and e-mail, against existing members and inside the file", async () => {
      const existing = await call(founder, "/club-members", { method: "POST", body: { displayName: "Dora Dublette", categoryKey: "aktiv", birthDate: "1985-05-05", contactEmail: "dora@example.com" } });
      expect(existing.status).toBe(201);
      const existingId = (await json(existing)).data.id as string;
      const csv = [
        "Name,Geburtsdatum,E-Mail",
        "dora  dublette,05.05.1985,", // 2: same name + birth date (case/space-insensitive)
        "Anders Heissend,01.01.1970,DORA@example.com", // 3: same e-mail
        "Neu Erster,02.02.1992,neu@example.com", // 4: ok
        "Neu Zweiter,03.03.1993,neu@example.com", // 5: e-mail duplicate of line 4
        "Neu Erster,02.02.1992,", // 6: name+birth duplicate of line 4
        "Ohne Geburt,,", // 7: ok (no birth date -> no name duplicate check)
        "Ohne Geburt,,", // 8: still ok
      ].join("\n");
      const { data } = await json(await dry(founder, csv));
      expect(data.delimiter).toBe(",");
      expect(data.summary).toMatchObject({ rows: 7, ok: 3, duplicates: 4, errors: 0 });
      const byLine = Object.fromEntries((data.rows as Json[]).map((r) => [r.line, r]));
      expect(byLine[2]).toMatchObject({ status: "duplicate", duplicates: [{ reason: "name_birthdate", clubMemberId: existingId, line: null }] });
      expect(byLine[3].duplicates[0]).toMatchObject({ reason: "email", clubMemberId: existingId });
      expect(byLine[5].duplicates[0]).toMatchObject({ reason: "email", clubMemberId: null, line: 4 });
      expect(byLine[6].duplicates[0]).toMatchObject({ reason: "name_birthdate", clubMemberId: null, line: 4 });
      expect(data.committable).toBe(true);
    });

    it("flags member numbers that are taken or repeated", async () => {
      await call(founder, "/club-members", { method: "POST", body: { displayName: "Nummer Besetzt", categoryKey: "aktiv", memberNumber: "X-100" } });
      const csv = ["Name;Mitgliedsnummer", "A;X-100", "B;X-200", "C;X-200"].join("\n");
      const { data } = await json(await dry(founder, csv));
      const codes = (data.rows as Json[]).map((r) => r.issues[0]?.code ?? "ok");
      expect(codes).toEqual(["member_number_taken", "ok", "member_number_duplicate_in_file"]);
    });

    it("rejects file-level problems with 422: no name column, empty, malformed, row cap, size cap", async () => {
      const cases: Array<[string, string]> = [
        ["Ort;PLZ\nKöln;50667", "csv_missing_name_column"],
        ["Name;Ort\n", "csv_empty"],
        ['Name;Ort\n"offen;x', "csv_malformed"],
      ];
      for (const [csv, code] of cases) {
        const res = await dry(founder, csv);
        expect(res.status, code).toBe(422);
        expect((await json(res)).error.details.code).toBe(code);
      }
      const previousRows = process.env.MEMBER_IMPORT_MAX_ROWS;
      process.env.MEMBER_IMPORT_MAX_ROWS = "3";
      try {
        const res = await dry(founder, "Name\nA\nB\nC\nD");
        expect(res.status).toBe(422);
        expect((await json(res)).error.details).toMatchObject({ code: "csv_too_many_rows", maxRows: 3 });
        expect((await dry(founder, "Name\nA\nB\nC")).status).toBe(200);
        // far over the cap: the parser stops early with the same error
        const huge = await dry(founder, `Name\n${"A\n".repeat(500)}`);
        expect(huge.status).toBe(422);
        expect((await json(huge)).error.details.code).toBe("csv_too_many_rows");
      } finally {
        if (previousRows === undefined) delete process.env.MEMBER_IMPORT_MAX_ROWS;
        else process.env.MEMBER_IMPORT_MAX_ROWS = previousRows;
      }
      const previousBytes = process.env.MEMBER_IMPORT_MAX_BYTES;
      process.env.MEMBER_IMPORT_MAX_BYTES = "1024";
      try {
        const res = await dry(founder, `Name\n${"x".repeat(1500)}`);
        expect(res.status).toBe(422);
        expect((await json(res)).error.details.code).toBe("csv_too_large");
      } finally {
        if (previousBytes === undefined) delete process.env.MEMBER_IMPORT_MAX_BYTES;
        else process.env.MEMBER_IMPORT_MAX_BYTES = previousBytes;
      }
    });

    it("is fast on a hostile e-mail cell", async () => {
      const started = Date.now();
      const res = await dry(founder, `Name;E-Mail\nEvil;a@${".".repeat(1500)}@`);
      expect(res.status).toBe(200);
      expect((await json(res)).data.rows[0].status).toBe("error");
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it("applies an explicit column mapping", async () => {
      const csv = "Wer;Wohnort\nMapped Person;Berlin";
      const res = await dry(founder, csv, { mapping: { Wer: "displayName", Wohnort: "city" } });
      expect(res.status).toBe(200);
      expect((await json(res)).data.columns).toEqual([{ header: "Wer", field: "displayName" }, { header: "Wohnort", field: "city" }]);
      expect((await dry(founder, csv)).status).toBe(422); // without mapping "Wer" is not a name column
    });
  });

  describe("commit", () => {
    it("requires the confirmToken of a dry run of exactly this file", async () => {
      const csv = "Name\nToken Test";
      const before = await countMembers();
      const noToken = await call(founder, "/club-members/import", { method: "POST", body: { csv, dryRun: false } });
      expect(noToken.status).toBe(422);
      expect((await json(noToken)).error.details.code).toBe("import_not_confirmed");

      const { data } = await json(await dry(founder, csv));
      const changed = await commit(founder, "Name\nToken Test\nExtra Zeile", data.confirmToken);
      expect(changed.status).toBe(422);
      expect(await commit(founder, csv, "garbage-token-value").then((r) => r.status)).toBe(422);
      // A token is bound to the user as well.
      expect((await commit(leader, csv, data.confirmToken)).status).toBe(422);
      expect(await countMembers()).toBe(before);
    });

    it("creates the members in one transaction with generated numbers, history, audit without personal data", async () => {
      const csv = [
        "Vorname;Nachname;Geburtsdatum;Kategorie;Status;Eintrittsdatum;Mitgliedsnummer;E-Mail;Telefon",
        "Carla;Commit;12.03.1991;Passiv;probe;01.01.2023;;carla.commit@example.com;0171 1",
        "Dirk;Commit;1988-07-09;;;;B10-MANUAL;dirk.commit@example.com;",
        "Erika;Commit;;aktiv;;;;;",
        "Carla;Commit;12.03.1991;aktiv;;;;;", // duplicate of line 2 -> skipped
      ].join("\r\n");
      const { data } = await json(await dry(founder, csv));
      expect(data.summary).toMatchObject({ rows: 4, ok: 3, duplicates: 1, errors: 0 });
      const res = await commit(founder, csv, data.confirmToken);
      expect(res.status).toBe(201);
      const body = (await json(res)).data;
      expect(body).toMatchObject({ dryRun: false, created: 3, skippedDuplicates: 1 });

      const rows = await db.select().from(clubMembers).where(and(eq(clubMembers.clubId, club), eq(clubMembers.lastName, "Commit")));
      expect(rows).toHaveLength(3);
      const carla = rows.find((r) => r.firstName === "Carla")!;
      expect(carla).toMatchObject({ displayName: "Carla Commit", birthDate: "1991-03-12", status: "probe", joinedAt: "2023-01-01", contactEmail: "carla.commit@example.com", phone: "0171 1", memberId: null });
      const dirk = rows.find((r) => r.firstName === "Dirk")!;
      expect(dirk.memberNumber).toBe("B10-MANUAL");
      expect(dirk.status).toBe("aktiv");
      // Generated numbers follow the club's sequence and are unique.
      const numbers = (await db.select({ n: clubMembers.memberNumber }).from(clubMembers).where(eq(clubMembers.clubId, club))).map((r) => r.n);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(rows.find((r) => r.firstName === "Erika")!.memberNumber).toMatch(/^B101-\d{4}$/);

      const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, carla.id));
      expect(history).toMatchObject([{ fromStatus: null, toStatus: "probe", reason: "import" }]);

      const audits = (await db.select().from(auditLog).where(eq(auditLog.eventType, "club_member.import"))).filter((a) => a.subjectId === club);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.payload).toMatchObject({ clubId: club, created: 3, skippedDuplicates: 1, rows: 4 });
      expect(JSON.stringify(audits[0]!.payload)).not.toMatch(/Carla|Dirk|carla\.commit|Commit/);

      expect(body.skippedSinceDryRun).toBe(0);
      // The token is single use: replaying the same commit is a 409 and creates nothing.
      const total = await countMembers();
      const again = await commit(founder, csv, data.confirmToken);
      expect(again.status).toBe(409);
      expect((await json(again)).error.details.code).toBe("import_already_applied");
      expect(await countMembers()).toBe(total);
      // A fresh dry run of the same file gets a fresh token, but nothing is left to create (explicit number taken).
      const second = (await json(await dry(founder, csv))).data;
      expect((await commit(founder, csv, second.confirmToken)).status).toBe(422);

      // Without an explicit number a replay finds only duplicates: nothing to do.
      const plainCsv = "Name;Geburtsdatum\nReplay Rita;04.04.1994";
      const plainDry = (await json(await dry(founder, plainCsv))).data;
      expect((await commit(founder, plainCsv, plainDry.confirmToken)).status).toBe(201);
      expect((await commit(founder, plainCsv, plainDry.confirmToken)).status).toBe(409);
      const replayDry = (await json(await dry(founder, plainCsv))).data;
      const replay = await commit(founder, plainCsv, replayDry.confirmToken);
      expect(replay.status).toBe(422);
      expect((await json(replay)).error.details.code).toBe("import_nothing_to_do");
    });

    it("reports duplicates that appeared between dry run and commit (skippedSinceDryRun)", async () => {
      const csv = "Name;Geburtsdatum\nSince Dry;07.07.1977\nSince Other;08.08.1978";
      const { data } = await json(await dry(founder, csv));
      expect(data.summary.duplicates).toBe(0);
      await call(founder, "/club-members", { method: "POST", body: { displayName: "Since Dry", categoryKey: "aktiv", birthDate: "1977-07-07" } });
      const res = await commit(founder, csv, data.confirmToken);
      expect(res.status).toBe(201);
      expect((await json(res)).data).toMatchObject({ created: 1, skippedDuplicates: 1, skippedSinceDryRun: 1 });
    });

    it("rolls back completely if the file has errors at commit time (state changed after the dry run)", async () => {
      const csv = ["Name;Mitgliedsnummer", "Rollback Eins;RB-1", "Rollback Zwei;RB-2"].join("\n");
      const { data } = await json(await dry(founder, csv));
      expect(data.summary.errors).toBe(0);
      // Someone takes RB-2 between dry run and commit.
      await call(founder, "/club-members", { method: "POST", body: { displayName: "Dazwischen", categoryKey: "aktiv", memberNumber: "RB-2" } });
      const res = await commit(founder, csv, data.confirmToken);
      expect(res.status).toBe(422);
      const err = (await json(res)).error.details;
      expect(err.code).toBe("import_has_errors");
      expect(err.rows).toHaveLength(1);
      const created = await db.select().from(clubMembers).where(and(eq(clubMembers.clubId, club), eq(clubMembers.displayName, "Rollback Eins")));
      expect(created).toHaveLength(0);
    });

    it("keeps explicit numbers collision-free against generated ones within one file", async () => {
      const csv = ["Name;Mitgliedsnummer", "Auto Eins;", "Manuell;B10-0777", "Auto Zwei;"].join("\n");
      const { data } = await json(await dry(founder, csv));
      expect((await commit(founder, csv, data.confirmToken)).status).toBe(201);
      const numbers = (await db.select({ n: clubMembers.memberNumber }).from(clubMembers).where(eq(clubMembers.clubId, club))).map((r) => r.n);
      expect(new Set(numbers).size).toBe(numbers.length);
      expect(numbers).toContain("B10-0777");
    });

    it("never evaluates formulas on import and round-trips the export escaping", async () => {
      const csv = ["Name;Ort", "'=2+2 Name;'@home", "'Plain Quote;Köln"].join("\n");
      const { data } = await json(await dry(founder, csv));
      expect((await commit(founder, csv, data.confirmToken)).status).toBe(201);
      const stored = await db.select().from(clubMembers).where(and(eq(clubMembers.clubId, club), eq(clubMembers.city, "@home")));
      expect(stored[0]!.displayName).toBe("=2+2 Name");
      const other = await db.select().from(clubMembers).where(and(eq(clubMembers.clubId, club), eq(clubMembers.city, "Köln")));
      expect(other[0]!.displayName).toBe("'Plain Quote");
    });
  });

  describe("export", () => {
    it("exports for members:read_sensitive as BOM + semicolon + CRLF with all columns by default and writes an audit entry without personal data", async () => {
      await call(founder, "/club-members", { method: "POST", body: { displayName: "=cmd|' /C calc'!A0", categoryKey: "aktiv", phone: "+49 170 555", street: "Weg; 1" } });
      const res = await call(founder, "/club-members/export");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="mitglieder-export-\d{4}-\d{2}-\d{2}\.csv"$/);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const text = await rawText(res);
      expect(text.startsWith(CSV_BOM)).toBe(true);
      const lines = text.slice(1).split("\r\n");
      expect(lines[0]).toBe("Mitgliedsnummer;Name;Vorname;Nachname;Geburtsdatum;Kategorie;Status;Eintrittsdatum;Austrittsdatum;Straße;PLZ;Ort;Telefon;E-Mail;Notfallkontakt;Notfalltelefon;Abteilungen;Konto-E-Mail");
      // Formula starters are neutralised, delimiters quoted.
      expect(text).toContain("'=cmd|' /C calc'!A0");
      expect(text).toContain("'+49 170 555");
      expect(text).toContain('"Weg; 1"');
      expect(lines.some((l) => /^[=+\-@]/.test(l.split(";")[1] ?? ""))).toBe(false);
      for (const line of lines.slice(1).filter(Boolean)) for (const cell of line.split(";")) expect(cell.startsWith("=")).toBe(false);

      const audits = (await db.select().from(auditLog).where(eq(auditLog.eventType, "club_member.export"))).filter((a) => a.subjectId === club);
      expect(audits.length).toBeGreaterThan(0);
      const payload = JSON.stringify(audits.at(-1)!.payload);
      expect(payload).toContain("exportedBy");
      expect(payload).not.toMatch(/calc|555|Weg/);
    });

    it("selects and orders columns and filters by status/category", async () => {
      const res = await call(founder, "/club-members/export?columns=status,displayName&category=passiv");
      const lines = (await rawText(res)).slice(1).split("\r\n").filter(Boolean);
      expect(lines[0]).toBe("Status;Name");
      expect(lines).toContain("probe;Carla Commit");
      expect(lines.every((l) => !l.includes("Dirk"))).toBe(true);

      const former = await call(founder, "/club-members/export?columns=displayName&status=ausgetreten");
      expect((await rawText(former)).slice(1).split("\r\n").filter(Boolean)).toEqual(["Name"]);
    });

    it("also serves /export.csv", async () => {
      const res = await call(founder, "/club-members/export.csv?columns=displayName");
      expect(res.status).toBe(200);
    });

    it("rejects unknown columns (422) and bad filters", async () => {
      const res = await call(founder, "/club-members/export?columns=displayName,passwordHash");
      expect(res.status).toBe(422);
      expect((await json(res)).error.details).toMatchObject({ code: "unknown_column", columns: ["passwordHash"] });
      expect((await call(founder, "/club-members/export?status=gibtsnicht")).status).toBe(422);
    });

    it("members:write without members:read_sensitive only gets the non-sensitive columns", async () => {
      const def = await call(leader, "/club-members/export");
      expect(def.status).toBe(200);
      expect((await rawText(def)).slice(1).split("\r\n")[0]).toBe("Name;Vorname;Nachname;Kategorie;Status;Eintrittsdatum;Austrittsdatum;Abteilungen");
      for (const column of ["birthDate", "memberNumber", "phone", "contactEmail", "accountEmail", "street", "emergencyContactPhone"]) {
        const res = await call(leader, `/club-members/export?columns=displayName,${column}`);
        expect(res.status, column).toBe(403);
      }
    });

    it("members:read_sensitive alone may export sensitive columns", async () => {
      const res = await call(treasurer, "/club-members/export?columns=displayName,birthDate");
      expect(res.status).toBe(200);
    });

    it("leaves former members out unless asked for", async () => {
      const gone = await json(await call(founder, "/club-members", { method: "POST", body: { displayName: "Ehemalig Eva", categoryKey: "aktiv" } }));
      await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.id, gone.data.id));
      const without = await rawText(await call(founder, "/club-members/export?columns=displayName"));
      expect(without).not.toContain("Ehemalig Eva");
      const withFormer = await rawText(await call(founder, "/club-members/export?columns=displayName&includeFormer=true"));
      expect(withFormer).toContain("Ehemalig Eva");
    });

    it("is club-scoped: a second club's members never show up", async () => {
      const other = await signUp("other");
      userIds.push(other.userId);
      const otherClub = (await auth.api.createOrganization({ body: { name: `B10 other ${suffix}`, slug: `b10-other-${suffix}`, userId: other.userId } }))!.id;
      try {
        const m = (await db.query.member.findFirst({ where: and(eq(member.organizationId, otherClub), eq(member.userId, other.userId)) }))!;
        await db.insert(clubRoles).values({ memberId: m.id, roleType: "vorsitz" });
        const res = await app.request(`/club-members/export?columns=displayName&clubId=${otherClub}`, { headers: { cookie: other.cookie, "x-forwarded-for": randomUUID() } });
        const text = await rawText(res);
        expect(res.status).toBe(200);
        expect(text).not.toContain("Carla Commit");
      } finally {
        await db.delete(organization).where(eq(organization.id, otherClub));
      }
    });
  });
});
