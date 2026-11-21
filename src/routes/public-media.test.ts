import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { sponsors } from "../db/schema/sponsors.js";
import { makePng } from "../lib/media-fixtures.js";
import { publicMediaUrls, syncPublicOptIn } from "../lib/media.js";
import { syncAllPublicMedia } from "../lib/public-profile.js";
import { adminClubRoutes } from "./admin-clubs.js";
import { clubPublicProfileRoutes } from "./club-public-profile.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { mediaRoutes } from "./media.js";
import { publicClubRoutes } from "./public-clubs.js";
import { sponsorRoutes } from "./sponsors.js";

/**
 * Media of the public club page (Wave 15 BM): sponsor logos are released exactly while the sponsor is active, `oeffentlich` and
 * shown on a live page; every change revokes at once (visibility, end date, deletion, page switch, suspension, daily job). The
 * public layer never returns `private`/`club` files and only images of the right club.
 */

const app = new Hono();
app.route("/public", publicClubRoutes);
app.route("/club-public-profile", clubPublicProfileRoutes);
app.route("/sponsors", sponsorRoutes);
app.route("/admin", adminClubRoutes);
app.route("/media", mediaRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const json = async (res: Response) => (await res.json()) as any;
const form = () => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(makePng())], "logo.png", { type: "image/png" }));
  return fd;
};
const unsigned = (key: string) => app.request(`/media/${key}`, { headers: { "x-forwarded-for": randomUUID() } });
const isoOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("public media opt-in (Wave 15 BM)", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let admin: Account;
  let sponsorId: string;
  const logoKey = async () => (await db.select().from(sponsors).where(eq(sponsors.id, sponsorId)))[0]!.logoKey!;
  const visibility = async (key: string) => (await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, key)))[0]!.visibility;

  beforeAll(async () => {
    club = await createClub("pubmedia", suffix);
    other = await createClub("pubmedia-other", suffix);
    admin = await signUpAndVerify(`pubmedia-admin-${suffix}@example.com`, "Admin");
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    const created = await json(await call(club.founder, "/sponsors", { method: "POST", clubId: club.clubId, body: { name: "Logo GmbH", visibility: "intern" } }));
    sponsorId = created.data.id;
    await call(club.founder, `/sponsors/${sponsorId}/logo`, { method: "PUT", clubId: club.clubId, form: form() });
    await call(club.founder, "/club-public-profile", { method: "PUT", clubId: club.clubId, body: { tagline: "Hallo", showSponsors: true } });
    await call(club.founder, "/club-public-profile/publish", { method: "POST", clubId: club.clubId, body: { enable: true } });
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds, admin.userId]);
    await closeDatabase();
  });

  it("releases a sponsor logo only while it is public, active and shown, and revokes it at once", async () => {
    const key = await logoKey();
    expect(await visibility(key)).toBe("private");
    expect((await unsigned(key)).status).toBe(403);

    await call(club.founder, `/sponsors/${sponsorId}`, { method: "PATCH", clubId: club.clubId, body: { visibility: "oeffentlich" } });
    expect(await visibility(key)).toBe("public_opt_in");
    const res = await unsigned(key);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, no-cache");
    // Revalidation: unchanged file -> 304 (cheap), revoked file -> 403 (see below), so a cache never serves a revoked logo.
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await app.request(`/media/${key}`, { headers: { "x-forwarded-for": randomUUID(), "if-none-match": etag } })).status).toBe(304);

    // Page no longer shows sponsors -> revoked.
    await call(club.founder, "/club-public-profile", { method: "PUT", clubId: club.clubId, body: { showSponsors: false } });
    await call(club.founder, "/club-public-profile/publish", { method: "POST", clubId: club.clubId, body: {} });
    expect((await unsigned(key)).status).toBe(403);
    await call(club.founder, "/club-public-profile", { method: "PUT", clubId: club.clubId, body: { showSponsors: true } });
    await call(club.founder, "/club-public-profile/publish", { method: "POST", clubId: club.clubId, body: {} });
    expect((await unsigned(key)).status).toBe(200);

    // Back to internal -> revoked.
    await call(club.founder, `/sponsors/${sponsorId}`, { method: "PATCH", clubId: club.clubId, body: { visibility: "intern" } });
    expect((await unsigned(key)).status).toBe(403);
    await call(club.founder, `/sponsors/${sponsorId}`, { method: "PATCH", clubId: club.clubId, body: { visibility: "oeffentlich" } });
    expect((await unsigned(key)).status).toBe(200);
  });

  it("takes the opt-in back when the contract ended (daily job) and on suspension", async () => {
    const key = await logoKey();
    // The end date passes without any request: the job catches it.
    await db.update(sponsors).set({ startsOn: isoOffset(-30), endsOn: isoOffset(-1) }).where(eq(sponsors.id, sponsorId));
    expect((await unsigned(key)).status).toBe(200);
    await syncAllPublicMedia();
    expect((await unsigned(key)).status).toBe(403);
    await call(club.founder, `/sponsors/${sponsorId}`, { method: "PATCH", clubId: club.clubId, body: { endsOn: null } });
    expect((await unsigned(key)).status).toBe(200);

    expect((await call(admin, `/admin/clubs/${club.clubId}/suspend`, { method: "POST", body: { reason: "Prüfung der Plattform" } })).status).toBe(200);
    expect((await unsigned(key)).status).toBe(403);
    expect((await call(admin, `/admin/clubs/${club.clubId}/unsuspend`, { method: "POST", body: { reason: "Prüfung beendet" } })).status).toBe(200);
    expect((await unsigned(key)).status).toBe(200);
  });

  it("revokes a replaced or deleted logo (the old key is gone, the new one follows the rules)", async () => {
    const oldKey = await logoKey();
    await call(club.founder, `/sponsors/${sponsorId}/logo`, { method: "PUT", clubId: club.clubId, form: form() });
    const newKey = await logoKey();
    expect((await unsigned(oldKey)).status).toBe(403);
    expect((await unsigned(newKey)).status).toBe(200);
    await call(club.founder, `/sponsors/${sponsorId}`, { method: "DELETE", clubId: club.clubId });
    expect((await unsigned(newKey)).status).toBe(403);
  });

  it("never returns private/club files or files of another club through the public layer", async () => {
    const [anyPrivate] = await db.select().from(mediaFiles).where(eq(mediaFiles.clubId, club.clubId));
    const up = await call(club.founder, "/club-public-profile/images", { method: "POST", clubId: club.clubId, form: form() });
    const draftKey: string = (await json(up)).data.key;
    expect(await visibility(draftKey)).toBe("private");
    const urls = await publicMediaUrls(club.clubId, [draftKey, anyPrivate!.storageKey, `${club.clubId}/${randomUUID()}.png`]);
    expect(urls.size).toBe(0);
    // A key of this club is never released for another club, even if asked to.
    await syncPublicOptIn(other.clubId, ["public_profile"], new Set([draftKey]));
    expect(await visibility(draftKey)).toBe("private");
    expect((await publicMediaUrls(other.clubId, [draftKey])).size).toBe(0);
    // The page response contains only unsigned links of released files.
    const page = await (await app.request(`/public/clubs/${club.slug}`, { headers: { "x-forwarded-for": randomUUID() } })).text();
    expect(page).not.toContain("sig=");
    expect(page).not.toContain(draftKey);
  });
});
