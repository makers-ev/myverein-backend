import { Hono } from "hono";

import { pingDatabase } from "../db/client.js";
import { getWorkerHeartbeat } from "../lib/jobs/worker.js";

/**
 * Liveness vs. readiness split, absent entirely from the old Keycloak
 * backend template (NEW-ARCHITECTURE-README §7):
 *  - GET /health -- process is up and answering HTTP. Never touches the DB,
 *    so it can't flap because of a transient Postgres blip.
 *  - GET /ready  -- process is up AND its dependencies (Postgres) are
 *    reachable. Use this for orchestrator readiness probes / load-balancer
 *    registration, not /health.
 */
export const healthRoutes = new Hono();

healthRoutes.get("/health", (c) => {
  return c.json({ status: "ok" });
});

healthRoutes.get("/ready", async (c) => {
  try {
    await pingDatabase();
    // Worker heartbeat (only present when this process runs the job worker). A stale worker is reported, not fatal:
    // the API itself is fine and a restart loop would not help a stuck handler.
    const worker = getWorkerHeartbeat();
    return c.json({ status: "ok", db: "up", ...(worker ? { worker: { status: worker.stale ? "stale" : "ok", lastPollAt: worker.lastPollAt, inFlight: worker.inFlight } } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return c.json({ status: "error", db: "down", message }, 503);
  }
});
