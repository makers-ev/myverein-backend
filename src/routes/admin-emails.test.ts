import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { toAppError } from "../lib/errors.js";
import type { SessionEnv } from "../middleware/session-guard.js";
import { adminEmailRoutes } from "./admin-emails.js";

/**
 * Integration test against a real Postgres (DATABASE_URL). Locks in the
 * admin-only gate for POST /admin/send-verification-email and that the
 * server-side re-entry path (no session -> Better Auth's anonymous branch)
 * actually reaches the e-mail-sending code for a *different* user -- which
 * the client-side `sendVerificationEmail` can never do for an admin (it
 * requires the session email to match, EMAIL_MISMATCH).
 */

const app = new Hono<SessionEnv>();
app.route("/admin", adminEmailRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

async function createUserWithCookie(email: string, role: "user" | "admin") {
  const password = "test-password-123!";
  const { user: created } = await auth.api.createUser({ body: { email, password, name: "Test User" } });
  await db.update(user).set({ emailVerified: true, role }).where(eq(user.id, created.id));

  const signInRes = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in did not return a session cookie");
  const cookie = setCookie.split(";")[0];

  return { userId: created.id, cookie };
}

describe("POST /admin/send-verification-email", () => {
  let admin: { userId: string; cookie: string };
  let plainUser: { userId: string; cookie: string };
  let target: { userId: string; email: string };
  const suffix = Date.now();

  beforeAll(async () => {
    admin = await createUserWithCookie(`admin-emails-admin-${suffix}@example.com`, "admin");
    plainUser = await createUserWithCookie(`admin-emails-user-${suffix}@example.com`, "user");
    const { user: created } = await auth.api.createUser({
      body: { email: `admin-emails-target-${suffix}@example.com`, password: "test-password-123!", name: "Target" },
    });
    target = { userId: created.id, email: created.email };
  }, 20_000);

  afterAll(async () => {
    await db.delete(user).where(eq(user.id, admin.userId));
    await db.delete(user).where(eq(user.id, plainUser.userId));
    await db.delete(user).where(eq(user.id, target.userId));
    await closeDatabase();
  });

  it("rejects a request with no session", async () => {
    const res = await app.request("/admin/send-verification-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: target.userId, callbackURL: "http://localhost:3001/verify-email" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a non-admin session", async () => {
    const res = await app.request("/admin/send-verification-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: plainUser.cookie },
      body: JSON.stringify({ userId: target.userId, callbackURL: "http://localhost:3001/verify-email" }),
    });
    expect(res.status).toBe(401);
  });

  it("404s for an unknown userId", async () => {
    const res = await app.request("/admin/send-verification-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({ userId: "does-not-exist", callbackURL: "http://localhost:3001/verify-email" }),
    });
    expect(res.status).toBe(404);
  });

  it("sends a verification email for a different (unverified) user as an admin", async () => {
    const res = await app.request("/admin/send-verification-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({ userId: target.userId, callbackURL: "http://localhost:3001/verify-email" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: boolean };
    expect(body.status).toBe(true);
  }, 10_000);

  it("refuses to re-send for an already-verified user", async () => {
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, target.userId));
    const res = await app.request("/admin/send-verification-email", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({ userId: target.userId, callbackURL: "http://localhost:3001/verify-email" }),
    });
    expect(res.status).toBe(409);
  });
});