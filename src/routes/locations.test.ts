import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { locationRoutes } from "./locations.js";

/**
 * Integration test against a real Postgres (DATABASE_URL), following
 * meetings.test.ts's / events.test.ts's pattern: real sign-up/sign-in/
 * createOrganization, no mocking. Covers location CRUD scoping, cross-club
 * IDOR (404), locations:write permission gating, key-holder add/duplicate/
 * remove, and -- most importantly -- the guest-visibility filter on
 * wifi/links (a "guest"-role member must never see a visibleToGuests=false
 * row, including its ssid/password/url fields).
 */

const app = new Hono();
app.route("/locations", locationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

// The in-memory rate limiter keys on x-forwarded-for; give every request its own bucket.
const realRequest = app.request.bind(app);
app.request = ((input: Parameters<typeof realRequest>[0], init?: RequestInit) =>
  realRequest(input, { ...init, headers: { "x-forwarded-for": randomUUID(), ...(init?.headers as Record<string, string> | undefined) } })) as typeof app.request;

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

describe("locations routes", () => {
  let clubAId: string;
  let clubBId: string;
  let userAId: string;
  let userBId: string;
  let userPlainId: string;
  let userGuestId: string;
  let cookieBoard: string;
  let cookieB: string;
  let cookiePlain: string;
  let cookieGuest: string;
  let memberPlainId: string;

  beforeAll(async () => {
    const board = await signUpAndVerify(`loc-board-${suffix}@example.com`, "Board Founder");
    const b = await signUpAndVerify(`loc-b-${suffix}@example.com`, "Club B Founder");
    const plain = await signUpAndVerify(`loc-plain-${suffix}@example.com`, "Plain Member");
    const guest = await signUpAndVerify(`loc-guest-${suffix}@example.com`, "Guest Member");
    userAId = board.userId;
    userBId = b.userId;
    userPlainId = plain.userId;
    userGuestId = guest.userId;
    cookieBoard = board.cookie;
    cookieB = b.cookie;
    cookiePlain = plain.cookie;
    cookieGuest = guest.cookie;

    const clubA = await auth.api.createOrganization({
      body: { name: `Locations Club A ${suffix}`, slug: `locations-club-a-${suffix}`, userId: userAId },
    });
    const clubB = await auth.api.createOrganization({
      body: { name: `Locations Club B ${suffix}`, slug: `locations-club-b-${suffix}`, userId: userBId },
    });
    clubAId = clubA!.id;
    clubBId = clubB!.id;

    await auth.api.addMember({ body: { userId: userPlainId, organizationId: clubAId, role: "member" } });
    await auth.api.addMember({ body: { userId: userGuestId, organizationId: clubAId, role: "guest" } });

    const memberBoard = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, userAId)),
    });
    const memberPlain = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, userPlainId)),
    });
    memberPlainId = memberPlain!.id;

    // Grants memberBoard locations:write, so cookieBoard acts as the "board"
    // caller throughout; cookiePlain/cookieGuest stay non-privileged.
    await db.insert(clubRoles).values({ memberId: memberBoard!.id, roleType: "vorsitz" });
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubAId));
    await db.delete(organization).where(eq(organization.id, clubBId));
    await db.delete(user).where(eq(user.id, userAId));
    await db.delete(user).where(eq(user.id, userBId));
    await db.delete(user).where(eq(user.id, userPlainId));
    await db.delete(user).where(eq(user.id, userGuestId));
    await closeDatabase();
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.request(`/locations?clubId=${clubAId}`);
    expect(res.status).toBe(401);
  });

  // --- Location CRUD -----------------------------------------------------------

  let locationId: string;

  it("rejects POST / from a member without locations:write", async () => {
    const res = await app.request(`/locations?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookiePlain, "content-type": "application/json" },
      body: JSON.stringify({ name: "Illegal Clubhouse" }),
    });
    expect(res.status).toBe(403);
  });

  it("creates a location with locations:write", async () => {
    const res = await app.request(`/locations?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Vereinsheim",
        address: "Hauptstrasse 1",
        latitude: 52.52,
        longitude: 13.405,
        openingHours: "Mo-Fr 18-22",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; name: string; latitude: string } };
    expect(body.data.name).toBe("Vereinsheim");
    expect(body.data.latitude).toBe("52.52");
    locationId = body.data.id;
  });

  it("lists the club's locations", async () => {
    const res = await app.request(`/locations?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.some((l) => l.id === locationId)).toBe(true);
  });

  it("returns 404 (cross-club IDOR) for GET /:id under the wrong club", async () => {
    const res = await app.request(`/locations/${locationId}?clubId=${clubBId}`, { headers: { cookie: cookieB } });
    expect(res.status).toBe(404);
  });

  it("returns the location under its own club, with an empty keyHolders list", async () => {
    const res = await app.request(`/locations/${locationId}?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; keyHolders: unknown[] } };
    expect(body.data.id).toBe(locationId);
    expect(body.data.keyHolders).toEqual([]);
  });

  it("rejects PATCH /:id from a member without locations:write", async () => {
    const res = await app.request(`/locations/${locationId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookiePlain, "content-type": "application/json" },
      body: JSON.stringify({ name: "Hacked" }),
    });
    expect(res.status).toBe(403);
  });

  it("updates a location with locations:write", async () => {
    const res = await app.request(`/locations/${locationId}?clubId=${clubAId}`, {
      method: "PATCH",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ accessNote: "Schluessel bei Vorstand", latitude: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { accessNote: string; latitude: string | null } };
    expect(body.data.accessNote).toBe("Schluessel bei Vorstand");
    expect(body.data.latitude).toBeNull();
  });

  // --- Key holders ---------------------------------------------------------------

  it("returns 422 for a key-holder memberId belonging to another club", async () => {
    const memberB = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubBId), eq(m.userId, userBId)),
    });
    const res = await app.request(`/locations/${locationId}/key-holders?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberB!.id }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects POST /:id/key-holders from a member without locations:write", async () => {
    const res = await app.request(`/locations/${locationId}/key-holders?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookiePlain, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberPlainId }),
    });
    expect(res.status).toBe(403);
  });

  it("adds a key holder", async () => {
    const res = await app.request(`/locations/${locationId}/key-holders?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberPlainId }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { memberId: string } };
    expect(body.data.memberId).toBe(memberPlainId);

    const getRes = await app.request(`/locations/${locationId}?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    const getBody = (await getRes.json()) as { data: { keyHolders: Array<{ memberId: string }> } };
    expect(getBody.data.keyHolders.some((k) => k.memberId === memberPlainId)).toBe(true);
  });

  it("rejects a duplicate key holder with 409", async () => {
    const res = await app.request(`/locations/${locationId}/key-holders?clubId=${clubAId}`, {
      method: "POST",
      headers: { cookie: cookieBoard, "content-type": "application/json" },
      body: JSON.stringify({ memberId: memberPlainId }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 deleting a key holder that doesn't exist for this location", async () => {
    const res = await app.request(`/locations/${locationId}/key-holders/${memberPlainId}-nope?clubId=${clubAId}`, {
      method: "DELETE",
      headers: { cookie: cookieBoard },
    });
    expect(res.status).toBe(404);
  });

  it("removes a key holder", async () => {
    const res = await app.request(`/locations/${locationId}/key-holders/${memberPlainId}?clubId=${clubAId}`, {
      method: "DELETE",
      headers: { cookie: cookieBoard },
    });
    expect(res.status).toBe(204);

    const getRes = await app.request(`/locations/${locationId}?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
    const getBody = (await getRes.json()) as { data: { keyHolders: Array<{ memberId: string }> } };
    expect(getBody.data.keyHolders.some((k) => k.memberId === memberPlainId)).toBe(false);
  });

  // --- WiFi networks ---------------------------------------------------------------

  describe("wifi networks", () => {
    let visibleWifiId: string;
    let hiddenWifiId: string;

    it("rejects POST /:id/wifi from a member without locations:write", async () => {
      const res = await app.request(`/locations/${locationId}/wifi?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookiePlain, "content-type": "application/json" },
        body: JSON.stringify({ label: "Illegal", ssid: "illegal-ssid", password: "secret" }),
      });
      expect(res.status).toBe(403);
    });

    it("creates a guest-visible and a members-only wifi network", async () => {
      const visibleRes = await app.request(`/locations/${locationId}/wifi?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ label: "Gast-WLAN", ssid: "vereinsheim-guest", password: "guestpass123", visibleToGuests: true }),
      });
      expect(visibleRes.status).toBe(201);
      const visibleBody = (await visibleRes.json()) as { data: { id: string; visibleToGuests: boolean } };
      expect(visibleBody.data.visibleToGuests).toBe(true);
      visibleWifiId = visibleBody.data.id;

      const hiddenRes = await app.request(`/locations/${locationId}/wifi?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ label: "Vorstands-WLAN", ssid: "vereinsheim-board", password: "topsecret456" }),
      });
      expect(hiddenRes.status).toBe(201);
      const hiddenBody = (await hiddenRes.json()) as { data: { id: string; visibleToGuests: boolean } };
      expect(hiddenBody.data.visibleToGuests).toBe(false);
      hiddenWifiId = hiddenBody.data.id;
    });

    it("shows a plain member both wifi networks, passwords included", async () => {
      const res = await app.request(`/locations/${locationId}/wifi?clubId=${clubAId}`, { headers: { cookie: cookiePlain } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string; ssid: string; password: string }> };
      expect(body.data.some((w) => w.id === visibleWifiId)).toBe(true);
      expect(body.data.some((w) => w.id === hiddenWifiId)).toBe(true);
      expect(body.data.find((w) => w.id === hiddenWifiId)?.password).toBe("topsecret456");
    });

    it("filters a guest's wifi list to only visibleToGuests=true rows, never leaking the hidden network's ssid/password", async () => {
      const res = await app.request(`/locations/${locationId}/wifi?clubId=${clubAId}`, { headers: { cookie: cookieGuest } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string; ssid: string; password: string }> };
      expect(body.data.some((w) => w.id === visibleWifiId)).toBe(true);
      expect(body.data.some((w) => w.id === hiddenWifiId)).toBe(false);
      expect(JSON.stringify(body.data)).not.toContain("topsecret456");
      expect(JSON.stringify(body.data)).not.toContain("vereinsheim-board");
    });

    it("updates a wifi network with locations:write", async () => {
      const res = await app.request(`/locations/${locationId}/wifi/${hiddenWifiId}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ label: "Vorstands-WLAN (neu)" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { label: string } };
      expect(body.data.label).toBe("Vorstands-WLAN (neu)");
    });

    it("returns 404 for a wifi id under the wrong location", async () => {
      const otherLocRes = await app.request(`/locations?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ name: "Sportplatz" }),
      });
      const otherLocBody = (await otherLocRes.json()) as { data: { id: string } };

      const res = await app.request(`/locations/${otherLocBody.data.id}/wifi/${hiddenWifiId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieBoard },
      });
      expect(res.status).toBe(404);
    });

    it("deletes a wifi network with locations:write", async () => {
      const res = await app.request(`/locations/${locationId}/wifi/${visibleWifiId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieBoard },
      });
      expect(res.status).toBe(204);

      const listRes = await app.request(`/locations/${locationId}/wifi?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
      const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
      expect(listBody.data.some((w) => w.id === visibleWifiId)).toBe(false);
    });
  });

  // --- Links -----------------------------------------------------------------------

  describe("links", () => {
    let visibleLinkId: string;
    let hiddenLinkId: string;

    it("rejects POST /:id/links from a member without locations:write", async () => {
      const res = await app.request(`/locations/${locationId}/links?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookiePlain, "content-type": "application/json" },
        body: JSON.stringify({ title: "Illegal", url: "https://example.com/illegal" }),
      });
      expect(res.status).toBe(403);
    });

    it("rejects an invalid url with 422", async () => {
      const res = await app.request(`/locations/${locationId}/links?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ title: "Bad link", url: "not-a-url" }),
      });
      expect(res.status).toBe(422);
    });

    it("creates a guest-visible and a members-only link", async () => {
      const visibleRes = await app.request(`/locations/${locationId}/links?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ title: "Vereins-Website", url: "https://example.com/verein", visibleToGuests: true }),
      });
      expect(visibleRes.status).toBe(201);
      const visibleBody = (await visibleRes.json()) as { data: { id: string } };
      visibleLinkId = visibleBody.data.id;

      const hiddenRes = await app.request(`/locations/${locationId}/links?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ title: "Vorstands-Intranet", url: "https://intranet.example.com/board" }),
      });
      expect(hiddenRes.status).toBe(201);
      const hiddenBody = (await hiddenRes.json()) as { data: { id: string } };
      hiddenLinkId = hiddenBody.data.id;
    });

    it("shows a plain member both links", async () => {
      const res = await app.request(`/locations/${locationId}/links?clubId=${clubAId}`, { headers: { cookie: cookiePlain } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      expect(body.data.some((l) => l.id === visibleLinkId)).toBe(true);
      expect(body.data.some((l) => l.id === hiddenLinkId)).toBe(true);
    });

    it("filters a guest's link list to only visibleToGuests=true rows, never leaking the hidden link's title/url", async () => {
      const res = await app.request(`/locations/${locationId}/links?clubId=${clubAId}`, { headers: { cookie: cookieGuest } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string; title: string; url: string }> };
      expect(body.data.some((l) => l.id === visibleLinkId)).toBe(true);
      expect(body.data.some((l) => l.id === hiddenLinkId)).toBe(false);
      expect(JSON.stringify(body.data)).not.toContain("intranet.example.com");
      expect(JSON.stringify(body.data)).not.toContain("Vorstands-Intranet");
    });

    it("updates a link with locations:write", async () => {
      const res = await app.request(`/locations/${locationId}/links/${hiddenLinkId}?clubId=${clubAId}`, {
        method: "PATCH",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ visibleToGuests: true }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { visibleToGuests: boolean } };
      expect(body.data.visibleToGuests).toBe(true);
    });

    it("deletes a link with locations:write", async () => {
      const res = await app.request(`/locations/${locationId}/links/${visibleLinkId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieBoard },
      });
      expect(res.status).toBe(204);

      const listRes = await app.request(`/locations/${locationId}/links?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
      const listBody = (await listRes.json()) as { data: Array<{ id: string }> };
      expect(listBody.data.some((l) => l.id === visibleLinkId)).toBe(false);
    });
  });

  // --- Visibility levels + access info (B8) ------------------------------------------------

  describe("visibility levels gast / mitglied / vorstand and access info", () => {
    let scopedLocationId: string;
    const ids: Record<string, string> = {};
    const call = (path: string, cookie: string, method = "GET", body?: unknown) =>
      app.request(`/locations${path}?clubId=${clubAId}`, {
        method,
        headers: { cookie, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const labels = async (path: string, cookie: string, key: "label" | "title") =>
      ((await (await call(path, cookie)).json()) as { data: Array<Record<string, string>> }).data.map((r) => r[key]);

    beforeAll(async () => {
      const loc = await call("", cookieBoard, "POST", { name: "Scoped Haus", accessNote: "Tuercode 4711" });
      scopedLocationId = ((await loc.json()) as { data: { id: string } }).data.id;
      await call(`/${scopedLocationId}/key-holders`, cookieBoard, "POST", { memberId: memberPlainId });
      for (const level of ["gast", "mitglied", "vorstand"] as const) {
        const wifi = await call(`/${scopedLocationId}/wifi`, cookieBoard, "POST", { label: `wifi-${level}`, ssid: `ssid-${level}`, password: `pw-${level}`, visibility: level });
        expect(wifi.status).toBe(201);
        ids[`wifi-${level}`] = ((await wifi.json()) as { data: { id: string; visibility: string; visibleToGuests: boolean } }).data.id;
        const link = await call(`/${scopedLocationId}/links`, cookieBoard, "POST", { title: `link-${level}`, url: `https://example.com/${level}`, visibility: level });
        expect(link.status).toBe(201);
        ids[`link-${level}`] = ((await link.json()) as { data: { id: string } }).data.id;
      }
    });

    it("rejects an unknown visibility level (422)", async () => {
      const res = await call(`/${scopedLocationId}/wifi`, cookieBoard, "POST", { label: "x", ssid: "x", password: "x", visibility: "geheim" });
      expect(res.status).toBe(422);
    });

    it("maps the legacy visibleToGuests flag (true -> gast, false -> mitglied) and derives it in responses", async () => {
      const res = await call(`/${scopedLocationId}/wifi/${ids["wifi-gast"]}`, cookieBoard, "PATCH", { visibleToGuests: false });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { visibility: string; visibleToGuests: boolean } }).data).toMatchObject({ visibility: "mitglied", visibleToGuests: false });
      // restore for the following tests
      const back = await call(`/${scopedLocationId}/wifi/${ids["wifi-gast"]}`, cookieBoard, "PATCH", { visibleToGuests: true });
      expect(((await back.json()) as { data: { visibility: string } }).data.visibility).toBe("gast");
    });

    it("the legacy visibleToGuests=false never raises a 'vorstand' row to 'mitglied' (A10)", async () => {
      for (const [kind, key] of [["wifi", "wifi-vorstand"], ["links", "link-vorstand"]] as const) {
        const res = await call(`/${scopedLocationId}/${kind}/${ids[key]}`, cookieBoard, "PATCH", { visibleToGuests: false });
        expect(res.status, kind).toBe(200);
        expect(((await res.json()) as { data: { visibility: string; visibleToGuests: boolean } }).data, kind).toMatchObject({ visibility: "vorstand", visibleToGuests: false });
      }
      // The plain member still must not see it.
      expect(await labels(`/${scopedLocationId}/wifi`, cookiePlain, "label")).not.toContain("wifi-vorstand");
    });

    it("guests see only 'gast', members 'gast' + 'mitglied', locations:write 'vorstand' too", async () => {
      expect(await labels(`/${scopedLocationId}/wifi`, cookieGuest, "label")).toEqual(["wifi-gast"]);
      expect((await labels(`/${scopedLocationId}/wifi`, cookiePlain, "label")).sort()).toEqual(["wifi-gast", "wifi-mitglied"]);
      expect((await labels(`/${scopedLocationId}/wifi`, cookieBoard, "label")).sort()).toEqual(["wifi-gast", "wifi-mitglied", "wifi-vorstand"]);
      expect(await labels(`/${scopedLocationId}/links`, cookieGuest, "title")).toEqual(["link-gast"]);
      expect((await labels(`/${scopedLocationId}/links`, cookiePlain, "title")).sort()).toEqual(["link-gast", "link-mitglied"]);
      expect((await labels(`/${scopedLocationId}/links`, cookieBoard, "title")).sort()).toEqual(["link-gast", "link-mitglied", "link-vorstand"]);
      const plainBody = JSON.stringify(await (await call(`/${scopedLocationId}/wifi`, cookiePlain)).json());
      expect(plainBody).not.toContain("pw-vorstand");
    });

    it("shows 'vorstand' entries with locations:read_access (abteilungsleitung) but without write rights", async () => {
      const plainMember = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubAId), eq(m.userId, userPlainId)) });
      await db.insert(clubRoles).values({ memberId: plainMember!.id, roleType: "abteilungsleitung" });
      try {
        expect((await labels(`/${scopedLocationId}/wifi`, cookiePlain, "label")).sort()).toEqual(["wifi-gast", "wifi-mitglied", "wifi-vorstand"]);
        const detail = (await (await call(`/${scopedLocationId}`, cookiePlain)).json()) as { data: { accessNote: string; accessRestricted: boolean } };
        expect(detail.data).toMatchObject({ accessNote: "Tuercode 4711", accessRestricted: false });
      } finally {
        await db.delete(clubRoles).where(eq(clubRoles.memberId, plainMember!.id));
      }
    });

    it("hides access note and key holders from members without access rights (list and detail)", async () => {
      const detail = (await (await call(`/${scopedLocationId}`, cookiePlain)).json()) as {
        data: { accessNote: string | null; accessRestricted: boolean; keyHolders: unknown[] };
      };
      expect(detail.data).toMatchObject({ accessNote: null, accessRestricted: true, keyHolders: [] });
      const guestDetail = (await (await call(`/${scopedLocationId}`, cookieGuest)).json()) as { data: { accessNote: string | null; keyHolders: unknown[] } };
      expect(guestDetail.data).toMatchObject({ accessNote: null, keyHolders: [] });
      const list = (await (await call("", cookiePlain)).json()) as { data: Array<{ id: string; accessNote: string | null }> };
      expect(list.data.find((l) => l.id === scopedLocationId)!.accessNote).toBeNull();
      expect(JSON.stringify(list)).not.toContain("Tuercode 4711");

      const board = (await (await call(`/${scopedLocationId}`, cookieBoard)).json()) as { data: { accessNote: string; keyHolders: unknown[] } };
      expect(board.data.accessNote).toBe("Tuercode 4711");
      expect(board.data.keyHolders).toHaveLength(1);
    });
  });

  // --- Delete ----------------------------------------------------------------

  describe("DELETE /:id", () => {
    let deleteLocationId: string;

    beforeAll(async () => {
      const res = await app.request(`/locations?clubId=${clubAId}`, {
        method: "POST",
        headers: { cookie: cookieBoard, "content-type": "application/json" },
        body: JSON.stringify({ name: "To be deleted" }),
      });
      const body = (await res.json()) as { data: { id: string } };
      deleteLocationId = body.data.id;
    });

    it("rejects DELETE from a member without locations:write", async () => {
      const res = await app.request(`/locations/${deleteLocationId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookiePlain },
      });
      expect(res.status).toBe(403);
    });

    it("deletes with locations:write", async () => {
      const res = await app.request(`/locations/${deleteLocationId}?clubId=${clubAId}`, {
        method: "DELETE",
        headers: { cookie: cookieBoard },
      });
      expect(res.status).toBe(204);

      const getRes = await app.request(`/locations/${deleteLocationId}?clubId=${clubAId}`, { headers: { cookie: cookieBoard } });
      expect(getRes.status).toBe(404);
    });
  });
});
