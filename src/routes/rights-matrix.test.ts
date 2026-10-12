import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { inventoryItems } from "../db/schema/inventory.js";
import { CLUB_ROLE_TYPES, clubPermissionsFor } from "../lib/club-permissions.js";
import { toAppError } from "../lib/errors.js";
import { adminClubRegistrationRoutes } from "./admin-club-registrations.js";
import { adminClubRoutes } from "./admin-clubs.js";
import { clubStatsRoutes } from "./club-stats.js";
import { clubExitRequestRoutes } from "./club-exit-requests.js";
import { clubSettingsRoutes } from "./club-settings.js";
import { adminEmailRoutes } from "./admin-emails.js";
import { adminNotificationRoutes } from "./admin-notifications.js";
import { adminNotificationTemplateRoutes } from "./admin-notification-templates.js";
import { adminStatsRoutes } from "./admin-stats.js";
import { availabilityRoutes } from "./availability.js";
import { calendarRoutes } from "./calendars.js";
import { clubApplicationRoutes } from "./club-applications.js";
import { clubInfoRoutes } from "./club-info.js";
import { clubMemberRoutes } from "./club-members.js";
import { clubRegistrationRoutes } from "./club-registrations.js";
import { departmentRoutes } from "./departments.js";
import { eventRoutes, icsRoutes } from "./events.js";
import { healthRoutes } from "./health.js";
import { internalStatsRoutes } from "./internal-stats.js";
import { inventoryItemRoutes } from "./inventory-items.js";
import { locationRoutes } from "./locations.js";
import { mediaRoutes } from "./media.js";
import { meetingRoutes } from "./meetings.js";
import { myClubRoutes } from "./my-clubs.js";
import { notificationRoutes } from "./notifications.js";

/**
 * Rights matrix (Wave 7 B12 part, deny-by-default): EVERY registered writing route (POST/PATCH/PUT/DELETE)
 * is called by an account member who holds ONLY the implicit role `mitglied` -- and once more by an external guest --
 * and must be denied with 403 (404 only where listed in MAY_BE_404; 401 is NOT accepted: a dead session would make
 * the whole matrix pass vacuously, so the sessions are verified first). Self-service routes are listed explicitly in
 * SELF_SERVICE. Handlers registered with `.all()` are not enumerated per method and therefore forbidden (test below).
 * A new route that is neither denied nor on the allowlist fails this test -- add a permission check or,
 * deliberately, an allowlist entry with a reason.
 */

// Mirrors the `app.route(...)` list of src/index.ts; the first test verifies that the two stay in sync.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- routers have different Env types
const MOUNTS: Array<[string, string, Hono<any>]> = [
  ["/", "healthRoutes", healthRoutes],
  ["/internal", "internalStatsRoutes", internalStatsRoutes],
  ["/admin", "adminStatsRoutes", adminStatsRoutes],
  ["/admin", "adminEmailRoutes", adminEmailRoutes],
  ["/admin", "adminClubRoutes", adminClubRoutes],
  ["/club-stats", "clubStatsRoutes", clubStatsRoutes],
  ["/club-settings", "clubSettingsRoutes", clubSettingsRoutes],
  ["/club-exit-requests", "clubExitRequestRoutes", clubExitRequestRoutes],
  ["/notifications", "notificationRoutes", notificationRoutes],
  ["/admin/notifications", "adminNotificationRoutes", adminNotificationRoutes],
  ["/admin/notification-templates", "adminNotificationTemplateRoutes", adminNotificationTemplateRoutes],
  ["/admin/club-registrations", "adminClubRegistrationRoutes", adminClubRegistrationRoutes],
  ["/club-registrations", "clubRegistrationRoutes", clubRegistrationRoutes],
  ["/my-clubs", "myClubRoutes", myClubRoutes],
  ["/club-members", "clubMemberRoutes", clubMemberRoutes],
  ["/club-applications", "clubApplicationRoutes", clubApplicationRoutes],
  ["/departments", "departmentRoutes", departmentRoutes],
  ["/club-info", "clubInfoRoutes", clubInfoRoutes],
  ["/calendars", "calendarRoutes", calendarRoutes],
  ["/events", "eventRoutes", eventRoutes],
  ["/events.ics", "icsRoutes", icsRoutes],
  ["/availability", "availabilityRoutes", availabilityRoutes],
  ["/meetings", "meetingRoutes", meetingRoutes],
  ["/locations", "locationRoutes", locationRoutes],
  ["/inventory-items", "inventoryItemRoutes", inventoryItemRoutes],
  ["/media", "mediaRoutes", mediaRoutes],
];

const app = new Hono();
for (const [path, , router] of MOUNTS) app.route(path, router);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];

/** Self-service routes a plain `mitglied` may use. Not asserted as denied; each entry needs a reason. */
const SELF_SERVICE: Record<string, string> = {
  "PATCH /club-members/me": "own profile",
  "POST /club-members/apply": "join request (the caller is not yet a member)",
  "POST /club-registrations": "found a club (user-level, own application)",
  "PATCH /club-registrations/:id": "own founding application (ownership checked)",
  "POST /club-registrations/:id/documents": "own founding application (ownership checked)",
  "DELETE /club-registrations/:id/documents/:docId": "own founding application (ownership checked)",
  "POST /club-registrations/:id/submit": "own founding application (ownership checked)",
  "POST /notifications/:id/read": "own notifications",
  "POST /notifications/:id/unread": "own notifications",
  "DELETE /notifications/:id": "own notifications",
  "POST /events/:id/rsvp": "own RSVP",
  "DELETE /events/:id/rsvp": "own RSVP",
  "POST /availability/slots": "own availability",
  "PATCH /availability/slots/:id": "own availability (ownership checked)",
  "DELETE /availability/slots/:id": "own availability (ownership checked)",
  "POST /availability/exceptions": "own availability",
  "PATCH /availability/exceptions/:id": "own availability (ownership checked)",
  "DELETE /availability/exceptions/:id": "own availability (ownership checked)",
  "PATCH /meetings/:id/invitees/me": "own accept/decline of an invitation",
  "POST /inventory-items/:id/loans": "self-service borrowing (switchable via club_settings.allow_self_loans)",
  "PATCH /inventory-items/:id/loans/:loanId": "return of the own loan (borrower or inventory:write)",
  "POST /inventory-items/:id/damage-reports": "self-service damage report",
  "POST /media": "image upload for damage reports / location photos (central media layer: magic bytes, EXIF strip, quota; the file stays unattached until a feature route claims it)",
  "PUT /club-members/me/photo": "own profile photo (minors are refused: the board sets them)",
  "DELETE /club-members/me/photo": "removing the own profile photo",
  "POST /club-members/invites/accept": "accepting an own invitation (session only; bound to the secret token and the account e-mail, no club membership needed)",
  "POST /club-exit-requests": "the member's own cancellation (recording a cancellation for others and exclusions need members:write, asserted in the B6 test)",
  "POST /club-exit-requests/:id/withdraw": "the requester withdraws the own request (the board may too; others get 403/404)",
};

/** Routes that may answer 404 instead of 403 (the resource is resolved/scoped before the permission check). */
const MAY_BE_404: Record<string, string> = {};

/** Read routes a plain mitglied may use but an external guest must NOT (guests: 403, or 404 where the resource is hidden). */
const GUEST_DENIED_READS: Array<[string, string]> = [
  ["GET", "/meetings"],
  ["GET", `/meetings/${"00000000-0000-4000-8000-000000000001"}`],
  ["GET", "/club-members"],
  ["GET", "/club-members?status=aktiv"],
];

/** Routes whose body validation runs before the permission check need a valid sample body. Default `{}`. */
const SOME_ID = "00000000-0000-4000-8000-000000000001";
const SAMPLE_BODIES: Record<string, unknown> = {
  "POST /club-members": { displayName: "Nobody", categoryKey: "aktiv" },
  "POST /club-members/:id/departments": { departmentId: SOME_ID },
  "POST /club-members/categories": { name: "Neue Kategorie" },
  "POST /club-members/transition-suggestions/apply": { memberIds: [SOME_ID] },
  "POST /club-members/:id/transition": { toStatus: "aktiv" },
  "POST /club-members/:id/invite": { email: "nobody@example.com" },
  "POST /club-exit-requests/:id/reject": { note: "Nein" },
  "POST /club-members/:id/roles": { roleType: "kassenwart" },
  "POST /club-members/:id/guardians": { guardianMemberId: SOME_ID },
  "POST /departments": { name: "Abteilung" },
  "PUT /club-info/:slug": { title: "Titel" },
  "POST /calendars": { name: "Kalender" },
  "POST /calendars/:id/visibility": { roleType: "trainer" },
  "POST /events": { calendarId: SOME_ID, title: "Termin", startsAt: "2030-01-01T10:00:00Z" },
  "POST /meetings": { type: "sonstige", title: "Treffen" },
  "POST /meetings/:id/invitees": { memberId: SOME_ID },
  "PATCH /meetings/:id/attendance": [{ memberId: SOME_ID, present: true }],
  "POST /meetings/:id/resolutions": { description: "Beschluss", votesFor: 1, votesAgainst: 0, votesAbstain: 0, result: "angenommen" },
  "PATCH /meetings/:id/resolutions/:rid": { result: "angenommen", correctionNote: "Korrektur" },
  "POST /locations": { name: "Ort" },
  "POST /locations/:id/key-holders": { memberId: SOME_ID },
  "POST /locations/:id/wifi": { label: "WLAN", ssid: "ssid", password: "pw" },
  "POST /locations/:id/links": { title: "Link", url: "https://example.com" },
  "POST /inventory-items": { name: "Zelt", condition: "gut" },
  "PATCH /inventory-items/:id/damage-reports/:reportId": { status: "behoben" },
};

function fillParams(path: string) {
  return path.replace(/:(\w+)(\{[^}]*\})?/g, (_m, name: string) => (name === "slug" ? "about" : randomUUID()));
}

describe("rights matrix (deny-by-default for the implicit role mitglied)", () => {
  const suffix = Date.now();
  let clubId: string;
  let founderId: string;
  let plainId: string;
  let guestId: string;
  let adminMemberId: string;
  let plainMemberId: string;
  let guestMemberId: string;
  let itemId: string;
  let cookieFounder: string;
  let cookiePlain: string;
  let cookieGuest: string;

  const req = (path: string, cookie: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(`${path}${path.includes("?") ? "&" : "?"}clubId=${clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  async function signUp(label: string) {
    const email = `matrix-${label}-${suffix}@example.com`;
    const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Matrix ${label}` } });
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
    const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
    return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
  }

  beforeAll(async () => {
    const founder = await signUp("founder");
    const plain = await signUp("plain");
    const guest = await signUp("guest");
    founderId = founder.userId;
    plainId = plain.userId;
    guestId = guest.userId;
    cookieFounder = founder.cookie;
    cookiePlain = plain.cookie;
    cookieGuest = guest.cookie;

    const club = await auth.api.createOrganization({ body: { name: `Matrix Club ${suffix}`, slug: `matrix-club-${suffix}`, userId: founderId } });
    clubId = club!.id;
    await auth.api.addMember({ body: { userId: plainId, organizationId: clubId, role: "member" } });
    await auth.api.addMember({ body: { userId: guestId, organizationId: clubId, role: "guest" } });

    const find = (userId: string) => db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, clubId), eq(m.userId, userId)) });
    adminMemberId = (await find(founderId))!.id;
    plainMemberId = (await find(plainId))!.id;
    guestMemberId = (await find(guestId))!.id;
    await db.insert(clubRoles).values({ memberId: adminMemberId, roleType: "vorsitz" });

    const [item] = await db.insert(inventoryItems).values({ clubId, name: "Matrix Zelt", condition: "gut" }).returning();
    itemId = item.id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of [founderId, plainId, guestId]) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("covers every router mounted in src/index.ts (the matrix cannot silently miss a router)", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const mounted = [...source.matchAll(/app\.route\("([^"]+)",\s*(\w+)\)/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    expect(MOUNTS.map(([path, name]) => `${path} ${name}`).sort()).toEqual(mounted);
  });

  it("only lists existing routes in the allowlists (no stale entries)", () => {
    const registered = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const key of [...Object.keys(SELF_SERVICE), ...Object.keys(MAY_BE_404), ...Object.keys(SAMPLE_BODIES)]) {
      expect(registered.has(key), `stale entry: ${key}`).toBe(true);
    }
  });

  it("has valid sessions for every test account (otherwise a 401 wall would make the matrix vacuous)", async () => {
    for (const [label, cookie] of [["founder", cookieFounder], ["plain", cookiePlain], ["guest", cookieGuest]] as const) {
      const res = await req("/club-members/me", cookie);
      expect(res.status, label).toBe(200);
    }
  });

  it("has no .all() handlers (they would escape the per-method matrix); only middleware may use ALL", () => {
    const catchAll = app.routes.filter((r) => r.method === "ALL" && !/\*$/.test(r.path));
    expect(catchAll.map((r) => r.path)).toEqual([]);
  });

  async function denialProblems(cookie: string): Promise<{ problems: string[]; checked: number }> {
    const writes = [...new Set(app.routes.filter((r) => WRITE_METHODS.includes(r.method)).map((r) => `${r.method} ${r.path}`))];
    expect(writes.length).toBeGreaterThan(50);

    const problems: string[] = [];
    let checked = 0;
    for (const key of writes) {
      if (key in SELF_SERVICE) continue;
      const [method, path] = key.split(" ");
      const res = await req(fillParams(path), cookie, { method, body: SAMPLE_BODIES[key] ?? {} });
      checked += 1;
      // adminGuard (src/middleware/session-guard.ts) answers an authenticated NON-admin with 401 "Admin privileges
      // required" (legacy contract of the admin dashboard); the sessions were verified above, so 401 cannot be a dead session.
      const allowed = key in MAY_BE_404 ? [403, 404] : path.startsWith("/admin") ? [401, 403] : [403];
      if (!allowed.includes(res.status)) {
        problems.push(`${key} -> ${res.status}${res.status === 422 ? " (validation ran first: add a valid body to SAMPLE_BODIES)" : ""}`);
      }
    }
    return { problems, checked };
  }

  it("denies every non-self-service writing route to a plain mitglied (403 only)", async () => {
    const { problems, checked } = await denialProblems(cookiePlain);
    expect(checked).toBeGreaterThan(40);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 120_000);

  it("denies every non-self-service writing route to an external guest too (403 only)", async () => {
    const { problems, checked } = await denialProblems(cookieGuest);
    expect(checked).toBeGreaterThan(40);
    expect(problems, problems.join("\n")).toEqual([]);
  }, 120_000);

  it("keeps the sensitive reads (meetings, member list) closed for an external guest", async () => {
    for (const [method, path] of GUEST_DENIED_READS) {
      const res = await req(path, cookieGuest, { method });
      expect([403, 404], `${method} ${path} -> ${res.status}`).toContain(res.status);
    }
    // ... while a plain member reads them, and the guest still reaches the own profile.
    expect((await req("/meetings", cookiePlain)).status).toBe(200);
    expect((await req("/club-members", cookiePlain)).status).toBe(200);
    expect((await req("/club-members/me", cookieGuest)).status).toBe(200);
  });

  it("denies the board-only exit-request variants and settings changes to a plain mitglied", async () => {
    const other = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, adminMemberId) }))!;
    const asBoard = await req("/club-exit-requests", cookiePlain, { method: "POST", body: { clubMemberId: other.id, kind: "cancellation" } });
    expect(asBoard.status).toBe(403);
    const exclusion = await req("/club-exit-requests", cookiePlain, { method: "POST", body: { clubMemberId: other.id, kind: "exclusion", reason: "x" } });
    expect(exclusion.status).toBe(403);
    expect((await req("/club-exit-requests", cookiePlain)).status).toBe(403);
    expect((await req("/club-settings", cookiePlain, { method: "PATCH", body: { allowSelfLoans: false } })).status).toBe(403);
  });

  it("is not vacuous: the same kind of request succeeds for a board role", async () => {
    const created = await req("/meetings", cookieFounder, { method: "POST", body: { type: "vorstandssitzung", title: "Matrix control" } });
    expect(created.status).toBe(201);
    const plainTry = await req("/meetings", cookiePlain, { method: "POST", body: { type: "vorstandssitzung", title: "Matrix control" } });
    expect(plainTry.status).toBe(403);
  });

  // --- implicit role mitglied -------------------------------------------------------------

  describe("implicit role mitglied", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
    const json = async (res: Response) => (await res.json()) as { data: any; implicit?: string[] };

    it("is part of CLUB_ROLE_TYPES with no permissions at all", () => {
      expect(CLUB_ROLE_TYPES).toContain("mitglied");
      expect(clubPermissionsFor(["mitglied"])).toEqual([]);
    });

    it("gives a plain member empty permissions and the board the new read permissions in /club-members/me", async () => {
      const plain = await json(await req("/club-members/me", cookiePlain));
      expect(plain.data.permissions).toEqual([]);
      const board = (await json(await req("/club-members/me", cookieFounder))).data.permissions as string[];
      expect(board).toEqual(expect.arrayContaining(["meetings:write", "meetings:read_board", "locations:write", "locations:read_access", "club_stats:read"]));
    });

    it("gives read permissions along the agreed roles", () => {
      for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "beisitzer"]) expect(clubPermissionsFor([role])).toContain("meetings:read_board");
      for (const role of ["kassenwart", "abteilungsleitung", "trainer", "erziehungsberechtigt"]) expect(clubPermissionsFor([role])).not.toContain("meetings:read_board");
      for (const role of ["vorsitz", "stellv_vorsitz", "schriftfuehrer", "abteilungsleitung"]) expect(clubPermissionsFor([role])).toContain("locations:read_access");
      for (const role of ["kassenwart", "beisitzer", "trainer", "erziehungsberechtigt"]) expect(clubPermissionsFor([role])).not.toContain("locations:read_access");
    });

    it("cannot be assigned (422) or revoked (409) and is listed as implicit, not as a deletable row", async () => {
      const assign = await req(`/club-members/${plainMemberId}/roles`, cookieFounder, { method: "POST", body: { roleType: "mitglied" } });
      expect(assign.status).toBe(422);

      const roles = await json(await req(`/club-members/${plainMemberId}/roles`, cookieFounder));
      expect(roles.data).toEqual([]);
      expect(roles.implicit).toEqual(["mitglied"]);

      // Even a stray DB row (should never exist) cannot be revoked through the API, and is not double-counted.
      const [stray] = await db.insert(clubRoles).values({ memberId: plainMemberId, roleType: "mitglied" }).returning();
      try {
        const revoke = await req(`/club-members/${plainMemberId}/roles/${stray.id}`, cookieFounder, { method: "DELETE" });
        expect(revoke.status).toBe(409);
        expect((await json(await req("/club-members/me", cookiePlain))).data.permissions).toEqual([]);
      } finally {
        await db.delete(clubRoles).where(eq(clubRoles.id, stray.id));
      }
    });

    it("does not apply to external guests but they stay without write permissions", async () => {
      const denied = await req("/meetings", cookieGuest, { method: "POST", body: { type: "sonstige", title: "Guest" } });
      expect(denied.status).toBe(403);
      expect(guestMemberId).toBeTruthy();
    });
  });

  // --- allow_self_loans (B8c) ------------------------------------------------------------------

  describe("allow_self_loans", () => {
    it("allows borrowing by default, rejects it with 403 when switched off, and exempts inventory:write", async () => {
      const ok = await req(`/inventory-items/${itemId}/loans`, cookiePlain, { method: "POST", body: {} });
      expect(ok.status).toBe(201);

      await db.insert(clubSettings).values({ clubId, allowSelfLoans: false });
      try {
        const denied = await req(`/inventory-items/${itemId}/loans`, cookiePlain, { method: "POST", body: {} });
        expect(denied.status).toBe(403);
        const board = await req(`/inventory-items/${itemId}/loans`, cookieFounder, { method: "POST", body: {} });
        expect(board.status).toBe(201);
        // Damage reports stay available.
        const damage = await req(`/inventory-items/${itemId}/damage-reports`, cookiePlain, { method: "POST", body: { description: "Loch im Zelt" } });
        expect(damage.status).toBe(201);
      } finally {
        await db.delete(clubSettings).where(eq(clubSettings.clubId, clubId));
      }
      const again = await req(`/inventory-items/${itemId}/loans`, cookiePlain, { method: "POST", body: {} });
      expect(again.status).toBe(201);
    });

    it("lets only the borrower or inventory:write return a loan", async () => {
      const loans = (await (await req(`/inventory-items/${itemId}/loans`, cookieFounder)).json()) as { data: Array<{ id: string; memberId: string; returnedAt: string | null }> };
      const open = loans.data.find((l) => l.memberId === plainMemberId && !l.returnedAt)!;
      const other = await signUp("other");
      await auth.api.addMember({ body: { userId: other.userId, organizationId: clubId, role: "member" } });
      try {
        const denied = await req(`/inventory-items/${itemId}/loans/${open.id}`, other.cookie, { method: "PATCH", body: {} });
        expect(denied.status).toBe(403);
        const own = await req(`/inventory-items/${itemId}/loans/${open.id}`, cookiePlain, { method: "PATCH", body: {} });
        expect(own.status).toBe(200);
      } finally {
        await db.delete(user).where(eq(user.id, other.userId));
      }
    });
  });

  // --- B16 bugfixes (verification) -----------------------------------------------------------------

  describe("B16 bug fixes", () => {
    it("rejects the founding role schriftfuehrer (it lacks roles:write, so the approval would fail)", async () => {
      const res = await req("/club-registrations", cookiePlain, {
        method: "POST",
        body: {
          clubName: "Schrift Verein",
          legalForm: "nicht_eingetragen",
          street: "Weg 1",
          postalCode: "63571",
          city: "Gelnhausen",
          claimedRole: "schriftfuehrer",
        },
      });
      expect(res.status).toBe(422);
    });

    it("keeps the member number when a Schriftführer (members:write, no read_sensitive) saves a member", async () => {
      const secretary = await signUp("secretary");
      const account = (await auth.api.addMember({ body: { userId: secretary.userId, organizationId: clubId, role: "member" } }))!;
      await db.insert(clubRoles).values({ memberId: account.id, roleType: "schriftfuehrer" });
      try {
        const before = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, plainMemberId) });
        expect(before!.memberNumber).toBeTruthy();
        const res = await req(`/club-members/${before!.id}`, secretary.cookie, { method: "PATCH", body: { city: "Neustadt" } });
        expect(res.status).toBe(200);
        const after = await db.query.clubMembers.findFirst({ where: and(eq(clubMembers.id, before!.id)) });
        expect(after!.memberNumber).toBe(before!.memberNumber);
        expect(after!.city).toBe("Neustadt");
      } finally {
        await db.delete(user).where(eq(user.id, secretary.userId));
      }
    });

    it("does not return e-mail addresses of other members to a plain member in GET /club-members", async () => {
      const res = await req("/club-members", cookiePlain);
      expect(res.status).toBe(200);
      const rows = ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
      expect(rows.length).toBeGreaterThan(1);
      const founderEmail = `matrix-founder-${suffix}@example.com`;
      expect(JSON.stringify(rows)).not.toContain(founderEmail);
    });
  });
});
