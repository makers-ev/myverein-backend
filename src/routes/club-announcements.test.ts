import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubAnnouncements, messageDeliveries, notificationPreferences } from "../db/schema/communication.js";
import { departments } from "../db/schema/departments.js";
import { jobs } from "../db/schema/jobs.js";
import { toAppError } from "../lib/errors.js";
import { handlePublishAnnouncement, PUBLISH_JOB_TYPE } from "../lib/announcements.js";
import { handleEmailDelivery } from "../lib/notify/email-job.js";
import { EMAIL_JOB_TYPE } from "../lib/notify/types.js";
import { clubAnnouncementRoutes, clubInboxRoutes } from "./club-announcements.js";

/** Wave 9 B7: announcement authoring, scoping, sending, deliveries and the member inbox. */

const app = new Hono();
app.route("/club-announcements", clubAnnouncementRoutes);
app.route("/club-inbox", clubInboxRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  if (appError.status >= 500) console.error("[test] 500 caused by", err); // eslint-disable-line no-console
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string; memberId: string; clubMemberId: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `b7-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `B7 ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

let club: string;
let otherClub: string;
function call(who: { cookie: string }, url: string, init: { method?: string; body?: object; clubId?: string } = {}) {
  return app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${init.clubId ?? club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
}
const json = async (res: Response) => (await res.json()) as Json;

describe("club announcements (B7)", () => {
  let vorsitz: Actor;
  let trainer: Actor; // trainer of deptA only
  let plain: Actor;
  let plain2: Actor;
  let outsider: Actor; // vorsitz of another club
  let deptA: string;
  let deptB: string;
  const userIds: string[] = [];

  async function join(label: string, clubId = club, roles: Array<{ roleType: string; departmentId?: string }> = []): Promise<Actor> {
    const s = await signUp(label);
    userIds.push(s.userId);
    const account = (await auth.api.addMember({ body: { userId: s.userId, organizationId: clubId, role: "member" } }))!;
    for (const r of roles) await db.insert(clubRoles).values({ memberId: account.id, roleType: r.roleType, departmentId: r.departmentId ?? null });
    const row = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) }))!;
    return { ...s, memberId: account.id, clubMemberId: row.id };
  }

  beforeAll(async () => {
    process.env.MAIL_SEND_RATE = "0";
    const f = await signUp("founder");
    const o = await signUp("outsider");
    userIds.push(f.userId, o.userId);
    club = (await auth.api.createOrganization({ body: { name: `B7 ${suffix}`, slug: `b7-${suffix}`, userId: f.userId } }))!.id;
    otherClub = (await auth.api.createOrganization({ body: { name: `B7 other ${suffix}`, slug: `b7-other-${suffix}`, userId: o.userId } }))!.id;
    const fm = (await db.query.member.findFirst({ where: and(eq(member.organizationId, club), eq(member.userId, f.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: fm.id, roleType: "vorsitz" });
    vorsitz = { ...f, memberId: fm.id, clubMemberId: (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, fm.id) }))!.id };
    const om = (await db.query.member.findFirst({ where: and(eq(member.organizationId, otherClub), eq(member.userId, o.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: om.id, roleType: "vorsitz" });
    outsider = { ...o, memberId: om.id, clubMemberId: "" };
    [deptA] = (await db.insert(departments).values({ clubId: club, name: "Fussball" }).returning()).map((d) => d.id);
    [deptB] = (await db.insert(departments).values({ clubId: club, name: "Tennis" }).returning()).map((d) => d.id);
    trainer = await join("trainer", club, [{ roleType: "trainer", departmentId: deptA! }]);
    plain = await join("plain");
    plain2 = await join("plain2");
    await db.insert(clubMemberDepartments).values({ clubMemberId: plain.clubMemberId, departmentId: deptA! });
    await db.insert(clubMemberDepartments).values({ clubMemberId: trainer.clubMemberId, departmentId: deptA! });
    await db.insert(clubMemberDepartments).values({ clubMemberId: plain2.clubMemberId, departmentId: deptB! });
  }, 90_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, club));
    await db.delete(organization).where(eq(organization.id, otherClub));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  const draft = async (who: Actor, extra: object = {}) => {
    const res = await call(who, "/club-announcements", { method: "POST", body: { title: "Hallo", body: "Training faellt aus", audience: { all: true }, ...extra } });
    expect(res.status).toBe(201);
    return (await json(res)).data as Json;
  };

  describe("authorization", () => {
    it("denies a plain member on every authoring route (403) and a non-member (404)", async () => {
      const id = randomUUID();
      for (const [method, path] of [["GET", ""], ["POST", ""], ["POST", "/preview"], ["GET", `/${id}`], ["PATCH", `/${id}`], ["DELETE", `/${id}`], ["POST", `/${id}/send`], ["POST", `/${id}/cancel`], ["GET", `/${id}/deliveries`], ["POST", `/${id}/resend-failed`]] as const) {
        const res = await call(plain, `/club-announcements${path}`, { method, body: method === "GET" || method === "DELETE" ? undefined : {} });
        expect(res.status, `${method} ${path}`).toBe(403);
      }
      expect((await call(outsider, "/club-announcements", { clubId: otherClub })).status).toBe(200); // own club works ...
      expect((await call(outsider, "/club-announcements", { clubId: club })).status).toBe(404); // ... a foreign club is invisible
    });

    it("lets a trainer address only the own department, never club-wide, never urgent", async () => {
      const ok = await call(trainer, "/club-announcements", { method: "POST", body: { title: "T", body: "B", audience: { departmentIds: [deptA!] } } });
      expect(ok.status).toBe(201);
      for (const [audience, urgent] of [[{ all: true }, false], [{ departmentIds: [deptB!] }, false], [{ departmentIds: [deptA!, deptB!] }, false], [{ departmentIds: [deptA!], roleTypes: ["vorsitz"] }, false], [{ memberIds: [plain.clubMemberId] }, false], [{ departmentIds: [deptA!] }, true]] as const) {
        const res = await call(trainer, "/club-announcements", { method: "POST", body: { title: "T", body: "B", audience, urgent } });
        expect(res.status, JSON.stringify({ audience, urgent })).toBe(403);
      }
      const preview = await call(trainer, "/club-announcements/preview", { method: "POST", body: { audience: { all: true } } });
      expect(preview.status).toBe(403);
    });

    it("limits a trainer to own announcements (404 for the board's) while the board sees all", async () => {
      const boards = await draft(vorsitz, { title: "Vorstand intern" });
      expect((await call(trainer, `/club-announcements/${boards.id}`)).status).toBe(404);
      const own = await draft(trainer, { audience: { departmentIds: [deptA!] } });
      const list = await json(await call(trainer, "/club-announcements"));
      expect(list.data.map((a: Json) => a.id)).toContain(own.id);
      expect(list.data.map((a: Json) => a.id)).not.toContain(boards.id);
      const all = await json(await call(vorsitz, "/club-announcements?pageSize=100"));
      expect(all.data.map((a: Json) => a.id)).toEqual(expect.arrayContaining([own.id, boards.id]));
    });

    it("blocks the urgent flag and a club-wide audience for a trainer on edit too", async () => {
      const own = await draft(trainer, { audience: { departmentIds: [deptA!] } });
      expect((await call(trainer, `/club-announcements/${own.id}`, { method: "PATCH", body: { urgent: true } })).status).toBe(403);
      expect((await call(trainer, `/club-announcements/${own.id}`, { method: "PATCH", body: { audience: { all: true } } })).status).toBe(403);
      expect((await call(trainer, `/club-announcements/${own.id}`, { method: "PATCH", body: { title: "Neu" } })).status).toBe(200);
    });

    it("validates the payload (422): plain text only, audience required", async () => {
      expect((await call(vorsitz, "/club-announcements", { method: "POST", body: { title: "x", body: "y", audience: {} } })).status).toBe(422);
      expect((await call(vorsitz, "/club-announcements", { method: "POST", body: { title: "x\u0000", body: "y", audience: { all: true } } })).status).toBe(422);
      expect((await call(vorsitz, "/club-announcements", { method: "POST", body: { title: "", body: "y", audience: { all: true } } })).status).toBe(422);
    });
  });

  describe("preview", () => {
    it("returns counts only", async () => {
      const res = await call(vorsitz, "/club-announcements/preview", { method: "POST", body: { audience: { departmentIds: [deptA!] }, channels: ["in_app", "email"] } });
      expect(res.status).toBe(200);
      const data = (await json(res)).data;
      expect(data.total).toBe(2); // plain + trainer
      expect(Object.keys(data).sort()).toEqual(["email", "emailOnly", "inApp", "push", "reachable", "sharedAddress", "total", "unreachable"]);
      expect(JSON.stringify(data)).not.toContain("example.com");
    });
  });

  describe("send, inbox and scoping", () => {
    it("sends to a department only, writes an audit entry and shows it only to addressees (404 for others)", async () => {
      const a = await draft(vorsitz, { title: "Nur Fussball", audience: { departmentIds: [deptA!] }, channels: ["in_app", "email"] });
      const res = await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} });
      expect(res.status).toBe(200);
      const sent = (await json(res)).data;
      expect(sent.status).toBe("sent");
      expect(sent.delivery.inApp).toBe(2);

      const mine = await json(await call(plain, "/club-inbox"));
      expect(mine.data.map((m: Json) => m.title)).toContain("Nur Fussball");
      const other = await json(await call(plain2, "/club-inbox"));
      expect(other.data.map((m: Json) => m.title)).not.toContain("Nur Fussball");

      const inboxId = (mine.data.find((m: Json) => m.title === "Nur Fussball") as Json).id;
      // plain2 was not addressed: reading someone else's delivery is a 404, and it stays unread for the owner
      expect((await call(plain2, `/club-inbox/${inboxId}/read`, { method: "POST" })).status).toBe(404);
      expect((await call(outsider, `/club-inbox/${inboxId}/read`, { method: "POST", clubId: otherClub })).status).toBe(404);
      expect((await call(outsider, `/club-inbox/${inboxId}/read`, { method: "POST", clubId: club })).status).toBe(404);
      expect((await call(plain, "/club-inbox/not-a-uuid/read", { method: "POST" })).status).toBe(404);

      const audit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_announcement.send"), eq(auditLog.subjectId, a.id)));
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]!.payload)).not.toContain("Nur Fussball");
      expect(audit[0]!.payload).toMatchObject({ clubId: club, actor: vorsitz.userId, inApp: 2 });
    });

    it("an all-audience reaches every member and read state/unread count/filter work (idempotent read)", async () => {
      const a = await draft(vorsitz, { title: "Alle Mitglieder" });
      expect((await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} })).status).toBe(200);
      const before = (await json(await call(plain2, "/club-inbox/unread-count"))).data.count as number;
      expect(before).toBeGreaterThanOrEqual(1);
      const unread = await json(await call(plain2, "/club-inbox?unread=true"));
      const item = unread.data.find((m: Json) => m.title === "Alle Mitglieder") as Json;
      expect(item.readAt).toBeNull();
      const r1 = await call(plain2, `/club-inbox/${item.id}/read`, { method: "POST" });
      const r2 = await call(plain2, `/club-inbox/${item.id}/read`, { method: "POST" });
      expect(r1.status).toBe(200);
      expect((await json(r1)).data.readAt).toBe((await json(r2)).data.readAt);
      expect((await json(await call(plain2, "/club-inbox/unread-count"))).data.count).toBe(before - 1);
      const after = await json(await call(plain2, "/club-inbox?unread=true"));
      expect(after.data.map((m: Json) => m.id)).not.toContain(item.id);
      const paged = await json(await call(plain2, "/club-inbox?pageSize=1&page=1"));
      expect(paged.data).toHaveLength(1);
      expect(paged.pagination.pageSize).toBe(1);
    });

    it("members of other clubs never see the announcement; a later joiner gets nothing delivered", async () => {
      const a = await draft(vorsitz, { title: "Nur Club A", audience: { all: true } });
      await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} });
      const foreign = await json(await call(outsider, "/club-inbox", { clubId: otherClub }));
      expect(foreign.data.map((m: Json) => m.title)).not.toContain("Nur Club A");
      const late = await join("late");
      const lateBox = await json(await call(late, "/club-inbox"));
      expect(lateBox.data.map((m: Json) => m.title)).not.toContain("Nur Club A");
    });

    it("second send is a 409; sending an unknown/foreign id is a 404", async () => {
      const a = await draft(vorsitz, { title: "Einmal" });
      expect((await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} })).status).toBe(200);
      expect((await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} })).status).toBe(409);
      expect((await call(outsider, `/club-announcements/${a.id}/send`, { method: "POST", body: {}, clubId: otherClub })).status).toBe(404);
      expect((await call(vorsitz, `/club-announcements/${randomUUID()}/send`, { method: "POST", body: {} })).status).toBe(404);
    });

    it("the sender's club cannot be switched: another club's vorsitz gets 404 on every id route", async () => {
      const a = await draft(vorsitz);
      for (const [method, path] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/send"], ["POST", "/cancel"], ["GET", "/deliveries"], ["POST", "/resend-failed"]] as const) {
        const res = await call(outsider, `/club-announcements/${a.id}${path}`, { method, body: method === "PATCH" || method === "POST" ? { title: "x" } : undefined, clubId: otherClub });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    });
  });

  describe("editing, pinning and withdrawing", () => {
    it("edits a draft, then only allows pin/withdraw once sent; a withdrawn announcement leaves the inbox", async () => {
      const a = await draft(vorsitz, { title: "Zum Zurueckziehen" });
      expect((await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: { title: "Geaendert" } })).status).toBe(200);
      await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} });
      expect((await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: { title: "Zu spaet" } })).status).toBe(409);
      expect((await call(vorsitz, `/club-announcements/${a.id}`, { method: "DELETE" })).status).toBe(409);
      const pin = await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: { pinned: true } });
      expect((await json(pin)).data.pinned).toBe(true);
      const box = await json(await call(plain, "/club-inbox"));
      expect(box.data[0].title).toBe("Geaendert"); // pinned first
      const wd = await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: { withdraw: true } });
      expect((await json(wd)).data.withdrawn).toBe(true);
      const after = await json(await call(plain, "/club-inbox"));
      expect(after.data.map((m: Json) => m.title)).not.toContain("Geaendert");
    });

    it("deletes a draft", async () => {
      const a = await draft(vorsitz);
      expect((await call(vorsitz, `/club-announcements/${a.id}`, { method: "DELETE" })).status).toBe(204);
      expect((await call(vorsitz, `/club-announcements/${a.id}`)).status).toBe(404);
    });
  });

  describe("scheduling", () => {
    it("schedules, reschedules, is not delivered early, and the publish job sends exactly once", async () => {
      const a = await draft(vorsitz, { title: "Spaeter" });
      const at = new Date(Date.now() + 3_600_000);
      const res = await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: { publishAt: at.toISOString() } });
      expect((await json(res)).data.status).toBe("scheduled");
      expect(await db.select().from(messageDeliveries).where(eq(messageDeliveries.announcementId, a.id))).toHaveLength(0);
      expect((await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: { publishAt: null } })).status).toBe(422);

      const later = new Date(Date.now() + 7_200_000);
      expect((await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: { title: "Spaeter!", publishAt: later.toISOString() } })).status).toBe(200);
      const queued = await db.select().from(jobs).where(eq(jobs.type, PUBLISH_JOB_TYPE));
      const mine = queued.filter((j) => (j.payload as Json).announcementId === a.id);
      expect(mine).toHaveLength(2);

      const job = (publishAt: string) => ({ id: randomUUID(), type: PUBLISH_JOB_TYPE, payload: { announcementId: a.id, publishAt }, attempt: 1, maxAttempts: 3 });
      await handlePublishAnnouncement(job(at.toISOString())); // stale (rescheduled): no-op
      expect(await db.select().from(messageDeliveries).where(eq(messageDeliveries.announcementId, a.id))).toHaveLength(0);
      await handlePublishAnnouncement(job(later.toISOString()));
      const rows = await db.select().from(messageDeliveries).where(eq(messageDeliveries.announcementId, a.id));
      expect(rows.length).toBeGreaterThan(0);
      await handlePublishAnnouncement(job(later.toISOString())); // double run
      expect(await db.select().from(messageDeliveries).where(eq(messageDeliveries.announcementId, a.id))).toHaveLength(rows.length);
      expect((await db.query.clubAnnouncements.findFirst({ where: eq(clubAnnouncements.id, a.id) }))!.status).toBe("sent");
    });

    it("cancel stops a scheduled send (job becomes a no-op); only scheduled can be cancelled", async () => {
      const a = await draft(vorsitz, { title: "Abgesagt" });
      expect((await call(vorsitz, `/club-announcements/${a.id}/cancel`, { method: "POST" })).status).toBe(409);
      const at = new Date(Date.now() + 3_600_000);
      await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: { publishAt: at.toISOString() } });
      expect((await call(vorsitz, `/club-announcements/${a.id}/cancel`, { method: "POST" })).status).toBe(200);
      await handlePublishAnnouncement({ id: randomUUID(), type: PUBLISH_JOB_TYPE, payload: { announcementId: a.id, publishAt: at.toISOString() }, attempt: 1, maxAttempts: 3 });
      expect(await db.select().from(messageDeliveries).where(eq(messageDeliveries.announcementId, a.id))).toHaveLength(0);
    });

    it("a past publishAt is rejected (422)", async () => {
      const a = await draft(vorsitz);
      const res = await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: { publishAt: new Date(Date.now() - 3_600_000).toISOString() } });
      expect(res.status).toBe(422);
    });

    it("a scheduled send of an author who lost the scope is cancelled instead of sent", async () => {
      const a = await draft(trainer, { title: "Verloren", audience: { departmentIds: [deptA!] } });
      const at = new Date(Date.now() + 3_600_000);
      await call(trainer, `/club-announcements/${a.id}/send`, { method: "POST", body: { publishAt: at.toISOString() } });
      await db.delete(clubRoles).where(and(eq(clubRoles.memberId, trainer.memberId), eq(clubRoles.departmentId, deptA!)));
      await handlePublishAnnouncement({ id: randomUUID(), type: PUBLISH_JOB_TYPE, payload: { announcementId: a.id, publishAt: at.toISOString() }, attempt: 1, maxAttempts: 3 });
      expect((await db.query.clubAnnouncements.findFirst({ where: eq(clubAnnouncements.id, a.id) }))!.status).toBe("cancelled");
      expect(await db.select().from(messageDeliveries).where(eq(messageDeliveries.announcementId, a.id))).toHaveLength(0);
      await db.insert(clubRoles).values({ memberId: trainer.memberId, roleType: "trainer", departmentId: deptA! });
    });
  });

  describe("deliveries", () => {
    it("gives the board the per-recipient list and a department author the aggregate only", async () => {
      const a = await draft(trainer, { title: "Mit Mail", audience: { departmentIds: [deptA!] }, channels: ["in_app", "email"] });
      expect((await call(trainer, `/club-announcements/${a.id}/send`, { method: "POST", body: {} })).status).toBe(200);

      const asAuthor = await json(await call(trainer, `/club-announcements/${a.id}/deliveries`));
      expect(asAuthor.data.summary.recipients).toBe(2);
      expect(asAuthor.data.recipients).toBeUndefined();

      const asBoard = await json(await call(vorsitz, `/club-announcements/${a.id}/deliveries`));
      expect(asBoard.data.summary.byChannel.in_app.total).toBe(2);
      expect(asBoard.data.recipients.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(asBoard)).not.toContain("@example.com"); // no addresses
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_announcement.deliveries_read"), eq(auditLog.subjectId, a.id)));
      expect(audit.length).toBe(1);

      // read state shows up in the aggregate
      const item = ((await json(await call(plain, "/club-inbox"))).data as Json[]).find((m) => m.title === "Mit Mail")!;
      await call(plain, `/club-inbox/${item.id}/read`, { method: "POST" });
      expect((await json(await call(trainer, `/club-announcements/${a.id}/deliveries`))).data.summary.read).toBe(1);
    });

    it("resend-failed re-queues failed e-mails only and keeps one delivery per recipient", async () => {
      const a = await draft(vorsitz, { title: "Retry", audience: { memberIds: [plain.clubMemberId] }, channels: ["in_app", "email"] });
      await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} });
      expect((await json(await call(vorsitz, `/club-announcements/${a.id}/resend-failed`, { method: "POST" }))).data.requeued).toBe(0);
      await db.update(messageDeliveries).set({ status: "failed", errorCode: "EENVELOPE", address: "plain@example.com" }).where(and(eq(messageDeliveries.announcementId, a.id), eq(messageDeliveries.channel, "email")));
      const res = await call(vorsitz, `/club-announcements/${a.id}/resend-failed`, { method: "POST" });
      expect((await json(res)).data.requeued).toBe(1);
      const rows = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.announcementId, a.id), eq(messageDeliveries.channel, "email")));
      expect(rows.map((r) => r.status)).toEqual(["queued"]);
      expect((await call(vorsitz, `/club-announcements/${(await draft(vorsitz)).id}/resend-failed`, { method: "POST" })).status).toBe(409);
    });
  });

  describe("system messages in the inbox", () => {
    it("shows the caller's own system deliveries only", async () => {
      const [row] = await db
        .insert(messageDeliveries)
        .values({ clubId: club, eventKey: "event.cancelled", refId: "x", userId: plain.userId, clubMemberId: plain.clubMemberId, channel: "in_app", status: "sent", sentAt: new Date(), content: { title: "Termin abgesagt", body: "Heute faellt aus", class: "optional" } })
        .returning();
      const mine = await json(await call(plain, "/club-inbox"));
      expect(mine.data.find((m: Json) => m.id === row!.id)).toMatchObject({ kind: "system", title: "Termin abgesagt" });
      const theirs = await json(await call(plain2, "/club-inbox"));
      expect(theirs.data.map((m: Json) => m.id)).not.toContain(row!.id);
    });
  });
  describe("department author rights over HTTP", () => {
    let trainerB: Actor; // trainer of deptB only

    beforeAll(async () => {
      trainerB = await join("trainerb", club, [{ roleType: "trainer", departmentId: deptB! }]);
    });

    it("hides another author's announcement completely (404 on every id route), even from a trainer of another department", async () => {
      const a = await draft(trainer, { audience: { departmentIds: [deptA!] }, channels: ["in_app", "email"] });
      for (const [method, path] of [["GET", ""], ["PATCH", ""], ["DELETE", ""], ["POST", "/send"], ["POST", "/cancel"], ["GET", "/deliveries"], ["POST", "/resend-failed"]] as const) {
        const res = await call(trainerB, `/club-announcements/${a.id}${path}`, { method, body: method === "PATCH" ? { title: "Fremd" } : method === "POST" ? {} : undefined });
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      expect((await db.query.clubAnnouncements.findFirst({ where: eq(clubAnnouncements.id, a.id) }))!.title).toBe("Hallo");
    });

    it("refuses another department, club-wide, wide and urgent audiences at create, preview and edit", async () => {
      const bodyOf = (extra: object) => ({ method: "POST", body: { title: "T", body: "B", audience: { departmentIds: [deptB!] }, ...extra } });
      expect((await call(trainerB, "/club-announcements", bodyOf({}))).status).toBe(201);
      for (const extra of [{ audience: { departmentIds: [deptA!] } }, { audience: { all: true } }, { audience: { roleTypes: ["vorsitz"] } }, { audience: { departmentIds: [deptB!], categoryKeys: ["erwachsene"] } }, { urgent: true }]) {
        expect((await call(trainerB, "/club-announcements", bodyOf(extra))).status, JSON.stringify(extra)).toBe(403);
      }
      expect((await call(trainerB, "/club-announcements/preview", { method: "POST", body: { audience: { departmentIds: [deptA!] } } })).status).toBe(403);
      const own = await draft(trainerB, { audience: { departmentIds: [deptB!] } });
      expect((await call(trainerB, `/club-announcements/${own.id}`, { method: "PATCH", body: { audience: { departmentIds: [deptA!] } } })).status).toBe(403);
    });

    it("re-checks the scope when sending: an announcement the board widened cannot be sent by the department author", async () => {
      const a = await draft(trainerB, { audience: { departmentIds: [deptB!] } });
      expect((await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: { audience: { all: true }, urgent: true } })).status).toBe(200);
      expect((await call(trainerB, `/club-announcements/${a.id}/send`, { method: "POST", body: {} })).status).toBe(403);
      expect((await call(trainerB, `/club-announcements/${a.id}`, { method: "PATCH", body: { title: "Neu" } })).status).toBe(403);
      expect(await db.select().from(messageDeliveries).where(eq(messageDeliveries.announcementId, a.id))).toHaveLength(0);
    });

    it("never returns a per-recipient delivery list to the department author, whatever the query", async () => {
      const a = await draft(trainerB, { audience: { departmentIds: [deptB!] }, channels: ["in_app", "email"] });
      expect((await call(trainerB, `/club-announcements/${a.id}/send`, { method: "POST", body: {} })).status).toBe(200);
      for (const query of ["", "?status=sent", "?page=1&pageSize=200", "?status=queued"]) {
        const res = await call(trainerB, `/club-announcements/${a.id}/deliveries${query}`);
        expect(res.status).toBe(200);
        const body = await json(res);
        expect(body.data.recipients).toBeUndefined();
        expect(body.pagination).toBeUndefined();
        expect(Object.keys(body.data)).toEqual(["summary"]);
        expect(JSON.stringify(body)).not.toMatch(/clubMemberId|attempts|errorCode/);
      }
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_announcement.deliveries_read"), eq(auditLog.subjectId, a.id)));
      expect(audit).toHaveLength(0); // only the per-recipient view is audited
    });
  });

  describe("scheduled edits, withdrawal and send-time checks", () => {
    // A second board member: the send route is rate limited per user (20/min), which the suite above already uses up.
    let vorsitz: Actor;
    beforeAll(async () => {
      vorsitz = await join("board2", club, [{ roleType: "vorsitz" }]);
    });

    it("resets a scheduled announcement to draft when audience, channels or urgency change (needs a new /send)", async () => {
      for (const change of [{ audience: { departmentIds: [deptA!] } }, { channels: ["in_app", "email"] }, { urgent: true }]) {
        const a = await draft(vorsitz, { title: "Geplant", audience: { departmentIds: [deptB!] } });
        const at = new Date(Date.now() + 3_600_000);
        await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: { publishAt: at.toISOString() } });
        const res = await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: change });
        expect((await json(res)).data.status, JSON.stringify(change)).toBe("draft");
        await handlePublishAnnouncement({ id: randomUUID(), type: PUBLISH_JOB_TYPE, payload: { announcementId: a.id, publishAt: at.toISOString() }, attempt: 1, maxAttempts: 3 });
        expect(await db.select().from(messageDeliveries).where(eq(messageDeliveries.announcementId, a.id))).toHaveLength(0);
      }
      // text-only edits and an unchanged audience keep the schedule
      const b = await draft(vorsitz, { title: "Bleibt", audience: { departmentIds: [deptB!] } });
      await call(vorsitz, `/club-announcements/${b.id}/send`, { method: "POST", body: { publishAt: new Date(Date.now() + 3_600_000).toISOString() } });
      const kept = await call(vorsitz, `/club-announcements/${b.id}`, { method: "PATCH", body: { title: "Bleibt!", audience: { departmentIds: [deptB!] }, channels: ["in_app"] } });
      expect((await json(kept)).data.status).toBe("scheduled");
    });

    it("withdrawing skips queued mails, the email handler skips withdrawn and opted-out rows, and resend-failed is refused", async () => {
      const a = await draft(vorsitz, { title: "Zurueck", audience: { memberIds: [plain.clubMemberId, plain2.clubMemberId] }, channels: ["in_app", "email"] });
      await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} });
      const mails = () => db.select().from(messageDeliveries).where(and(eq(messageDeliveries.announcementId, a.id), eq(messageDeliveries.channel, "email")));
      await db.update(messageDeliveries).set({ address: "x@example.test" }).where(and(eq(messageDeliveries.announcementId, a.id), eq(messageDeliveries.channel, "email")));
      const queued = (await mails()).filter((r) => r.status === "queued");
      expect(queued.length).toBeGreaterThan(0);
      expect((await call(vorsitz, `/club-announcements/${a.id}`, { method: "PATCH", body: { withdraw: true } })).status).toBe(200);
      for (const r of await mails()) {
        if (queued.some((q) => q.id === r.id)) expect([r.status, r.errorCode]).toEqual(["skipped", "withdrawn"]);
      }
      expect((await call(vorsitz, `/club-announcements/${a.id}/resend-failed`, { method: "POST" })).status).toBe(409);

      // a row that was still queued when the withdrawal happened elsewhere is skipped by the handler itself
      const [one] = queued;
      await db.update(messageDeliveries).set({ status: "queued", errorCode: null }).where(eq(messageDeliveries.id, one!.id));
      await handleEmailDelivery({ id: randomUUID(), type: EMAIL_JOB_TYPE, payload: { deliveryId: one!.id }, attempt: 1, maxAttempts: 3 });
      const [after] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, one!.id));
      expect([after!.status, after!.errorCode]).toEqual(["skipped", "withdrawn"]);
    });

    it("skips mails of recipients who opted out of the category after sending, in the handler and in resend-failed", async () => {
      const a = await draft(vorsitz, { title: "Opt-out spaeter", audience: { memberIds: [plain.clubMemberId] }, channels: ["in_app", "email"] });
      await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} });
      await db.update(messageDeliveries).set({ address: "plain@example.test", status: "failed", errorCode: "EENVELOPE" }).where(and(eq(messageDeliveries.announcementId, a.id), eq(messageDeliveries.channel, "email")));
      await db.insert(notificationPreferences).values({ userId: plain.userId, category: "announcements", channel: "email", enabled: false });
      try {
        const res = await call(vorsitz, `/club-announcements/${a.id}/resend-failed`, { method: "POST" });
        expect((await json(res)).data.requeued).toBe(0);
        const [row] = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.announcementId, a.id), eq(messageDeliveries.channel, "email")));
        expect(row!.status).toBe("skipped_optout");
        await db.update(messageDeliveries).set({ status: "queued" }).where(eq(messageDeliveries.id, row!.id));
        await handleEmailDelivery({ id: randomUUID(), type: EMAIL_JOB_TYPE, payload: { deliveryId: row!.id }, attempt: 1, maxAttempts: 3 });
        const [done] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, row!.id));
        expect(done!.status).toBe("skipped_optout");
      } finally {
        await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, plain.userId));
      }
    });

    it("stores no recipient name on in-app rows", async () => {
      const a = await draft(vorsitz, { title: "Ohne Namen", audience: { memberIds: [plain.clubMemberId] } });
      await call(vorsitz, `/club-announcements/${a.id}/send`, { method: "POST", body: {} });
      const [row] = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.announcementId, a.id), eq(messageDeliveries.channel, "in_app")));
      expect((row!.content as Json).recipientName).toBeNull();
    });
  });
});
