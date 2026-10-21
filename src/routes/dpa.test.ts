import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubMembers } from "../db/schema/club-members.js";
import { jobs } from "../db/schema/jobs.js";
import { dpaAcceptances, dpaVersions } from "../db/schema/privacy.js";
import { dpaChecksum, handleDpaVersionNotify, DPA_NOTIFY_JOB_TYPE } from "../lib/dpa.js";
import { toAppError } from "../lib/errors.js";
import { adminDpaAcceptanceRoutes, adminDpaVersionRoutes } from "./admin-dpa.js";
import { clubMemberRoutes } from "./club-members.js";
import { departmentRoutes } from "./departments.js";
import { dpaRoutes } from "./dpa.js";

/** Wave 10 B10: versions (platform admin), acceptance by the owner, the gate with grace period, the rights that stay open. */

const app = new Hono();
app.route("/admin/dpa-versions", adminDpaVersionRoutes);
app.route("/admin/dpa-acceptances", adminDpaAcceptanceRoutes);
app.route("/dpa", dpaRoutes);
app.route("/departments", departmentRoutes);
app.route("/club-members", clubMemberRoutes);
app.onError((err, c) => {
  const e = toAppError(err);
  return c.json(e.toJSON(), e.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
const DAY = 86_400_000;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { cookie: string; userId: string };

async function signUp(label: string, role: "user" | "admin" = "user"): Promise<Who> {
  const email = `dpa-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Dpa ${label}` } });
  await db.update(user).set({ emailVerified: true, role }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const json = async (res: Response) => (await res.json()) as Json;

describe("processor agreement (B10)", () => {
  let clubId: string;
  let admin: Who;
  let owner: Who;
  let board: Who; // vorsitz but NOT the owner
  let plain: Who;
  let ownerClubMemberId: string;
  const userIds: string[] = [];
  const versionIds: string[] = [];

  const adminCall = (path: string, init: { method?: string; json?: object; who?: Who } = {}) =>
    app.request(`/admin/dpa-versions${path}`, { method: init.method ?? "GET", headers: { cookie: (init.who ?? admin).cookie, "x-forwarded-for": randomUUID(), ...(init.json ? { "content-type": "application/json" } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined });
  const call = (who: Who, url: string, init: { method?: string; json?: object } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, { method: init.method ?? "GET", headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), ...(init.json ? { "content-type": "application/json" } : {}) }, body: init.json ? JSON.stringify(init.json) : undefined });
  const draft = { title: "Auftragsverarbeitungsvertrag", body: "Dieser Vertrag regelt die Verarbeitung personenbezogener Daten im Auftrag des Vereins.", subprocessors: [{ name: "Hosting GmbH", purpose: "Hosting", location: "Frankfurt" }], tomAnnex: "Zutrittskontrolle, Verschlüsselung." };
  async function publishVersion(extra: object = {}): Promise<Json> {
    const created = await json(await adminCall("", { method: "POST", json: { ...draft, ...extra } }));
    versionIds.push(created.data.id);
    const published = await adminCall(`/${created.data.id}/publish`, { method: "POST" });
    expect(published.status).toBe(200);
    return (await json(published)).data;
  }
  const addDepartment = (who: Who) => call(who, "/departments", { method: "POST", json: { name: `Abteilung ${randomUUID().slice(0, 6)}` } });

  beforeAll(async () => {
    delete process.env.DPA_REQUIRED;
    process.env.DPA_GRACE_DAYS = "30";
    admin = await signUp("admin", "admin");
    owner = await signUp("owner");
    board = await signUp("board");
    plain = await signUp("plain");
    userIds.push(admin.userId, owner.userId, board.userId, plain.userId);
    clubId = (await auth.api.createOrganization({ body: { name: `Dpa Club ${suffix}`, slug: `dpa-club-${suffix}`, userId: owner.userId } }))!.id;
    await auth.api.addMember({ body: { userId: board.userId, organizationId: clubId, role: "member" } });
    await auth.api.addMember({ body: { userId: plain.userId, organizationId: clubId, role: "member" } });
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    const boardAccount = accounts.find((a) => a.userId === board.userId)!;
    const ownerAccount = accounts.find((a) => a.userId === owner.userId)!;
    await db.insert(clubRoles).values([{ memberId: boardAccount.id, roleType: "vorsitz" }, { memberId: ownerAccount.id, roleType: "vorsitz" }]);
    ownerClubMemberId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, ownerAccount.id) }))!.id;
  }, 90_000);

  afterAll(async () => {
    delete process.env.DPA_REQUIRED;
    await db.delete(jobs).where(eq(jobs.type, DPA_NOTIFY_JOB_TYPE));
    await db.delete(organization).where(eq(organization.id, clubId));
    if (versionIds.length) await db.delete(dpaVersions).where(inArray(dpaVersions.id, versionIds));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("versions (platform admin)", () => {
    it("is for platform admins only", async () => {
      expect([401, 403]).toContain((await adminCall("", { who: owner })).status);
      expect([401, 403]).toContain((await adminCall("", { method: "POST", json: draft, who: owner })).status);
    });

    it("creates drafts with growing numbers, edits them, publishes once, and keeps published versions immutable", async () => {
      expect((await adminCall("", { method: "POST", json: { ...draft, body: "zu kurz" } })).status).toBe(422);
      const first = (await json(await adminCall("", { method: "POST", json: draft }))).data;
      versionIds.push(first.id);
      expect(first).toMatchObject({ status: "draft", publishedAt: null });
      expect(first.sha256).toBe(dpaChecksum({ ...draft, tomAnnex: draft.tomAnnex }));

      const patched = (await json(await adminCall(`/${first.id}`, { method: "PATCH", json: { title: "AV-Vertrag Neu", requiredFrom: "2030-01-01" } }))).data;
      expect(patched).toMatchObject({ title: "AV-Vertrag Neu", requiredFrom: "2030-01-01" });
      expect(patched.sha256).not.toBe(first.sha256);
      expect((await adminCall(`/${first.id}`, { method: "PATCH", json: {} })).status).toBe(422);

      const published = await adminCall(`/${first.id}/publish`, { method: "POST" });
      expect(published.status).toBe(200);
      const publishedBody = (await json(published)).data;
      expect(publishedBody).toMatchObject({ status: "published", version: first.version });
      expect(publishedBody.publishedAt).toBeTruthy();
      expect((await adminCall(`/${first.id}`, { method: "PATCH", json: { title: "x y z" } })).status).toBe(409);
      expect((await adminCall(`/${first.id}/publish`, { method: "POST" })).status).toBe(409);
      expect((await adminCall(`/${first.id}`, { method: "DELETE" })).status).toBe(409);

      const second = (await json(await adminCall("", { method: "POST", json: draft }))).data;
      versionIds.push(second.id);
      expect(second.version).toBe(first.version + 1);
      expect((await adminCall(`/${second.id}`, { method: "DELETE" })).status).toBe(204);
      versionIds.pop();
      expect((await adminCall(`/${randomUUID()}`, { method: "DELETE" })).status).toBe(404);

      const list = await json(await adminCall(""));
      expect(list.data.find((v: Json) => v.id === first.id)).toMatchObject({ status: "published", acceptedClubs: 0 });
      expect(list.gate).toMatchObject({ required: false, graceDays: 30 });
      const audits = await db.select().from(auditLog).where(eq(auditLog.subjectId, first.id));
      expect(audits.map((a) => a.eventType).sort()).toEqual(["dpa_version.create", "dpa_version.publish", "dpa_version.update"]);
      expect(audits.every((a) => a.clubId === null)).toBe(true);
    });
  });

  describe("club side", () => {
    let current: Json;

    it("shows the current version and the status to every member; nothing is required while the gate is off", async () => {
      const res = await json(await call(plain, "/dpa/current"));
      expect(res.data.version).toMatchObject({ title: "AV-Vertrag Neu" });
      expect(res.data.status).toMatchObject({ required: false, accepted: false, blocked: false, version: res.data.version.version });
      expect(res.data.canAccept).toBe(false);
      expect((await json(await call(owner, "/dpa/current"))).data.canAccept).toBe(true);
      current = res.data.version;
      expect((await addDepartment(board)).status).toBe(201);
    });

    it("offers the agreement as Markdown and escaped HTML download", async () => {
      const md = await call(plain, "/dpa/current/document");
      expect(md.status).toBe(200);
      expect(md.headers.get("content-disposition")).toContain("av-vertrag.md");
      expect(await md.text()).toContain("Hosting GmbH");
      const html = await call(plain, "/dpa/current/document?format=html");
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("cache-control")).toBe("private, no-store");
    });

    it("lets the club work during the grace period (banner), and locks writing afterwards", async () => {
      process.env.DPA_REQUIRED = "true";
      // The version above is mandatory from 2030: not yet.
      expect((await json(await call(owner, "/dpa/current"))).data.status).toMatchObject({ required: true, blocked: false, mandatoryFrom: expect.any(String) });
      current = await publishVersion({ requiredFrom: new Date(Date.now() - 5 * DAY).toISOString().slice(0, 10) });
      const status = (await json(await call(owner, "/dpa/current"))).data.status;
      expect(status).toMatchObject({ required: true, accepted: false, blocked: false });
      expect(status.daysLeft).toBeGreaterThan(0);
      expect((await addDepartment(board)).status).toBe(201);

      // An old club and a version that was mandatory 45 days ago: past the grace period.
      await db.update(organization).set({ createdAt: new Date(Date.now() - 100 * DAY) }).where(eq(organization.id, clubId));
      current = await publishVersion({ requiredFrom: new Date(Date.now() - 45 * DAY).toISOString().slice(0, 10) });
      const locked = await addDepartment(board);
      expect(locked.status).toBe(403);
      const body = await json(locked);
      expect(body.error.code).toBe("DPA_REQUIRED");
      expect(body.error.details).toMatchObject({ code: "dpa_required", version: current.version });
      expect((await json(await call(owner, "/dpa/current"))).data.status).toMatchObject({ blocked: true, daysLeft: expect.any(Number) });
    });

    it("keeps reading, the agreement itself and the rights of data subjects open while locked", async () => {
      expect((await call(plain, "/departments")).status).toBe(200);
      expect((await call(plain, "/dpa/current")).status).toBe(200);
      expect((await call(plain, "/club-members/me/erasure-request", { method: "POST" })).status).toBe(201);
      expect((await call(plain, "/club-members/me/data-export")).status).toBe(200);
      expect((await call(board, `/club-members/${ownerClubMemberId}/data-export`, { method: "POST", json: { identityChecked: true } })).status).toBe(200);
      expect((await call(board, `/club-members/${ownerClubMemberId}/erasure/plan`, { method: "POST" })).status).toBe(200);
      // Self-service writes of the person stay open (rectification, visibility, notification settings) ...
      for (const [path, method, json] of [
        ["/club-members/me", "PATCH", { phone: "123" }],
        [`/club-members/${ownerClubMemberId}/visibility`, "PUT", { phone: "mitglieder" }],
        ["/notification-preferences", "PUT", {}],
      ] as const) {
        const res = await call(plain, path, { method, json });
        expect(await res.clone().text(), `${method} ${path}`).not.toContain("DPA_REQUIRED");
      }
      expect((await call(plain, "/club-members/me", { method: "PATCH", json: { phone: "123" } })).status).toBe(200);
      // ... other writing stays locked, for members too.
      const locked = await addDepartment(plain);
      expect(locked.status).toBe(403);
      expect((await json(locked)).error.code).toBe("DPA_REQUIRED");
    });

    it("lets only the owner accept the current version, idempotently, and then unlocks writing", async () => {
      const accept = (who: Who, versionId: string, extra: object = {}) => call(who, "/dpa/accept", { method: "POST", json: { dpaVersionId: versionId, signerName: "Max Mustermann", authorized: true, ...extra } });
      expect((await accept(board, current.id)).status).toBe(403); // vorsitz, not the owner
      expect((await accept(plain, current.id)).status).toBe(403);
      expect((await accept(owner, current.id, { authorized: false })).status).toBe(422);
      expect((await accept(owner, current.id, { signerName: "M" })).status).toBe(422);
      const stale = await accept(owner, versionIds[0]!);
      expect(stale.status).toBe(409);
      expect((await json(stale)).error.details.code).toBe("dpa_version_outdated");

      const ok = await accept(owner, current.id);
      expect(ok.status).toBe(201);
      const accepted = (await json(ok)).data;
      expect(accepted).toMatchObject({ signerName: "Max Mustermann", version: current.version, status: { accepted: true, blocked: false } });
      expect((await accept(owner, current.id)).status).toBe(200);
      expect(await db.select().from(dpaAcceptances).where(and(eq(dpaAcceptances.clubId, clubId), eq(dpaAcceptances.dpaVersionId, current.id)))).toHaveLength(1);
      const [row] = await db.select().from(dpaAcceptances).where(eq(dpaAcceptances.clubId, clubId));
      expect(row).toMatchObject({ acceptedByUserId: owner.userId, authorizedConfirmed: true });
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubId), eq(auditLog.eventType, "dpa.accept")));
      expect(audit).toHaveLength(1);
      expect((await addDepartment(board)).status).toBe(201);
    });

    it("asks again for a new version, with its own grace period", async () => {
      const next = await publishVersion(); // mandatory from today: the grace period starts now
      let status = (await json(await call(owner, "/dpa/current"))).data;
      expect(status.version.id).toBe(next.id);
      expect(status.status).toMatchObject({ accepted: false, blocked: false });
      expect((await addDepartment(board)).status).toBe(201);

      const overdue = await publishVersion({ requiredFrom: new Date(Date.now() - 45 * DAY).toISOString().slice(0, 10) });
      status = (await json(await call(owner, "/dpa/current"))).data;
      expect(status.version.id).toBe(overdue.id);
      expect(status.status.blocked).toBe(true);
      expect((await addDepartment(board)).status).toBe(403);
    });

    it("tells the owners of a club that has not accepted, once", async () => {
      const [latest] = await db.select().from(dpaVersions).where(inArray(dpaVersions.id, versionIds)).orderBy(dpaVersions.version).then((r) => r.slice(-1));
      const job = { id: randomUUID(), type: DPA_NOTIFY_JOB_TYPE, payload: { dpaVersionId: latest!.id, clubId }, attempt: 1, maxAttempts: 3 };
      await handleDpaVersionNotify(job);
      const sent = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, "dpa.version_published")));
      expect(new Set(sent.map((d) => d.userId))).toEqual(new Set([owner.userId]));
      const count = sent.length;
      await handleDpaVersionNotify(job);
      expect((await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.eventKey, "dpa.version_published")))).length).toBe(count);
      // Publishing enqueued the notification job for every version.
      expect((await db.select().from(jobs).where(eq(jobs.type, DPA_NOTIFY_JOB_TYPE))).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("acceptance overview (platform admin)", () => {
    it("lists clubs with their acceptance of the current or a given version", async () => {
      const current = (await json(await call(owner, "/dpa/current"))).data.version;
      const missing = await json(await app.request(`/admin/dpa-acceptances?state=missing&pageSize=100`, { headers: { cookie: admin.cookie, "x-forwarded-for": randomUUID() } }));
      expect(missing.version.id).toBe(current.id);
      const mine = missing.data.find((r: Json) => r.clubId === clubId);
      expect(mine).toMatchObject({ accepted: false, blocked: true, signerName: null });

      const rows = await db.select().from(dpaAcceptances).where(eq(dpaAcceptances.clubId, clubId));
      const acceptedId = rows[0]!.dpaVersionId;
      const list = await json(await app.request(`/admin/dpa-acceptances?versionId=${acceptedId}&state=accepted&pageSize=100`, { headers: { cookie: admin.cookie, "x-forwarded-for": randomUUID() } }));
      expect(list.data.find((r: Json) => r.clubId === clubId)).toMatchObject({ accepted: true, signerName: "Max Mustermann", acceptedBy: "Dpa owner" });
      expect([401, 403]).toContain((await app.request("/admin/dpa-acceptances", { headers: { cookie: owner.cookie, "x-forwarded-for": randomUUID() } })).status);
    });
  });
});
