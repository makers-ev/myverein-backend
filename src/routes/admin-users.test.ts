import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { toAppError } from "../lib/errors.js";
import type { SessionEnv } from "../middleware/session-guard.js";
import { adminUserRoutes } from "./admin-users.js";

/** H2: the platform admin deletes accounts through the erasure process; Better Auth's own remove-user is switched off. */

const app = new Hono<SessionEnv>();
app.route("/admin", adminUserRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUp(label: string, role: "user" | "admin" = "user") {
  const email = `admin-users-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `AU ${label}` } });
  await db.update(user).set({ emailVerified: true, role }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

describe("DELETE /admin/users/:id", () => {
  let admin: Awaited<ReturnType<typeof signUp>>;
  let plain: Awaited<ReturnType<typeof signUp>>;
  let owner: Awaited<ReturnType<typeof signUp>>;
  let member: Awaited<ReturnType<typeof signUp>>;
  let clubId: string;
  const del = (cookie: string, id: string) => app.request(`/admin/users/${id}`, { method: "DELETE", headers: { cookie } });

  beforeAll(async () => {
    admin = await signUp("admin", "admin");
    plain = await signUp("plain");
    owner = await signUp("owner");
    member = await signUp("member");
    clubId = (await auth.api.createOrganization({ body: { name: `AU Club ${suffix}`, slug: `au-club-${suffix}`, userId: owner.userId } }))!.id;
    await auth.api.addMember({ body: { userId: member.userId, organizationId: clubId, role: "member" } });
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it("is admin only", async () => {
    expect((await del(plain.cookie, member.userId)).status).toBe(401);
    expect((await app.request(`/admin/users/${member.userId}`, { method: "DELETE" })).status).toBe(401);
  });

  it("switches off Better Auth's remove-user", async () => {
    const res = await auth.handler(new Request("http://localhost:3000/api/auth/admin/remove-user", { method: "POST", headers: { cookie: admin.cookie, "content-type": "application/json", origin: "http://localhost:3001" }, body: JSON.stringify({ userId: member.userId }) }));
    expect(res.status).toBe(404);
    expect(await db.query.user.findFirst({ where: eq(user.id, member.userId) })).toBeTruthy();
  });

  it("refuses the deletion of a sole owner and changes nothing", async () => {
    const res = await del(admin.cookie, owner.userId);
    expect(res.status).toBe(409);
    expect(await db.query.user.findFirst({ where: eq(user.id, owner.userId) })).toBeTruthy();
  });

  it("refuses to delete oneself and unknown users", async () => {
    expect((await del(admin.cookie, admin.userId)).status).toBe(422);
    expect((await del(admin.cookie, "nope")).status).toBe(404);
  });

  it("anonymises the club record instead of cascading it away", async () => {
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.lastUserId, member.userId) });
    expect(cm).toBeTruthy();
    const res = await del(admin.cookie, member.userId);
    expect(res.status).toBe(200);
    expect(await db.query.user.findFirst({ where: eq(user.id, member.userId) })).toBeUndefined();
    const [row] = await db.select().from(clubMembers).where(eq(clubMembers.id, cm!.id));
    expect(row).toMatchObject({ displayName: "Gelöschtes Mitglied", memberId: null });
  });
});
