import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { closeDatabase, db } from "../db/client.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { contrastAgainstWhite, imageDimensions } from "../lib/image-dimensions.js";
import { GPS_MARKER, makeJpeg, makePng, makeWebp, PDF_BYTES } from "../lib/media-fixtures.js";
import { loadBranding } from "../lib/branding.js";
import { clubBrandingRoutes } from "./club-branding.js";
import { mediaRoutes } from "./media.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";

/** Wave 13 B7: branding settings, logo hardening, contrast check, test page, rights. */
const app = new Hono();
app.route("/club-settings/branding", clubBrandingRoutes);
app.route("/media", mediaRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();

const file = (bytes: Buffer, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });
const form = (f: File) => {
  const data = new FormData();
  data.set("file", f);
  return data;
};
type Branding = { data: { primaryColor: string | null; accentColor: string | null; effective: { primaryColor: string }; letterhead: Record<string, string | null>; logo: { url: string } | null } };

describe("club branding", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let guest: Account;
  const id = () => club.clubId;
  const patch = (who: Account, body: unknown) => call(who, "/club-settings/branding", { method: "PATCH", body, clubId: id() });
  const putLogo = (who: Account, f: File, clubId = id()) => call(who, "/club-settings/branding/logo", { method: "PUT", form: form(f), clubId });

  beforeAll(async () => {
    club = await createClub("brand", suffix, { plain: null, kassen: "kassenwart" });
    other = await createClub("brando", suffix);
    guest = await signUpAndVerify(`brand-guest-${suffix}@example.com`, "Brand Guest");
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: id(), role: "guest" } });
    club.userIds.push(guest.userId);
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("measures image sizes from the headers and contrast like WCAG", () => {
    expect(imageDimensions(makePng(false, { width: 120, height: 80 }), "image/png")).toEqual({ width: 120, height: 80 });
    expect(imageDimensions(makeJpeg(true, { width: 300, height: 200 }), "image/jpeg")).toEqual({ width: 300, height: 200 });
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]), "image/jpeg")).toBeNull();
    expect(imageDimensions(Buffer.from("garbage"), "image/png")).toBeNull();
    expect(contrastAgainstWhite("#000000")).toBeCloseTo(21, 0);
    expect(contrastAgainstWhite("#ffffff")).toBeCloseTo(1, 1);
    expect(contrastAgainstWhite("#2c4870")).toBeGreaterThan(8);
    expect(contrastAgainstWhite("#ffff00")).toBeLessThan(1.5);
  });

  it("shows neutral defaults and lets every member read, but not external guests", async () => {
    const res = await call(club.members.plain!, "/club-settings/branding", { clubId: id() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Branding;
    expect(body.data).toMatchObject({ primaryColor: null, logo: null, effective: { primaryColor: "#2c4870" } });
    expect((await call(guest, "/club-settings/branding", { clubId: id() })).status).toBe(403);
  });

  it("changes colours and letterhead only with branding:write and validates them", async () => {
    expect((await patch(club.members.plain!, { primaryColor: "#112233" })).status).toBe(403);
    expect((await patch(club.members.kassen!, { footer: "x" })).status).toBe(403);
    expect((await patch(guest, {})).status).toBe(403);
    expect((await patch(club.founder, { primaryColor: "red" })).status).toBe(422);
    expect((await patch(club.founder, { primaryColor: "#ffff00" })).status).toBe(422); // too light for headings
    expect((await patch(club.founder, { accentColor: "#ffffcc" })).status).toBe(422);
    expect((await patch(club.founder, { address: "a‮b" })).status).toBe(422);
    expect((await patch(club.founder, { footer: "x".repeat(161) })).status).toBe(422);
    const ok = await patch(club.founder, { primaryColor: "#8B1A1A", accentColor: "#C0392B", address: "Vereinsstraße 1\n12345 Musterstadt", register: "VR 1234 AG Musterstadt", representatives: "Vorsitz: Erika Mustermann", contact: "info@example.org", footer: "TSV Muster e.V." });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as Branding;
    expect(body.data).toMatchObject({ primaryColor: "#8b1a1a", accentColor: "#c0392b", letterhead: { address: "Vereinsstraße 1\n12345 Musterstadt", footer: "TSV Muster e.V." } });
    const cleared = (await (await patch(club.founder, { footer: "" })).json()) as Branding;
    expect(cleared.data.letterhead.footer).toBeNull();
    expect(cleared.data.primaryColor).toBe("#8b1a1a"); // untouched fields stay
    expect((await call(other.founder, "/club-settings/branding", { clubId: other.clubId }).then((r) => r.json()) as Branding).data.primaryColor).toBeNull();
  });

  describe("logo", () => {
    it("accepts a PNG or JPEG, strips metadata, serves it as a signed URL and replaces the old file", async () => {
      expect((await putLogo(club.members.plain!, file(makePng(false, { width: 64, height: 64 }), "l.png", "image/png"))).status).toBe(403);
      const first = await putLogo(club.founder, file(makePng(true, { width: 64, height: 64 }), "logo.png", "image/png"));
      expect(first.status).toBe(200);
      const [s1] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, id()));
      const key1 = s1!.brandLogoKey!;
      expect(key1.startsWith(`${id()}/branding/`)).toBe(true);
      const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, key1));
      expect(media).toMatchObject({ ownerType: "branding", ownerId: id(), kind: "image", sensitive: false, mimeType: "image/png" });

      const shown = (await (await call(club.members.plain!, "/club-settings/branding", { clubId: id() })).json()) as Branding;
      const url = new URL(shown.data.logo!.url);
      const served = await app.request(`${url.pathname}${url.search}`, { headers: { "x-forwarded-for": "branding-test" } });
      expect(served.status).toBe(200);
      expect(Buffer.from(await served.arrayBuffer()).includes(GPS_MARKER)).toBe(false);
      expect(served.headers.get("cache-control")).toMatch(/^private/);
      expect((await app.request(`${url.pathname}`, { headers: { "x-forwarded-for": "branding-test2" } })).status).toBe(403);

      expect((await putLogo(club.founder, file(makeJpeg(true, { width: 200, height: 100 }), "logo.jpg", "image/jpeg"))).status).toBe(200);
      const [s2] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, id()));
      expect(s2!.brandLogoKey).not.toBe(key1);
      const [old] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, key1));
      expect(old!.deletedAt).not.toBeNull();
      expect((await app.request(`${url.pathname}${url.search}`, { headers: { "x-forwarded-for": "branding-test3" } })).status).toBe(404);
    });

    it("refuses SVG, WebP, PDF, spoofed types, tiny, huge and oversized logos without changing the current one", async () => {
      const [before] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, id()));
      const bad: Array<[string, File, string]> = [
        ["svg", file(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), "l.svg", "image/svg+xml"), "logo_type"],
        ["svg as png", file(Buffer.from("<svg onload=alert(1)>"), "l.png", "image/png"), "logo_type"],
        ["webp", file(makeWebp(false), "l.webp", "image/webp"), "logo_type"],
        ["pdf", file(PDF_BYTES, "l.pdf", "application/pdf"), "logo_type"],
        ["png declared jpeg", file(makePng(false, { width: 64, height: 64 }), "l.jpg", "image/jpeg"), ""],
        ["1x1 png", file(makePng(false), "l.png", "image/png"), "logo_dimensions"],
        ["huge dimensions", file(makePng(false, { width: 20000, height: 20000 }), "l.png", "image/png"), "logo_dimensions"],
        ["too many pixels", file(makePng(false, { width: 4000, height: 4000 }), "l.png", "image/png"), "logo_dimensions"],
      ];
      for (const [label, f, code] of bad) {
        const res = await putLogo(club.founder, f);
        expect(res.status, label).toBe(422);
        if (code) expect(((await res.json()) as { error: { details?: { code?: string } } }).error.details?.code, label).toBe(code);
      }
      const big = Buffer.concat([makePng(false, { width: 64, height: 64 }), Buffer.alloc(2 * 1024 * 1024)]);
      expect((await putLogo(club.founder, file(big, "big.png", "image/png"))).status).toBe(422);
      expect((await call(club.founder, "/club-settings/branding/logo", { method: "PUT", clubId: id(), body: {} })).status).toBe(422);
      const [after] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, id()));
      expect(after!.brandLogoKey).toBe(before!.brandLogoKey);
    });

    it("loads the logo into the document branding only when it is a PNG/JPEG of this club", async () => {
      const branding = await loadBranding(id());
      expect(branding.logo).not.toBeNull();
      expect(branding).toMatchObject({ primaryColor: "#8b1a1a", accentColor: "#c0392b" });
      expect(branding.letterhead).toContain("Vereinsstraße 1");
      // a key of another club in the settings is ignored
      const foreign = (await db.select().from(clubSettings).where(eq(clubSettings.clubId, id())))[0]!;
      await putLogo(other.founder, file(makePng(false, { width: 64, height: 64 }), "o.png", "image/png"), other.clubId);
      const [o] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, other.clubId));
      await db.update(clubSettings).set({ brandLogoKey: o!.brandLogoKey }).where(eq(clubSettings.clubId, id()));
      expect((await loadBranding(id())).logo).toBeNull();
      await db.update(clubSettings).set({ brandLogoKey: foreign.brandLogoKey }).where(eq(clubSettings.clubId, id()));
    });

    it("removes the logo and its file", async () => {
      const [s] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, id()));
      expect((await call(club.members.plain!, "/club-settings/branding/logo", { method: "DELETE", clubId: id() })).status).toBe(403);
      expect((await call(club.founder, "/club-settings/branding/logo", { method: "DELETE", clubId: id() })).status).toBe(204);
      expect((await db.select().from(clubSettings).where(eq(clubSettings.clubId, id())))[0]!.brandLogoKey).toBeNull();
      expect((await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, s!.brandLogoKey!)))[0]!.deletedAt).not.toBeNull();
      expect((await call(club.founder, "/club-settings/branding/logo", { method: "DELETE", clubId: id() })).status).toBe(204);
    });
  });

  describe("test page", () => {
    it("renders a PDF with the current branding for branding:write only, without storing anything", async () => {
      expect((await call(club.members.plain!, "/club-settings/branding/preview", { method: "POST", clubId: id() })).status).toBe(403);
      expect((await call(club.members.kassen!, "/club-settings/branding/preview", { method: "POST", clubId: id() })).status).toBe(403);
      await putLogo(club.founder, file(makeJpeg(false, { width: 100, height: 100 }), "logo.jpg", "image/jpeg"));
      const live = async () => (await db.select().from(mediaFiles).where(eq(mediaFiles.clubId, id()))).filter((r) => !r.deletedAt).length;
      const before = await live();
      const res = await call(club.founder, "/club-settings/branding/preview", { method: "POST", clubId: id() });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(await live()).toBe(before); // nothing stored for the test page
    });
  });
});
