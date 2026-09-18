// ponytail: in-memory per-instance rate limiting — correct for this
// template's single-replica default (see compose.yml / docker-entrypoint.sh
// migration-on-boot trade-off), wrong once you scale to multiple backend
// replicas behind a load balancer (each instance has its own counter).
// Upgrade path: swap the in-memory Map for a Redis-backed limiter
// (e.g. @upstash/ratelimit) if/when a product scales horizontally.
import { createMiddleware } from "hono/factory";

import { TooManyRequestsError } from "../lib/errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Factory-style sliding-window-by-reset limiter, keyed by client IP. Falls
 * back to a single shared bucket if no IP header is present (e.g. local
 * dev without a reverse proxy setting `x-forwarded-for`).
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }) {
  const buckets = new Map<string, Bucket>();

  return createMiddleware(async (c, next) => {
    const key = c.req.header("x-forwarded-for") ?? "unknown";
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      throw new TooManyRequestsError("Rate limit exceeded, try again later");
    }

    await next();
  });
}
