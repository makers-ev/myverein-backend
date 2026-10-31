import { randomUUID } from "node:crypto";
import { withConsent } from "./forms-test-support.js";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubMemberRoutes } from "./club-members.js";

/** Wave 7 B15: POST /club-members/apply answers with distinguishable error codes in the nested error format. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-applications", clubApplicationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string): Promise<Actor> {
  const email = `apply-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Apply ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

const apply = (who: Actor, body: object) =>
  app.request("/club-members/apply", { method: "POST", headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() }, body: JSON.stringify(withConsent(body)) });
const decide = (who: Actor, clubId: string, id: string, action: "approve" | "reject") =>
  app.request(`/club-applications/${id}/${action}?clubId=${clubId}`, { method: "POST", headers: { cookie: who.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() }, body: action === "reject" ? JSON.stringify({ note: "Nein" }) : "{}" });

describe("POST /club-members/apply error codes (B15)", () => {
  let founder: Actor;
  let clubId: string;
  let slug: string;
  const userIds: string[] = [];

  beforeAll(async () => {
    founder = await signUp("founder");
    userIds.push(founder.userId);
    slug = `apply-codes-${suffix}`;
    const club = await auth.api.createOrganization({ body: { name: `Apply Codes ${suffix}`, slug, userId: founder.userId } });
    clubId = club!.id;
    const founderMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubId), eq(m.userId, founder.userId)) });
    await db.insert(clubRoles).values({ memberId: founderMember!.id, roleType: "vorsitz" });
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  async function newApplicant(label: string) {
    const who = await signUp(label);
    userIds.push(who.userId);
    return who;
  }

  it("answers 409 ALREADY_MEMBER (nested error object with details) for someone who is a member", async () => {
    const res = await apply(founder, { clubId });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Json;
    expect(body.error.code).toBe("ALREADY_MEMBER");
    expect(typeof body.error.message).toBe("string");
    expect(body.error.details).toMatchObject({ clubId });
    expect(body.error.details.clubMemberId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(body)).toEqual(["error"]);
  });

  it("answers 409 APPLICATION_PENDING with the own application's id for a repeated request (by id and by slug)", async () => {
    const who = await newApplicant("pending");
    const first = await apply(who, { clubId });
    expect(first.status).toBe(201);
    const applicationId = ((await first.json()) as Json).data.application.id as string;

    for (const body of [{ clubId }, { clubSlug: slug }]) {
      const again = await apply(who, body);
      expect(again.status).toBe(409);
      const json = (await again.json()) as Json;
      expect(json.error.code).toBe("APPLICATION_PENDING");
      expect(json.error.details).toMatchObject({ clubId, applicationId });
      expect(typeof json.error.details.submittedAt).toBe("string");
    }
    expect(await db.$count(clubApplications, eq(clubApplications.userId, who.userId))).toBe(1);
  });

  it("does not leak another user's application: the details always belong to the caller", async () => {
    const a = await newApplicant("leak-a");
    const b = await newApplicant("leak-b");
    const appA = ((await (await apply(a, { clubId })).json()) as Json).data.application.id as string;
    const resB = await apply(b, { clubId });
    expect(resB.status).toBe(201);
    const appB = ((await resB.json()) as Json).data.application.id as string;
    expect(appB).not.toBe(appA);
    const again = (await (await apply(b, { clubId })).json()) as Json;
    expect(again.error.details.applicationId).toBe(appB);
  });

  it("two parallel applications of the same user: one 201, the other APPLICATION_PENDING", async () => {
    const who = await newApplicant("race");
    const [r1, r2] = await Promise.all([apply(who, { clubId }), apply(who, { clubId })]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(((await loser.json()) as Json).error.code).toBe("APPLICATION_PENDING");
  });

  it("switches from APPLICATION_PENDING to ALREADY_MEMBER once approved, and allows a new application after a rejection", async () => {
    const approved = await newApplicant("approved");
    const appId = ((await (await apply(approved, { clubId })).json()) as Json).data.application.id as string;
    expect((await decide(founder, clubId, appId, "approve")).status).toBe(200);
    const afterApprove = await apply(approved, { clubId });
    expect(afterApprove.status).toBe(409);
    expect(((await afterApprove.json()) as Json).error.code).toBe("ALREADY_MEMBER");

    const rejected = await newApplicant("rejected");
    const rejId = ((await (await apply(rejected, { clubId })).json()) as Json).data.application.id as string;
    expect((await decide(founder, clubId, rejId, "reject")).status).toBe(200);
    expect((await apply(rejected, { clubId })).status).toBe(201);
  });

  it("keeps the other failures unchanged: unknown club 404, invalid body 422, no session 401", async () => {
    const who = await newApplicant("misc");
    expect((await apply(who, { clubSlug: `no-such-club-${suffix}` })).status).toBe(404);
    expect((await apply(who, {})).status).toBe(422);
    const anon = await app.request("/club-members/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(withConsent({ clubId })) });
    expect(anon.status).toBe(401);
  });
});
