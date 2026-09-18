import { createMiddleware } from "hono/factory";

import { logger } from "../lib/logger.js";

/** Typed context variable attached by `requestId`. */
export type LoggerEnv = {
  Variables: {
    logger: typeof logger;
  };
};

/**
 * Propagates (or mints) a request ID and attaches a child logger scoped to
 * it, so every log line for a request can be correlated -- across this
 * service and any upstream proxy that also stamps `X-Request-Id`.
 */
export const requestId = createMiddleware<LoggerEnv>(async (c, next) => {
  const id = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.set("logger", logger.child({ requestId: id }));
  c.header("X-Request-Id", id);
  await next();
});
