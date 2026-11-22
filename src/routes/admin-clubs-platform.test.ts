import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubRegistrations } from "../db/schema/club-registrations.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { handleEmailDelivery, notify } from "../lib/notify/index.js";
import { adminClubRoutes } from "./admin-clubs.js";
import { clubFormRoutes } from "./club-forms.js";
import { clubMemberRoutes } from "./club-members.js";
import { createClub, dropClubs, installErrorHandler, requester, signUpAndVerify, type Account } from "./forms-test-support.js";
import { myClubRoutes } from "./my-clubs.js";

/**
 * Platform admin tools (Wave 15 B7): club list/detail, suspension with mandatory reason (enforced by clubGuard, readable hint
 * for members), plan data (no billing), register check link. The sweep over EVERY clubGuard route lives in the rights matrix.
 */

vi.mock("../lib/email.js", () => ({ sendEmail: async () => undefined }));

const app = new Hono();
app.route("/admin", adminClubRoutes);
app.route("/club-members", clubMemberRoutes);
app.route("/my-clubs", myClubRoutes);
app.route("/club-forms", clubFormRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const json = async (res: Response) => (await res.json()) as any;

describe("admin clubs (Wave 15 B7)", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;
  let admin: Account;

  beforeAll(async () => {
    club = await createClub("platform", suffix, { plain: null });
    other = await createClub("platform-other", suffix);
    admin = await signUpAndVerify(`platform-admin-${suffix}@example.com`, "Platform Admin");
    await db.update(user).set({ role: "admin" }).where(eq(user.id, admin.userId));
    await db.insert(clubRegistrations).values({ userId: club.founder.userId, clubName: "Forms platform", legalForm: "ev", registerCourt: "Amtsgericht Wiesbaden", registerNumber: "VR 1234", street: "Weg 1", postalCode: "65183", city: "Wiesbaden", status: "approved", clubId: club.clubId });
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds, admin.userId]);
    await closeDatabase();
  });

  it("is admin-only", async () => {
    expect((await call(club.founder, "/admin/clubs")).status).toBe(401);
    expect((await call(club.founder, `/admin/clubs/${club.clubId}/suspend`, { method: "POST", body: { reason: "Missbrauch der Plattform" } })).status).toBe(401);
  });

  it("lists clubs with counts, status and plan; filters by name and status", async () => {
    const res = await call(admin, `/admin/clubs?q=${encodeURIComponent(`platform ${suffix}`)}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.total).toBe(1);
    expect(body.data[0]).toMatchObject({ clubId: club.clubId, slug: club.slug, memberCount: 2, accountCount: 2, status: "active", suspendedAt: null, plan: null, overMemberLimit: false });
    expect(body.data[0].lastActivityAt === null || typeof body.data[0].lastActivityAt === "string").toBe(true);
    expect((await json(await call(admin, `/admin/clubs?q=${suffix}&status=suspended`))).total).toBe(0);
  });

  it("shows the detail with the registration and a manual register check link", async () => {
    const detail = (await json(await call(admin, `/admin/clubs/${club.clubId}`))).data;
    expect(detail.registration).toMatchObject({ registerCourt: "Amtsgericht Wiesbaden", registerNumber: "VR 1234", status: "approved" });
    expect(detail.registerCheck).toEqual({ portalUrl: expect.stringMatching(/^https:\/\//), court: "Amtsgericht Wiesbaden", number: "VR 1234" });
    expect(detail.suspension).toBeNull();
    expect(Array.isArray(detail.auditExcerpt)).toBe(true);
    expect((await call(admin, "/admin/clubs/does-not-exist")).status).toBe(404);
  });

  it("suspends with a mandatory reason; every club route answers CLUB_SUSPENDED with the member note", async () => {
    expect((await call(admin, `/admin/clubs/${club.clubId}/suspend`, { method: "POST", body: { reason: "kurz" } })).status).toBe(422);
    const res = await call(admin, `/admin/clubs/${club.clubId}/suspend`, { method: "POST", body: { reason: "Hinweise auf Missbrauch, Klärung läuft", note: "Bitte wende dich an den Vorstand." } });
    expect(res.status).toBe(200);
    const detail = (await json(res)).data;
    expect(detail).toMatchObject({ status: "suspended", suspension: { reason: "Hinweise auf Missbrauch, Klärung läuft", note: "Bitte wende dich an den Vorstand.", suspendedBy: { userId: admin.userId } } });
    expect((await call(admin, `/admin/clubs/${club.clubId}/suspend`, { method: "POST", body: { reason: "Noch einmal sperren" } })).status).toBe(409);

    for (const who of [club.founder, club.members.plain!]) {
      const blocked = await call(who, "/club-members/me", { clubId: club.clubId });
      expect(blocked.status).toBe(403);
      const err = (await json(blocked)).error;
      expect(err.code).toBe("CLUB_SUSPENDED");
      expect(err.details).toMatchObject({ code: "club_suspended", note: "Bitte wende dich an den Vorstand." });
      expect(JSON.stringify(err)).not.toContain("Missbrauch");
    }
    // Strangers still learn nothing (404 before the suspension check); other clubs are untouched.
    expect((await call(other.founder, "/club-members/me", { clubId: club.clubId })).status).toBe(404);
    expect((await call(other.founder, "/club-members/me", { clubId: other.clubId })).status).toBe(200);
    // The public application form of a suspended club is gone (404); another club's form is still there.
    expect((await call(other.founder, `/club-forms/${club.slug}/aufnahme`)).status).toBe(404);
    expect((await call(club.founder, `/club-forms/${other.slug}/aufnahme`)).status).toBe(200);
    const mine = (await json(await call(club.founder, "/my-clubs"))).data;
    const row = mine.find((x: { clubId: string }) => x.clubId === club.clubId);
    expect(row).toMatchObject({ suspended: true, suspension: { since: expect.any(String), note: "Bitte wende dich an den Vorstand." } });
    expect(JSON.stringify(mine)).not.toContain("Missbrauch");
    expect(mine.find((x: { clubId: string }) => x.clubId === other.clubId)).toBeUndefined();
    expect((await json(await call(admin, `/admin/clubs?q=${suffix}&status=suspended`))).data.map((x: { clubId: string }) => x.clubId)).toEqual([club.clubId]);
  });

  it("sends nothing for a suspended club: new messages are dropped, queued mails skipped, reminders not scheduled", async () => {
    // A mail queued before the suspension (the club is suspended by the previous test).
    const [queued] = await db.insert(messageDeliveries).values({ clubId: club.clubId, channel: "email", status: "queued", address: "someone@example.com", eventKey: "test.suspended", refId: randomUUID(), content: { title: "x", body: "y" } as never }).returning();
    await handleEmailDelivery({ id: randomUUID(), type: "notify.email", payload: { deliveryId: queued!.id }, attempt: 1, maxAttempts: 3 });
    const [after] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, queued!.id));
    expect(after).toMatchObject({ status: "skipped", errorCode: "club_suspended" });

    const result = await notify({ clubId: club.clubId, class: "optional", eventKey: "test.suspended.new", refId: randomUUID(), audience: { all: true }, content: { title: "Hallo", body: "Welt" }, channels: ["in_app", "email"] });
    expect(result.recipients).toBe(0);
    expect(await db.select().from(messageDeliveries).where(eq(messageDeliveries.eventKey, "test.suspended.new"))).toEqual([]);
    // Same message to the other (active) club goes out.
    const ok = await notify({ clubId: other.clubId, class: "optional", eventKey: "test.suspended.other", refId: randomUUID(), audience: { all: true }, content: { title: "Hallo", body: "Welt" }, channels: ["in_app"] });
    expect(ok.recipients).toBeGreaterThan(0);
  });

  it("unsuspends with a reason and keeps the history", async () => {
    expect((await call(admin, `/admin/clubs/${other.clubId}/unsuspend`, { method: "POST", body: { reason: "Nicht gesperrt gewesen" } })).status).toBe(409);
    const res = await call(admin, `/admin/clubs/${club.clubId}/unsuspend`, { method: "POST", body: { reason: "Sachverhalt geklärt" } });
    expect(res.status).toBe(200);
    const detail = (await json(res)).data;
    expect(detail.status).toBe("active");
    expect(detail.statusHistory.map((h: { action: string }) => h.action)).toEqual(["unsuspend", "suspend"]);
    expect((await call(club.founder, "/club-members/me", { clubId: club.clubId })).status).toBe(200);
    const mine = (await json(await call(club.founder, "/my-clubs"))).data;
    expect(mine.find((x: { clubId: string }) => x.clubId === club.clubId)).toMatchObject({ suspended: false, suspension: null });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.clubId, club.clubId), eq(auditLog.subjectId, club.clubId)));
    expect(audits.map((a) => a.eventType)).toEqual(expect.arrayContaining(["admin.club_suspend", "admin.club_unsuspend"]));
  });

  it("stores plan data only and flags an exceeded member limit", async () => {
    expect((await call(admin, `/admin/clubs/${club.clubId}/plan`, { method: "PUT", body: { tier: "Basis Plus" } })).status).toBe(422);
    expect((await call(admin, `/admin/clubs/${club.clubId}/plan`, { method: "PUT", body: { tier: "basis", validFrom: "2026-02-01", validUntil: "2026-01-01" } })).status).toBe(422);
    const res = await call(admin, `/admin/clubs/${club.clubId}/plan`, { method: "PUT", body: { tier: "basis", validFrom: "2026-01-01", validUntil: "2026-12-31", memberLimit: 1, note: "Pilot" } });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ plan: { tier: "basis", memberLimit: 1, note: "Pilot" }, overMemberLimit: true });
    expect((await call(admin, `/admin/clubs/${club.clubId}/plan`, { method: "DELETE" })).status).toBe(204);
    expect((await json(await call(admin, `/admin/clubs/${club.clubId}`))).data.plan).toBeNull();
  });
});

describe("register portal link (Wave 15 B7, E4)", () => {
  it("only ever hands out an https link; anything else falls back to the default", async () => {
    const { registerPortalUrl, DEFAULT_REGISTER_PORTAL_URL } = await import("../lib/club-platform.js");
    const saved = process.env.REGISTER_PORTAL_URL;
    try {
      for (const bad of ["javascript:alert(1)", "http://register.example/search", "not a url", "https://"]) {
        process.env.REGISTER_PORTAL_URL = bad;
        expect(registerPortalUrl(), bad).toBe(DEFAULT_REGISTER_PORTAL_URL);
      }
      process.env.REGISTER_PORTAL_URL = "https://register.example/search";
      expect(registerPortalUrl()).toBe("https://register.example/search");
      delete process.env.REGISTER_PORTAL_URL;
      expect(registerPortalUrl()).toBe(DEFAULT_REGISTER_PORTAL_URL);
    } finally {
      if (saved === undefined) delete process.env.REGISTER_PORTAL_URL;
      else process.env.REGISTER_PORTAL_URL = saved;
    }
  });
});
