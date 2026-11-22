import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubPlatformStatus } from "../db/schema/club-platform.js";
import { departments } from "../db/schema/departments.js";
import { events } from "../db/schema/events.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { sponsors } from "../db/schema/sponsors.js";
import { makePng } from "../lib/media-fixtures.js";
import { PUBLIC_CLUB_KEYS, rateLimitPrefix, syncPublicMedia } from "../lib/public-profile.js";
import { publishNotice } from "../lib/privacy-notice.js";
import { clubPublicProfileRoutes } from "./club-public-profile.js";
import { createClub, dropClubs, installErrorHandler, requester, type Account } from "./forms-test-support.js";
import { mediaRoutes } from "./media.js";
import { publicClubRoutes } from "./public-clubs.js";
import { publicEventRoutes } from "./public-events.js";
import { sponsorRoutes } from "./sponsors.js";

/**
 * Public club page (Wave 15 B3) and its media (BM): opt-in (default off), editor rights, publish with contact confirmation,
 * strict field whitelist, no data of non-public clubs (same 404 for every case), released media only (unsigned, revocable),
 * cache headers, rate limits.
 */

const app = new Hono();
app.route("/public", publicEventRoutes);
app.route("/public", publicClubRoutes);
app.route("/club-public-profile", clubPublicProfileRoutes);
app.route("/sponsors", sponsorRoutes);
app.route("/media", mediaRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const json = async (res: Response) => (await res.json()) as any;
const form = (bytes: Buffer, name = "bild.png") => {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(bytes)], name, { type: "image/png" }));
  return fd;
};
const pub = (path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { "x-forwarded-for": randomUUID(), ...headers } });
const isoOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("rate limit subject (pure)", () => {
  it("counts IPv6 per /64 and keeps IPv4 as is", () => {
    expect(rateLimitPrefix("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitPrefix("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitPrefix("2001:0db8:0001:0002:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(rateLimitPrefix("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitPrefix("::ffff:198.51.100.4")).toBe("198.51.100.4");
  });
});

describe("public club page", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let board: Account;
  let deptId: string;
  let hiddenDeptId: string;
  let calendarId: string;
  let logoKey: string;
  const sponsorIds: Record<string, string> = {};

  beforeAll(async () => {
    club = await createClub("public", suffix, { schrift: "schriftfuehrer", kasse: "kassenwart", plain: null });
    other = await createClub("public-other", suffix);
    board = club.founder;
    const [d1] = await db.insert(departments).values({ clubId: club.clubId, name: "Fußball" }).returning();
    const [d2] = await db.insert(departments).values({ clubId: club.clubId, name: "Geheimrat" }).returning();
    deptId = d1!.id;
    hiddenDeptId = d2!.id;
    const [cal] = await db.insert(calendars).values({ clubId: club.clubId, name: "Öffentlich" }).returning();
    calendarId = cal!.id;
    await db.insert(events).values([
      { calendarId, title: "Tag der offenen Tür", startsAt: new Date(Date.now() + 5 * 86_400_000) },
      { calendarId, title: "Vergangen", startsAt: new Date(Date.now() - 5 * 86_400_000) },
    ]);
    const [internal] = await db.insert(calendars).values({ clubId: club.clubId, name: "Vorstand" }).returning();
    await db.insert(events).values({ calendarId: internal!.id, title: "Vorstandssitzung geheim", startsAt: new Date(Date.now() + 3 * 86_400_000) });
    // Sponsors: active public, internal, expired public -- each with a logo.
    for (const [key, body] of Object.entries({
      active: { name: "Aktiv GmbH", visibility: "oeffentlich", website: "https://aktiv.example", notes: "GEHEIME-NOTIZ" },
      internal: { name: "Intern AG", visibility: "intern" },
      expired: { name: "Vorbei KG", visibility: "oeffentlich", startsOn: isoOffset(-60), endsOn: isoOffset(-1) },
    })) {
      const created = await json(await call(club.members.kasse!, "/sponsors", { method: "POST", clubId: club.clubId, body }));
      sponsorIds[key] = created.data.id;
      await call(club.members.kasse!, `/sponsors/${created.data.id}/logo`, { method: "PUT", clubId: club.clubId, form: form(makePng()) });
    }
  }, 60_000);

  afterAll(async () => {
    delete process.env.PUBLIC_CLUB_INVALID_LIMIT_PER_HOUR;
    delete process.env.PUBLIC_CLUB_IP_LIMIT_PER_HOUR;
    delete process.env.PUBLIC_API_TRUSTED_TOKEN;
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("is off by default: the slug of an existing club answers exactly like an unknown slug", async () => {
    const a = await pub(`/public/clubs/${club.slug}`);
    const b = await pub(`/public/clubs/does-not-exist-${suffix}`);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
    expect(a.headers.get("cache-control")).toBe("no-store");
  });

  it("lets only public_profile:write edit the page", async () => {
    for (const who of [club.members.plain!, club.members.kasse!]) {
      expect((await call(who, "/club-public-profile", { clubId: club.clubId })).status).toBe(403);
      expect((await call(who, "/club-public-profile", { method: "PUT", clubId: club.clubId, body: { tagline: "x" } })).status).toBe(403);
    }
    const res = await call(club.members.schrift!, "/club-public-profile", { clubId: club.clubId });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ settings: { publicProfileEnabled: false, discoverable: false }, published: null, hasUnpublishedChanges: true, publicPath: `/v/${club.slug}` });
  });

  it("validates referenced images, departments and calendars", async () => {
    const upload = await call(board, "/club-public-profile/images", { method: "POST", clubId: club.clubId, form: form(makePng()) });
    expect(upload.status).toBe(201);
    const up = (await json(upload)).data;
    expect(up.previewUrl).toMatch(/sig=/);
    logoKey = up.key;
    const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, logoKey));
    expect(media).toMatchObject({ visibility: "private", ownerType: "public_profile" });

    const [foreignDept] = await db.insert(departments).values({ clubId: other.clubId, name: "Fremd" }).returning();
    const bad = async (body: unknown, code: string) => {
      const res = await call(board, "/club-public-profile", { method: "PUT", clubId: club.clubId, body });
      expect(res.status).toBe(422);
      expect((await json(res)).error.details.code).toBe(code);
    };
    await bad({ logoKey: `${club.clubId}/nope.png` }, "unknown_image");
    await bad({ departmentIds: [foreignDept!.id] }, "unknown_department");
    await bad({ eventCalendarIds: [randomUUID()] }, "unknown_calendar");
  });

  it("publishes only after the contact was confirmed, and stays hidden until the page is enabled", async () => {
    const put = await call(board, "/club-public-profile", {
      method: "PUT",
      clubId: club.clubId,
      body: { tagline: "Sport für alle", description: "Wir sind ein Verein.", city: "Wiesbach", contactEmail: "info@verein.example", website: "https://verein.example", logoKey, departmentIds: [deptId], eventCalendarIds: [calendarId], showSponsors: true, leadFormEnabled: true, trialTrainingEnabled: true },
    });
    expect(put.status).toBe(200);
    // The enquiry form needs the club's published privacy notice.
    const noNotice = await call(board, "/club-public-profile/publish", { method: "POST", clubId: club.clubId, body: { contactConsentConfirmed: true } });
    expect(noNotice.status).toBe(422);
    expect((await json(noNotice)).error.details.code).toBe("privacy_notice_required");
    await publishNotice(club.clubId, "Datenschutzhinweis des Vereins: Wir verarbeiten deine Anfrage nur, um dich zu kontaktieren. Verantwortlich ist der Vorstand.", club.founder.userId);
    const noConsent = await call(board, "/club-public-profile/publish", { method: "POST", clubId: club.clubId, body: {} });
    expect(noConsent.status).toBe(422);
    expect((await json(noConsent)).error.details.code).toBe("contact_consent_required");
    const published = await call(board, "/club-public-profile/publish", { method: "POST", clubId: club.clubId, body: { contactConsentConfirmed: true } });
    expect(published.status).toBe(200);
    expect((await json(published)).data).toMatchObject({ hasUnpublishedChanges: false, published: { tagline: "Sport für alle", publishedBy: { memberId: expect.any(String) } } });
    // Published but not enabled: still the generic 404, and nothing is released.
    expect((await pub(`/public/clubs/${club.slug}`)).status).toBe(404);
    const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, logoKey));
    expect(media!.visibility).toBe("private");
  });

  it("serves exactly the whitelisted fields once enabled, with released media only", async () => {
    expect((await call(board, "/club-public-profile/settings", { method: "PUT", clubId: club.clubId, body: { publicProfileEnabled: true } })).status).toBe(200);
    const res = await pub(`/public/clubs/${club.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, no-cache");
    const text = await res.clone().text();
    const data = (await json(res)).data;
    expect(Object.keys(data).sort()).toEqual([...PUBLIC_CLUB_KEYS].sort());
    expect(Object.keys(data.contact).sort()).toEqual(["email", "phone", "website"]);
    expect(data).toMatchObject({ slug: club.slug, indexable: true, tagline: "Sport für alle", city: "Wiesbach", contact: { email: "info@verein.example" } });
    expect(data.departments).toEqual([{ id: deptId, name: "Fußball" }]);
    expect(data.events.map((e: { title: string }) => e.title)).toEqual(["Tag der offenen Tür"]);
    expect(Object.keys(data.events[0]).sort()).toEqual(["allDay", "cancelled", "endsAt", "locationName", "startsAt", "title"]);
    expect(data.sponsors.map((s: { name: string }) => s.name)).toEqual(["Aktiv GmbH"]);
    expect(Object.keys(data.sponsors[0]).sort()).toEqual(["logoUrl", "name", "website"]);
    expect(data.leadForm).toMatchObject({ enabled: true, trialTraining: true, departments: [{ id: deptId, name: "Fußball" }], privacyNotice: { version: 1, body: expect.stringContaining("Datenschutzhinweis") } });
    // Nothing internal: no hidden department, no board calendar, no sponsor notes, no member names/addresses, no signatures.
    for (const forbidden of ["Geheimrat", "Vorstandssitzung", "GEHEIME-NOTIZ", "Intern AG", "Vorbei KG", "Founder public", "@example.com", "sig=", hiddenDeptId]) expect(text).not.toContain(forbidden);

    // Released media: unsigned URL works with a public cache header; the internal and expired sponsor logos stay private.
    expect(data.logoUrl).toMatch(/\/media\/.+\.png$/);
    const logo = await pub(new URL(data.logoUrl).pathname);
    expect(logo.status).toBe(200);
    expect(logo.headers.get("cache-control")).toMatch(/^public/);
    const sponsorLogo = await pub(new URL(data.sponsors[0].logoUrl).pathname);
    expect(sponsorLogo.status).toBe(200);
    for (const key of ["internal", "expired"]) {
      const [s] = await db.select().from(sponsors).where(eq(sponsors.id, sponsorIds[key]!));
      const [m] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, s!.logoKey!));
      expect(m!.visibility, key).toBe("private");
      expect((await pub(`/media/${s!.logoKey}`)).status, key).toBe(403);
    }
  });

  it("revokes at once: unpublish, disable and suspension all give the same 404 and make the files unreachable", async () => {
    const before = (await json(await pub(`/public/clubs/${club.slug}`))).data;
    const logoPath = new URL(before.logoUrl).pathname;
    const unknown = await (await pub(`/public/clubs/does-not-exist-${suffix}`)).text();

    expect((await call(board, "/club-public-profile/unpublish", { method: "POST", clubId: club.clubId })).status).toBe(200);
    const off = await pub(`/public/clubs/${club.slug}`);
    expect(off.status).toBe(404);
    expect(await off.text()).toBe(unknown);
    expect((await pub(logoPath)).status).toBe(403);

    await call(board, "/club-public-profile/publish", { method: "POST", clubId: club.clubId, body: { contactConsentConfirmed: true } });
    expect((await pub(`/public/clubs/${club.slug}`)).status).toBe(200);
    expect((await pub(logoPath)).status).toBe(200);

    await call(board, "/club-public-profile/settings", { method: "PUT", clubId: club.clubId, body: { publicProfileEnabled: false } });
    expect((await pub(`/public/clubs/${club.slug}`)).status).toBe(404);
    expect((await pub(logoPath)).status).toBe(403);

    await call(board, "/club-public-profile/settings", { method: "PUT", clubId: club.clubId, body: { publicProfileEnabled: true } });
    await db.insert(clubPlatformStatus).values({ clubId: club.clubId, suspendedAt: new Date(), suspensionReason: "Test" });
    await syncPublicMedia(club.clubId);
    expect((await pub(`/public/clubs/${club.slug}`)).status).toBe(404);
    expect((await pub(logoPath)).status).toBe(403);
    await db.delete(clubPlatformStatus).where(eq(clubPlatformStatus.clubId, club.clubId));
    await syncPublicMedia(club.clubId);
    expect((await pub(`/public/clubs/${club.slug}`)).status).toBe(200);
  });

  it("never serves a non-released key without a signature (no key probing)", async () => {
    const [privateFile] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.clubId, club.clubId), eq(mediaFiles.visibility, "private")));
    const known = await pub(`/media/${privateFile!.storageKey}`);
    const unknown = await pub(`/media/${club.clubId}/${randomUUID()}.png`);
    expect(known.status).toBe(403);
    expect(unknown.status).toBe(403);
    expect(await known.text()).toBe(await unknown.text());
  });

  it("finds only opted-in, discoverable, live clubs with name/slug/city/logo (B5)", async () => {
    const search = async (qs: string) => pub(`/public/clubs?${qs}`);
    for (const qs of ["", "q=ab", "city=W", `q=${encodeURIComponent("Forms public")}&city=W`]) {
      const res = await search(qs);
      expect(res.status, qs).toBe(400);
      expect((await json(res)).error, qs).toMatchObject({ code: "QUERY_TOO_SHORT", details: { code: "query_too_short", min: 3, minCity: 2 } });
    }
    const names = async (qs: string) => (await json(await search(qs))).data.map((x: { slug: string }) => x.slug);
    // Live but not discoverable: invisible, like a club that does not exist.
    expect(await names(`q=${encodeURIComponent(`public ${suffix}`)}`)).toEqual([]);
    await call(board, "/club-public-profile/settings", { method: "PUT", clubId: club.clubId, body: { discoverable: true } });
    const res = await search(`q=${encodeURIComponent(`public ${suffix}`)}`);
    expect(res.headers.get("cache-control")).toBe("public, no-cache");
    const hits = (await json(res)).data;
    expect(hits).toEqual([{ slug: club.slug, name: `Forms public ${suffix}`, city: "Wiesbach", logoUrl: expect.stringMatching(/\/media\//) }]);
    expect(await names("city=wiesb")).toContain(club.slug);
    // The other club (no public page) never shows up, also not via LIKE metacharacters.
    expect(await names(`q=${encodeURIComponent(`public-other ${suffix}`)}`)).toEqual([]);
    expect(await names("q=%25%25%25")).toEqual([]);
    expect(await names("q=___")).toEqual([]);
    // Suspended or not enabled: gone.
    await db.insert(clubPlatformStatus).values({ clubId: club.clubId, suspendedAt: new Date(), suspensionReason: "Test" });
    expect(await names("city=wiesb")).not.toContain(club.slug);
    await db.delete(clubPlatformStatus).where(eq(clubPlatformStatus.clubId, club.clubId));
    expect(await names("city=wiesb")).toContain(club.slug);

    // The search only uses its own budget: with a general limit of 1 two searches still pass.
    process.env.PUBLIC_CLUB_IP_LIMIT_PER_HOUR = "1";
    const ipOnly = randomUUID();
    expect((await pub("/public/clubs?city=wiesb", { "x-forwarded-for": ipOnly })).status).toBe(200);
    expect((await pub("/public/clubs?city=wiesb", { "x-forwarded-for": ipOnly })).status).toBe(200);
    delete process.env.PUBLIC_CLUB_IP_LIMIT_PER_HOUR;
    process.env.PUBLIC_CLUB_SEARCH_LIMIT_PER_HOUR = "2";
    const ip = randomUUID();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await pub("/public/clubs?city=wiesb", { "x-forwarded-for": ip })).status);
    expect(statuses).toEqual([200, 200, 429]);
    delete process.env.PUBLIC_CLUB_SEARCH_LIMIT_PER_HOUR;
  });

  it("lists live, indexable, active clubs in the sitemap (slug + updatedAt only) and drops them at once (E5)", async () => {
    const sitemap = async (qs = "", ip = randomUUID()) => pub(`/public/club-sitemap${qs}`, { "x-forwarded-for": ip });
    const allSlugs = async () => {
      const out: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 1000; i++) {
        const res = await sitemap(`?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.status).toBe(200);
        const body = await json(res);
        for (const row of body.data) expect(Object.keys(row).sort()).toEqual(["slug", "updatedAt"]);
        out.push(...body.data.map((r: { slug: string }) => r.slug));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      return out;
    };
    const first = await sitemap();
    expect(first.headers.get("cache-control")).toBe("public, no-cache");
    expect(Object.keys(await json(first)).sort()).toEqual(["data", "nextCursor"]);
    expect(await allSlugs()).toContain(club.slug);
    // Not live / not published clubs never appear.
    expect(await allSlugs()).not.toContain(other.slug);

    // Keyset pagination: limit 1 walks in slug order without repeats.
    const p1 = await json(await sitemap("?limit=1"));
    expect(p1.data).toHaveLength(1);
    if (p1.nextCursor) {
      const p2 = await json(await sitemap(`?limit=1&cursor=${p1.nextCursor}`));
      expect(p2.data[0].slug > p1.data[0].slug).toBe(true);
    }
    expect((await sitemap("?limit=0")).status).toBe(422);
    expect((await sitemap("?limit=5000")).status).toBe(422);
    expect((await sitemap("?cursor=%25%25")).status).toBe(422);

    // noindex: the page stays reachable but says so, and leaves the sitemap.
    expect((await call(board, "/club-public-profile/settings", { method: "PUT", clubId: club.clubId, body: { publicIndexingEnabled: false } })).status).toBe(200);
    expect((await json(await pub(`/public/clubs/${club.slug}`))).data.indexable).toBe(false);
    expect(await allSlugs()).not.toContain(club.slug);
    expect((await json(await call(board, "/club-public-profile", { clubId: club.clubId }))).data.settings.publicIndexingEnabled).toBe(false);
    await call(board, "/club-public-profile/settings", { method: "PUT", clubId: club.clubId, body: { publicIndexingEnabled: true } });
    expect(await allSlugs()).toContain(club.slug);
    // Suspension and switching the page off remove it at once.
    await db.insert(clubPlatformStatus).values({ clubId: club.clubId, suspendedAt: new Date(), suspensionReason: "Test" });
    expect(await allSlugs()).not.toContain(club.slug);
    await db.delete(clubPlatformStatus).where(eq(clubPlatformStatus.clubId, club.clubId));
    await call(board, "/club-public-profile/settings", { method: "PUT", clubId: club.clubId, body: { publicProfileEnabled: false } });
    expect(await allSlugs()).not.toContain(club.slug);
    await call(board, "/club-public-profile/settings", { method: "PUT", clubId: club.clubId, body: { publicProfileEnabled: true } });

    process.env.PUBLIC_CLUB_SITEMAP_LIMIT_PER_HOUR = "2";
    const ip = randomUUID();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await sitemap("", ip)).status);
    expect(statuses).toEqual([200, 200, 429]);
    delete process.env.PUBLIC_CLUB_SITEMAP_LIMIT_PER_HOUR;
  });

  it("rate limits failed lookups and all requests per client", async () => {
    process.env.PUBLIC_CLUB_INVALID_LIMIT_PER_HOUR = "3";
    const ip = randomUUID();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await pub(`/public/clubs/nope-${i}-${suffix}`, { "x-forwarded-for": ip })).status);
    expect(statuses).toEqual([404, 404, 404, 429]);
    const limited = await pub(`/public/clubs/nope-x-${suffix}`, { "x-forwarded-for": ip });
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect((await json(limited)).error.code).toBe("TOO_MANY_REQUESTS");

    process.env.PUBLIC_CLUB_IP_LIMIT_PER_HOUR = "2";
    const ip2 = randomUUID();
    const hits: number[] = [];
    for (let i = 0; i < 3; i++) hits.push((await pub(`/public/clubs/${club.slug}`, { "x-forwarded-for": ip2 })).status);
    expect(hits).toEqual([200, 200, 429]);
    delete process.env.PUBLIC_CLUB_IP_LIMIT_PER_HOUR;
    delete process.env.PUBLIC_CLUB_INVALID_LIMIT_PER_HOUR;
  });

  it("lets the website server forward the visitor address with its token (per-visitor budget instead of one shared IP)", async () => {
    process.env.PUBLIC_API_TRUSTED_TOKEN = "trusted-token-0123456789abcdef";
    process.env.PUBLIC_CLUB_INVALID_LIMIT_PER_HOUR = "1";
    const server = randomUUID();
    // Fresh visitor addresses per run: the DB-backed budget outlives a test run.
    const n = Math.floor(Math.random() * 200) + 1;
    const v = (i: number) => `10.${n}.${Math.floor(Math.random() * 250)}.${i}`;
    const [v1, v2, v3, v4] = [v(1), v(2), v(3), v(4)];
    const headers = (visitor: string, token = "trusted-token-0123456789abcdef") => ({ "x-forwarded-for": server, "x-public-api-token": token, "x-public-client-ip": visitor });
    expect((await pub(`/public/clubs/nope-a-${suffix}`, headers(v1))).status).toBe(404);
    expect((await pub(`/public/clubs/nope-b-${suffix}`, headers(v1))).status).toBe(429);
    // Another visitor through the same server has its own budget; a wrong token falls back to the server IP.
    expect((await pub(`/public/clubs/nope-c-${suffix}`, headers(v2))).status).toBe(404);
    expect((await pub(`/public/clubs/nope-d-${suffix}`, headers(v3, "wrong-token-0123456789abcdef"))).status).toBe(404);
    expect((await pub(`/public/clubs/nope-e-${suffix}`, headers(v4, "wrong-token-0123456789abcdef"))).status).toBe(429);
    delete process.env.PUBLIC_CLUB_INVALID_LIMIT_PER_HOUR;
    delete process.env.PUBLIC_API_TRUSTED_TOKEN;
  });
});
