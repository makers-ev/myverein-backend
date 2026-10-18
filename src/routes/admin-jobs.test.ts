import { randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { jobs } from "../db/schema/jobs.js";
import { toAppError } from "../lib/errors.js";
import { adminJobRoutes, scrubJobError } from "./admin-jobs.js";

/** Wave 9 A1: queue overview and re-scheduling of dead jobs (platform admin only). */

const app = new Hono();
app.route("/admin/jobs", adminJobRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
const TYPE_A = `t-admin-a-${suffix}`;
const TYPE_B = `t-admin-b-${suffix}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const userIds: string[] = [];
let admin: { cookie: string; userId: string };
let plain: { cookie: string };

async function createUser(label: string, role: "user" | "admin") {
  const email = `a1-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `A1 ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true, role }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const call = (who: { cookie: string } | null, path: string, method = "GET") =>
  app.request(`/admin/jobs${path}`, { method, headers: { ...(who ? { cookie: who.cookie } : {}), "x-forwarded-for": randomUUID() } });

let deadId: string;
let doneId: string;

beforeAll(async () => {
  admin = await createUser("admin", "admin");
  plain = await createUser("plain", "user");
  const past = new Date("2000-01-01T00:00:00Z"); // oldest first, so leftover jobs of other tests cannot push these out of the list
  const rows = await db
    .insert(jobs)
    .values([
      { type: TYPE_A, status: "queued", runAt: past, payload: { secret: "do-not-leak@example.test" } },
      { type: TYPE_A, status: "queued", runAt: new Date(Date.now() + 3_600_000) },
      { type: TYPE_A, status: "failed", runAt: past, attempts: 1, lastError: "Error: x" },
      { type: TYPE_A, status: "done", finishedAt: new Date() },
      { type: TYPE_B, status: "running", lockedBy: "w1", lockedUntil: new Date(Date.now() + 60_000) },
      { type: TYPE_B, status: "dead", attempts: 5, maxAttempts: 5, finishedAt: new Date(Date.now() + 3_600_000), // newest first, so leftover dead jobs of other tests cannot push it out of the list
         lastError: "Error: smtp refused anna.schmidt@example.test (ExponentPushToken[abcdefgh12345678])" },
      { type: TYPE_B, status: "done", finishedAt: new Date() },
    ])
    .returning({ id: jobs.id, type: jobs.type, status: jobs.status });
  deadId = rows.find((r) => r.status === "dead")!.id;
  doneId = rows.find((r) => r.type === TYPE_B && r.status === "done")!.id;
}, 60_000);

afterAll(async () => {
  await db.delete(jobs).where(like(jobs.type, "t-admin-%"));
  await db.delete(auditLog).where(eq(auditLog.eventType, "admin.job_retry"));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("admin jobs (A1)", () => {
  it("is admin only", async () => {
    expect((await call(null, "/stats")).status).toBe(401);
    expect((await call(plain, "/stats")).status).toBe(401);
    expect((await call(plain, `/${deadId}/retry`, "POST")).status).toBe(401);
    expect((await call(null, `/${deadId}/retry`, "POST")).status).toBe(401);
    expect((await db.select().from(jobs).where(eq(jobs.id, deadId)))[0]!.status).toBe("dead");
  });

  it("counts per status and job type, lists the oldest due and the dead jobs without payload and personal data", async () => {
    const res = await call(admin, "/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const { data } = (await res.json()) as Json;
    expect(data.types.find((t: Json) => t.type === TYPE_A)).toEqual({ type: TYPE_A, queued: 2, running: 0, done: 1, failed: 1, dead: 0, total: 4 });
    expect(data.types.find((t: Json) => t.type === TYPE_B)).toEqual({ type: TYPE_B, queued: 0, running: 1, done: 1, failed: 0, dead: 1, total: 3 });
    expect(data.totals.queued).toBeGreaterThanOrEqual(2);

    const due = data.oldestDue.filter((j: Json) => j.type === TYPE_A);
    expect(due.map((j: Json) => j.status).sort()).toEqual(["failed", "queued"]); // the future job is not due
    expect(due.every((j: Json) => j.overdueSeconds >= 3500)).toBe(true);
    const sortedByRunAt = [...data.oldestDue].map((j: Json) => new Date(j.runAt).getTime());
    expect(sortedByRunAt).toEqual([...sortedByRunAt].sort((a, b) => a - b));

    const dead = data.dead.find((j: Json) => j.id === deadId);
    expect(dead).toMatchObject({ type: TYPE_B, status: "dead", attempts: 5, maxAttempts: 5 });
    expect(dead.lastError).toBe("Error: smtp refused [address] ([push-token])");
    const wire = JSON.stringify(data);
    expect(wire).not.toContain("do-not-leak");
    expect(wire).not.toContain("anna.schmidt");
    expect(wire).not.toContain("payload");
  });

  it("re-schedules only dead jobs and audits it", async () => {
    const res = await call(admin, `/${deadId}/retry`, "POST");
    expect(res.status).toBe(200);
    expect(((await res.json()) as Json).data).toEqual({ id: deadId, type: TYPE_B, status: "queued" });
    const [row] = await db.select().from(jobs).where(eq(jobs.id, deadId));
    expect(row).toMatchObject({ status: "queued", attempts: 0, lastError: null, lockedBy: null, finishedAt: null });
    expect(row!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const audits = (await db.select().from(auditLog).where(eq(auditLog.eventType, "admin.job_retry"))).filter((a) => a.subjectId === deadId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ type: TYPE_B, actor: admin.userId });

    // A second call and a job that is not dead: 409; unknown / malformed ids: 404.
    expect((await call(admin, `/${deadId}/retry`, "POST")).status).toBe(409);
    expect((await call(admin, `/${doneId}/retry`, "POST")).status).toBe(409);
    expect((await call(admin, `/${randomUUID()}/retry`, "POST")).status).toBe(404);
    expect((await call(admin, "/not-a-uuid/retry", "POST")).status).toBe(404);
  });

  it("scrubs addresses, tokens and long text from errors", () => {
    expect(scrubJobError(null)).toBeNull();
    expect(scrubJobError("a@b.de  failed\nagain")).toBe("[address] failed again");
    expect(scrubJobError("x".repeat(500))).toHaveLength(300);
  });
});
