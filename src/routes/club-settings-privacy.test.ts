import { randomUUID } from "node:crypto";

import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { clubSettingsRoutes } from "./club-settings.js";

/** Wave 10: privacy fields of /club-settings (age of consent, both guardians, contact, controller). */

const app = new Hono();
app.route("/club-settings", clubSettingsRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { userId: string; cookie: string };
const userIds: string[] = [];
let club: string;
let board: Who;
let trainer: Who;
let plain: Who;

async function signUp(label: string): Promise<Who> {
  const email = `w10p-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `W10 ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const call = (who: Who, url: string, init: { method?: string; body?: object } = {}) =>
  app.request(`${url}?clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (res: Response) => (await res.json()) as Json;

beforeAll(async () => {
  board = await signUp("board");
  trainer = await signUp("trainer");
  plain = await signUp("plain");
  club = (await auth.api.createOrganization({ body: { name: `TV Beispiel ${suffix}`, slug: `w10p-${suffix}`, userId: board.userId } }))!.id;
  const boardMember = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, club), e(m.userId, board.userId)) });
  await db.insert(clubRoles).values({ memberId: boardMember!.id, roleType: "vorsitz" });
  for (const [who, roleType] of [[trainer, "trainer"], [plain, null]] as const) {
    const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
    if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
  }
}, 60_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});


describe("club settings privacy fields", () => {
  it("returns the defaults to every member", async () => {
    const res = await json(await call(plain, "/club-settings"));
    expect(res.data).toMatchObject({ consentAgeLimit: 18, consentBothGuardians: false, privacyContact: null, privacyController: null });
  });

  it("lets privacy:manage change them (audited, normalised) and shows them to everybody", async () => {
    const res = await call(board, "/club-settings", { method: "PATCH", body: { consentAgeLimit: 16, consentBothGuardians: true, privacyContact: " datenschutz@verein.example ", privacyController: "Verein e. V., Musterweg 1" } });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ consentAgeLimit: 16, consentBothGuardians: true, privacyContact: "datenschutz@verein.example", privacyController: "Verein e. V., Musterweg 1" });
    expect((await json(await call(plain, "/club-settings"))).data.consentAgeLimit).toBe(16);
    const cleared = await call(board, "/club-settings", { method: "PATCH", body: { privacyContact: "" } });
    expect((await json(cleared)).data.privacyContact).toBeNull();
  });

  it("denies everybody without privacy:manage, also an empty-looking change", async () => {
    expect((await call(trainer, "/club-settings", { method: "PATCH", body: { consentAgeLimit: 14 } })).status).toBe(403);
    expect((await call(plain, "/club-settings", { method: "PATCH", body: { privacyContact: "x" } })).status).toBe(403);
  });

  it("rejects an age limit outside 10-18", async () => {
    expect((await call(board, "/club-settings", { method: "PATCH", body: { consentAgeLimit: 25 } })).status).toBe(422);
    expect((await call(board, "/club-settings", { method: "PATCH", body: { consentAgeLimit: 3 } })).status).toBe(422);
  });
});
