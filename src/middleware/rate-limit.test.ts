import { Hono } from "hono";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { rateLimit } from "./rate-limit.js";

function buildApp(max: number, windowMs: number) {
  const app = new Hono();
  app.use("*", rateLimit({ windowMs, max }));
  app.get("/", (c) => c.json({ ok: true }));
  app.onError((err, c) => c.json({ error: (err as Error).message }, 429));
  return app;
}

const headers = { "x-forwarded-for": "1.2.3.4" };

describe("rateLimit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows requests up to the max within the window", async () => {
    const app = buildApp(3, 60_000);
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/", { headers });
      expect(res.status).toBe(200);
    }
  });

  it("rejects the Nth+1 request within the window with 429", async () => {
    const app = buildApp(3, 60_000);
    for (let i = 0; i < 3; i++) {
      await app.request("/", { headers });
    }
    const res = await app.request("/", { headers });
    expect(res.status).toBe(429);
  });

  it("resets the count after the window elapses", async () => {
    const app = buildApp(2, 1_000);
    await app.request("/", { headers });
    await app.request("/", { headers });
    const blocked = await app.request("/", { headers });
    expect(blocked.status).toBe(429);

    vi.advanceTimersByTime(1_001);

    const afterReset = await app.request("/", { headers });
    expect(afterReset.status).toBe(200);
  });

  it("tracks separate clients independently", async () => {
    const app = buildApp(1, 60_000);
    const a = await app.request("/", { headers: { "x-forwarded-for": "1.1.1.1" } });
    const b = await app.request("/", { headers: { "x-forwarded-for": "2.2.2.2" } });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});
