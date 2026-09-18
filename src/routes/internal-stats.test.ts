import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { toAppError } from "../lib/errors.js";
import { internalStatsRoutes } from "./internal-stats.js";

/**
 * Integration test against a real Postgres (DATABASE_URL). Locks in the
 * token-gate behaviour (unconfigured -> 503, wrong/missing token -> 401,
 * correct token -> 200) and that the returned counts actually reflect the
 * database, not just that the route responds.
 */

const app = new Hono();
app.route("/internal", internalStatsRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const TOKEN = "test-internal-stats-token";
const originalToken = process.env.INTERNAL_STATS_TOKEN;

describe("GET /internal/stats", () => {
  let userId: string;

  beforeEach(() => {
    process.env.INTERNAL_STATS_TOKEN = TOKEN;
  });

  beforeAll(async () => {
    const { user: created } = await auth.api.createUser({
      body: { email: `internal-stats-test-${Date.now()}@example.com`, password: "test-password-123!", name: "Stats Test" },
    });
    userId = created.id;
  }, 20_000);

  afterAll(async () => {
    await db.delete(user).where(eq(user.id, userId));
    process.env.INTERNAL_STATS_TOKEN = originalToken;
    await closeDatabase();
  });

  it("responds 503 when INTERNAL_STATS_TOKEN is not configured", async () => {
    delete process.env.INTERNAL_STATS_TOKEN;
    const res = await app.request("/internal/stats", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(503);
  });

  it("rejects a request with no token", async () => {
    const res = await app.request("/internal/stats");
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const res = await app.request("/internal/stats", { headers: { Authorization: "Bearer wrong-token" } });
    expect(res.status).toBe(401);
  });

  it("returns aggregate counts with the correct token", async () => {
    const res = await app.request("/internal/stats", { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      totalUsers: number;
      newUsersLast7Days: number;
      activeSessions: number;
      eventCounts: Record<string, number>;
      generatedAt: string;
    };

    // The user created in beforeAll counts toward both totals -- a loose
    // lower-bound check (>=, not ===) since other tests in this suite run
    // against the same database and create their own users concurrently.
    expect(body.totalUsers).toBeGreaterThanOrEqual(1);
    expect(body.newUsersLast7Days).toBeGreaterThanOrEqual(1);
    expect(typeof body.activeSessions).toBe("number");
    expect(typeof body.eventCounts).toBe("object");
    expect(new Date(body.generatedAt).toString()).not.toBe("Invalid Date");
  });
});
