import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { messageDeliveries, notificationPreferences } from "../db/schema/communication.js";
import { events } from "../db/schema/events.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { toAppError } from "../lib/errors.js";
import { notifyWaitlistPromoted } from "../lib/event-notify.js";
import { eventRoutes } from "./events.js";

/** G3: the person who moves up from the waitlist is told (optional, events) in addition to the audit entry. */

const app = new Hono();
app.route("/events", eventRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();

async function signUp(label: string) {
  const email = `wl-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: label } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("waitlist promotion notification (G3)", () => {
  let clubId: string;
  let calendarId: string;
  const people: Record<string, { userId: string; cookie: string; accountId: string; clubMemberId: string }> = {};
  const userIds: string[] = [];

  const call = (who: string, url: string, method = "GET") =>
    app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${clubId}`, { method, headers: { cookie: people[who]!.cookie, "x-forwarded-for": randomUUID() } });
  const newEvent = async (extra: Partial<typeof events.$inferInsert> = {}) => {
    const [row] = await db.insert(events).values({ calendarId, title: "Training", startsAt: new Date("2030-06-01T16:00:00.000Z"), capacity: 1, createdBy: people.board!.userId, ...extra }).returning();
    return row!;
  };
  const deliveries = (eventId: string) => db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${eventId}%`), eq(messageDeliveries.eventKey, "event.promoted")));
  async function fillAndFree(eventId: string, waiter: string) {
    expect((await call("m1", `/events/${eventId}/rsvp`, "POST")).status).toBe(200);
    expect((await call(waiter, `/events/${eventId}/rsvp`, "POST")).status).toBe(200);
    expect((await call("m1", `/events/${eventId}/rsvp`, "DELETE")).status).toBe(204);
  }

  beforeAll(async () => {
    const labels = ["board", "m1", "m2", "child", "guardian"];
    for (const label of labels) {
      const s = await signUp(label);
      userIds.push(s.userId);
      people[label] = { ...s, accountId: "", clubMemberId: "" };
    }
    const club = await auth.api.createOrganization({ body: { name: `Wl Club ${suffix}`, slug: `wl-club-${suffix}`, userId: people.board!.userId } });
    clubId = club!.id;
    for (const label of labels.slice(1)) await auth.api.addMember({ body: { userId: people[label]!.userId, organizationId: clubId, role: "member" } });
    const accounts = await db.query.member.findMany({ where: (m, { eq: same }) => same(m.organizationId, clubId) });
    for (const label of labels) {
      const account = accounts.find((a) => a.userId === people[label]!.userId)!;
      people[label]!.accountId = account.id;
      people[label]!.clubMemberId = (await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.memberId, account.id)))[0]!.id;
    }
    await db.insert(clubRoles).values({ memberId: people.board!.accountId, roleType: "vorsitz" });
    await db.insert(guardianLinks).values({ guardianMemberId: people.guardian!.accountId, wardClubMemberId: people.child!.clubMemberId });
    const [calendar] = await db.insert(calendars).values({ clubId, name: "Allgemein", createdBy: people.board!.userId }).returning();
    calendarId = calendar!.id;
  }, 40_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("tells the promoted person (in-app + mail, optional events) and keeps the audit entry; the one who left is not told", async () => {
    const event = await newEvent();
    await fillAndFree(event.id, "m2");
    const rows = await deliveries(event.id);
    expect(rows.map((r) => `${r.channel}:${r.clubMemberId}`).sort()).toEqual([`email:${people.m2!.clubMemberId}`, `in_app:${people.m2!.clubMemberId}`, `push:${people.m2!.clubMemberId}`].sort());
    expect(rows[0]!.content).toMatchObject({ class: "optional", category: "events", title: "Du bist nachgerückt: Training" });
    expect(await db.select().from(auditLog).where(and(eq(auditLog.subjectId, event.id), eq(auditLog.eventType, "event_attendee.promote")))).toHaveLength(1);
  });

  it("is idempotent for the same waitlist entry and honours the mail opt-out", async () => {
    await db.insert(notificationPreferences).values({ userId: people.m2!.userId, category: "events", channel: "email", enabled: false });
    const event = await newEvent();
    await fillAndFree(event.id, "m2");
    const first = await deliveries(event.id);
    expect(first.find((r) => r.channel === "email")?.status).toBe("skipped_optout");
    expect(first.find((r) => r.channel === "in_app")).toBeDefined();
    const attendee = (await db.query.eventAttendees.findFirst({ where: (a, { and: both, eq: same }) => both(same(a.eventId, event.id), same(a.memberId, people.m2!.accountId)) }))!;
    await notifyWaitlistPromoted({ clubId, event, accountMemberId: people.m2!.accountId, respondedAt: attendee.respondedAt });
    expect(await deliveries(event.id)).toHaveLength(first.length);
    await db.delete(notificationPreferences).where(eq(notificationPreferences.userId, people.m2!.userId));
  });

  it("tells the guardians of a promoted child as well", async () => {
    const event = await newEvent();
    await fillAndFree(event.id, "child");
    const inApp = (await deliveries(event.id)).filter((r) => r.channel === "in_app").map((r) => r.userId).sort();
    expect(inApp).toEqual([people.child!.userId, people.guardian!.userId].sort());
  });

  it("sends nothing for a cancelled or an already started event, nor when nobody moves up", async () => {
    const cancelled = await newEvent({ cancelledAt: new Date() });
    await notifyWaitlistPromoted({ clubId, event: cancelled, accountMemberId: people.m2!.accountId, respondedAt: new Date() });
    const past = await newEvent({ startsAt: new Date(Date.now() - 3_600_000) });
    await notifyWaitlistPromoted({ clubId, event: past, accountMemberId: people.m2!.accountId, respondedAt: new Date() });
    expect(await deliveries(cancelled.id)).toHaveLength(0);
    expect(await deliveries(past.id)).toHaveLength(0);

    const free = await newEvent({ capacity: null });
    expect((await call("m1", `/events/${free.id}/rsvp`, "POST")).status).toBe(200);
    expect((await call("m1", `/events/${free.id}/rsvp`, "DELETE")).status).toBe(204);
    expect(await deliveries(free.id)).toHaveLength(0);
  });
});
