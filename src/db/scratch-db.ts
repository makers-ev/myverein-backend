import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";

/**
 * Shared helper for migration tests that run against throw-away databases.
 *
 * Every pool handed out here has an `error` listener (an idle client that Postgres terminates -- e.g. 57P01 when a
 * database is dropped WITH (FORCE) -- would otherwise surface as an unhandled 'error' event and fail the vitest run),
 * and `cleanup()` always ends all scratch pools and waits for them BEFORE it drops the databases.
 */

export const MIGRATIONS = path.resolve("src/db/migrations");

export class ScratchDatabases {
  private readonly baseUrl: string;
  private admin: Pool | undefined;
  private readonly pools = new Set<Pool>();
  private readonly databases: string[] = [];
  private readonly tmpDirs: string[] = [];

  constructor(baseUrl: string = process.env.DATABASE_URL!) {
    this.baseUrl = baseUrl;
  }

  private track(connectionString: string, max: number): Pool {
    const pool = new Pool({ connectionString, max });
    pool.on("error", () => {
      // Backend of an idle client went away (database dropped / server shutting down); nothing to recover in a test.
    });
    this.pools.add(pool);
    return pool;
  }

  private adminPool(): Pool {
    this.admin ??= this.track(this.baseUrl, 1);
    return this.admin;
  }

  /** A copy of the migrations folder whose journal only contains entries up to and including `lastIdx`. */
  async migrationsUpTo(lastIdx: number): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mv-mig-"));
    this.tmpDirs.push(dir);
    await cp(MIGRATIONS, dir, { recursive: true });
    const journalPath = path.join(dir, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
    journal.entries = journal.entries.filter((e) => e.idx <= lastIdx);
    await writeFile(journalPath, JSON.stringify(journal));
    return dir;
  }

  /** Creates an empty scratch database and returns a tracked pool connected to it. */
  async create(label: string): Promise<Pool> {
    const name = `mv_mig_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await this.adminPool().query(`CREATE DATABASE "${name}"`);
    this.databases.push(name);
    const url = new URL(this.baseUrl);
    url.pathname = `/${name}`;
    return this.track(url.toString(), 2);
  }

  /** Ends every pool (and awaits it), then drops the scratch databases and removes temp folders. Safe to call twice. */
  async cleanup(): Promise<void> {
    const admin = this.admin;
    const scratchPools = [...this.pools].filter((p) => p !== admin);
    await Promise.allSettled(scratchPools.map((p) => p.end()));
    for (const p of scratchPools) this.pools.delete(p);
    if (admin) {
      for (const name of this.databases.splice(0)) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
      await admin.end();
      this.pools.delete(admin);
      this.admin = undefined;
    }
    for (const dir of this.tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  }
}
