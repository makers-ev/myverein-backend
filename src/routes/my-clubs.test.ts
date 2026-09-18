import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { toAppError } from "../lib/errors.js";
import { myClubRoutes } from "./my-clubs.js";

const app = new Hono();
app.route("/my-clubs", myClubRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

describe("GET /my-clubs", () => {
  let userId: string;
  let clubId: string;
  let cookie: string;

  beforeAll(async () => {
    const { user: created } = await auth.api.createUser({
      body: { email: `my-clubs-${suffix}@example.com`, password: "test-password-123!", name: "My Clubs Test" },
    });
    userId = created.id;
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));

    const signIn = await auth.api.signInEmail({
      body: { email: `my-clubs-${suffix}@example.com`, password: "test-password-123!" },
      asResponse: true,
    });
    cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0];

    const club = await auth.api.createOrganization({
      body: { name: `My Clubs Test Club ${suffix}`, slug: `my-clubs-test-${suffix}`, userId },
    });
    clubId = club!.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    await db.delete(user).where(eq(user.id, userId));
    await closeDatabase();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/my-clubs");
    expect(res.status).toBe(401);
  });

  it("lists the club the user was auto-added to by createOrganization", async () => {
    const res = await app.request("/my-clubs", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ clubId: string; clubName: string | null }> };
    expect(body.data.some((c) => c.clubId === clubId)).toBe(true);
    expect(body.data.find((c) => c.clubId === clubId)?.clubName).toBe(`My Clubs Test Club ${suffix}`);
  });
});
