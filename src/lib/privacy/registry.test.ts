import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { contributors } from "./index.js";
import { EXEMPT_TABLES, coveredTables } from "./registry.js";

/**
 * Completeness gate (Wave 10 B7): every table with a personal reference to a club member must have an export and an
 * erasure contributor, or an explicit exemption with a reason. Later waves that add such a table fail here until they register.
 *
 * "Personal reference" = a foreign key to `club_members`, or a cascading / restricting foreign key to the account membership
 * `member` (rows ABOUT the person). `set null` references to `member` are actor references ("decided_by", "created_by") that
 * lose the person with the account and are not data about them.
 */
const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/schema");

async function allTables(): Promise<PgTable[]> {
  const tables = new Map<string, PgTable>();
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
    const mod = (await import(pathToFileURL(path.join(SCHEMA_DIR, file)).href)) as Record<string, unknown>;
    for (const value of Object.values(mod)) {
      if (value instanceof PgTable) tables.set(getTableConfig(value).name, value);
    }
  }
  return [...tables.values()];
}

describe("privacy contributor registry", () => {
  it("covers every table that references a club member or the account membership", async () => {
    contributors();
    const covered = coveredTables();
    const needed: string[] = [];
    for (const table of await allTables()) {
      const cfg = getTableConfig(table);
      const personal = cfg.foreignKeys.some((fk) => {
        const ref = fk.reference();
        const target = getTableConfig(ref.foreignTable).name;
        if (target === "club_members") return true;
        return target === "member" && fk.onDelete !== "set null";
      });
      if (personal) needed.push(cfg.name);
    }
    expect(needed.length).toBeGreaterThan(10);
    const missing = needed.filter((t) => !covered.has(t) && !(t in EXEMPT_TABLES));
    expect(missing, `register an export/erase contributor (lib/privacy/contributors.ts) or exempt with a reason: ${missing.join(", ")}`).toEqual([]);
  });

  it("only lists real tables and gives every exemption a reason", async () => {
    contributors();
    const names = new Set((await allTables()).map((t) => getTableConfig(t).name));
    for (const t of coveredTables().keys()) expect(names.has(t), `unknown table in a contributor: ${t}`).toBe(true);
    for (const [t, reason] of Object.entries(EXEMPT_TABLES)) {
      expect(names.has(t), `unknown exempt table: ${t}`).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("assigns each table to exactly one contributor", () => {
    const seen = new Map<string, string>();
    for (const c of contributors()) {
      for (const t of c.tables) {
        expect(seen.has(t), `${t} is in ${seen.get(t)} and ${c.key}`).toBe(false);
        seen.set(t, c.key);
      }
    }
  });
});
