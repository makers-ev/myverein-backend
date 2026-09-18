import "dotenv/config";
import { migrate } from "drizzle-orm/node-postgres/migrator";

import { db, pool } from "./client.js";

/**
 * Runtime migration runner used by docker-entrypoint.sh. Uses drizzle-orm's
 * migrator (not the drizzle-kit CLI) so the production image never needs
 * drizzle-kit or any other devDependency installed.
 */
async function main() {
  await migrate(db, { migrationsFolder: "./src/db/migrations" });
  await pool.end();
}

main()
  .then(() => {
    console.log("[migrate] up to date");
    process.exit(0);
  })
  .catch((err) => {
    console.error("[migrate] failed", err);
    process.exit(1);
  });
