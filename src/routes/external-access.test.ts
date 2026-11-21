import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { auth } from "../auth/auth.js";
import { member } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubExternalInvites } from "../db/schema/external-access.js";
import { locations } from "../db/schema/locations.js";
import { sponsors } from "../db/schema/sponsors.js";
import { ASSIGNABLE_ROLE_TYPES } from "../lib/club-permissions.js";
import { createExternalInvite, externalPathAllowed, isExternalOnly } from "../lib/external-access.js";
import { clubMemberRoutes } from "./club-members.js";
import { externalAccessRoutes, externalRoutes } from "./external-access.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { sponsorRoutes } from "./sponsors.js";

vi.mock("../lib/email.js", () => ({ sendEmail: async () => undefined }));

/**
 * External logins (Wave 15 B2): invitation (e-mail binding, single use, revocation), the resulting guest membership with the
 * external role, the sponsor link, the self view (own sponsor without notes, assignments with hidden details until they start)
 * and the central boundary (everything else 403 `external_role_restricted`). The sweep over every route is in the rights matrix.
 */

const app = new Hono();
app.route("/external-access", externalAccessRoutes);
app.route("/external", externalRoutes);
app.route("/club-members", clubMemberRoutes);
app.route("/sponsors", sponsorRoutes);
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const json = async (res: Response) => (await res.json()) as any;

describe("external access helpers (pure)", () => {
  it("treats only guests with nothing but external roles as external-only", () => {
    expect(isExternalOnly("guest", ["sponsor"])).toBe(true);
    expect(isExternalOnly("guest", ["sponsor", "dienstleister"])).toBe(true);
    expect(isExternalOnly("guest", ["sponsor", "erziehungsberechtigt"])).toBe(false);
    expect(isExternalOnly("member", ["mitglied", "sponsor"])).toBe(false);
    expect(isExternalOnly("guest", [])).toBe(false);
  });
  it("allows only the own view, own profile and own inbox", () => {
    expect(externalPathAllowed("GET", "/external/me")).toBe(true);
    expect(externalPathAllowed("GET", "/club-members/me")).toBe(true);
    expect(externalPathAllowed("PATCH", "/club-members/me")).toBe(false);
    expect(externalPathAllowed("GET", "/club-members")).toBe(false);
    expect(externalPathAllowed("GET", "/club-members/me/data-export")).toBe(false);
    expect(externalPathAllowed("POST", "/club-inbox/abc/read")).toBe(true);
    expect(externalPathAllowed("GET", "/externalx")).toBe(false);
    expect(externalPathAllowed("GET", "/sponsors")).toBe(false);
  });
  it("keeps the external roles out of the roles API", () => {
    expect(ASSIGNABLE_ROLE_TYPES as readonly string[]).not.toContain("sponsor");
    expect(ASSIGNABLE_ROLE_TYPES as readonly string[]).not.toContain("dienstleister");
  });
});

describe("external access API", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let sponsorUser: Account;
  let providerUser: Account;
  let stranger: Account;
  let sponsorId: string;
  let locationId: string;
  const emails = { sponsor: `ext-sponsor-${suffix}@example.com`, provider: `ext-provider-${suffix}@example.com` };

  beforeAll(async () => {
    club = await createClub("external", suffix, { kasse: "kassenwart", plain: null });
    sponsorUser = await signUpAndVerify(emails.sponsor, "Sabine Sponsor");
    providerUser = await signUpAndVerify(emails.provider, "Paul Putz");
    stranger = await signUpAndVerify(`ext-stranger-${suffix}@example.com`, "Fremd");
    const [s] = await db.insert(sponsors).values({ clubId: club.clubId, name: "Sponsor GmbH", notes: "GEHEIM-INTERN", visibility: "oeffentlich" }).returning();
    sponsorId = s!.id;
    const [loc] = await db.insert(locations).values({ clubId: club.clubId, name: "Sporthalle", address: "Hallenweg 1", accessNote: "Code 1234 (intern)" }).returning();
    locationId = loc!.id;
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId], [...club.userIds, sponsorUser.userId, providerUser.userId, stranger.userId]);
    await closeDatabase();
  });

  it("is board-only (roles:write)", async () => {
    for (const who of [club.members.plain!, club.members.kasse!]) {
      expect((await call(who, "/external-access", { clubId: club.clubId })).status).toBe(403);
      expect((await call(who, "/external-access/invites", { method: "POST", clubId: club.clubId, body: { email: "x@example.com", roleType: "sponsor", displayName: "X" } })).status).toBe(403);
    }
  });

  it("invites by e-mail and lists the invitation", async () => {
    const res = await call(club.founder, "/external-access/invites", { method: "POST", clubId: club.clubId, body: { email: emails.sponsor, roleType: "sponsor", displayName: "Sabine Sponsor", sponsorId } });
    expect(res.status).toBe(201);
    expect((await json(res)).data).toMatchObject({ roleType: "sponsor", status: "pending", sponsor: { id: sponsorId, name: "Sponsor GmbH" }, emailSent: expect.any(Boolean) });
    expect((await call(club.founder, "/external-access/invites", { method: "POST", clubId: club.clubId, body: { email: emails.sponsor, roleType: "mitglied", displayName: "X" } })).status).toBe(422);
    const list = (await json(await call(club.founder, "/external-access", { clubId: club.clubId }))).data;
    expect(list.invites.length).toBe(1);
    expect(list.accounts).toEqual([]);
  });

  it("binds the token to the verified e-mail, links the sponsor and creates a restricted guest login", async () => {
    const { token } = await createExternalInvite({ clubId: club.clubId, email: emails.sponsor, roleType: "sponsor", displayName: "Sabine Sponsor", sponsorId, createdBy: (await db.query.member.findFirst({ where: and(eq(member.organizationId, club.clubId), eq(member.userId, club.founder.userId)) }))!.id });
    const preview = await json(await call(stranger, "/external-access/invites/preview", { method: "POST", body: { token } }));
    expect(preview.data).toMatchObject({ roleType: "sponsor", emailMatches: false, invitedEmail: expect.stringMatching(/^e\*\*\*@/) });
    expect((await call(stranger, "/external-access/invites/accept", { method: "POST", body: { token } })).status).toBe(403);

    const accepted = await call(sponsorUser, "/external-access/invites/accept", { method: "POST", body: { token } });
    expect(accepted.status).toBe(200);
    const { memberId } = (await json(accepted)).data;
    const account = await db.query.member.findFirst({ where: eq(member.id, memberId) });
    expect(account!.role).toBe("guest");
    expect((await db.select().from(clubRoles).where(eq(clubRoles.memberId, memberId))).map((r) => r.roleType)).toEqual(["sponsor"]);
    const row = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, memberId) });
    expect(row).toMatchObject({ status: "interessent", memberNumber: null });
    const [s] = await db.select().from(sponsors).where(eq(sponsors.id, sponsorId));
    expect(s!.linkedMemberId).toBe(memberId);
    // Single use.
    expect((await call(sponsorUser, "/external-access/invites/accept", { method: "POST", body: { token } })).status).toBe(404);
  });

  it("shows the sponsor only the own profile (no notes) and nothing of the club's members", async () => {
    const me = await call(sponsorUser, "/external/me", { clubId: club.clubId });
    expect(me.status).toBe(200);
    const text = await me.clone().text();
    const data = (await json(me)).data;
    expect(data).toMatchObject({ externalOnly: true, roleTypes: ["sponsor"], sponsors: [{ id: sponsorId, name: "Sponsor GmbH", status: "aktiv" }], assignments: [] });
    expect(text).not.toContain("GEHEIM-INTERN");
    for (const path of ["/club-members", "/sponsors", `/club-members/${data.sponsors[0].id}`]) {
      const res = await call(sponsorUser, path, { clubId: club.clubId });
      expect(res.status, path).toBe(403);
      expect((await json(res)).error.details.code).toBe("external_role_restricted");
    }
    expect((await call(sponsorUser, "/club-members/me", { clubId: club.clubId })).status).toBe(200);
  });

  it("keeps Better Auth's organization member/invitation endpoints closed for external logins, guests and plain members", async () => {
    const authCall = (who: Account, path: string, init: { method?: string; body?: unknown } = {}) =>
      app.request(`/api/auth/organization/${path}`, { method: init.method ?? "GET", headers: { cookie: who.cookie, "content-type": "application/json", origin: process.env.WEB_ORIGIN ?? "http://localhost:3001" }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const gated = [`list-members?organizationId=${club.clubId}`, `get-full-organization?organizationId=${club.clubId}`, `list-invitations?organizationId=${club.clubId}`, `get-active-member?organizationId=${club.clubId}`];
    for (const who of [sponsorUser, club.members.plain!, club.members.kasse!]) {
      for (const path of gated) {
        const res = await authCall(who, path);
        expect(res.status, path).toBe(403);
        expect(await res.text()).not.toContain("@example.com");
      }
      // Without an explicit id the active organization is used; still closed.
      expect((await authCall(who, "list-members")).status).toBe(403);
      expect((await authCall(who, "get-full-organization", { method: "GET" })).status).toBe(403);
    }
    // The board (members:write) keeps access; self-service paths stay open.
    expect((await authCall(club.founder, `list-members?organizationId=${club.clubId}`)).status).toBe(200);
    expect((await authCall(sponsorUser, "list")).status).toBe(200);
  });

  it("gives service providers time-boxed assignments; details only once the window started", async () => {
    const { token } = await createExternalInvite({ clubId: club.clubId, email: emails.provider, roleType: "dienstleister", displayName: "Paul Putz", sponsorId: null, createdBy: null });
    const { memberId } = (await json(await call(providerUser, "/external-access/invites/accept", { method: "POST", body: { token } }))).data;
    const now = Date.now();
    const iso = (h: number) => new Date(now + h * 3_600_000).toISOString();
    const sponsorMember = (await db.select().from(sponsors).where(eq(sponsors.id, sponsorId)))[0]!.linkedMemberId!;
    expect((await call(club.founder, `/external-access/accounts/${sponsorMember}/assignments`, { method: "POST", clubId: club.clubId, body: { title: "X", validFrom: iso(-1), validUntil: iso(1) } })).status).toBe(422);
    const bad = await call(club.founder, `/external-access/accounts/${memberId}/assignments`, { method: "POST", clubId: club.clubId, body: { title: "X", locationId: "00000000-0000-4000-8000-000000000001", validFrom: iso(-1), validUntil: iso(1) } });
    expect((await json(bad)).error.details.code).toBe("unknown_location");
    for (const [title, from, until] of [["Reinigung jetzt", -1, 2], ["Wartung später", 48, 50], ["Vorbei", -10, -5]] as const) {
      const res = await call(club.founder, `/external-access/accounts/${memberId}/assignments`, { method: "POST", clubId: club.clubId, body: { title, note: "Schlüssel im Kasten", locationId, validFrom: iso(from), validUntil: iso(until) } });
      expect(res.status).toBe(201);
    }
    const data = (await json(await call(providerUser, "/external/me", { clubId: club.clubId }))).data;
    expect(data.roleTypes).toEqual(["dienstleister"]);
    expect(data.assignments.map((a: { title: string }) => a.title)).toEqual(["Reinigung jetzt", "Wartung später"]);
    expect(data.assignments[0]).toMatchObject({ active: true, note: "Schlüssel im Kasten", location: { id: locationId, name: "Sporthalle", address: "Hallenweg 1" } });
    expect(data.assignments[1]).toMatchObject({ active: false, note: null, location: null });
    expect(JSON.stringify(data)).not.toContain("Code 1234");
    // The board sees everything.
    const accounts = (await json(await call(club.founder, "/external-access", { clubId: club.clubId }))).data.accounts;
    expect(accounts.map((a: { roleTypes: string[] }) => a.roleTypes[0]).sort()).toEqual(["dienstleister", "sponsor"]);
  });

  it("revokes invitations and ends access (membership removed when nothing else is left)", async () => {
    const created = await json(await call(club.founder, "/external-access/invites", { method: "POST", clubId: club.clubId, body: { email: `ext-later-${suffix}@example.com`, roleType: "dienstleister", displayName: "Später" } }));
    expect((await call(club.founder, `/external-access/invites/${created.data.id}`, { method: "DELETE", clubId: club.clubId })).status).toBe(204);
    expect((await call(club.founder, `/external-access/invites/${created.data.id}`, { method: "DELETE", clubId: club.clubId })).status).toBe(409);
    const [inv] = await db.select().from(clubExternalInvites).where(eq(clubExternalInvites.id, created.data.id));
    expect(inv!.revokedAt).not.toBeNull();

    const linked = (await db.select().from(sponsors).where(eq(sponsors.id, sponsorId)))[0]!.linkedMemberId!;
    expect((await call(club.founder, `/external-access/accounts/${linked}`, { method: "DELETE", clubId: club.clubId })).status).toBe(204);
    expect(await db.query.member.findFirst({ where: eq(member.id, linked) })).toBeUndefined();
    expect((await db.select().from(sponsors).where(eq(sponsors.id, sponsorId)))[0]!.linkedMemberId).toBeNull();
    expect((await call(sponsorUser, "/external/me", { clubId: club.clubId })).status).toBe(404);
    // A regular member is never an "external account" for this route.
    const plainMember = await db.query.member.findFirst({ where: and(eq(member.organizationId, club.clubId), eq(member.userId, club.members.plain!.userId)) });
    expect((await call(club.founder, `/external-access/accounts/${plainMember!.id}`, { method: "DELETE", clubId: club.clubId })).status).toBe(404);
  });
});
