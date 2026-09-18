import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { toAppError } from "../lib/errors.js";
import type { SessionEnv } from "../middleware/session-guard.js";
import { accountsRoutes } from "./accounts.js";

/**
 * Integration test against a real Postgres (DATABASE_URL). Locks in the
 * ownership-scoping behaviour in accounts.ts: a user must get a 404 (not
 * the row) when requesting another user's account by ID -- 404 rather than
 * 403 so the endpoint doesn't confirm the resource exists at all.
 */

const app = new Hono<SessionEnv>();
app.route("/accounts", accountsRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

async function createVerifiedUserWithCookie(email: string) {
  const password = "test-password-123!";
  const { user: created } = await auth.api.createUser({ body: { email, password, name: "Test User" } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));

  const signInRes = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in did not return a session cookie");
  const cookie = setCookie.split(";")[0];

  return { userId: created.id, cookie };
}

describe("accounts ownership scoping", () => {
  let userA: { userId: string; cookie: string };
  let userB: { userId: string; cookie: string };
  const suffix = Date.now();

  beforeAll(async () => {
    userA = await createVerifiedUserWithCookie(`accounts-test-a-${suffix}@example.com`);
    userB = await createVerifiedUserWithCookie(`accounts-test-b-${suffix}@example.com`);
  }, 20_000);

  afterAll(async () => {
    await db.delete(user).where(eq(user.id, userA.userId));
    await db.delete(user).where(eq(user.id, userB.userId));
    await closeDatabase();
  });

  it("lets the owner read their own account", async () => {
    const createRes = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userA.cookie },
      body: JSON.stringify({ name: "A's account" }),
    });
    expect(createRes.status).toBe(201);
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const getRes = await app.request(`/accounts/${created.id}`, {
      headers: { Cookie: userA.cookie },
    });
    expect(getRes.status).toBe(200);
  });

  it("returns 404 (not 403, not the row) when a different user requests it", async () => {
    const createRes = await app.request("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userA.cookie },
      body: JSON.stringify({ name: "A's other account" }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const getRes = await app.request(`/accounts/${created.id}`, {
      headers: { Cookie: userB.cookie },
    });
    expect(getRes.status).toBe(404);
    const body = (await getRes.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("rejects requests with no session", async () => {
    const res = await app.request("/accounts");
    expect(res.status).toBe(401);
  });
});
