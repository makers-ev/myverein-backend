import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { toAppError } from "../lib/errors.js";
import { GPS_MARKER, makeJpeg, makePng, makeWebp, PDF_BYTES } from "../lib/media-fixtures.js";
import { deleteMedia, normalizeContentType, setMediaVisibility, signedMediaUrls, sniffMimeType, storeUpload, streamSensitiveMedia, sweepUnattachedUploads } from "../lib/media.js";
import { signMediaKey } from "../lib/media-url.js";
import { putObject, UPLOADS_DIR } from "../lib/storage.js";
import { mediaRoutes } from "./media.js";

/**
 * Integration test of the central media security layer (Wave 7 B18) against a real Postgres: upload hardening
 * (magic bytes, declared type, size, EXIF/GPS strip, quota), signed URLs (valid / missing / wrong / expired / foreign
 * key), registry as source of truth (deleted / unknown / sensitive), public_opt_in, legacy files, authenticated
 * streaming of sensitive documents with audit.
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

const file = (bytes: Buffer, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });

/** Path + query of an absolute signed URL, so it can be requested from the in-process app. */
const localUrl = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

describe("media routes and security layer", () => {
  let clubAId: string;
  let clubBId: string;
  let userIds: string[] = [];
  let cookieA: string;
  let cookieB: string;
  let founderAId: string;

  const upload = (clubId: string, cookie: string, form: FormData) =>
    app.request(`/media?clubId=${clubId}`, { method: "POST", headers: { cookie, "x-forwarded-for": `up-${Math.random()}` }, body: form });
  const uploadFile = (clubId: string, cookie: string, f: File) => {
    const form = new FormData();
    form.set("file", f);
    return upload(clubId, cookie, form);
  };
  type Uploaded = { data: { key: string; url: string; mimeType: string; sizeBytes: number } };
  const uploadOk = async (clubId: string, cookie: string, f: File) => {
    const res = await uploadFile(clubId, cookie, f);
    expect(res.status).toBe(201);
    return ((await res.json()) as Uploaded).data;
  };
  const get = (pathAndQuery: string) => app.request(pathAndQuery, { headers: { "x-forwarded-for": `get-${Math.random()}` } });

  beforeAll(async () => {
    const founderA = await signUpAndVerify(`media-a-${suffix}@example.com`, "Club A Founder");
    const founderB = await signUpAndVerify(`media-b-${suffix}@example.com`, "Club B Founder");
    userIds = [founderA.userId, founderB.userId];
    founderAId = founderA.userId;
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

  afterEach(() => {
    delete process.env.MEDIA_QUOTA_BYTES_PER_CLUB;
    delete process.env.MEDIA_UNATTACHED_MAX_FILES_PER_USER;
    delete process.env.MEDIA_UNATTACHED_MAX_BYTES_PER_USER;
  });

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

  describe("sniffing", () => {
    it("recognises the allowed formats by their magic bytes only", () => {
      expect(sniffMimeType(makeJpeg())).toBe("image/jpeg");
      expect(sniffMimeType(makePng())).toBe("image/png");
      expect(sniffMimeType(makeWebp())).toBe("image/webp");
      expect(sniffMimeType(PDF_BYTES)).toBe("application/pdf");
      expect(sniffMimeType(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
      expect(sniffMimeType(Buffer.from("MZ\x90\0"))).toBeNull();
      expect(sniffMimeType(Buffer.alloc(0))).toBeNull();
    });
  });

  describe("upload", () => {
    it("rejects an unauthenticated upload with 401", async () => {
      const form = new FormData();
      form.set("file", file(makePng(), "photo.png", "image/png"));
      const res = await app.request(`/media?clubId=${clubAId}`, { method: "POST", body: form });
      expect(res.status).toBe(401);
    });

    it("stores a valid image, registers it and strips metadata from the stored bytes", async () => {
      const png = makePng(true);
      const data = await uploadOk(clubAId, cookieA, file(png, "Urlaub Foto ü.png", "image/png"));
      expect(data.key).toMatch(new RegExp(`^${clubAId}/[0-9a-f-]{36}\\.png$`)); // no client filename in the key
      expect(data.mimeType).toBe("image/png");
      expect(data.url).toContain(`/media/${clubAId}/`);
      expect(data.url).toContain("sig=");

      const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, data.key));
      expect(row).toMatchObject({ clubId: clubAId, kind: "image", mimeType: "image/png", visibility: "club", sensitive: false, ownerType: "unattached", uploadedBy: founderAId, deletedAt: null });
      expect(row.sizeBytes).toBe(data.sizeBytes);
      expect(row.sizeBytes).toBeLessThan(png.length);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(row.originalFilename).toBe("Urlaub Foto ü.png");

      const onDisk = await readFile(path.join(UPLOADS_DIR, data.key));
      expect(onDisk.length).toBe(row.sizeBytes);
      expect(onDisk.includes(GPS_MARKER)).toBe(false);
    });

    it.each([
      ["JPEG", makeJpeg(true), "image/jpeg"],
      ["WebP", makeWebp(true), "image/webp"],
    ])("strips EXIF/GPS from a %s", async (_label, bytes, type) => {
      const data = await uploadOk(clubAId, cookieA, file(bytes, "x", type));
      const onDisk = await readFile(path.join(UPLOADS_DIR, data.key));
      expect(onDisk.includes(GPS_MARKER)).toBe(false);
      expect(sniffMimeType(onDisk)).toBe(type);
    });

    it("rejects content that is not an allowed image although the declared type says so (magic bytes)", async () => {
      const res = await uploadFile(clubAId, cookieA, file(Buffer.alloc(2048, 1), "photo.png", "image/png"));
      expect(res.status).toBe(422);
    });

    it("rejects a declared type that disagrees with the content, an SVG and a PDF on the image endpoint", async () => {
      expect((await uploadFile(clubAId, cookieA, file(makePng(), "a.jpg", "image/jpeg"))).status).toBe(422);
      expect((await uploadFile(clubAId, cookieA, file(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "a.svg", "image/svg+xml"))).status).toBe(422);
      expect((await uploadFile(clubAId, cookieA, file(PDF_BYTES, "a.pdf", "application/pdf"))).status).toBe(422);
      expect((await uploadFile(clubAId, cookieA, file(Buffer.from("hello"), "notes.txt", "text/plain"))).status).toBe(422);
    });

    it("rejects an empty, a corrupt (truncated) and an oversized file", async () => {
      expect((await uploadFile(clubAId, cookieA, file(Buffer.alloc(0), "e.png", "image/png"))).status).toBe(422);
      expect((await uploadFile(clubAId, cookieA, file(makeJpeg().subarray(0, 30), "t.jpg", "image/jpeg"))).status).toBe(422);
      const huge = Buffer.concat([makePng(false), Buffer.alloc(10 * 1024 * 1024 + 4096, 1)]);
      expect((await uploadFile(clubAId, cookieA, file(huge, "huge.png", "image/png"))).status).toBe(422);
    }, 20_000);

    it("rejects a request without the file field with 422", async () => {
      const form = new FormData();
      form.set("file", "not-a-file");
      expect((await upload(clubAId, cookieA, form)).status).toBe(422);
    });

    it("enforces the per-club quota (422 QUOTA_EXCEEDED), also for parallel uploads, and frees it on delete", async () => {
      const probe = await uploadOk(clubBId, cookieB, file(makePng(false), "p.png", "image/png"));
      const size = probe.sizeBytes;
      await deleteMedia(probe.key);

      process.env.MEDIA_QUOTA_BYTES_PER_CLUB = String(size * 2 + 1);
      const results = await Promise.all(Array.from({ length: 5 }, () => uploadFile(clubBId, cookieB, file(makePng(false), "q.png", "image/png"))));
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 201, 422, 422, 422]);
      const rejected = results.find((r) => r.status === 422)!;
      const rejectedBody = (await rejected.json()) as { error: { code: string; details?: unknown } };
      expect(rejectedBody.error.code).toBe("QUOTA_EXCEEDED");
      expect(rejectedBody.error.details).toMatchObject({ code: "club_quota" });

      // Deleting a file gives the space back.
      const live = await db.select().from(mediaFiles).where(eq(mediaFiles.clubId, clubBId));
      const first = live.find((r) => !r.deletedAt)!;
      await deleteMedia(first.storageKey);
      expect((await uploadFile(clubBId, cookieB, file(makePng(false), "again.png", "image/png"))).status).toBe(201);
      // Usage is counted per club: club A holds more than the tiny quota already, club B's usage is what counted above.
      expect((await uploadFile(clubAId, cookieA, file(makePng(false), "a.png", "image/png"))).status).toBe(422);
    });
  });

  describe("GET /media/* (signature + registry, no cookie)", () => {
    it("serves a validly signed URL without any cookie, with private cache headers and the registry content type", async () => {
      const png = makePng(true);
      const data = await uploadOk(clubAId, cookieA, file(png, "readback.png", "image/png"));
      const res = await get(localUrl(data.url));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
      expect(res.headers.get("content-disposition")).toContain("inline");
      const bytes = Buffer.from(await res.arrayBuffer());
      expect(bytes.length).toBe(data.sizeBytes);
      expect(bytes.includes(GPS_MARKER)).toBe(false);
    });

    it("takes the content type from the registry, not from the key's extension", async () => {
      const data = await uploadOk(clubAId, cookieA, file(makeJpeg(false), "x.jpg", "image/jpeg"));
      const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, data.key));
      expect(row.mimeType).toBe("image/jpeg");
      await db.update(mediaFiles).set({ mimeType: "image/webp" }).where(eq(mediaFiles.id, row.id));
      const res = await get(localUrl(data.url));
      expect(res.headers.get("content-type")).toBe("image/webp");
    });

    it("answers 403 without a signature, with a wrong, a tampered, an expired or another file's signature", async () => {
      const data = await uploadOk(clubAId, cookieA, file(makePng(false), "s.png", "image/png"));
      const other = await uploadOk(clubAId, cookieA, file(makePng(false), "o.png", "image/png"));
      const url = new URL(data.url);
      const exp = url.searchParams.get("exp")!;
      const sig = url.searchParams.get("sig")!;
      const base = url.pathname;

      expect((await get(base)).status).toBe(403);
      expect((await get(`${base}?exp=${exp}`)).status).toBe(403);
      expect((await get(`${base}?sig=${sig}`)).status).toBe(403);
      expect((await get(`${base}?exp=${exp}&sig=${"0".repeat(64)}`)).status).toBe(403);
      expect((await get(`${base}?exp=${exp}&sig=${sig.slice(0, 20)}`)).status).toBe(403);
      expect((await get(`${base}?exp=${Number(exp) + 60_000}&sig=${sig}`)).status).toBe(403); // extended expiry
      const past = Date.now() - 1000;
      expect((await get(`${base}?exp=${past}&sig=${signMediaKey(data.key, past)}`)).status).toBe(403); // genuinely expired
      const otherSig = new URL(other.url).searchParams.get("sig")!;
      expect((await get(`${base}?exp=${new URL(other.url).searchParams.get("exp")}&sig=${otherSig}`)).status).toBe(403); // signature of another key
      expect((await get(localUrl(data.url))).status).toBe(200); // the original still works
    });

    it("cannot be used to probe keys: unsigned requests get 403 whether the key exists or not", async () => {
      const unknown = await get(`/media/${clubAId}/does-not-exist.png`);
      expect(unknown.status).toBe(403);
    });

    it("answers 404 for a validly signed but unknown key, and for path traversal", async () => {
      const exp = Date.now() + 60_000;
      const key = `${clubAId}/does-not-exist.png`;
      expect((await get(`/media/${key}?exp=${exp}&sig=${signMediaKey(key, exp)}`)).status).toBe(404);
      const traversal = `${clubAId}/../../../etc/passwd`;
      expect((await get(`/media/${clubAId}%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd?exp=${exp}&sig=${signMediaKey(traversal, exp)}`)).status).toBe(404);
    });

    it("answers 404 after the file was deleted (registry tombstone + file removed)", async () => {
      const data = await uploadOk(clubAId, cookieA, file(makePng(false), "gone.png", "image/png"));
      expect((await get(localUrl(data.url))).status).toBe(200);
      await deleteMedia(data.key);
      expect((await get(localUrl(data.url))).status).toBe(404);
      await expect(stat(path.join(UPLOADS_DIR, data.key))).rejects.toThrow();
      const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, data.key));
      expect(row.deletedAt).not.toBeNull();
      expect((await signedMediaUrls(clubAId, [data.key])).size).toBe(0);
    });

    it("answers 404 when the registry row exists but the file is gone from disk", async () => {
      const data = await uploadOk(clubAId, cookieA, file(makePng(false), "lost.png", "image/png"));
      await rm(path.join(UPLOADS_DIR, data.key));
      expect((await get(localUrl(data.url))).status).toBe(404);
    });
  });

  describe("signing", () => {
    it("only mints URLs for live, non-sensitive files of the asked club", async () => {
      const a = await uploadOk(clubAId, cookieA, file(makePng(false), "a.png", "image/png"));
      expect((await signedMediaUrls(clubAId, [a.key, null, undefined, "", "nope"])).size).toBe(1);
      // The same key asked for by another club never resolves (IDOR between clubs).
      expect((await signedMediaUrls(clubBId, [a.key])).size).toBe(0);

      const sensitive = await storeUpload({ file: file(PDF_BYTES, "proof.pdf", "application/pdf"), clubId: clubAId, kind: "document", allowedTypes: ["application/pdf"], maxBytes: 1024 * 1024, sensitive: true, uploadedBy: founderAId });
      expect((await signedMediaUrls(clubAId, [sensitive.storageKey])).size).toBe(0);
    });

    it("never serves a sensitive file through GET /media/*, even with a correct signature", async () => {
      const sensitive = await storeUpload({ file: file(PDF_BYTES, "proof.pdf", "application/pdf"), clubId: clubAId, kind: "document", allowedTypes: ["application/pdf"], maxBytes: 1024 * 1024, sensitive: true, uploadedBy: founderAId });
      const exp = Date.now() + 60_000;
      expect((await get(`/media/${sensitive.storageKey}?exp=${exp}&sig=${signMediaKey(sensitive.storageKey, exp)}`)).status).toBe(404);
    });
  });

  describe("public_opt_in", () => {
    it("serves an explicitly opted-in image without a signature; sensitive files and documents can never opt in", async () => {
      const data = await uploadOk(clubAId, cookieA, file(makePng(false), "logo.png", "image/png"));
      expect((await get(`/media/${data.key}`)).status).toBe(403);
      await setMediaVisibility(data.key, "public_opt_in");
      const res = await get(`/media/${data.key}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toMatch(/^public/);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      await setMediaVisibility(data.key, "private");
      expect((await get(`/media/${data.key}`)).status).toBe(403);

      const doc = await storeUpload({ file: file(PDF_BYTES, "d.pdf", "application/pdf"), clubId: clubAId, kind: "document", allowedTypes: ["application/pdf"], maxBytes: 1024 * 1024, sensitive: true, uploadedBy: founderAId });
      await expect(setMediaVisibility(doc.storageKey, "public_opt_in")).rejects.toThrow();
    });
  });

  describe("content type normalisation", () => {
    it("accepts the usual spellings of the declared type (image/JPG, parameters, case) as long as the content agrees", async () => {
      expect(normalizeContentType("IMAGE/JPG")).toBe("image/jpeg");
      expect(normalizeContentType("image/pjpeg")).toBe("image/jpeg");
      expect(normalizeContentType("Image/PNG; charset=binary")).toBe("image/png");
      expect(normalizeContentType("image/x-png")).toBe("image/png");
      expect((await uploadFile(clubAId, cookieA, file(makeJpeg(false), "a.jpg", "image/jpg"))).status).toBe(201);
      expect((await uploadFile(clubAId, cookieA, file(makePng(false), "a.png", "Image/PNG"))).status).toBe(201);
      expect((await uploadFile(clubAId, cookieA, file(makePng(false), "a.png", "image/jpg"))).status).toBe(422); // still must agree
    });
  });

  describe("unclaimed uploads", () => {
    it("caps unattached files and bytes per user (QUOTA_EXCEEDED) and frees the slot when the file is deleted", async () => {
      const who = await signUpAndVerify(`media-cap-${suffix}@example.com`, "Cap User");
      userIds.push(who.userId);
      await auth.api.addMember({ body: { userId: who.userId, organizationId: clubAId, role: "member" } });
      process.env.MEDIA_UNATTACHED_MAX_FILES_PER_USER = "2";
      const first = await uploadOk(clubAId, who.cookie, file(makePng(false), "1.png", "image/png"));
      await uploadOk(clubAId, who.cookie, file(makePng(false), "2.png", "image/png"));
      const third = await uploadFile(clubAId, who.cookie, file(makePng(false), "3.png", "image/png"));
      expect(third.status).toBe(422);
      const thirdBody = (await third.json()) as { error: { code: string; details?: unknown } };
      expect(thirdBody.error.code).toBe("QUOTA_EXCEEDED");
      expect(thirdBody.error.details).toEqual({ code: "unattached_cap" });
      // another (fresh) user is unaffected
      const other = await signUpAndVerify(`media-cap2-${suffix}@example.com`, "Cap User 2");
      userIds.push(other.userId);
      await auth.api.addMember({ body: { userId: other.userId, organizationId: clubAId, role: "member" } });
      expect((await uploadFile(clubAId, other.cookie, file(makePng(false), "x.png", "image/png"))).status).toBe(201);
      await deleteMedia(first.key);
      expect((await uploadFile(clubAId, who.cookie, file(makePng(false), "4.png", "image/png"))).status).toBe(201);

      process.env.MEDIA_UNATTACHED_MAX_FILES_PER_USER = "100";
      process.env.MEDIA_UNATTACHED_MAX_BYTES_PER_USER = "10";
      expect((await uploadFile(clubAId, who.cookie, file(makePng(false), "5.png", "image/png"))).status).toBe(422);
    });

    it("sweeps unclaimed uploads after the TTL (file + registry row) and keeps fresh and claimed ones", async () => {
      const old = await uploadOk(clubAId, cookieA, file(makePng(false), "old.png", "image/png"));
      const fresh = await uploadOk(clubAId, cookieA, file(makePng(false), "fresh.png", "image/png"));
      const claimed = await uploadOk(clubAId, cookieA, file(makePng(false), "claimed.png", "image/png"));
      const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await db.update(mediaFiles).set({ createdAt: longAgo }).where(eq(mediaFiles.storageKey, old.key));
      await db.update(mediaFiles).set({ createdAt: longAgo, ownerType: "location", ownerId: "x" }).where(eq(mediaFiles.storageKey, claimed.key));

      expect(await sweepUnattachedUploads()).toBeGreaterThanOrEqual(1);
      const [oldRow] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, old.key));
      expect(oldRow.deletedAt).not.toBeNull();
      await expect(stat(path.join(UPLOADS_DIR, old.key))).rejects.toThrow();
      expect((await get(localUrl(old.url))).status).toBe(404);
      expect((await get(localUrl(fresh.url))).status).toBe(200);
      expect((await get(localUrl(claimed.url))).status).toBe(200);
      expect(await sweepUnattachedUploads()).toBe(0); // idempotent
      const [stillThere] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.storageKey, claimed.key)));
      expect(stillThere.deletedAt).toBeNull();
    });
  });

  describe("legacy files (written before the registry existed)", () => {
    it("registers a pre-registry image of the own club on first signing, from its magic bytes", async () => {
      const { key } = await putObject({ prefix: clubAId, extension: "jpg", buffer: makeJpeg(false) });
      expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, key))).length).toBe(0);
      const urls = await signedMediaUrls(clubAId, [key], "damage_report");
      expect(urls.size).toBe(1);
      const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, key));
      expect(row).toMatchObject({ clubId: clubAId, mimeType: "image/jpeg", ownerType: "damage_report", kind: "image" });
      expect((await get(localUrl(urls.get(key)!))).status).toBe(200);
    });

    it("strips metadata from a pre-registry image when registering it (the file is rewritten) and ignores oversized files", async () => {
      const { key } = await putObject({ prefix: clubAId, extension: "jpg", buffer: makeJpeg(true) });
      expect((await readFile(path.join(UPLOADS_DIR, key))).includes(GPS_MARKER)).toBe(true);
      const urls = await signedMediaUrls(clubAId, [key]);
      expect(urls.size).toBe(1);
      const onDisk = await readFile(path.join(UPLOADS_DIR, key));
      expect(onDisk.includes(GPS_MARKER)).toBe(false);
      const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, key));
      expect(row.sizeBytes).toBe(onDisk.length);

      const big = await putObject({ prefix: clubAId, extension: "jpg", buffer: Buffer.concat([makeJpeg(false), Buffer.alloc(11 * 1024 * 1024)]) });
      expect((await signedMediaUrls(clubAId, [big.key])).size).toBe(0);
      const corrupt = await putObject({ prefix: clubAId, extension: "jpg", buffer: makeJpeg(true).subarray(0, 40) });
      expect((await signedMediaUrls(clubAId, [corrupt.key])).size).toBe(0);
    });

    it("does not register garbage, a foreign club's key, or a file that is not an image", async () => {
      const foreign = await putObject({ prefix: clubBId, extension: "png", buffer: makePng(false) });
      expect((await signedMediaUrls(clubAId, [foreign.key])).size).toBe(0);
      expect((await signedMediaUrls(clubBId, [`${clubBId}/../${clubAId}/x.png`])).size).toBe(0);
      const text = await putObject({ prefix: clubAId, extension: "png", buffer: Buffer.from("this is not an image") });
      expect((await signedMediaUrls(clubAId, [text.key])).size).toBe(0);
      expect((await signedMediaUrls(clubAId, [`${clubAId}/missing.png`, "http://evil.example/x.png"])).size).toBe(0);
    });
  });

  describe("sensitive documents", () => {
    it("streams authenticated with attachment + private no-store and writes one audit entry per retrieval", async () => {
      const doc = await storeUpload({ file: file(PDF_BYTES, "Satzung.pdf", "application/pdf"), clubId: null, storagePrefix: `registrations/${suffix}`, kind: "document", allowedTypes: ["application/pdf"], maxBytes: 1024 * 1024, sensitive: true, owner: { type: "club_registration", id: String(suffix) }, uploadedBy: founderAId });
      expect(doc).toMatchObject({ sensitive: true, clubId: null, kind: "document", mimeType: "application/pdf" });

      const ctx = new Hono();
      ctx.get("/d", (c) => streamSensitiveMedia(c, doc, { accessedBy: founderAId, subjectId: "reg-1" }));
      const before = (await db.select().from(auditLog).where(eq(auditLog.eventType, "media.sensitive_access"))).length;
      const res = await ctx.request("/d");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await res.arrayBuffer()).equals(PDF_BYTES)).toBe(true);
      await ctx.request("/d");
      const entries = await db.select().from(auditLog).where(eq(auditLog.eventType, "media.sensitive_access"));
      expect(entries.length - before).toBe(2);
      expect(entries.find((e) => (e.payload as { mediaId?: string }).mediaId === doc.id)?.payload).toMatchObject({ mediaId: doc.id, ownerType: "club_registration", accessedBy: founderAId });
      await deleteMedia(doc.storageKey);
    });

    it("refuses to stream a non-sensitive file through the sensitive path", async () => {
      const data = await uploadOk(clubAId, cookieA, file(makePng(false), "n.png", "image/png"));
      const [row] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, data.key));
      const ctx = new Hono();
      ctx.onError((err, c) => c.json(toAppError(err).toJSON(), toAppError(err).status as 409));
      ctx.get("/d", (c) => streamSensitiveMedia(c, row, { accessedBy: founderAId }));
      expect((await ctx.request("/d")).status).toBe(409);
    });
  });
});
