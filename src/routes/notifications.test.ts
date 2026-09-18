import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { notification } from "../db/schema/notifications.js";
import { toAppError } from "../lib/errors.js";
import type { SessionEnv } from "../middleware/session-guard.js";
import { notificationRoutes } from "./notifications.js";

/**
 * Integration test against a real Postgres (DATABASE_URL). Locks in the
 * lazy-state merge (a missing `notification_state` row means unread/not
 * deleted) across unread/read/delete combinations, and the `deletable`
 * guard on DELETE.
 */

const app = new Hono<SessionEnv>();
app.route("/notifications", notificationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

async function createUserWithCookie(email: string) {
  const password = "test-password-123!";
  const { user: created } = await auth.api.createUser({ body: { email, password, name: "Test User" } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));

  const signInRes = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signInRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("sign-in did not return a session cookie");
  const cookie = setCookie.split(";")[0];

  return { userId: created.id, cookie };
}

describe("notification routes", () => {
  let owner: { userId: string; cookie: string };
  let other: { userId: string; cookie: string };
  const suffix = Date.now();
  const notificationIds: string[] = [];

  beforeAll(async () => {
    owner = await createUserWithCookie(`notif-owner-${suffix}@example.com`);
    other = await createUserWithCookie(`notif-other-${suffix}@example.com`);
  }, 20_000);

  afterAll(async () => {
    for (const id of notificationIds) {
      await db.delete(notification).where(eq(notification.id, id));
    }
    await db.delete(user).where(eq(user.id, owner.userId));
    await db.delete(user).where(eq(user.id, other.userId));
    await closeDatabase();
  });

  async function insertNotification(targetUserId: string | null, deletable = true) {
    const [row] = await db
      .insert(notification)
      .values({ kind: "system", targetUserId, translationKey: "notification.welcome", deletable })
      .returning();
    notificationIds.push(row.id);
    return row;
  }

  it("lists a targeted notification as unread with no state row", async () => {
    const n = await insertNotification(owner.userId);

    const res = await app.request("/notifications?filter=unread", { headers: { Cookie: owner.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; read: boolean }> };
    expect(body.data.some((row) => row.id === n.id && row.read === false)).toBe(true);
  });

  it("excludes another user's targeted notification", async () => {
    const n = await insertNotification(other.userId);

    const res = await app.request("/notifications", { headers: { Cookie: owner.cookie } });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((row) => row.id === n.id)).toBe(false);
  });

  it("includes a broadcast notification for every user", async () => {
    const n = await insertNotification(null);

    const res = await app.request("/notifications", { headers: { Cookie: other.cookie } });
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((row) => row.id === n.id)).toBe(true);
  });

  it("moves a notification from unread to read and back, reflected in unread-count", async () => {
    const n = await insertNotification(owner.userId);

    const before = (await (
      await app.request("/notifications/unread-count", { headers: { Cookie: owner.cookie } })
    ).json()) as { data: { count: number } };

    await app.request(`/notifications/${n.id}/read`, { method: "POST", headers: { Cookie: owner.cookie } });

    const afterRead = (await (
      await app.request("/notifications/unread-count", { headers: { Cookie: owner.cookie } })
    ).json()) as { data: { count: number } };
    expect(afterRead.data.count).toBe(before.data.count - 1);

    await app.request(`/notifications/${n.id}/unread`, { method: "POST", headers: { Cookie: owner.cookie } });
    const afterUnread = (await (
      await app.request("/notifications/unread-count", { headers: { Cookie: owner.cookie } })
    ).json()) as { data: { count: number } };
    expect(afterUnread.data.count).toBe(before.data.count);
  });

  it("soft-deletes a deletable notification, hiding it from later listings", async () => {
    const n = await insertNotification(owner.userId, true);

    const res = await app.request(`/notifications/${n.id}`, { method: "DELETE", headers: { Cookie: owner.cookie } });
    expect(res.status).toBe(204);

    const list = (await (
      await app.request("/notifications", { headers: { Cookie: owner.cookie } })
    ).json()) as { data: Array<{ id: string }> };
    expect(list.data.some((row) => row.id === n.id)).toBe(false);
  });

  it("refuses to delete a non-deletable notification", async () => {
    const n = await insertNotification(owner.userId, false);

    const res = await app.request(`/notifications/${n.id}`, { method: "DELETE", headers: { Cookie: owner.cookie } });
    expect(res.status).toBe(403);
  });

  it("404s deleting a notification not targeted at the caller", async () => {
    const n = await insertNotification(other.userId);

    const res = await app.request(`/notifications/${n.id}`, { method: "DELETE", headers: { Cookie: owner.cookie } });
    expect(res.status).toBe(404);
  });
});
