import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries, notificationPreferences } from "../db/schema/communication.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { inventoryItems } from "../db/schema/inventory.js";
import { locations } from "../db/schema/locations.js";
import { toAppError } from "../lib/errors.js";
import { notifyHandover } from "../lib/handover-notify.js";
import { inventoryItemRoutes } from "./inventory-items.js";
import { locationRoutes } from "./locations.js";

/** G7: handing out, returning and extending a loan or key tells the borrower / holder (optional); self actions stay quiet. */

const app = new Hono();
app.route("/inventory-items", inventoryItemRoutes);
app.route("/locations", locationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(label: string) {
  const email = `hnd-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: label } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("handover notifications (G7)", () => {
  let clubId: string;
  let itemId: string;
  let locationId: string;
  const people: Record<string, { userId: string; cookie: string; accountId: string; clubMemberId: string }> = {};
  const userIds: string[] = [];
  const in30d = () => new Date(Date.now() + 30 * 86_400_000).toISOString();
  const in60d = () => new Date(Date.now() + 60 * 86_400_000).toISOString();

  const call = (who: string, url: string, init: { method?: string; body?: object } = {}) =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: people[who]!.cookie, "content-type": "application/json", "x-forwarded-for": randomUUID() },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  const data = async (res: Response) => ((await res.json()) as Json).data as Json;
  const rows = (eventKey: string, ref?: string) =>
    db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, eventKey), ...(ref ? [like(messageDeliveries.refId, `${ref}%`)] : []), eq(messageDeliveries.clubId, clubId)));
  const inApp = async (eventKey: string, ref: string) => (await rows(eventKey, ref)).filter((r) => r.channel === "in_app").map((r) => r.userId).sort();
  const setSwitch = (value: boolean) => db.insert(clubSettings).values({ clubId, notifyHandover: value }).onConflictDoUpdate({ target: clubSettings.clubId, set: { notifyHandover: value } });
  const borrow = async (who: string, extra: Json = {}) => {
    const res = await call(who, `/inventory-items/${itemId}/loans`, { method: "POST", body: extra });
    expect(res.status).toBe(201);
    return data(res);
  };

  beforeAll(async () => {
    const labels = ["board", "m1", "m2", "child", "parent"];
    for (const label of labels) {
      const s = await signUp(label);
      userIds.push(s.userId);
      people[label] = { ...s, accountId: "", clubMemberId: "" };
    }
    const club = await auth.api.createOrganization({ body: { name: `Hnd Club ${suffix}`, slug: `hnd-club-${suffix}`, userId: people.board!.userId } });
    clubId = club!.id;
    for (const label of labels.slice(1)) await auth.api.addMember({ body: { userId: people[label]!.userId, organizationId: clubId, role: "member" } });
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    for (const label of labels) {
      const account = accounts.find((a) => a.userId === people[label]!.userId)!;
      people[label]!.accountId = account.id;
      people[label]!.clubMemberId = (await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, account.id)))[0]!.id;
    }
    await db.insert(clubRoles).values({ memberId: people.board!.accountId, roleType: "vorsitz" });
    await db.insert(guardianLinks).values({ guardianMemberId: people.parent!.accountId, wardClubMemberId: people.child!.clubMemberId });
    itemId = (await db.insert(inventoryItems).values({ clubId, name: "Beamer", condition: "gut" }).returning())[0]!.id;
    locationId = (await db.insert(locations).values({ clubId, name: "Vereinsheim" }).returning())[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("borrowing confirms to the borrower (and the guardians of a child) with the return date", async () => {
    const loan = await borrow("m1", { dueAt: in30d() });
    expect(await inApp("loan.issued", loan.id)).toEqual([people.m1!.userId]);
    const mail = (await rows("loan.issued", loan.id)).filter((r) => r.channel === "email");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.content).toMatchObject({ class: "optional", category: "reminders", title: "Ausleihe: Beamer" });
    expect((mail[0]!.content as { body: string }).body).toContain("Rückgabe bis:");

    const kid = await borrow("child");
    expect(await inApp("loan.issued", kid.id)).toEqual([people.child!.userId, people.parent!.userId].sort());
  });

  it("a return by the board tells the borrower; the borrower returning their own loan stays quiet", async () => {
    const loan = await borrow("m1");
    expect((await call("board", `/inventory-items/${itemId}/loans/${loan.id}`, { method: "PATCH", body: {} })).status).toBe(200);
    expect(await inApp("loan.returned", loan.id)).toEqual([people.m1!.userId]);

    const own = await borrow("m2");
    expect((await call("m2", `/inventory-items/${itemId}/loans/${own.id}`, { method: "PATCH" })).status).toBe(200);
    expect(await rows("loan.returned", own.id)).toHaveLength(0);
  });

  it("extending needs inventory:write, validates the date, tells the borrower once per new date and refuses a returned loan", async () => {
    const loan = await borrow("m1", { dueAt: in30d() });
    const url = `/inventory-items/${itemId}/loans/${loan.id}`;
    expect((await call("m1", url, { method: "PATCH", body: { dueAt: in60d() } })).status).toBe(403);
    expect((await call("board", url, { method: "PATCH", body: { dueAt: new Date(Date.now() + 86_400_000).toISOString() } })).status).toBe(422);
    expect((await call("board", url, { method: "PATCH", body: { dueAt: "tomorrow" } })).status).toBe(422);
    expect((await call("board", url, { method: "PATCH", body: { dueAt: in60d(), extra: 1 } })).status).toBe(422);

    const dueAt = in60d();
    const res = await call("board", url, { method: "PATCH", body: { dueAt } });
    expect(res.status).toBe(200);
    expect(new Date((await data(res)).dueAt).toISOString()).toBe(dueAt);
    const extended = await rows("loan.extended", loan.id);
    expect(extended.filter((r) => r.channel === "in_app").map((r) => r.userId)).toEqual([people.m1!.userId]);
    expect((extended[0]!.content as { body: string }).body).toContain("verlängert");
    expect(await db.select().from(auditLog).where(and(eq(auditLog.subjectId, loan.id), eq(auditLog.eventType, "inventory_loan.extend")))).toHaveLength(1);

    // the same date is no extension any more; a later one is a new message
    expect((await call("board", url, { method: "PATCH", body: { dueAt } })).status).toBe(422);
    expect((await call("board", url, { method: "PATCH", body: { dueAt: new Date(Date.now() + 90 * 86_400_000).toISOString() } })).status).toBe(200);
    expect((await rows("loan.extended", loan.id)).filter((r) => r.channel === "in_app")).toHaveLength(2);

    expect((await call("board", url, { method: "PATCH", body: {} })).status).toBe(200);
    expect((await call("board", url, { method: "PATCH", body: { dueAt: new Date(Date.now() + 120 * 86_400_000).toISOString() } })).status).toBe(409);
  });

  it("keys: handing out and taking back tell the holder; the board's own key stays quiet; a duplicate hand-out sends nothing new", async () => {
    const issue = await call("board", `/locations/${locationId}/key-holders`, { method: "POST", body: { memberId: people.m1!.accountId, keyLabel: "Nr. 3", note: "intern" } });
    expect(issue.status).toBe(201);
    const issued = await rows("key.issued");
    expect(issued.filter((r) => r.channel === "in_app").map((r) => r.userId)).toEqual([people.m1!.userId]);
    const text = (issued[0]!.content as { body: string; title: string });
    expect(text.title).toBe("Schlüsselausgabe: Vereinsheim");
    expect(text.body).toContain("(Nr. 3)");
    expect(text.body).not.toContain("intern");
    expect((await call("board", `/locations/${locationId}/key-holders`, { method: "POST", body: { memberId: people.m1!.accountId } })).status).toBe(409);
    expect(await rows("key.issued")).toHaveLength(issued.length);

    expect((await call("board", `/locations/${locationId}/key-holders/${people.m1!.accountId}`, { method: "DELETE" })).status).toBe(204);
    expect((await rows("key.returned")).filter((r) => r.channel === "in_app").map((r) => r.userId)).toEqual([people.m1!.userId]);

    const before = (await rows("key.issued")).length;
    expect((await call("board", `/locations/${locationId}/key-holders`, { method: "POST", body: { memberId: people.board!.accountId } })).status).toBe(201);
    expect(await rows("key.issued")).toHaveLength(before);
  });

  it("is idempotent, honours the mail opt-out and the club switch", async () => {
    const loan = await borrow("m2", { dueAt: in30d() });
    const before = (await rows("loan.issued", loan.id)).length;
    await notifyHandover({ clubId, kind: "loan.issued", refId: loan.id, accountMemberId: people.m2!.accountId, actorAccountMemberId: people.m2!.accountId, subject: "Beamer" });
    expect(await rows("loan.issued", loan.id)).toHaveLength(before);

    await db.insert(notificationPreferences).values({ userId: people.m2!.userId, category: "reminders", channel: "email", enabled: false });
    const optedOut = await borrow("m2");
    const delivered = await rows("loan.issued", optedOut.id);
    expect(delivered.find((r) => r.channel === "email")?.status).toBe("skipped_optout");
    expect(delivered.find((r) => r.channel === "in_app")).toBeDefined();
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, people.m2!.userId));

    await setSwitch(false);
    const silent = await borrow("m1");
    expect((await call("board", `/inventory-items/${itemId}/loans/${silent.id}`, { method: "PATCH" })).status).toBe(200);
    expect(await rows("loan.issued", silent.id)).toHaveLength(0);
    expect(await rows("loan.returned", silent.id)).toHaveLength(0);
    await setSwitch(true);
  });
});
