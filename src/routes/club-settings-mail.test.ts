import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { toAppError } from "../lib/errors.js";
import { clubSettingsRoutes } from "./club-settings.js";

/** Wave 9 B15: club mail template (sender name, signature, reply-to, text blocks) and the preview. */

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
  const email = `b15-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `B15 ${label}` } });
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
  club = (await auth.api.createOrganization({ body: { name: `TV Beispiel ${suffix}`, slug: `b15-${suffix}`, userId: board.userId } }))!.id;
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

const BLOCKS = [{ key: "absage", title: "Absage", text: "Das Training fällt heute leider aus.\nBitte beachtet die Hinweise." }];

describe("club mail template (B15)", () => {
  it("lets the board save sender name, signature, reply-to and text blocks (normalized, audited)", async () => {
    const res = await call(board, "/club-settings", { method: "PATCH", body: { senderName: "  Vorstand TV Beispiel ", signature: "Viele Grüße\nDer Vorstand", replyTo: "Vorstand@Example.ORG", textBlocks: BLOCKS } });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ senderName: "Vorstand TV Beispiel", signature: "Viele Grüße\nDer Vorstand", replyTo: "vorstand@example.org", textBlocks: BLOCKS });
    const [row] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, club));
    expect(row).toMatchObject({ senderName: "Vorstand TV Beispiel", replyTo: "vorstand@example.org" });
    const get = await json(await call(board, "/club-settings"));
    expect(get.data.textBlocks).toEqual(BLOCKS);
  });

  it("keeps other settings untouched and clears values with null / empty string", async () => {
    const res = await call(board, "/club-settings", { method: "PATCH", body: { signature: "", replyTo: null } });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ signature: null, replyTo: null, senderName: "Vorstand TV Beispiel", timezone: "Europe/Berlin" });
  });

  it("validates the fields (422)", async () => {
    const bad: object[] = [
      { replyTo: "not-an-address" },
      { replyTo: "a@b.de\r\nBcc: x@y.de" },
      { senderName: "Zeile1\nZeile2" },
      { senderName: "x".repeat(81) },
      { signature: "x".repeat(1001) },
      { signature: "bidi ‮ text" },
      { textBlocks: [{ key: "Bad Key", title: "T", text: "x" }] },
      { textBlocks: [{ key: "a", title: "T", text: "x" }, { key: "a", title: "U", text: "y" }] },
      { textBlocks: Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, title: "T", text: "x" })) },
      { textBlocks: [{ key: "a", title: "T", text: "x".repeat(2001) }] },
    ];
    for (const body of bad) expect((await call(board, "/club-settings", { method: "PATCH", body })).status, JSON.stringify(body).slice(0, 60)).toBe(422);
  });

  it("denies the mail template to members without announcements:write and hides it on GET", async () => {
    for (const who of [trainer, plain]) {
      for (const field of [{ senderName: "Fake" }, { signature: "x" }, { replyTo: "evil@example.org" }, { textBlocks: BLOCKS }]) {
        expect((await call(who, "/club-settings", { method: "PATCH", body: field })).status).toBe(403);
      }
      const get = await json(await call(who, "/club-settings"));
      expect(get.data).toMatchObject({ senderName: null, signature: null, replyTo: null, textBlocks: [] });
      expect(get.data.timezone).toBe("Europe/Berlin");
      expect((await call(who, "/club-settings/mail-preview", { method: "POST", body: {} })).status).toBe(403);
    }
    const [row] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, club));
    expect(row!.senderName).toBe("Vorstand TV Beispiel");
  });

  it("previews the mail with sample data and the fixed sender address", async () => {
    process.env.EMAIL_FROM = "MyVerein <noreply@myverein.example>";
    await call(board, "/club-settings", { method: "PATCH", body: { signature: "Viele Grüße\nDer <b>Vorstand</b>", replyTo: "vorstand@example.org" } });
    const res = await call(board, "/club-settings/mail-preview", { method: "POST", body: { template: "urgent" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const { data } = await json(res);
    expect(data).toMatchObject({ sample: true, subject: "[Dringend] Beispiel: Training fällt aus", from: '"Vorstand TV Beispiel" <noreply@myverein.example>', replyTo: "vorstand@example.org" });
    expect(data.html).toContain("Hallo Max,");
    expect(data.html).toContain("Viele Grüße");
    expect(data.html).toContain("&lt;b&gt;Vorstand&lt;/b&gt;"); // signature is escaped plain text
    expect(data.html).not.toContain("cid:");
  });

  it("previews unsaved edits and a stored text block, refuses unknown blocks and never accepts a free sender address", async () => {
    const res = await call(board, "/club-settings/mail-preview", { method: "POST", body: { senderName: "Jugendleitung", signature: "Tschüss", textBlockKey: "absage", template: "announcement" } });
    const { data } = await json(res);
    expect(data.from).toBe('"Jugendleitung" <noreply@myverein.example>');
    expect(data.html).toContain("Das Training fällt heute leider aus.");
    expect(data.html).toContain("Tschüss");
    expect((await call(board, "/club-settings/mail-preview", { method: "POST", body: { textBlockKey: "gibts-nicht" } })).status).toBe(422);
    // sender names cannot smuggle a different address into the From header
    const spoof = await json(await call(board, "/club-settings/mail-preview", { method: "POST", body: { senderName: 'Chef" <evil@example.org>' } }));
    expect(spoof.data.from).toContain("<noreply@myverein.example>");
    expect(spoof.data.from).not.toContain("<evil@example.org>");
    const stored = await db.select().from(clubSettings).where(and(eq(clubSettings.clubId, club), eq(clubSettings.senderName, "Jugendleitung")));
    expect(stored).toHaveLength(0); // preview never stores
  });
});
