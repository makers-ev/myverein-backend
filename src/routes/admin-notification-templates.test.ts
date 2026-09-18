import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { notification, notificationTemplate } from "../db/schema/notifications.js";
import { toAppError } from "../lib/errors.js";
import type { SessionEnv } from "../middleware/session-guard.js";
import { adminNotificationTemplateRoutes } from "./admin-notification-templates.js";

/**
 * Integration test against a real Postgres (DATABASE_URL). Locks in the
 * "known key, no override yet" default shape GET returns, the PATCH
 * upsert + admin-only gate, and DELETE reverting to no-override.
 */

const app = new Hono<SessionEnv>();
app.route("/admin/notification-templates", adminNotificationTemplateRoutes);
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

describe("admin notification template routes", () => {
  let admin: { userId: string; cookie: string };
  let plainUser: { userId: string; cookie: string };
  const suffix = Date.now();

  beforeAll(async () => {
    admin = await createUserWithCookie(`notif-tpl-admin-${suffix}@example.com`, "admin");
    plainUser = await createUserWithCookie(`notif-tpl-user-${suffix}@example.com`, "user");
  }, 20_000);

  afterEach(async () => {
    await db.delete(notificationTemplate).where(eq(notificationTemplate.translationKey, "notification.welcome"));
  });

  afterAll(async () => {
    await db.delete(user).where(eq(user.id, admin.userId));
    await db.delete(user).where(eq(user.id, plainUser.userId));
    await closeDatabase();
  });

  it("lists the known key with null translations when there is no override", async () => {
    const res = await app.request("/admin/notification-templates", { headers: { Cookie: admin.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ translationKey: string; translations: unknown }> };
    expect(body.data).toEqual([{ translationKey: "notification.welcome", translations: null, updatedAt: null }]);
  });

  it("rejects a non-admin session", async () => {
    const res = await app.request("/admin/notification-templates", { headers: { Cookie: plainUser.cookie } });
    expect(res.status).toBe(401);
  });

  it("upserts an override and reflects it in the list", async () => {
    const translations = { de: { title: "Hallo", body: "Willkommen" }, en: { title: "Hi", body: "Welcome" } };
    const patchRes = await app.request("/admin/notification-templates/notification.welcome", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({ translations }),
    });
    expect(patchRes.status).toBe(200);

    const listRes = await app.request("/admin/notification-templates", { headers: { Cookie: admin.cookie } });
    const body = (await listRes.json()) as { data: Array<{ translations: typeof translations }> };
    expect(body.data[0].translations).toEqual(translations);
  });

  it("404s PATCH for an unknown key", async () => {
    const res = await app.request("/admin/notification-templates/not-a-real-key", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({ translations: { de: { title: "x", body: "x" }, en: { title: "x", body: "x" } } }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE reverts an override back to no-override", async () => {
    await app.request("/admin/notification-templates/notification.welcome", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({
        translations: { de: { title: "Hallo", body: "Willkommen" }, en: { title: "Hi", body: "Welcome" } },
      }),
    });

    const deleteRes = await app.request("/admin/notification-templates/notification.welcome", {
      method: "DELETE",
      headers: { Cookie: admin.cookie },
    });
    expect(deleteRes.status).toBe(204);

    const listRes = await app.request("/admin/notification-templates", { headers: { Cookie: admin.cookie } });
    const body = (await listRes.json()) as { data: Array<{ translations: unknown }> };
    expect(body.data[0].translations).toBeNull();
  });

  it("welcome hook bakes an active override into a new user's welcome notification", async () => {
    await app.request("/admin/notification-templates/notification.welcome", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: admin.cookie },
      body: JSON.stringify({
        translations: { de: { title: "Servus", body: "Willkommen!" }, en: { title: "Howdy", body: "Welcome!" } },
      }),
    });

    const { user: created } = await auth.api.createUser({
      body: { email: `notif-tpl-signup-${suffix}@example.com`, password: "test-password-123!", name: "New User" },
    });

    const welcome = await db.query.notification.findFirst({
      where: eq(notification.targetUserId, created.id),
    });
    expect(welcome?.translations?.de.title).toBe("Servus");
    expect(welcome?.translations?.en.title).toBe("Howdy");

    await db.delete(notification).where(eq(notification.targetUserId, created.id));
    await db.delete(user).where(eq(user.id, created.id));
  });
});
