import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { pushTokens } from "../db/schema/communication.js";
import { toAppError } from "../lib/errors.js";
import { pushTokenRoutes } from "./push-tokens.js";

/** Wave 9 B8: registering, taking over and removing push tokens. */

const app = new Hono();
app.route("/push-tokens", pushTokenRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
const userIds: string[] = [];
type Who = { userId: string; cookie: string };
async function signUp(label: string): Promise<Who> {
  const email = `b8-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `B8 ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  userIds.push(created.id);
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const call = (who: Who | null, path: string, init: { method?: string; body?: object } = {}) =>
  app.request(`/push-tokens${path}`, {
    method: init.method ?? "POST",
    headers: { ...(who ? { cookie: who.cookie } : {}), "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const tok = (n: string) => `ExponentPushToken[b8${suffix}${n}abcdefgh]`;

let a: Who;
let b: Who;
beforeAll(async () => {
  a = await signUp("a");
  b = await signUp("b");
}, 60_000);
afterAll(async () => {
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("push tokens (B8)", () => {
  it("requires a session and a valid Expo token", async () => {
    expect((await call(null, "", { body: { token: tok("x"), platform: "ios" } })).status).toBe(401);
    expect((await call(a, "", { body: { token: "nope", platform: "ios" } })).status).toBe(422);
    expect((await call(a, "", { body: { token: tok("x"), platform: "web" } })).status).toBe(422);
  });

  it("registers a token for the caller and is idempotent", async () => {
    const body = { token: tok("one"), platform: "ios", appVersion: "1.2.3" };
    expect((await call(a, "", { body })).status).toBe(200);
    expect((await call(a, "", { body })).status).toBe(200);
    const rows = await db.select().from(pushTokens).where(eq(pushTokens.token, tok("one")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: a.userId, platform: "ios", appVersion: "1.2.3", disabledAt: null });
  });

  it("re-assigns a token of another account to the caller without revealing the previous owner", async () => {
    await call(a, "", { body: { token: tok("shared"), platform: "android" } });
    await db.update(pushTokens).set({ disabledAt: new Date() }).where(eq(pushTokens.token, tok("shared")));
    const res = await call(b, "", { body: { token: tok("shared"), platform: "android" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { registered: true } });
    const [row] = await db.select().from(pushTokens).where(eq(pushTokens.token, tok("shared")));
    expect(row).toMatchObject({ userId: b.userId, disabledAt: null });
  });

  it("deletes only the caller's own token, silently ignoring others", async () => {
    await call(a, "", { body: { token: tok("del"), platform: "ios" } });
    expect((await call(b, `/${encodeURIComponent(tok("del"))}`, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(pushTokens).where(eq(pushTokens.token, tok("del")))).toHaveLength(1);
    expect((await call(a, `/${encodeURIComponent(tok("del"))}`, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(pushTokens).where(eq(pushTokens.token, tok("del")))).toHaveLength(0);
    expect((await call(a, `/${encodeURIComponent(tok("none"))}`, { method: "DELETE" })).status).toBe(204);
  });

  it("limits the number of devices per account (429)", async () => {
    process.env.PUSH_TOKENS_MAX_PER_USER = "2";
    try {
      const c = await signUp("c");
      expect((await call(c, "", { body: { token: tok("c1"), platform: "ios" } })).status).toBe(200);
      expect((await call(c, "", { body: { token: tok("c2"), platform: "ios" } })).status).toBe(200);
      const res = await call(c, "", { body: { token: tok("c3"), platform: "ios" } });
      expect(res.status).toBe(429);
      // Re-registering an already known token is not a new device.
      expect((await call(c, "", { body: { token: tok("c2"), platform: "ios" } })).status).toBe(200);
    } finally {
      delete process.env.PUSH_TOKENS_MAX_PER_USER;
    }
  });

  it("limits registrations per account and hour in the database (429, audit)", async () => {
    process.env.PUSH_TOKEN_REGISTRATIONS_PER_HOUR = "2";
    try {
      const d = await signUp("d");
      expect((await call(d, "", { body: { token: tok("d1"), platform: "ios" } })).status).toBe(200);
      expect((await call(d, "", { body: { token: tok("d1"), platform: "ios" } })).status).toBe(200);
      const res = await call(d, "", { body: { token: tok("d1"), platform: "ios" } });
      expect(res.status).toBe(429);
      expect(((await res.json()) as { error: { details: { rule: string } } }).error.details.rule).toBe("push_token.user");
    } finally {
      delete process.env.PUSH_TOKEN_REGISTRATIONS_PER_HOUR;
    }
  });
});
