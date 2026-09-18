import pino from "pino";

/**
 * Module-level logger for call sites outside request context (DB pool
 * errors, process shutdown, server start). Request-scoped code should
 * prefer `c.get("logger")` (src/middleware/request-id.ts) so log lines carry
 * a request ID.
 *
 * Pretty-printing is dev-only and goes through pino's own `transport`
 * option so `pino-pretty` only has to exist as a devDependency, not a
 * runtime one -- production just gets ndjson on stdout.
 */
export const logger = pino({
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});
