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
/** Properties of database errors that carry the bound values of the query (absence notes, proof sources, e-mail addresses ...). */
const BOUND_VALUE_KEYS = ["params", "query", "parameters", "values", "sql"];

/** Pino's error serializer minus everything a driver or ORM error attaches about the statement and its values (also on `cause`). */
export function serializeError(err: unknown): Record<string, unknown> {
  const out = pino.stdSerializers.err(err as Error) as unknown as Record<string, unknown>;
  const strip = (o: Record<string, unknown>, depth: number): void => {
    for (const key of BOUND_VALUE_KEYS) delete o[key];
    // Drizzle's "Failed query: <sql>\nparams: <values>" message (and the stack that starts with it): keep the statement, cut the values.
    for (const key of ["message", "stack"]) if (typeof o[key] === "string") o[key] = (o[key] as string).replace(/\nparams:[^\n]*/g, "\nparams: [redacted]");
    if (depth < 5 && o.cause && typeof o.cause === "object") strip(o.cause as Record<string, unknown>, depth + 1);
  };
  strip(out, 0);
  return out;
}

export const logger = pino({
  serializers: { err: serializeError },
  redact: { paths: ["params", "*.params", "query", "*.query", "*.cause.params"], censor: "[redacted]" },
  transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty" },
});
