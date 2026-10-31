import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { clientIp, ipSubject } from "./rate-limits.js";

/** B14 review: `x-forwarded-for` is only trusted from the right (our own proxies), never from the client-chosen first entry. */
describe("client IP for rate limits", () => {
  const original = process.env.TRUSTED_PROXY_HOPS;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = original;
  });

  const probe = async (header: string | undefined) => {
    const app = new Hono();
    app.get("/", (c) => c.json({ ip: clientIp(c), subject: ipSubject(c) }));
    const res = await app.request("/", { headers: header === undefined ? {} : { "x-forwarded-for": header } });
    return (await res.json()) as { ip: string; subject: string };
  };

  it("uses the last entry by default, so a spoofed first entry changes nothing", async () => {
    delete process.env.TRUSTED_PROXY_HOPS;
    const a = await probe("1.1.1.1, 203.0.113.9");
    const b = await probe("2.2.2.2, 3.3.3.3, 203.0.113.9");
    expect(a.ip).toBe("203.0.113.9");
    expect(b.ip).toBe("203.0.113.9");
    expect(a.subject).toBe(b.subject);
    expect(a.subject).not.toContain("203.0.113.9");
  });

  it("honours TRUSTED_PROXY_HOPS, falls back to the first entry when there are fewer, and 'unknown' without a header", async () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect((await probe("9.9.9.9, 203.0.113.9, 10.0.0.1")).ip).toBe("203.0.113.9");
    expect((await probe("203.0.113.9")).ip).toBe("203.0.113.9");
    expect((await probe(undefined)).ip).toBe("unknown");
    process.env.TRUSTED_PROXY_HOPS = "garbage";
    expect((await probe("9.9.9.9, 203.0.113.9")).ip).toBe("203.0.113.9");
  });
});
