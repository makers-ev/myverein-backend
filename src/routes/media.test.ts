import { rm } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { toAppError } from "../lib/errors.js";
import { UPLOADS_DIR } from "../lib/storage.js";
import { mediaRoutes } from "./media.js";

/**
 * Integration test against a real Postgres (DATABASE_URL), following
 * locations.test.ts's pattern for session/club setup. Covers upload
 * success (returned key), content-type rejection, oversized-file
 * rejection, and the club-scoping 404 on GET /media/:key when a different
 * club's session requests a key it doesn't own.
 */

const app = new Hono();
app.route("/media", mediaRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUpAndVerify(email: string, name: string) {
  const { user: created } = await auth.api.createUser({
    body: { email, password: "test-password-123!", name },
  });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  const cookie = signIn.headers.get("set-cookie") ?? "";
  return { userId: created.id, cookie: cookie.split(";")[0] };
}

function pngFile(name: string, sizeBytes: number, type = "image/png"): File {
  return new File([Buffer.alloc(sizeBytes, 1)], name, { type });
}

describe("media routes", () => {
  let clubAId: string;
  let clubBId: string;
  let userIds: string[] = [];
  let cookieA: string;
  let cookieB: string;

  beforeAll(async () => {
    const founderA = await signUpAndVerify(`media-a-${suffix}@example.com`, "Club A Founder");
    const founderB = await signUpAndVerify(`media-b-${suffix}@example.com`, "Club B Founder");
    userIds = [founderA.userId, founderB.userId];
    cookieA = founderA.cookie;
    cookieB = founderB.cookie;

    const clubA = await auth.api.createOrganization({
      body: { name: `Media Club A ${suffix}`, slug: `media-club-a-${suffix}`, userId: founderA.userId },
    });
    const clubB = await auth.api.createOrganization({
      body: { name: `Media Club B ${suffix}`, slug: `media-club-b-${suffix}`, userId: founderB.userId },
    });
    clubAId = clubA!.id;
    clubBId = clubB!.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubAId));
    await db.delete(organization).where(eq(organization.id, clubBId));
    for (const id of userIds) {
      await db.delete(user).where(eq(user.id, id));
    }
    await closeDatabase();
    await rm(`${UPLOADS_DIR}/${clubAId}`, { recursive: true, force: true });
    await rm(`${UPLOADS_DIR}/${clubBId}`, { recursive: true, force: true });
  });

  it("rejects an unauthenticated upload with 401", async () => {
    const form = new FormData();
    form.set("file", pngFile("photo.png", 1024));
    const res = await app.request(`/media?clubId=${clubAId}`, { method: "POST", body: form });
    expect(res.status).toBe(401);
  });

  it("uploads a valid image and returns its storage key", async () => {
    const form = new FormData();
    form.set("file", pngFile("photo.png", 2048));
    const res = await app.request(`/media?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA },
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { key: string } };
    expect(body.data.key.startsWith(`${clubAId}/`)).toBe(true);
    expect(body.data.key.endsWith("photo.png")).toBe(true);
  });

  it("rejects a disallowed content type with 422", async () => {
    const form = new FormData();
    form.set("file", pngFile("notes.txt", 1024, "text/plain"));
    const res = await app.request(`/media?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA },
      body: form,
    });
    expect(res.status).toBe(422);
  });

  it("rejects a file over the 10 MB size limit with 422", async () => {
    const form = new FormData();
    form.set("file", pngFile("huge.png", 10 * 1024 * 1024 + 4096));
    const res = await app.request(`/media?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA },
      body: form,
    });
    expect(res.status).toBe(422);
  }, 15_000);

  it("rejects a request missing the file field with 422", async () => {
    const form = new FormData();
    form.set("file", "not-a-file");
    const res = await app.request(`/media?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA },
      body: form,
    });
    expect(res.status).toBe(422);
  });

  it("serves back the uploaded bytes with an inferred content type for the owning club", async () => {
    const form = new FormData();
    form.set("file", pngFile("readback.png", 512));
    const uploadRes = await app.request(`/media?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA },
      body: form,
    });
    const uploadBody = (await uploadRes.json()) as { data: { key: string } };

    const getRes = await app.request(`/media/${uploadBody.data.key}?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await getRes.arrayBuffer());
    expect(bytes.length).toBe(512);
  });

  it("404s (never 403) fetching another club's key -- club-id prefix mismatch", async () => {
    const form = new FormData();
    form.set("file", pngFile("secret.png", 256));
    const uploadRes = await app.request(`/media?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieA },
      body: form,
    });
    const uploadBody = (await uploadRes.json()) as { data: { key: string } };

    const res = await app.request(`/media/${uploadBody.data.key}?clubId=${clubBId}`, { headers: { cookie: cookieB } });
    expect(res.status).toBe(404);
  });

  it("404s fetching a key that doesn't exist on disk, within the caller's own club", async () => {
    const res = await app.request(`/media/${clubAId}/does-not-exist.png?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(404);
  });

  it("404s (never a filesystem error) on a path-traversal key that still matches the caller's own club-id prefix", async () => {
    // Literal "../" here would be collapsed by URL parsing before Hono's
    // router ever sees it (testing nothing but URL normalization). Percent-
    // encode the slashes so the raw ".." reaches storage.ts's own
    // containment check in getObject() -- that's the guard actually under
    // test, not an incidental 404 from routing.
    const encodedTraversal = `${clubAId}%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`;
    const res = await app.request(`/media/${encodedTraversal}?clubId=${clubAId}`, { headers: { cookie: cookieA } });
    expect(res.status).toBe(404);
  });
});
