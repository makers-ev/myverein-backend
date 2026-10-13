import "dotenv/config";
import { Pool } from "pg";

import { collectReport, formatReport } from "../db/verify-counts.js";

/**
 * Read-only count/integrity report against DATABASE_URL (run it on a COPY of production, before and after
 * `npm run db:migrate:runtime`, and diff the two outputs). Prints table names and numbers only, no personal data.
 * Exit code 1 if an integrity check fails.
 */
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const report = await collectReport(pool);
    console.log(formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[verify-counts] failed", err instanceof Error ? err.message : err);
  process.exit(1);
});
