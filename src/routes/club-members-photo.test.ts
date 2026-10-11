import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
import { mediaFiles } from "../db/schema/media-files.js";
import { toAppError } from "../lib/errors.js";
import { GPS_MARKER, makeJpeg, makePng, makeWebp, PDF_BYTES } from "../lib/media-fixtures.js";
import { UPLOADS_DIR } from "../lib/storage.js";
import { clubInfoRoutes } from "./club-info.js";
import { clubMemberRoutes } from "./club-members.js";
import { mediaRoutes } from "./media.js";

/**
 * Wave 7 B13: member profile photos on the central media layer -- own and board-managed upload/replace/delete, signed URL
 * only after the permission check, minors, guardians, club scoping, club-info board list.
 */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-info", clubInfoRoutes);
app.route("/media", mediaRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; memberId: string; clubMemberId: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `photo-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Photo ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

const json = async (res: Response) => (await res.json()) as Json;
const localUrl = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

describe("member profile photos (B13)", () => {
  let clubId: string;
  let otherClubId: string;
  let board: Actor;
  let plain: Actor;
  let plain2: Actor;
  let guardian: Actor; // external guest guardian, linked to the ward
  let parent: Actor; // plain member, linked to the ward
  let stranger: Actor; // guest + erziehungsberechtigt without a link
  let outsider: Actor; // founder of the other club
  let wardId: string; // account-less child (club_members.id)
  let adultNoAccountId: string;
  const userIds: string[] = [];

  const call = (who: Actor, url: string, init: { method?: string; body?: BodyInit; json?: object; club?: string } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${init.club ?? clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), ...(init.json ? { "content-type": "application/json" } : {}) },
      body: init.json ? JSON.stringify(init.json) : init.body,
    });
  const photoForm = (bytes: Buffer, type = "image/png", name = "me.png") => {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], name, { type }));
    return form;
  };
  const putPhoto = (who: Actor, url: string, bytes = makePng(true), type = "image/png", club?: string) => call(who, url, { method: "PUT", body: photoForm(bytes, type), club });

  async function resolve(s: { userId: string; cookie: string }, club: string): Promise<Actor> {
    const m = await db.query.member.findFirst({ where: (t, { and: a, eq: e }) => a(e(t.organizationId, club), e(t.userId, s.userId)) });
    const cm = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) });
    return { ...s, memberId: m!.id, clubMemberId: cm!.id };
  }
  async function join(label: string, club: string, role: "member" | "guest" = "member"): Promise<Actor> {
    const s = await signUp(label);
    userIds.push(s.userId);
    await auth.api.addMember({ body: { userId: s.userId, organizationId: club, role } });
    return resolve(s, club);
  }

  beforeAll(async () => {
    const founder = await signUp("board");
    userIds.push(founder.userId);
    const clubA = await auth.api.createOrganization({ body: { name: `Photo Club ${suffix}`, slug: `photo-club-${suffix}`, userId: founder.userId } });
    clubId = clubA!.id;
    const out = await signUp("outsider");
    userIds.push(out.userId);
    const clubB = await auth.api.createOrganization({ body: { name: `Photo Other ${suffix}`, slug: `photo-other-${suffix}`, userId: out.userId } });
    otherClubId = clubB!.id;

    board = await resolve(founder, clubId);
    await db.insert(clubRoles).values({ memberId: board.memberId, roleType: "vorsitz" });
    outsider = await resolve(out, otherClubId);
    await db.insert(clubRoles).values({ memberId: outsider.memberId, roleType: "vorsitz" });
    plain = await join("plain", clubId);
    plain2 = await join("plain2", clubId);
    guardian = await join("guardian", clubId, "guest");
    stranger = await join("stranger", clubId, "guest");
    parent = await join("parent", clubId);
    await db.insert(clubRoles).values([
      { memberId: guardian.memberId, roleType: "erziehungsberechtigt" },
      { memberId: stranger.memberId, roleType: "erziehungsberechtigt" },
    ]);

    const child = await json(await call(board, "/club-members", { method: "POST", json: { displayName: "Kind Ohne Konto", categoryKey: "jugend", birthDate: "2016-05-05" } }));
    wardId = child.data.id;
    const adult = await json(await call(board, "/club-members", { method: "POST", json: { displayName: "Erwachsen Ohne Konto", categoryKey: "aktiv", birthDate: "1985-05-05" } }));
    adultNoAccountId = adult.data.id;
    expect((await call(board, `/club-members/${wardId}/guardians`, { method: "POST", json: { guardianMemberId: guardian.clubMemberId } })).status).toBe(201);
    expect((await call(board, `/club-members/${wardId}/guardians`, { method: "POST", json: { guardianMemberId: parent.clubMemberId } })).status).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    await db.delete(organization).where(eq(organization.id, otherClubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("own photo", () => {
    it("uploads, strips EXIF/GPS, returns a signed URL that loads without a cookie and streams authenticated", async () => {
      const res = await putPhoto(plain, "/club-members/me/photo", makePng(true));
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.data.photoUrl).toMatch(/\/media\/.+\.png\?exp=\d+&sig=[0-9a-f]{64}$/);
      expect(body.data.photoKey).toBeUndefined();

      const row = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, plain.clubMemberId) });
      expect(row?.photoKey).toMatch(new RegExp(`^${clubId}/[0-9a-f-]{36}\\.png$`));
      const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, row!.photoKey!));
      expect(media).toMatchObject({ clubId, kind: "image", sensitive: false, visibility: "private", ownerType: "club_member", ownerId: plain.clubMemberId, uploadedBy: plain.userId });
      expect((await readFile(path.join(UPLOADS_DIR, media.storageKey))).includes(GPS_MARKER)).toBe(false);

      const viaUrl = await app.request(localUrl(body.data.photoUrl));
      expect(viaUrl.status).toBe(200);
      expect(viaUrl.headers.get("cache-control")).toMatch(/^private/);

      const streamed = await call(plain, "/club-members/me/photo");
      expect(streamed.status).toBe(200);
      expect(streamed.headers.get("content-type")).toBe("image/png");
      expect(streamed.headers.get("cache-control")).toBe("private, no-store");
      expect(streamed.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await call({ ...plain, cookie: "" }, "/club-members/me/photo")).status).toBe(401);

      const me = await json(await call(plain, "/club-members/me"));
      expect(me.data.photoUrl).toContain("/media/");
    });

    it("accepts JPEG and WebP, rejects other types, corrupt and oversized files (422)", async () => {
      expect((await putPhoto(plain, "/club-members/me/photo", makeJpeg(true), "image/jpeg", undefined)).status).toBe(200);
      expect((await putPhoto(plain, "/club-members/me/photo", makeWebp(true), "image/webp")).status).toBe(200);
      expect((await putPhoto(plain, "/club-members/me/photo", PDF_BYTES, "application/pdf")).status).toBe(422);
      expect((await putPhoto(plain, "/club-members/me/photo", Buffer.from("<svg/>"), "image/svg+xml")).status).toBe(422);
      expect((await putPhoto(plain, "/club-members/me/photo", Buffer.alloc(4096, 7), "image/png")).status).toBe(422); // magic bytes
      expect((await putPhoto(plain, "/club-members/me/photo", makeJpeg().subarray(0, 25), "image/jpeg")).status).toBe(422); // corrupt
      expect((await putPhoto(plain, "/club-members/me/photo", Buffer.concat([makePng(false), Buffer.alloc(5 * 1024 * 1024 + 1024, 1)]))).status).toBe(422); // > 5 MB
      expect((await call(plain, "/club-members/me/photo", { method: "PUT", body: new FormData() })).status).toBe(422);
      // None of the failed uploads left a file or a row behind: the member still has the WebP.
      const row = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, plain.clubMemberId) });
      expect(row?.photoKey?.endsWith(".webp")).toBe(true);
    }, 30_000);

    it("replaces the photo: the old registry row is a tombstone, its file and URL are gone", async () => {
      const before = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, plain.clubMemberId) });
      const oldUrl = (await json(await call(plain, "/club-members/me"))).data.photoUrl as string;
      expect((await app.request(localUrl(oldUrl))).status).toBe(200);

      const res = await putPhoto(plain, "/club-members/me/photo", makePng(true));
      expect(res.status).toBe(200);
      const after = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, plain.clubMemberId) });
      expect(after?.photoKey).not.toBe(before?.photoKey);

      const [oldMedia] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, before!.photoKey!));
      expect(oldMedia.deletedAt).not.toBeNull();
      await expect(stat(path.join(UPLOADS_DIR, before!.photoKey!))).rejects.toThrow();
      expect((await app.request(localUrl(oldUrl))).status).toBe(404);
      const live = await db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerType, "club_member"), eq(mediaFiles.ownerId, plain.clubMemberId)));
      expect(live.filter((m) => !m.deletedAt)).toHaveLength(1);
    });

    it("deletes the photo (204, idempotent), clears photoUrl and the file; writes audit entries without personal data", async () => {
      const key = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, plain.clubMemberId) }))!.photoKey!;
      expect((await call(plain, "/club-members/me/photo", { method: "DELETE" })).status).toBe(204);
      expect((await call(plain, "/club-members/me/photo", { method: "DELETE" })).status).toBe(204);
      expect((await json(await call(plain, "/club-members/me"))).data.photoUrl).toBeNull();
      expect((await call(plain, "/club-members/me/photo")).status).toBe(404);
      await expect(stat(path.join(UPLOADS_DIR, key))).rejects.toThrow();
      const audits = await db.select().from(auditLog).where(eq(auditLog.subjectId, plain.clubMemberId));
      const types = audits.map((a) => a.eventType);
      expect(types).toContain("club_member.photo_set");
      expect(types).toContain("club_member.photo_remove");
      expect(JSON.stringify(audits.map((a) => a.payload))).not.toMatch(/\.png|\.webp|photo-plain/);
    });

    it("lets a concurrent pair of replacements finish with exactly one live photo", async () => {
      const [a, b] = await Promise.all([putPhoto(plain2, "/club-members/me/photo"), putPhoto(plain2, "/club-members/me/photo")]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const rows = await db.select().from(mediaFiles).where(and(eq(mediaFiles.ownerType, "club_member"), eq(mediaFiles.ownerId, plain2.clubMemberId)));
      expect(rows.filter((r) => !r.deletedAt)).toHaveLength(1);
      const member = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, plain2.clubMemberId) });
      expect(rows.find((r) => !r.deletedAt)?.storageKey).toBe(member?.photoKey);
    });
  });

  describe("visibility (photo URL only after the permission check)", () => {
    it("shows a photo to the person, to members:write and to a linked guardian -- not to other plain members or an unlinked guardian", async () => {
      expect((await putPhoto(board, `/club-members/${wardId}/photo`)).status).toBe(200);
      expect((await putPhoto(board, `/club-members/${adultNoAccountId}/photo`)).status).toBe(200);
      expect((await putPhoto(plain2, "/club-members/me/photo")).status).toBe(200);

      const urlOf = async (viewer: Actor, id: string) => (await json(await call(viewer, `/club-members/${id}`))).data.photoUrl as string | null | undefined;

      // own
      expect(await urlOf(plain2, plain2.clubMemberId)).toContain("/media/");
      // board sees everyone's, including the child's
      expect(await urlOf(board, wardId)).toContain("/media/");
      expect(await urlOf(board, plain2.clubMemberId)).toContain("/media/");
      // a plain member sees no photo of others (E6: default only board / the person itself)
      expect(await urlOf(plain, plain2.clubMemberId)).toBeNull();
      expect(await urlOf(plain, adultNoAccountId)).toBeNull();
      // a linked guardian who is a normal member sees the ward's photo ...
      expect(await urlOf(parent, wardId)).toContain("/media/");
      // ... a plain member without a link does not, and external guests cannot read other members' rows at all
      expect(await urlOf(plain, wardId)).toBeNull();
      expect((await call(guardian, `/club-members/${wardId}`)).status).toBe(404);
      expect((await call(stranger, `/club-members/${wardId}`)).status).toBe(404);

      // list: same rules per row
      const list = await json(await call(plain, "/club-members?pageSize=100"));
      expect((list.data as Json[]).filter((m) => m.photoUrl !== null).map((m) => m.id)).toEqual([]);
      const boardList = await json(await call(board, "/club-members?pageSize=100"));
      expect((boardList.data as Json[]).filter((m) => m.photoUrl !== null).map((m) => m.id).sort()).toEqual([wardId, adultNoAccountId, plain2.clubMemberId].sort());
    });

    it("applies the same rules to the authenticated stream GET /club-members/:id/photo (404 where hidden)", async () => {
      expect((await call(board, `/club-members/${wardId}/photo`)).status).toBe(200);
      expect((await call(parent, `/club-members/${wardId}/photo`)).status).toBe(200);
      expect((await call(plain, `/club-members/${wardId}/photo`)).status).toBe(404);
      expect((await call(guardian, `/club-members/${wardId}/photo`)).status).toBe(404); // guests reach no other member's row (Wave 10: guardian routes)
      expect((await call(plain2, `/club-members/${plain2.clubMemberId}/photo`)).status).toBe(200);
      expect((await call(plain, `/club-members/${plain2.clubMemberId}/photo`)).status).toBe(404);
      expect((await call(stranger, `/club-members/${wardId}/photo`)).status).toBe(404);
      expect((await call(plain, `/club-members/${randomUUID()}/photo`)).status).toBe(404);
      expect((await call(board, `/club-members/${plain.clubMemberId}/photo`)).status).toBe(404); // member without photo
    });

    it("does not reach into another club: ids of club A are 404 for the other club's board, nothing leaks", async () => {
      expect((await call(outsider, `/club-members/${wardId}/photo`, { club: otherClubId })).status).toBe(404);
      expect((await putPhoto(outsider, `/club-members/${wardId}/photo`, makePng(), "image/png", otherClubId)).status).toBe(404);
      expect((await call(outsider, `/club-members/${wardId}/photo`, { method: "DELETE", club: otherClubId })).status).toBe(404);
      // ... and the outsider is no member of club A at all.
      expect((await call(outsider, `/club-members/${wardId}/photo`, { club: clubId })).status).toBe(404);
    });
  });

  describe("board-managed photos and minors", () => {
    it("lets members:write set, replace and delete photos of others, also account-less members; plain members get 403", async () => {
      expect((await putPhoto(plain, `/club-members/${adultNoAccountId}/photo`)).status).toBe(403);
      expect((await call(plain, `/club-members/${adultNoAccountId}/photo`, { method: "DELETE" })).status).toBe(403);
      expect((await putPhoto(guardian, `/club-members/${wardId}/photo`)).status).toBe(403);

      const replaced = await putPhoto(board, `/club-members/${adultNoAccountId}/photo`, makeJpeg(true), "image/jpeg");
      expect(replaced.status).toBe(200);
      expect((await json(replaced)).data.photoUrl).toContain(".jpg");
      expect((await call(board, `/club-members/${adultNoAccountId}/photo`, { method: "DELETE" })).status).toBe(204);
      expect((await json(await call(board, `/club-members/${adultNoAccountId}`))).data.photoUrl).toBeNull();
    });

    it("refuses a minor to set the own photo (403) while the board may, and keeps minors out of the club-info board list", async () => {
      await db.update(clubMembers).set({ birthDate: `${new Date().getFullYear() - 15}-01-01` }).where(eq(clubMembers.id, plain.clubMemberId));
      const denied = await putPhoto(plain, "/club-members/me/photo");
      expect(denied.status).toBe(403);
      // deleting the own photo stays possible
      expect((await call(plain, "/club-members/me/photo", { method: "DELETE" })).status).toBe(204);
      expect((await putPhoto(board, `/club-members/${plain.clubMemberId}/photo`)).status).toBe(200);
      await db.update(clubMembers).set({ birthDate: null }).where(eq(clubMembers.id, plain.clubMemberId));
      expect((await call(board, `/club-members/${plain.clubMemberId}/photo`, { method: "DELETE" })).status).toBe(204);
    });
  });

  describe("club-info board list", () => {
    it("shows adult board members' photos to every club member, never a minor's, and nothing for members without a photo", async () => {
      expect((await putPhoto(board, "/club-members/me/photo")).status).toBe(200);
      await db.insert(clubRoles).values({ memberId: plain2.memberId, roleType: "beisitzer" });
      await db.insert(clubRoles).values({ memberId: plain.memberId, roleType: "schriftfuehrer" });

      const info = async (viewer: Actor) => ((await json(await call(viewer, "/club-info"))).data.board as Json[]);
      for (const viewer of [plain, guardian]) {
        const rows = await info(viewer);
        const byMember = new Map(rows.map((r) => [r.memberId, r]));
        expect(byMember.get(board.memberId)?.photoUrl).toContain("/media/");
        expect(byMember.get(plain2.memberId)?.photoUrl).toContain("/media/"); // adult with photo
        expect(byMember.get(plain.memberId)?.photoUrl).toBeNull(); // no photo
      }
      // Minor on the board list: no photo for anybody.
      await db.update(clubMembers).set({ birthDate: `${new Date().getFullYear() - 16}-06-06` }).where(eq(clubMembers.id, plain2.clubMemberId));
      const rows = await info(plain);
      expect(rows.find((r) => r.memberId === plain2.memberId)?.photoUrl).toBeNull();
      expect(rows.find((r) => r.memberId === board.memberId)?.photoUrl).toContain("/media/");
      // The signed URL of the board photo loads without a cookie.
      const url = rows.find((r) => r.memberId === board.memberId)!.photoUrl as string;
      expect((await app.request(localUrl(url))).status).toBe(200);
    });
  });
});
