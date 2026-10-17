import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberInvites } from "../db/schema/club-member-invites.js";
import { clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { toAppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { pool } from "../db/client.js";
import { accountLinkLockKey, ensureClubMember } from "../lib/club-members.js";
import { inviteLinkContext } from "../lib/invite-context.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { departments } from "../db/schema/departments.js";
import { clubExitRequests } from "../db/schema/club-exit-requests.js";
import { clubMemberDepartments } from "../db/schema/club-members.js";

const sent = vi.hoisted(() => ({ mails: [] as Array<{ to: string; subject: string; html: string }>, fail: false, hang: false }));
vi.mock("../lib/email.js", () => ({
  sendEmail: async (mail: { to: string; subject: string; html: string }) => {
    if (sent.hang) return new Promise<void>(() => undefined);
    if (sent.fail) throw new Error(`SMTP refused ${mail.to}`);
    sent.mails.push(mail);
  },
}));

const { clubMemberRoutes } = await import("./club-members.js");

/** Wave 7 B4: account linking by e-mail invitation (token lifecycle, race, scoping) and unlinking. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  // eslint-disable-next-line no-console
  if (appError.status >= 500) console.error("[test] 500 caused by", err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; email: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string): Promise<Actor> {
  const email = `inv-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Inv ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0], email };
}
let club: string;
let otherClub: string;
function call(who: { cookie: string } | null, url: string, init: { method?: string; body?: object; clubId?: string | null } = {}) {
  const clubId = init.clubId === undefined ? club : init.clubId;
  const withClub = clubId ? `${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}` : url;
  return app.request(withClub, {
    method: init.method ?? "GET",
    headers: { ...(who ? { cookie: who.cookie } : {}), "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}
const data = async (res: Response) => ((await res.json()) as Json).data as Json;
const body = async (res: Response) => (await res.json()) as Json;
const tokenFrom = (html: string) => decodeURIComponent(/einladung\?token=([^"&\s]+)/.exec(html)![1]!);

describe("account linking by invitation (B4)", () => {
  let founder: Actor;
  let founderMemberId: string;
  let plain: Actor;
  let boards: Actor[] = [];
  let outsider: Actor; // founder of another club
  const userIds: string[] = [];

  async function join(label: string, clubRole?: string) {
    const s = await signUp(label);
    userIds.push(s.userId);
    const account = (await auth.api.addMember({ body: { userId: s.userId, organizationId: club, role: "member" } }))!;
    if (clubRole) await db.insert(clubRoles).values({ memberId: account.id, roleType: clubRole });
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
    return { ...s, memberId: account.id, clubMemberId: row.id };
  }
  async function child(name = "Kim Kind"): Promise<Json> {
    const res = await call(founder, "/club-members", { method: "POST", body: { displayName: name, categoryKey: "jugend" } });
    expect(res.status).toBe(201);
    return data(res);
  }
  const stored = (id: string) => db.query.clubMembers.findFirst({ where: eq(clubMembers.id, id) }).then((r) => r!);
  const invite = (who: Actor, id: string, email: string) => call(who, `/club-members/${id}/invite`, { method: "POST", body: { email } });
  const preview = (who: Actor | null, token: string) => call(who, `/club-members/invites/preview?token=${encodeURIComponent(token)}`, { clubId: null });
  const accept = (who: Actor | null, token: string) => call(who, "/club-members/invites/accept", { method: "POST", body: { token }, clubId: null });
  /** Invites `email` for a new member without account and returns the plain token from the (captured) mail. */
  let rotation = 0;
  async function invited(email: string, name?: string) {
    const c = await child(name);
    // invitation creation is limited per user (20/hour): rotate the board members so the test setup never hits it
    const res = await invite(boards[rotation++ % boards.length]!, c.id, email);
    expect(res.status).toBe(201);
    return { clubMemberId: c.id as string, token: tokenFrom(sent.mails.at(-1)!.html), inviteId: (await data(res)).id as string };
  }

  beforeAll(async () => {
    const f = await signUp("founder");
    const o = await signUp("outsider");
    userIds.push(f.userId, o.userId);
    club = (await auth.api.createOrganization({ body: { name: `Invite Club ${suffix}`, slug: `inv-${suffix}`, userId: f.userId } }))!.id;
    otherClub = (await auth.api.createOrganization({ body: { name: `Invite Other ${suffix}`, slug: `inv-other-${suffix}`, userId: o.userId } }))!.id;
    founderMemberId = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, f.userId)) }))!.id;
    await db.insert(clubRoles).values({ memberId: founderMemberId, roleType: "vorsitz" });
    const om = (await db.query.member.findFirst({ where: and(eq(member.organizationId, otherClub), eq(member.userId, o.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: om.id, roleType: "vorsitz" });
    founder = f;
    outsider = o;
    plain = await join("plain");
    boards = await Promise.all([join("board1", "schriftfuehrer"), join("board2", "schriftfuehrer"), join("board3", "stellv_vorsitz"), join("board4", "stellv_vorsitz")]);
  }, 60_000);

  beforeEach(() => {
    sent.mails.length = 0;
    sent.fail = false;
    sent.hang = false;
  });

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, club));
    await db.delete(organization).where(eq(organization.id, otherClub));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("creating an invitation", () => {
    it("needs members:write, a valid address and a member without account", async () => {
      const c = await child();
      expect((await invite(plain, c.id, "x@example.com")).status).toBe(403);
      expect((await call(founder, `/club-members/${c.id}/invite`, { method: "POST", body: { email: "no-email" } })).status).toBe(422);
      expect((await call(founder, `/club-members/${c.id}/invite`, { method: "POST", body: {} })).status).toBe(422);
      const withAccount = await invite(founder, plain.userId === founder.userId ? c.id : (await db.query.clubMembers.findFirst({ where: eq(clubMembers.lastUserId, plain.userId) }))!.id, "x@example.com");
      expect(withAccount.status).toBe(409);
      expect(sent.mails).toHaveLength(0);
    });

    it("sends a German mail with the link, stores only a hash, never returns the token, and audits without the address", async () => {
      const c = await child("Anna <b>Schmidt</b>");
      const email = `Invitee-Mail-${suffix}@Example.com`;
      const res = await invite(founder, c.id, email);
      expect(res.status).toBe(201);
      const out = await data(res);
      expect(out).toMatchObject({ clubMemberId: c.id, email: email.toLowerCase(), status: "pending", emailSent: true });
      expect(JSON.stringify(out)).not.toMatch(/token/i);
      const ttl = new Date(out.expiresAt).getTime() - Date.now();
      expect(ttl).toBeGreaterThan(13.9 * 86_400_000);
      expect(ttl).toBeLessThan(14.1 * 86_400_000);

      expect(sent.mails).toHaveLength(1);
      const mail = sent.mails[0]!;
      expect(mail.to).toBe(email.toLowerCase());
      expect(mail.html).toContain("lädt dich ein");
      expect(mail.html).toContain(`Invite Club ${suffix}`);
      expect(mail.html).not.toContain("<b>Schmidt</b>");
      expect(mail.html).toContain("&lt;b&gt;Schmidt&lt;/b&gt;");
      expect(mail.html).toMatch(/http:\/\/localhost:3001\/einladung\?token=[A-Za-z0-9_-]{43}/);

      const token = tokenFrom(mail.html);
      expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
      const row = (await db.query.clubMemberInvites.findFirst({ where: eq(clubMemberInvites.clubMemberId, c.id) }))!;
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.tokenHash).not.toContain(token);
      const rows = await db.select().from(clubMemberInvites);
      expect(JSON.stringify(rows)).not.toContain(token);
      const audit = await db.select().from(auditLog).where(eq(auditLog.subjectId, c.id));
      expect(audit.some((a) => a.eventType === "club_member.invite")).toBe(true);
      expect(JSON.stringify(audit)).not.toContain("invitee-mail");
    });

    it("a new invitation replaces the open one (one open invite per member); the old token dies", async () => {
      const first = await invited(`replace-${suffix}@example.com`);
      const reinvite = await invite(founder, first.clubMemberId, `replace-${suffix}@example.com`);
      expect(reinvite.status).toBe(201);
      const second = tokenFrom(sent.mails.at(-1)!.html);
      expect(second).not.toBe(first.token);
      const open = await db.select().from(clubMemberInvites).where(and(eq(clubMemberInvites.clubMemberId, first.clubMemberId), isNull(clubMemberInvites.acceptedAt)));
      expect(open).toHaveLength(1);
      const invitee = await signUp(`replace-${suffix}`.replace(`-${suffix}`, "")).catch(() => null);
      void invitee;
      const viewer = await signUp("replace-viewer");
      userIds.push(viewer.userId);
      expect((await preview(viewer, first.token)).status).toBe(404);
      expect((await preview(viewer, second)).status).toBe(200);
    });

    it("status for the board; revoking kills the token", async () => {
      const { clubMemberId, token } = await invited(`status-${suffix}@example.com`);
      expect((await call(plain, `/club-members/${clubMemberId}/invite`)).status).toBe(403);
      const status = await data(await call(founder, `/club-members/${clubMemberId}/invite`));
      expect(status).toMatchObject({ status: "pending", email: `status-${suffix}@example.com` });
      const revoke = await call(founder, `/club-members/${clubMemberId}/invite`, { method: "DELETE" });
      expect(revoke.status).toBe(204);
      expect((await call(founder, `/club-members/${clubMemberId}/invite`).then(data))).toBeNull();
      expect((await call(founder, `/club-members/${clubMemberId}/invite`, { method: "DELETE" })).status).toBe(404);
      const viewer = await signUp("status-viewer");
      userIds.push(viewer.userId);
      expect((await accept(viewer, token)).status).toBe(404);
    });

    it("mail problems never block the invitation and the address is not logged", async () => {
      sent.fail = true;
      const spy = vi.spyOn(logger, "error");
      try {
        const c = await child();
        const res = await invite(founder, c.id, `leaky-${suffix}@example.com`);
        expect(res.status).toBe(201);
        expect((await data(res)).emailSent).toBe(false);
        expect(await db.query.clubMemberInvites.findFirst({ where: eq(clubMemberInvites.clubMemberId, c.id) })).toBeTruthy();
        expect(spy).toHaveBeenCalled();
        expect(JSON.stringify(spy.mock.calls)).not.toContain("leaky-");
      } finally {
        spy.mockRestore();
      }
    });

    it("is scoped to the club: another club's board gets 404 for status, invite, revoke and unlink", async () => {
      const c = await child();
      for (const [method, path, payload] of [
        ["POST", `/club-members/${c.id}/invite`, { email: "x@example.com" }],
        ["GET", `/club-members/${c.id}/invite`, undefined],
        ["DELETE", `/club-members/${c.id}/invite`, undefined],
        ["POST", `/club-members/${c.id}/unlink`, {}],
      ] as const) {
        expect((await call(outsider, path, { method, body: payload, clubId: otherClub })).status, `${method} ${path}`).toBe(404);
      }
    });

    it("refuses members who left", async () => {
      const c = await child();
      expect((await call(founder, `/club-members/${c.id}/transition`, { method: "POST", body: { toStatus: "ausgetreten" } })).status).toBe(200);
      expect((await invite(founder, c.id, "left@example.com")).status).toBe(409);
    });
  });

  describe("preview", () => {
    it("needs a session; shows club name, masked member name and masked address; 404 for anything unusable", async () => {
      const email = `preview-${suffix}@example.com`;
      const { token, clubMemberId } = await invited(email, "Max Mustermann");
      expect((await preview(null, token)).status).toBe(401);

      const viewer = await signUp("preview-viewer");
      userIds.push(viewer.userId);
      const ok = await data(await preview(viewer, token));
      expect(ok).toMatchObject({ clubName: `Invite Club ${suffix}`, memberName: "Max M.", invitedEmail: "p***@example.com", emailMatches: false });
      expect(JSON.stringify(ok)).not.toContain("Mustermann");
      expect(JSON.stringify(ok)).not.toContain(email);

      expect((await preview(viewer, "x".repeat(43))).status).toBe(404);
      expect((await preview(viewer, "short")).status).toBe(422);

      await db.update(clubMemberInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(clubMemberInvites.clubMemberId, clubMemberId));
      expect((await preview(viewer, token)).status).toBe(404);
    });
  });

  describe("preview via POST (token in the body) and resend", () => {
    const previewPost = (who: Actor | null, token: string) => call(who, "/club-members/invites/preview", { method: "POST", body: { token }, clubId: null });

    it("POST preview answers like the deprecated GET and needs a session", async () => {
      const invitee = await signUp("preview-post");
      userIds.push(invitee.userId);
      const { token } = await invited(invitee.email, "Pia Post");
      const viaPost = await previewPost(invitee, token);
      expect(viaPost.status).toBe(200);
      const viaGet = await preview(invitee, token);
      expect(viaGet.headers.get("deprecation")).toBe("true");
      const postData = await data(viaPost);
      expect(postData).toEqual(await data(viaGet));
      expect(postData).toMatchObject({ memberName: "Pia P.", emailMatches: true });
      expect((await previewPost(null, token)).status).toBe(401);
      expect((await previewPost(invitee, "x".repeat(43))).status).toBe(404);
      expect((await previewPost(invitee, "short")).status).toBe(422);
    });

    it("resend revokes the open invite, issues a new token to the same address and mails it", async () => {
      const invitee = await signUp("resend");
      userIds.push(invitee.userId);
      const { token, clubMemberId, inviteId } = await invited(invitee.email);
      sent.mails.length = 0;
      const res = await call(boards[0]!, `/club-members/${clubMemberId}/invite/resend`, { method: "POST" });
      expect(res.status).toBe(201);
      const out = await data(res);
      expect(out).toMatchObject({ clubMemberId, status: "pending", email: invitee.email, emailSent: true });
      expect(out.id).not.toBe(inviteId);
      expect(JSON.stringify(out)).not.toContain("token");
      expect(sent.mails).toHaveLength(1);
      expect(sent.mails[0]!.to).toBe(invitee.email);
      const fresh = tokenFrom(sent.mails[0]!.html);
      expect(fresh).not.toBe(token);
      expect((await preview(invitee, token)).status).toBe(404);
      expect((await accept(invitee, fresh)).status).toBe(200);
    });

    it("resend also works for an expired invite; 404 without open invite; needs members:write; club scoped", async () => {
      const c = await child();
      expect((await call(boards[1]!, `/club-members/${c.id}/invite/resend`, { method: "POST" })).status).toBe(404);
      expect((await invite(boards[1]!, c.id, `resend-exp-${suffix}@example.com`)).status).toBe(201);
      await db.update(clubMemberInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(clubMemberInvites.clubMemberId, c.id));
      expect((await call(plain, `/club-members/${c.id}/invite/resend`, { method: "POST" })).status).toBe(403);
      expect((await call(outsider, `/club-members/${c.id}/invite/resend`, { method: "POST", clubId: otherClub })).status).toBe(404);
      const res = await call(boards[1]!, `/club-members/${c.id}/invite/resend`, { method: "POST" });
      expect(res.status).toBe(201);
      expect((await data(res)).status).toBe("pending");
    });

    it("resend shares the 20/hour limit with invitation creation and reports mail failures", async () => {
      const limited = await join("resend-limit", "schriftfuehrer");
      const c = await child();
      expect((await invite(limited, c.id, `resend-lim-${suffix}@example.com`)).status).toBe(201);
      sent.fail = true;
      const first = await call(limited, `/club-members/${c.id}/invite/resend`, { method: "POST" });
      expect(first.status).toBe(201);
      expect((await data(first)).emailSent).toBe(false);
      sent.fail = false;
      let tooMany = 0;
      for (let i = 0; i < 20; i++) {
        const r = await call(limited, `/club-members/${c.id}/invite/resend`, { method: "POST" });
        if (r.status === 429) tooMany += 1;
      }
      expect(tooMany).toBeGreaterThanOrEqual(1);
    });
  });

  describe("accepting", () => {
    it("links the existing member to the signed-in account (same row, same number), single use", async () => {
      const invitee = await signUp("accept-ok");
      userIds.push(invitee.userId);
      const { token, clubMemberId } = await invited(invitee.email, "Lena Link");
      const before = await stored(clubMemberId);
      const countBefore = (await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.clubId, club))).length;

      expect((await data(await preview(invitee, token))).emailMatches).toBe(true);
      const res = await accept(invitee, token);
      expect(res.status).toBe(200);
      const out = await data(res);
      expect(out).toMatchObject({ clubId: club, clubName: `Invite Club ${suffix}`, clubMemberId });

      const after = await stored(clubMemberId);
      expect(after).toMatchObject({ memberId: out.memberId, lastUserId: invitee.userId, memberNumber: before.memberNumber, displayName: "Lena Link", status: before.status });
      expect((await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.clubId, club))).length).toBe(countBefore); // no second row
      const account = (await db.query.member.findFirst({ where: eq(member.id, out.memberId) }))!;
      expect(account).toMatchObject({ organizationId: club, userId: invitee.userId, role: "member" });
      const invitesRow = (await db.query.clubMemberInvites.findFirst({ where: eq(clubMemberInvites.clubMemberId, clubMemberId) }))!;
      expect(invitesRow.acceptedAt).not.toBeNull();
      const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, clubMemberId));
      expect(history.some((h) => h.reason === "Konto verknüpft (Einladung)")).toBe(true);
      const audit = await db.select().from(auditLog).where(eq(auditLog.subjectId, clubMemberId));
      expect(audit.some((a) => a.eventType === "club_member.invite_accept")).toBe(true);

      // the new account works as this very member
      const me = await data(await call(invitee, "/club-members/me"));
      expect(me).toMatchObject({ id: clubMemberId, hasAccount: true, name: "Lena Link" });
      expect((await call(invitee, `/club-members/${clubMemberId}`).then(data)).memberId).toBe(out.memberId);

      // single use
      const reuse = await accept(invitee, token);
      expect([404, 409]).toContain(reuse.status);
      const other = await signUp("accept-reuse");
      userIds.push(other.userId);
      expect((await accept(other, token)).status).toBe(404);
    });

    it("the wrong account (e-mail mismatch) gets 403 and does not burn the invitation", async () => {
      const invitee = await signUp("accept-right");
      const stranger = await signUp("accept-wrong");
      userIds.push(invitee.userId, stranger.userId);
      const { token, clubMemberId } = await invited(invitee.email);
      expect((await accept(stranger, token)).status).toBe(403);
      expect((await stored(clubMemberId)).memberId).toBeNull();
      expect(await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, stranger.userId)) })).toBeUndefined();
      // comparison is case-insensitive; the rightful account can still accept
      await db.update(user).set({ email: invitee.email.toUpperCase() }).where(eq(user.id, invitee.userId));
      const ok = await accept(invitee, token);
      expect(ok.status).toBe(200);
    });

    it("an unverified account e-mail is not enough (403)", async () => {
      const invitee = await signUp("accept-unverified");
      userIds.push(invitee.userId);
      const { token } = await invited(invitee.email);
      await db.update(user).set({ emailVerified: false }).where(eq(user.id, invitee.userId));
      expect((await accept(invitee, token)).status).toBe(403);
      await db.update(user).set({ emailVerified: true }).where(eq(user.id, invitee.userId));
      expect((await accept(invitee, token)).status).toBe(200);
    });

    it("an account that already is a member (untouched own row) is merged into the invited row", async () => {
      const existing = await join("accept-merge");
      const { token, clubMemberId } = await invited(existing.email, "Mia Merge");
      await db.update(clubMembers).set({ phone: "0170 1", city: "Bonn", memberNumber: null }).where(eq(clubMembers.id, existing.clubMemberId));
      await db.update(clubMembers).set({ phone: "0170 2", memberNumber: "M-777" }).where(eq(clubMembers.id, clubMemberId));
      // a ward of the account row, a role and a guardian link must survive the merge
      const ward = await child("Wanda Ward");
      await db.insert(guardianLinks).values({ guardianMemberId: boards[0]!.memberId, wardClubMemberId: existing.clubMemberId });
      await db.insert(clubRoles).values({ memberId: existing.memberId, roleType: "trainer" });
      void ward;

      const res = await accept(existing, token);
      expect(res.status).toBe(200);
      expect(await data(res)).toMatchObject({ clubMemberId, memberId: existing.memberId, merged: true });

      const kept = await stored(clubMemberId);
      expect(kept).toMatchObject({ memberId: existing.memberId, lastUserId: existing.userId, displayName: "Mia Merge", memberNumber: "M-777", phone: "0170 2", city: "Bonn" });
      expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, existing.clubMemberId) })).toBeUndefined();
      expect((await db.query.clubRoles.findMany({ where: eq(clubRoles.memberId, existing.memberId) })).map((r) => r.roleType)).toContain("trainer");
      expect((await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, clubMemberId))).map((g) => g.guardianMemberId)).toEqual([boards[0]!.memberId]);
      expect(await db.select().from(member).where(and(eq(member.organizationId, club), eq(member.userId, existing.userId)))).toHaveLength(1);
      const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, clubMemberId));
      expect(history.some((h) => h.reason === "merged")).toBe(true);
      const audit = await db.select().from(auditLog).where(eq(auditLog.subjectId, clubMemberId));
      expect(audit.map((a) => a.eventType)).toEqual(expect.arrayContaining(["club_member.merge", "club_member.invite_accept"]));
      // the account now works as the invited member
      expect(await data(await call(existing, "/club-members/me"))).toMatchObject({ id: clubMemberId, name: "Mia Merge" });
      // single use / idempotent
      expect([404, 409]).toContain((await accept(existing, token)).status);
      expect((await stored(clubMemberId)).memberId).toBe(existing.memberId);
    });

    it("copies profile fields the invited row lacks and takes the number of the account row if the invited row has none", async () => {
      const existing = await join("accept-merge-copy");
      const { token, clubMemberId } = await invited(existing.email);
      await db.update(clubMembers).set({ phone: "0171 5", street: "Hauptstr. 1", memberNumber: "M-555", birthDate: "1990-04-05" }).where(eq(clubMembers.id, existing.clubMemberId));
      await db.update(clubMembers).set({ memberNumber: null }).where(eq(clubMembers.id, clubMemberId));
      expect((await accept(existing, token)).status).toBe(200);
      expect(await stored(clubMemberId)).toMatchObject({ phone: "0171 5", street: "Hauptstr. 1", memberNumber: "M-555", birthDate: "1990-04-05" });
    });

    it("an own row with its own data is NOT merged: 409 merge_conflict lists only the kinds, nothing is consumed", async () => {
      const existing = await join("accept-conflict");
      const { token, clubMemberId } = await invited(existing.email, "Carla Conflict");
      await db.update(clubMembers).set({ memberNumber: "SECRET-111", displayName: "Geheim Person" }).where(eq(clubMembers.id, existing.clubMemberId));
      await db.update(clubMembers).set({ memberNumber: "OTHER-222" }).where(eq(clubMembers.id, clubMemberId));
      const dep = (await db.insert(departments).values({ clubId: club, name: `Abt ${suffix}-c` }).returning())[0]!;
      await db.insert(clubMemberDepartments).values({ clubMemberId: existing.clubMemberId, departmentId: dep.id });
      await db.insert(clubMemberStatusHistory).values({ clubMemberId: existing.clubMemberId, fromStatus: "aktiv", toStatus: "ruhend", effectiveOn: "2026-01-01", reason: "x" });

      const res = await accept(existing, token);
      expect(res.status).toBe(409);
      const json = await body(res);
      expect(json.error.details.code).toBe("merge_conflict");
      expect(json.error.details.conflicts.sort()).toEqual(["departments", "member_number", "status_history"]);
      const text = JSON.stringify(json);
      for (const secret of ["SECRET-111", "OTHER-222", "Geheim", "Carla", "Conflict"]) expect(text).not.toContain(secret);
      expect((await stored(clubMemberId)).memberId).toBeNull();
      expect((await stored(existing.clubMemberId)).memberId).toBe(existing.memberId);
      expect((await db.query.clubMemberInvites.findFirst({ where: eq(clubMemberInvites.clubMemberId, clubMemberId) }))!.acceptedAt).toBeNull();
    });

    it("an open exit request on the own row also blocks the merge", async () => {
      const a = await join("accept-conflict-photo");
      const t1 = await invited(a.email);
      await db.update(clubMembers).set({ memberNumber: null }).where(eq(clubMembers.id, a.clubMemberId));
      await db.insert(clubExitRequests).values({ clubMemberId: a.clubMemberId, kind: "cancellation", requestedBy: a.memberId, requestedOn: "2026-10-01", status: "pending" });
      const res = await accept(a, t1.token);
      expect(res.status).toBe(409);
      expect((await body(res)).error.details.conflicts).toEqual(["exit_requests"]);
    });

    it("the e-mail binding is checked before any merge information is revealed", async () => {
      const existing = await join("accept-conflict-order");
      const other = await join("accept-conflict-order2");
      const { token } = await invited(existing.email);
      await db.update(clubMembers).set({ memberNumber: "ZZ-1" }).where(eq(clubMembers.id, other.clubMemberId));
      const res = await accept(other, token);
      expect(res.status).toBe(403);
      expect(JSON.stringify(await body(res))).not.toContain("merge");
    });

    it("parallel accepts of a merge: exactly one wins and exactly one row stays", async () => {
      const existing = await join("accept-merge-race");
      const { token, clubMemberId } = await invited(existing.email);
      await db.update(clubMembers).set({ memberNumber: null }).where(eq(clubMembers.id, existing.clubMemberId));
      const results = await Promise.all([accept(existing, token), accept(existing, token), accept(existing, token)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 200)) expect([404, 409]).toContain(r.status);
      expect(await db.select().from(clubMembers).where(eq(clubMembers.memberId, existing.memberId))).toHaveLength(1);
      expect((await stored(clubMemberId)).memberId).toBe(existing.memberId);
    });

    it("notifies the inviting board member by mail (name only), never fails the accept", async () => {
      const invitee = await signUp("accept-notify");
      userIds.push(invitee.userId);
      const board = boards[0]!;
      const c = await child("Nora Notify");
      expect((await invite(board, c.id, invitee.email)).status).toBe(201);
      const token = tokenFrom(sent.mails.at(-1)!.html);
      sent.mails.length = 0;
      expect((await accept(invitee, token)).status).toBe(200);
      await vi.waitFor(() => expect(sent.mails).toHaveLength(1));
      const mail = sent.mails[0]!;
      expect(mail.to).toBe(board.email);
      expect(mail.subject).toContain("Nora Notify");
      expect(mail.html).toContain("Nora Notify");
      expect(mail.html).not.toContain(token);
      expect(mail.html).not.toContain(invitee.email);

      // mail failure does not fail the accept
      const invitee2 = await signUp("accept-notify2");
      userIds.push(invitee2.userId);
      const c2 = await child("Otto Notify");
      expect((await invite(board, c2.id, invitee2.email)).status).toBe(201);
      const token2 = tokenFrom(sent.mails.at(-1)!.html);
      sent.fail = true;
      const logged = vi.spyOn(logger, "error");
      expect((await accept(invitee2, token2)).status).toBe(200);
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
      expect(JSON.stringify(logged.mock.calls)).not.toContain(board.email);
      logged.mockRestore();
    });

    it("no notification if the inviter lost board rights or was removed", async () => {
      const inviter = await join("accept-notify-gone", "schriftfuehrer");
      const invitee = await signUp("accept-notify-gone2");
      userIds.push(invitee.userId);
      const c = await child();
      expect((await invite(inviter, c.id, invitee.email)).status).toBe(201);
      const token = tokenFrom(sent.mails.at(-1)!.html);
      await db.delete(clubRoles).where(eq(clubRoles.memberId, inviter.memberId));
      sent.mails.length = 0;
      expect((await accept(invitee, token)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(sent.mails).toHaveLength(0);
    });

    it("no notification to an inviter who has left the club", async () => {
      const inviter = await join("accept-notify-left", "schriftfuehrer");
      const invitee = await signUp("accept-notify-left2");
      userIds.push(invitee.userId);
      const c = await child();
      expect((await invite(inviter, c.id, invitee.email)).status).toBe(201);
      const token = tokenFrom(sent.mails.at(-1)!.html);
      await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2026-01-01" }).where(eq(clubMembers.id, inviter.clubMemberId));
      sent.mails.length = 0;
      expect((await accept(invitee, token)).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(sent.mails).toHaveLength(0);
    });

    it("a hanging mail transport does not block the accept", async () => {
      const invitee = await signUp("accept-notify-hang");
      userIds.push(invitee.userId);
      const c = await child();
      expect((await invite(boards[2]!, c.id, invitee.email)).status).toBe(201);
      const token = tokenFrom(sent.mails.at(-1)!.html);
      sent.hang = true;
      const started = Date.now();
      expect((await accept(invitee, token)).status).toBe(200);
      expect(Date.now() - started).toBeLessThan(5000);
      // lock released: a second accept of the same account in the same club answers immediately (already linked)
      expect([404, 409]).toContain((await accept(invitee, token)).status);
    });

    it("an automatically formatted number of the own row is discarded, a manual one stays a conflict", async () => {
      const slugAbbr = `inv-${suffix}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
      const existing = await join("accept-merge-auto");
      const t = await invited(existing.email);
      const invitedBefore = await stored(t.clubMemberId);
      await db.update(clubMembers).set({ memberNumber: `${slugAbbr}-9001` }).where(eq(clubMembers.id, existing.clubMemberId));
      await db.update(clubMembers).set({ memberNumber: "MANUELL-1" }).where(eq(clubMembers.id, t.clubMemberId));
      void invitedBefore;
      expect((await accept(existing, t.token)).status).toBe(200);
      expect((await stored(t.clubMemberId)).memberNumber).toBe("MANUELL-1");
      const audit = await db.select().from(auditLog).where(eq(auditLog.subjectId, t.clubMemberId));
      const merge = audit.find((a) => a.eventType === "club_member.merge")!;
      expect(JSON.stringify(merge.payload)).toContain("own number discarded");
      expect(JSON.stringify(merge.payload)).not.toContain(`${slugAbbr}-9001`);

      const manual = await join("accept-merge-manual");
      const t2 = await invited(manual.email);
      await db.update(clubMembers).set({ memberNumber: "HANDGEMACHT" }).where(eq(clubMembers.id, manual.clubMemberId));
      const res = await accept(manual, t2.token);
      expect(res.status).toBe(409);
      expect((await body(res)).error.details.conflicts).toContain("member_number");
    });

    it("an external guest account is a merge conflict; a self-guardian link is removed", async () => {
      const guest = await join("accept-merge-guest");
      await db.update(member).set({ role: "guest" }).where(eq(member.id, guest.memberId));
      const t = await invited(guest.email);
      const res = await accept(guest, t.token);
      expect(res.status).toBe(409);
      expect((await body(res)).error.details.conflicts).toEqual(["guest_account"]);

      const self = await join("accept-merge-self");
      const t2 = await invited(self.email);
      await db.update(clubMembers).set({ memberNumber: null }).where(eq(clubMembers.id, self.clubMemberId));
      await db.insert(guardianLinks).values({ guardianMemberId: self.memberId, wardClubMemberId: self.clubMemberId });
      expect((await accept(self, t2.token)).status).toBe(200);
      expect(await db.select().from(guardianLinks).where(eq(guardianLinks.wardClubMemberId, t2.clubMemberId))).toHaveLength(0);
    });

    it("an expired invitation is refused (404), also directly after the TTL", async () => {
      const invitee = await signUp("accept-expired");
      userIds.push(invitee.userId);
      const { token, clubMemberId } = await invited(invitee.email);
      await db.update(clubMemberInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(clubMemberInvites.clubMemberId, clubMemberId));
      expect((await accept(invitee, token)).status).toBe(404);
      expect((await stored(clubMemberId)).memberId).toBeNull();
      // a fresh invite revives the path
      const again = await invite(founder, clubMemberId, invitee.email);
      expect(again.status).toBe(201);
      expect((await accept(invitee, tokenFrom(sent.mails.at(-1)!.html))).status).toBe(200);
    });

    it("needs a session", async () => {
      expect((await accept(null, "x".repeat(43))).status).toBe(401);
    });

    it("two parallel accepts of the same invitation: exactly one account membership and one link", async () => {
      const invitee = await signUp("race-same");
      userIds.push(invitee.userId);
      const { token, clubMemberId } = await invited(invitee.email);
      const results = await Promise.all([accept(invitee, token), accept(invitee, token), accept(invitee, token)]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 200)) expect([404, 409]).toContain(r.status);
      const accounts = await db.select().from(member).where(and(eq(member.organizationId, club), eq(member.userId, invitee.userId)));
      expect(accounts).toHaveLength(1);
      expect((await stored(clubMemberId)).memberId).toBe(accounts[0]!.id);
      expect(await db.select().from(clubMembers).where(eq(clubMembers.memberId, accounts[0]!.id))).toHaveLength(1);
    });

    it("two invitations to the same address accepted in parallel: one wins, the other stays open (one account per club)", async () => {
      const invitee = await signUp("race-two");
      userIds.push(invitee.userId);
      const a = await invited(invitee.email, "Kind A");
      const b = await invited(invitee.email, "Kind B");
      const results = await Promise.all([accept(invitee, a.token), accept(invitee, b.token)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await body(results.find((r) => r.status === 409)!)).error.details.code).toBe("merge_conflict");
      const accounts = await db.select().from(member).where(and(eq(member.organizationId, club), eq(member.userId, invitee.userId)));
      expect(accounts).toHaveLength(1);
      const linked = [await stored(a.clubMemberId), await stored(b.clubMemberId)].filter((r) => r.memberId !== null);
      expect(linked).toHaveLength(1);
      const loser = linked[0]!.id === a.clubMemberId ? b : a;
      expect((await db.query.clubMemberInvites.findFirst({ where: eq(clubMemberInvites.clubMemberId, loser.clubMemberId) }))!.acceptedAt).toBeNull();
    });

    it("a token of club A cannot be used to reach club B's data (the link only affects the invited member)", async () => {
      const invitee = await signUp("scoping");
      userIds.push(invitee.userId);
      const { token } = await invited(invitee.email);
      expect((await accept(invitee, token)).status).toBe(200);
      expect((await call(invitee, "/club-members/me", { clubId: otherClub })).status).toBe(404);
      expect(await db.query.member.findFirst({ where: and(eq(member.organizationId, otherClub), eq(member.userId, invitee.userId)) })).toBeUndefined();
    });
  });

  describe("unlinking", () => {
    async function linkedMember(label: string) {
      const invitee = await signUp(label);
      userIds.push(invitee.userId);
      const { token, clubMemberId } = await invited(invitee.email, `Name ${label}`);
      const out = await data(await accept(invitee, token));
      return { invitee, clubMemberId, accountId: out.memberId as string };
    }

    it("detaches the account but is NOT an exit: status and master data stay, last_user_id is kept", async () => {
      const { invitee, clubMemberId, accountId } = await linkedMember("unlink-ok");
      const before = await stored(clubMemberId);
      expect((await call(plain, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: {} })).status).toBe(403);

      const res = await call(founder, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: {} });
      expect(res.status).toBe(200);
      expect(await data(res)).toMatchObject({ id: clubMemberId, hasAccount: false, memberId: null, status: "aktiv", effectiveStatus: "aktiv", leftAt: null });

      const after = await stored(clubMemberId);
      expect(after).toMatchObject({ memberId: null, lastUserId: invitee.userId, status: before.status, leftAt: null, memberNumber: before.memberNumber });
      expect(after.accountUnlinkedAt).not.toBeNull();
      expect(await db.query.member.findFirst({ where: eq(member.id, accountId) })).toBeUndefined();
      expect((await call(invitee, "/club-members/me")).status).toBe(404);

      // the lazy closers (list, id resolution) must not turn it into an exit
      await call(founder, "/club-members");
      await call(founder, `/club-members/${clubMemberId}`);
      expect(await stored(clubMemberId)).toMatchObject({ status: "aktiv", leftAt: null });
      const history = await db.select().from(clubMemberStatusHistory).where(eq(clubMemberStatusHistory.clubMemberId, clubMemberId));
      expect(history.some((h) => h.reason === "Konto-Verknüpfung getrennt")).toBe(true);
      expect(history.some((h) => h.toStatus === "ausgetreten")).toBe(false);
      const audit = await db.select().from(auditLog).where(eq(auditLog.subjectId, clubMemberId));
      expect(audit.some((a) => a.eventType === "club_member.unlink")).toBe(true);

      // twice is a 409; the member can be invited again (e.g. the right account this time)
      expect((await call(founder, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: {} })).status).toBe(409);
      expect((await invite(founder, clubMemberId, `again-${suffix}@example.com`)).status).toBe(201);
    });

    it("a person who joins again afterwards gets a NEW row; the unlinked one is not reused", async () => {
      const { invitee, clubMemberId } = await linkedMember("unlink-rejoin");
      await call(founder, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: {} });
      const rejoined = (await auth.api.addMember({ body: { userId: invitee.userId, organizationId: club, role: "member" } }))!;
      const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, rejoined.id) }))!;
      expect(row.id).not.toBe(clubMemberId);
      expect((await stored(clubMemberId)).memberId).toBeNull();
    });

    it("refuses the own account, an owner account and (unless forced) an account with open loans", async () => {
      const founderRow = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, founderMemberId) }))!;
      expect((await call(founder, `/club-members/${founderRow.id}/unlink`, { method: "POST", body: {} })).status).toBe(409);
      const secretary = await join("unlink-secretary", "schriftfuehrer");
      const ownerTry = await call(secretary, `/club-members/${founderRow.id}/unlink`, { method: "POST", body: {} });
      expect(ownerTry.status).toBe(409);
      expect((await body(ownerTry)).error.message).toMatch(/owner/);

      const { clubMemberId, accountId } = await linkedMember("unlink-loan");
      const [item] = await db.insert(inventoryItems).values({ clubId: club, name: "Beamer Invite", condition: "gut" }).returning();
      await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: accountId });
      const blocked = await call(founder, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: {} });
      expect(blocked.status).toBe(409);
      expect(((await body(blocked)).error.details as Json)).toMatchObject({ code: "account_has_open_items", openLoans: 1, keys: 0 });
      expect((await stored(clubMemberId)).memberId).toBe(accountId);
      const forced = await call(founder, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: { force: true } });
      expect(forced.status).toBe(200);
    });

    it("a member without account cannot be unlinked (409)", async () => {
      const c = await child();
      expect((await call(founder, `/club-members/${c.id}/unlink`, { method: "POST", body: {} })).status).toBe(409);
    });
  });

  describe("review fixes", () => {
    async function linkedWith(label: string, roleType?: string) {
      const invitee = await signUp(label);
      userIds.push(invitee.userId);
      const { token, clubMemberId } = await invited(invitee.email, `Name ${label}`);
      const out = await data(await accept(invitee, token));
      if (roleType) await db.insert(clubRoles).values({ memberId: out.memberId, roleType });
      return { invitee, clubMemberId, accountId: out.memberId as string };
    }

    it("unlinking a board member needs roles:write (also with force); the warning lists what disappears", async () => {
      const secretary = await join("fix-secretary", "schriftfuehrer");
      const { clubMemberId } = await linkedWith("fix-board", "beisitzer");
      const denied = await call(secretary, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: { force: true } });
      expect(denied.status).toBe(403);
      expect(((await body(denied)).error.details as Json).code).toBe("board_protected");
      const warn = await call(founder, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: {} });
      expect(warn.status).toBe(409);
      expect(((await body(warn)).error.details as Json)).toMatchObject({ code: "account_has_open_items", roles: 1, openLoans: 0, keys: 0, guardianLinks: 0, departmentsLed: 0, eventRsvps: 0, meetingInvites: 0 });
      expect((await call(founder, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: { force: true } })).status).toBe(200);
    });

    it("guardian links and led departments are part of the warning", async () => {
      const { clubMemberId, accountId } = await linkedWith("fix-links");
      const kid = await child();
      await db.insert(guardianLinks).values({ guardianMemberId: accountId, wardClubMemberId: kid.id });
      await db.insert(departments).values({ clubId: club, name: `Abteilung ${suffix}`, leadMemberId: accountId });
      const warn = await call(founder, `/club-members/${clubMemberId}/unlink`, { method: "POST", body: {} });
      expect(warn.status).toBe(409);
      expect(((await body(warn)).error.details as Json)).toMatchObject({ guardianLinks: 1, departmentsLed: 1 });
    });

    it("the repair path ensureClubMember waits for an accept in progress instead of creating a competing row", async () => {
      const invitee = await signUp("fix-lock");
      userIds.push(invitee.userId);
      // account membership without club_members row, as it exists between addMember and the link
      const created = (await inviteLinkContext.run({ clubMemberId: "x" }, () => auth.api.addMember({ body: { userId: invitee.userId, organizationId: club, role: "member" } })))!;
      expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, created.id) })).toBeUndefined();

      const holder = await pool.connect();
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [accountLinkLockKey(club, invitee.userId)]);
      let done = false;
      const repair = ensureClubMember(db, created).then((row) => {
        done = true;
        return row;
      });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [accountLinkLockKey(club, invitee.userId)]);
      holder.release();
      expect((await repair).memberId).toBe(created.id);
    });

    it("an accept racing with the list repair still ends with exactly one linked row", async () => {
      const invitee = await signUp("fix-race");
      userIds.push(invitee.userId);
      const { token, clubMemberId } = await invited(invitee.email);
      const results = await Promise.all([accept(invitee, token), ...Array.from({ length: 6 }, () => call(founder, "/club-members?pageSize=100"))]);
      expect(results[0]!.status).toBe(200);
      const account = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, invitee.userId)) }))!;
      expect(await db.select().from(clubMembers).where(eq(clubMembers.memberId, account.id))).toHaveLength(1);
      expect((await stored(clubMemberId)).memberId).toBe(account.id);
    });
  });

  describe("rate limit", () => {
    it("limits invitation creation per user (20 per hour) with 429", async () => {
      const spammer = await join("spammer", "schriftfuehrer");
      const c = await child();
      let limited = 0;
      for (let i = 0; i < 22; i++) {
        const res = await invite(spammer, c.id, `spam-${i}-${suffix}@example.com`);
        if (res.status === 429) limited += 1;
        else expect(res.status).toBe(201);
      }
      expect(limited).toBeGreaterThanOrEqual(2);
    });
  });
});
