import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import * as authSchema from "../auth/auth-schema.js";
import { logger } from "../lib/logger.js";
import * as accountsSchema from "./schema/accounts.js";
import * as auditLogSchema from "./schema/audit-log.js";
import * as notificationsSchema from "./schema/notifications.js";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and configure it.");
}

/**
 * Explicit pool bounds. The old Keycloak backend template shipped an
 * unbounded `pg` pool (documented weakness, see NEW-ARCHITECTURE-README §7)
 * which let a burst of concurrent requests exhaust Postgres connections.
 * `max`/`min`/`idleTimeoutMillis` are set deliberately here and should be
 * tuned per deployment via env vars rather than left implicit.
 */
export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  min: Number(process.env.DB_POOL_MIN ?? 2),
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS ?? 30_000),
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? 5_000),
});

pool.on("error", (err) => {
  // A backend connection that is idle in the pool errored out. Log and let
  // the pool recycle it; it must never crash the process.
  logger.error({ err }, "[db] unexpected error on idle client");
});

export const schema = {
  ...authSchema,
  ...accountsSchema,
  ...auditLogSchema,
  ...notificationsSchema,
};

export const db = drizzle(pool, { schema });

/** Cheap liveness probe used by GET /ready. Throws if the DB is unreachable. */
export async function pingDatabase(): Promise<void> {
  await pool.query("SELECT 1");
}

/** Graceful shutdown hook for process signal handlers in src/index.ts. */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}
