import "dotenv/config";

import { closeDatabase } from "./db/client.js";
import { registerAllJobs, startJobWorker } from "./lib/jobs/index.js";
import { logger } from "./lib/logger.js";

/**
 * Stand-alone worker entry (`node dist/worker.js`) for deployments that run the API with `WORKER_ENABLED=false`.
 * Same queue, same handlers; several processes are safe (FOR UPDATE SKIP LOCKED + dedupe keys).
 */
registerAllJobs();
const worker = startJobWorker();

async function shutdown(signal: string) {
  logger.info(`[shutdown] received ${signal}, stopping worker`);
  await worker.stop();
  await closeDatabase();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
