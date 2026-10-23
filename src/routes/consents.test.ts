import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { consentRecords } from "../db/schema/privacy.js";
import { toAppError } from "../lib/errors.js";
import { makePng } from "../lib/media-fixtures.js";
import { UPLOADS_DIR } from "../lib/storage.js";
import { clubMemberRoutes } from "./club-members.js";
import { consentOverviewRoutes, consentPurposeRoutes } from "./consent-purposes.js";
import { mediaRoutes } from "./media.js";

/**
 * Wave 10 B3 + BM: consent purposes and texts, consent events (append-only, latest wins), the age rule, guardians, the
 * board's paper proof, club scoping, voluntariness (no consent blocks anything) and the photo revocation through the media layer.
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/consent-purposes", consentPurposeRoutes);
app.route("/consents", consentOverviewRoutes);
app.route("/media", mediaRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; memberId: string; clubMemberId: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `consent-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Consent ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}
const json = async (res: Response) => (await res.json()) as Json;
const localUrl = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

describe("consents (B3)", () => {
  let clubId: string;
  let otherClubId: string;
  let board: Actor;
  let adult: Actor;
  let teen: Actor; // minor WITH an account
  let guardian: Actor; // can_consent
  let guardianNoConsent: Actor; // link without can_consent
  let stranger: Actor; // plain member
  let outsider: Actor; // board of the other club
  let childId: string; // account-less minor
  let purposeFoto: string;
  let purposePhoto: string;
  let textFoto: string;
  let textPhoto: string;
  let otherPurpose: string;
  const userIds: string[] = [];

  const call = (who: Actor, url: string, init: { method?: string; json?: object; club?: string } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${init.club ?? clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), ...(init.json ? { "content-type": "application/json" } : {}) },
      body: init.json ? JSON.stringify(init.json) : undefined,
    });
  const grant = (who: Actor, memberId: string, purposeId: string, textVersionId: string, extra: object = {}) =>
    call(who, `/club-members/${memberId}/consents/${purposeId}`, { method: "POST", json: { textVersionId, ...extra } });
  const revoke = (who: Actor, memberId: string, purposeId: string, extra?: object) =>
    call(who, `/club-members/${memberId}/consents/${purposeId}`, { method: "DELETE", ...(extra ? { json: extra } : {}) });
  const records = (memberId: string, purposeId: string) => db.select().from(consentRecords).where(and(eq(consentRecords.clubMemberId, memberId), eq(consentRecords.purposeId, purposeId)));

  async function resolve(s: { userId: string; cookie: string }, club: string): Promise<Actor> {
    const m = await db.query.member.findFirst({ where: (t, { and: a, eq: e }) => a(e(t.organizationId, club), e(t.userId, s.userId)) });
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) });
    return { ...s, memberId: m!.id, clubMemberId: cm!.id };
  }
  async function join(label: string, club: string, role: "member" | "guest" = "member", birthDate?: string): Promise<Actor> {
    const s = await signUp(label);
    userIds.push(s.userId);
    await auth.api.addMember({ body: { userId: s.userId, organizationId: club, role } });
    const actor = await resolve(s, club);
    if (birthDate) await db.update(clubMembers).set({ birthDate }).where(eq(clubMembers.id, actor.clubMemberId));
    return actor;
  }
  const publish = async (purposeId: string, body: string) => json(await call(board, `/consent-purposes/${purposeId}/texts`, { method: "POST", json: { body } }));

  beforeAll(async () => {
    const founder = await signUp("board");
    userIds.push(founder.userId);
    clubId = (await auth.api.createOrganization({ body: { name: `Consent Club ${suffix}`, slug: `consent-club-${suffix}`, userId: founder.userId } }))!.id;
    const out = await signUp("outsider");
    userIds.push(out.userId);
    otherClubId = (await auth.api.createOrganization({ body: { name: `Consent Other ${suffix}`, slug: `consent-other-${suffix}`, userId: out.userId } }))!.id;

    board = await resolve(founder, clubId);
    await db.insert(clubRoles).values({ memberId: board.memberId, roleType: "vorsitz" });
    outsider = await resolve(out, otherClubId);
    await db.insert(clubRoles).values({ memberId: outsider.memberId, roleType: "vorsitz" });
    adult = await join("adult", clubId, "member", "1990-01-01");
    teen = await join("teen", clubId, "member", "2012-03-03");
    stranger = await join("stranger", clubId, "member", "1985-05-05");
    guardian = await join("guardian", clubId, "guest");
    guardianNoConsent = await join("guardian-nc", clubId, "guest");
    await db.insert(clubRoles).values([
      { memberId: guardian.memberId, roleType: "erziehungsberechtigt" },
      { memberId: guardianNoConsent.memberId, roleType: "erziehungsberechtigt" },
    ]);
    const child = await json(await call(board, "/club-members", { method: "POST", json: { displayName: "Kind Ohne Konto", categoryKey: "jugend", birthDate: "2016-05-05" } }));
    childId = child.data.id;
    expect((await call(board, `/club-members/${childId}/guardians`, { method: "POST", json: { guardianMemberId: guardian.clubMemberId } })).status).toBe(201);
    expect((await call(board, `/club-members/${childId}/guardians`, { method: "POST", json: { guardianMemberId: guardianNoConsent.clubMemberId } })).status).toBe(201);
    await db.update(guardianLinks).set({ canConsent: false }).where(eq(guardianLinks.guardianMemberId, guardianNoConsent.memberId));

    const list = await json(await call(board, "/consent-purposes"));
    purposeFoto = list.data.find((p: Json) => p.key === "foto_video").id;
    purposePhoto = list.data.find((p: Json) => p.key === "profilfoto_ausweis").id;
    const otherList = await json(await call(outsider, "/consent-purposes", { club: otherClubId }));
    otherPurpose = otherList.data[0].id;
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    await db.delete(organization).where(eq(organization.id, otherClubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("purposes and texts", () => {
    it("seeds the five system purposes inactive; members see none until a text is published", async () => {
      const all = await json(await call(board, "/consent-purposes"));
      expect(all.data.map((p: Json) => p.key).sort()).toEqual(["foto_video", "messenger_verteiler", "profilfoto_ausweis", "verbandsweitergabe", "veroeffentlichung"]);
      expect(all.data.every((p: Json) => p.active === false && p.currentText === null && p.requested === false)).toBe(true);
      expect((await json(await call(adult, "/consent-purposes"))).data).toEqual([]);
    });

    it("publishes immutable versions: first activates, the same text is a no-op, a change is version + 1", async () => {
      const first = await call(board, `/consent-purposes/${purposeFoto}/texts`, { method: "POST", json: { body: "Fotos beim Training dürfen verwendet werden." } });
      expect(first.status).toBe(201);
      const v1 = (await json(first)).data;
      expect(v1.version).toBe(1);
      expect(v1.sha256).toMatch(/^[0-9a-f]{64}$/);
      textFoto = v1.id;
      const again = await call(board, `/consent-purposes/${purposeFoto}/texts`, { method: "POST", json: { body: "Fotos beim Training dürfen verwendet werden." } });
      expect(again.status).toBe(200);
      expect((await json(again)).data.id).toBe(v1.id);

      const members = await json(await call(adult, "/consent-purposes"));
      expect(members.data.map((p: Json) => p.key)).toEqual(["foto_video"]);
      expect(members.data[0].currentText.body).toContain("Fotos");

      const second = (await publish(purposeFoto, "Fotos und Videos beim Training und bei Wettkämpfen.")).data;
      expect(second.version).toBe(2);
      const history = await json(await call(board, `/consent-purposes/${purposeFoto}/texts`));
      expect(history.data.map((t: Json) => t.version)).toEqual([2, 1]);
      textFoto = second.id;

      const photoText = (await publish(purposePhoto, "Mein Profilfoto darf im Verein angezeigt werden.")).data;
      textPhoto = photoText.id;
    });

    it("manages purposes: create custom, edit, requested flag, no archive of system purposes, rights", async () => {
      expect((await call(adult, "/consent-purposes", { method: "POST", json: { name: "Nope" } })).status).toBe(403);
      const created = await call(board, "/consent-purposes", { method: "POST", json: { name: "Vereinsfahrt Fotos", requested: true } });
      expect(created.status).toBe(201);
      const custom = (await json(created)).data;
      expect(custom).toMatchObject({ key: "vereinsfahrt_fotos", system: false, active: false, requested: true });
      expect((await call(board, "/consent-purposes", { method: "POST", json: { name: "Vereinsfahrt Fotos" } })).status).toBe(409);
      expect((await call(board, `/consent-purposes/${custom.id}`, { method: "PATCH", json: { active: true } })).status).toBe(409); // no text
      const patched = await json(await call(board, `/consent-purposes/${custom.id}`, { method: "PATCH", json: { description: "Für die Fahrt", requested: false } }));
      expect(patched.data).toMatchObject({ description: "Für die Fahrt", requested: false });
      expect((await call(board, `/consent-purposes/${purposeFoto}`, { method: "PATCH", json: { archived: true } })).status).toBe(409);
      expect((await call(board, `/consent-purposes/${custom.id}`, { method: "PATCH", json: { archived: true } })).status).toBe(200);
      expect((await call(adult, `/consent-purposes/${custom.id}`, { method: "PATCH", json: { name: "x" } })).status).toBe(403);
      expect((await call(adult, `/consent-purposes/${purposeFoto}/texts`)).status).toBe(403);
    });

    it("scopes purposes to the club (IDOR): a foreign purpose id is 404 everywhere", async () => {
      expect((await call(board, `/consent-purposes/${otherPurpose}`, { method: "PATCH", json: { name: "Hijack" } })).status).toBe(404);
      expect((await call(board, `/consent-purposes/${otherPurpose}/texts`, { method: "POST", json: { body: "Ein langer Text für fremden Zweck." } })).status).toBe(404);
      expect((await call(board, `/consent-purposes/${otherPurpose}/texts`)).status).toBe(404);
      expect((await call(adult, `/club-members/${adult.clubMemberId}/consents/${otherPurpose}`, { method: "POST", json: { textVersionId: textFoto } })).status).toBe(404);
      // And the other club's board cannot reach this club's members or purposes.
      expect((await call(outsider, `/club-members/${adult.clubMemberId}/consents`, { club: otherClubId })).status).toBe(404);
      expect((await call(outsider, `/consent-purposes/${purposeFoto}`, { method: "PATCH", json: { name: "x" }, club: otherClubId })).status).toBe(404);
      expect((await call(outsider, "/consent-purposes", { club: clubId })).status).toBe(404); // not a member of this club
    });
  });

  describe("consent events", () => {
    it("an adult consents, repeats idempotently, revokes and consents again; the history is append-only", async () => {
      const ok = await grant(adult, adult.clubMemberId, purposeFoto, textFoto);
      expect(ok.status).toBe(201);
      expect((await json(ok)).data).toMatchObject({ key: "foto_video", state: "granted", givenBy: "self", outdated: false });
      expect((await grant(adult, adult.clubMemberId, purposeFoto, textFoto)).status).toBe(200); // idempotent
      expect(await records(adult.clubMemberId, purposeFoto)).toHaveLength(1);

      expect((await revoke(adult, adult.clubMemberId, purposeFoto)).status).toBe(200);
      expect((await revoke(adult, adult.clubMemberId, purposeFoto)).status).toBe(200); // idempotent
      expect(await records(adult.clubMemberId, purposeFoto)).toHaveLength(2);
      expect((await grant(adult, adult.clubMemberId, purposeFoto, textFoto)).status).toBe(201);

      const view = await json(await call(adult, `/club-members/${adult.clubMemberId}/consents`));
      expect(view.data.consents.find((c: Json) => c.key === "foto_video").state).toBe("granted");
      expect(view.data.history.map((h: Json) => h.action)).toEqual(["granted", "revoked", "granted"]);
      // The three events carry text version 2, actor kind and no proof.
      expect(view.data.history.every((h: Json) => h.version === 2 && h.givenBy === "self" && h.proofDate === null)).toBe(true);
    });

    it("keeps the revocation possible after the purpose was archived (Art. 7(3)); granting stays blocked", async () => {
      const created = (await json(await call(board, "/consent-purposes", { method: "POST", json: { name: "Archivtest" } }))).data;
      const text = (await publish(created.id, "Archivtest Einwilligungstext")).data;
      expect((await grant(adult, adult.clubMemberId, created.id, text.id)).status).toBe(201);
      expect((await call(board, `/consent-purposes/${created.id}`, { method: "PATCH", json: { archived: true } })).status).toBe(200);

      const listed = (await json(await call(adult, `/club-members/${adult.clubMemberId}/consents`))).data.consents.find((c: Json) => c.key === created.key);
      expect(listed).toMatchObject({ state: "granted", retired: true, open: false });
      expect((await grant(adult, adult.clubMemberId, created.id, text.id)).status).toBe(404);
      expect((await revoke(adult, adult.clubMemberId, created.id)).status).toBe(200);
      expect(await records(adult.clubMemberId, created.id)).toHaveLength(2);
      const after = (await json(await call(adult, `/club-members/${adult.clubMemberId}/consents`))).data.consents;
      expect(after.find((c: Json) => c.key === created.key)).toBeUndefined();
    });

    it("shows a guardian only their own link, the board all of them (M6)", async () => {
      // A guardian who is a club member (a guest guardian cannot read member rows at all).
      expect((await call(board, `/club-members/${childId}/guardians`, { method: "POST", json: { guardianMemberId: stranger.clubMemberId } })).status).toBe(201);
      const own = (await json(await call(stranger, `/club-members/${childId}/guardians`))).data as Json[];
      expect(own.map((l) => l.guardianMemberId)).toEqual([stranger.memberId]);
      const all = (await json(await call(board, `/club-members/${childId}/guardians`))).data as Json[];
      expect(all).toHaveLength(3);
      await db.delete(guardianLinks).where(eq(guardianLinks.guardianMemberId, stranger.memberId));
    });

    it("only against the currently published text version: an old or foreign version is 409", async () => {
      const old = (await json(await call(board, `/consent-purposes/${purposeFoto}/texts`))).data.find((t: Json) => t.version === 1).id;
      const res = await grant(stranger, stranger.clubMemberId, purposeFoto, old);
      expect(res.status).toBe(409);
      expect((await json(res)).error.details.code).toBe("consent_text_outdated");
      expect((await grant(stranger, stranger.clubMemberId, purposeFoto, randomUUID())).status).toBe(409);
      expect((await grant(stranger, stranger.clubMemberId, purposeFoto, "not-a-uuid")).status).toBe(422);
      expect(await records(stranger.clubMemberId, purposeFoto)).toHaveLength(0);
    });

    it("a new text version marks the old decision as outdated without blocking anything", async () => {
      await grant(stranger, stranger.clubMemberId, purposeFoto, textFoto);
      const next = (await publish(purposeFoto, "Fotos und Videos beim Training, bei Wettkämpfen und Festen.")).data;
      const view = (await json(await call(stranger, `/club-members/${stranger.clubMemberId}/consents`))).data.consents.find((c: Json) => c.key === "foto_video");
      expect(view).toMatchObject({ state: "granted", outdated: true, recordedTextVersion: 2 });
      expect(view.text.version).toBe(3);
      textFoto = next.id;
      expect((await grant(stranger, stranger.clubMemberId, purposeFoto, textFoto)).status).toBe(201); // re-confirm
    });

    it("rejects a purpose without a published text", async () => {
      const messenger = (await json(await call(board, "/consent-purposes"))).data.find((p: Json) => p.key === "messenger_verteiler");
      const res = await grant(adult, adult.clubMemberId, messenger.id, textFoto);
      expect(res.status).toBe(409);
      expect((await json(res)).error.details.code).toBe("consent_not_available");
    });

    it("a minor with an account cannot grant alone but may revoke; a guardian with can_consent decides for the child", async () => {
      const denied = await grant(teen, teen.clubMemberId, purposeFoto, textFoto);
      expect(denied.status).toBe(403);
      expect((await json(denied)).error.details.code).toBe("consent_requires_guardian");
      expect((await revoke(teen, teen.clubMemberId, purposeFoto)).status).toBe(200); // explicit decline / withdrawal is always possible

      const byGuardian = await grant(guardian, childId, purposeFoto, textFoto);
      expect(byGuardian.status).toBe(201);
      expect((await json(byGuardian)).data).toMatchObject({ state: "granted", givenBy: "guardian" });
      const rec = (await records(childId, purposeFoto))[0];
      expect(rec).toMatchObject({ givenBy: "guardian", recordedByUserId: guardian.userId });

      expect((await revoke(guardian, childId, purposeFoto)).status).toBe(200);
      const view = await json(await call(guardian, `/club-members/${childId}/consents`));
      expect(view.data.consents.find((c: Json) => c.key === "foto_video").state).toBe("revoked");
    });

    it("denies guardians without can_consent, strangers and other members (403) and unknown members (404)", async () => {
      const noConsent = await grant(guardianNoConsent, childId, purposeFoto, textFoto);
      expect(noConsent.status).toBe(403);
      expect((await json(noConsent)).error.details.code).toBe("guardian_cannot_consent");
      expect((await grant(stranger, childId, purposeFoto, textFoto)).status).toBe(403);
      expect((await revoke(stranger, childId, purposeFoto)).status).toBe(403);
      expect((await grant(adult, stranger.clubMemberId, purposeFoto, textFoto)).status).toBe(403);
      // Reading: a forbidden existing member answers exactly like an unknown id (no existence oracle).
      const forbidden = await call(stranger, `/club-members/${childId}/consents`);
      const unknown = await call(stranger, `/club-members/${randomUUID()}/consents`);
      expect(forbidden.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await forbidden.json()).toEqual(await unknown.json());
      expect((await call(stranger, `/club-members/${adult.clubMemberId}/consents`)).status).toBe(404);
      expect((await grant(adult, randomUUID(), purposeFoto, textFoto)).status).toBe(404);
    });

    it("a guardian link that expired (valid_until) or is unconfirmed grants nothing, without any job running", async () => {
      await db.update(guardianLinks).set({ validUntil: "2020-01-01" }).where(eq(guardianLinks.guardianMemberId, guardian.memberId));
      expect((await grant(guardian, childId, purposeFoto, textFoto)).status).toBe(403);
      expect((await call(guardian, `/club-members/${childId}/consents`)).status).toBe(404);
      await db.update(guardianLinks).set({ validUntil: null, confirmedAt: null }).where(eq(guardianLinks.guardianMemberId, guardian.memberId));
      expect((await grant(guardian, childId, purposeFoto, textFoto)).status).toBe(403);
      await db.update(guardianLinks).set({ confirmedAt: new Date() }).where(eq(guardianLinks.guardianMemberId, guardian.memberId));
      expect((await grant(guardian, childId, purposeFoto, textFoto)).status).toBe(201);
    });

    it("the board needs a paper proof (date + source) for somebody else; the proof is visible to the board only", async () => {
      const without = await grant(board, childId, purposeFoto, textFoto);
      expect(without.status).toBe(422);
      expect((await json(without)).error.details.code).toBe("proof_required");
      expect((await grant(board, childId, purposeFoto, textFoto, { proofDate: "2026-09-01" })).status).toBe(422);
      expect((await revoke(board, childId, purposeFoto, { proofDate: "2026-09-02", proofSource: "" })).status).toBe(422);

      const paper = await grant(board, stranger.clubMemberId, purposeFoto, textFoto, { proofDate: "2026-09-01", proofSource: "Papierformular Sommerfest" });
      expect([200, 201]).toContain(paper.status);
      const revokedPaper = await revoke(board, childId, purposeFoto, { proofDate: "2026-09-03", proofSource: "Brief der Eltern" });
      expect(revokedPaper.status).toBe(200);
      const rec = (await records(childId, purposeFoto)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)!;
      expect(rec).toMatchObject({ action: "revoked", givenBy: "board_paper", proofDate: "2026-09-03", proofSource: "Brief der Eltern" });

      const asBoard = (await json(await call(board, `/club-members/${childId}/consents`))).data.history[0];
      expect(asBoard).toMatchObject({ givenBy: "board_paper", proofSource: "Brief der Eltern" });
      const asGuardian = (await json(await call(guardian, `/club-members/${childId}/consents`))).data.history[0];
      expect(asGuardian).toMatchObject({ givenBy: "board_paper", proofDate: null, proofSource: null });
    });

    it("writes audit entries with ids only (no free text)", async () => {
      const rows = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubId), eq(auditLog.subjectId, childId)));
      const types = rows.map((r) => r.eventType);
      expect(types).toContain("consent.grant");
      expect(types).toContain("consent.revoke");
      expect(JSON.stringify(rows.map((r) => r.payload))).not.toMatch(/Brief der Eltern|Papierformular/);
    });

    it("never blocks anything: open and declined consents do not limit what a member can do (Art. 7(4) GDPR)", async () => {
      const requested = await json(await call(board, "/consent-purposes", { method: "POST", json: { name: "Verteiler Info", requested: true } }));
      await publish(requested.data.id, "Meine Adresse darf im Info-Verteiler stehen.");
      // `stranger` never decided about the requested purpose, `adult` declines it explicitly.
      const open = (await json(await call(stranger, `/club-members/${stranger.clubMemberId}/consents`))).data;
      expect(open.consents.find((c: Json) => c.key === "verteiler_info")).toMatchObject({ requested: true, state: "none", open: true });
      expect(open.open).toBeGreaterThanOrEqual(1);
      const textId = (await json(await call(adult, "/consent-purposes"))).data.find((p: Json) => p.key === "verteiler_info").currentText.id;
      await grant(adult, adult.clubMemberId, requested.data.id, textId);
      expect((await revoke(adult, adult.clubMemberId, requested.data.id)).status).toBe(200);
      const declined = (await json(await call(adult, `/club-members/${adult.clubMemberId}/consents`))).data;
      expect(declined.consents.find((c: Json) => c.key === "verteiler_info")).toMatchObject({ state: "revoked", open: false });

      for (const who of [stranger, adult]) {
        for (const url of ["/club-members/me", "/club-members", "/consent-purposes"]) {
          expect((await call(who, url)).status, `${url} for a member with open/declined consents`).toBe(200);
        }
        expect((await call(who, `/club-members/${who.clubMemberId}/consents`)).status).toBe(200);
      }
    });
  });

  describe("overview", () => {
    it("shows the matrix with counters to privacy:read only, scoped to the club", async () => {
      expect((await call(adult, "/consents/overview")).status).toBe(403);
      expect((await call(guardian, "/consents/overview")).status).toBe(403);
      const res = await json(await call(board, "/consents/overview?pageSize=100"));
      const foto = res.data.purposes.find((p: Json) => p.key === "foto_video");
      expect(foto.counts.granted).toBeGreaterThanOrEqual(2);
      expect(res.data.members.some((m: Json) => m.clubMemberId === adult.clubMemberId)).toBe(true);
      const childRow = res.data.members.find((m: Json) => m.clubMemberId === childId);
      expect(childRow.states[purposeFoto]).toMatchObject({ state: "revoked", needsGuardian: true });
      expect(res.data.members.some((m: Json) => m.clubMemberId === (outsider.clubMemberId))).toBe(false);

      const filtered = await json(await call(board, `/consents/overview?purposeId=${purposeFoto}&state=granted&pageSize=100`));
      expect(filtered.data.members.length).toBeGreaterThanOrEqual(2);
      expect(filtered.data.members.every((m: Json) => m.states[purposeFoto].state === "granted")).toBe(true);
      expect((await call(board, `/consents/overview?state=granted`)).status).toBe(422);
      expect((await call(board, `/consents/overview?purposeId=${otherPurpose}`)).status).toBe(404);
      expect((await call(outsider, "/consents/overview", { club: clubId })).status).toBe(404);
    });
  });

  describe("profilfoto_ausweis revocation (BM)", () => {
    it("removes the photo file AND the media_files row; the old signed URL stops working; a repeat is harmless", async () => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(makePng(true))], "me.png", { type: "image/png" }));
      const put = await app.request(`/club-members/me/photo?clubId=${clubId}`, { method: "PUT", headers: { cookie: adult.cookie, "x-forwarded-for": randomUUID() }, body: form });
      expect(put.status).toBe(200);
      const photoUrl = (await json(put)).data.photoUrl as string;
      const key = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, adult.clubMemberId) }))!.photoKey!;
      expect((await app.request(localUrl(photoUrl))).status).toBe(200);

      // Setting the photo needed no consent (voluntary); the person grants for the ID card and later withdraws.
      expect((await grant(adult, adult.clubMemberId, purposePhoto, textPhoto)).status).toBe(201);
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, adult.clubMemberId) }))!.photoKey).toBe(key);

      expect((await revoke(adult, adult.clubMemberId, purposePhoto)).status).toBe(200);
      const after = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, adult.clubMemberId) });
      expect(after?.photoKey).toBeNull();
      const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, key));
      expect(media?.deletedAt).not.toBeNull();
      await expect(stat(path.join(UPLOADS_DIR, key))).rejects.toThrow();
      expect((await app.request(localUrl(photoUrl))).status).toBe(404);
      expect((await call(adult, "/club-members/me/photo")).status).toBe(404);

      expect((await revoke(adult, adult.clubMemberId, purposePhoto)).status).toBe(200);
      const audits = await db.select().from(auditLog).where(eq(auditLog.subjectId, adult.clubMemberId));
      expect(audits.map((a) => a.eventType)).toContain("club_member.photo_remove");
    });

    it("a revoked consent by the guardian removes the photo of the child as well", async () => {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(makePng(true))], "kid.png", { type: "image/png" }));
      expect((await app.request(`/club-members/${childId}/photo?clubId=${clubId}`, { method: "PUT", headers: { cookie: board.cookie, "x-forwarded-for": randomUUID() }, body: form })).status).toBe(200);
      expect((await grant(guardian, childId, purposePhoto, textPhoto)).status).toBe(201);
      expect((await revoke(guardian, childId, purposePhoto)).status).toBe(200);
      expect((await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, childId) }))!.photoKey).toBeNull();
    });
  });
});
