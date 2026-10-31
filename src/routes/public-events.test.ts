import { randomUUID } from "node:crypto";

import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { forms, formSubmissions, formVersions } from "../db/schema/forms.js";
import { events } from "../db/schema/events.js";
import { createEventFixture, type EventFixture } from "./event-test-support.js";
import { publicEventRoutes } from "./public-events.js";

/** Guest registration without account (Wave 12 B14): public link, double opt-in, management link, capacity, rate limits, no leakage. */
describe("public guest registration", () => {
  let fx: EventFixture;
  let formId: string;
  const suffix = Date.now();
  let seq = 0;

  const pub = (path: string, init: { method?: string; body?: unknown; ip?: string } = {}) =>
    fx.app.request(`/public${path}`, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", "x-forwarded-for": init.ip ?? randomUUID() },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const email = (label: string) => `gast-${label}-${suffix}-${seq++}@example.com`;
  const settings = (eventId: string, body: unknown) => fx.req(fx.users.board, `/events/${eventId}/registration`, { method: "PUT", body });

  async function guestEvent(extra: Partial<typeof events.$inferInsert> = {}, config: Record<string, unknown> = {}) {
    const e = await fx.addEvent({ calendarId: fx.calClub, capacity: 2, title: "Sommerfest", ...extra });
    expect((await settings(e.id, { enabled: true, allowGuests: true, maxCompanions: 3, formId, ...config })).status).toBe(200);
    const link = await fx.req(fx.users.board, `/events/${e.id}/public-link`, { method: "POST" });
    expect(link.status).toBe(201);
    const { token } = (await fx.json(link)).data;
    return { event: e, token: token as string };
  }
  /** The confirmation code sits in the queued mail (`ctaUrl`) until the mail job sends and wipes it. */
  async function confirmCodeFor(eventId: string, to: string): Promise<string> {
    const rows = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${eventId}%`), eq(messageDeliveries.eventKey, "event.guest_confirm"), eq(messageDeliveries.address, to)));
    const latest = rows.at(-1)!;
    return (latest.content as { ctaUrl: string }).ctaUrl.split("/").at(-1)!;
  }

  beforeAll(async () => {
    fx = await createEventFixture("pub", [["/public", publicEventRoutes]]);
    const [form] = await db.insert(forms).values({ clubId: fx.clubId, purpose: "veranstaltungsanmeldung", name: "Fest" }).returning();
    formId = form!.id;
    await db.insert(formVersions).values({
      formId,
      version: 1,
      status: "published",
      publishedAt: new Date(),
      privacyNotice: "Wir speichern Name und E-Mail bis 30 Tage nach dem Fest.",
      fields: [{ key: "menu", type: "select", label: "Essen", required: true, options: [{ value: "veg", label: "Vegetarisch" }, { value: "fleisch", label: "Fleisch" }] }],
    });
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("creates the public link only for managers with guests allowed, shows the token once and stores only its hash", async () => {
    const e = await fx.addEvent({ calendarId: fx.calClub });
    expect((await fx.req(fx.users.member1, `/events/${e.id}/public-link`, { method: "POST" })).status).toBe(403);
    expect((await fx.req(fx.users.trainerA, `/events/${e.id}/public-link`, { method: "POST" })).status).toBe(403);
    expect((await fx.req(fx.users.outsider, `/events/${e.id}/public-link`, { method: "POST" })).status).toBe(404);
    const refused = await fx.req(fx.users.board, `/events/${e.id}/public-link`, { method: "POST" });
    expect(refused.status).toBe(409);
    expect((await fx.json(refused)).error.details.code).toBe("guests_not_allowed");

    const { event, token } = await guestEvent();
    expect(token).toHaveLength(43);
    const [row] = await db.select().from(events).where(eq(events.id, event.id));
    expect(row!.publicRegistrationTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.publicRegistrationTokenHash).not.toContain(token);
    const manage = (await fx.json(await fx.req(fx.users.board, `/events/${event.id}/registration`))).data.manage;
    expect(manage.publicLinkActive).toBe(true);
  });

  it("shows guests only event facts, the form and whether it is full -- never counts, members or ids of others", async () => {
    const { event, token } = await guestEvent({ description: "Grillen am See", costNote: "5 EUR" });
    const res = await pub(`/events/${token}`);
    expect(res.status).toBe(200);
    const { data } = await fx.json(res);
    expect(data.event).toMatchObject({ title: "Sommerfest", description: "Grillen am See", cancelled: false, costNote: "5 EUR" });
    expect(data.registration).toMatchObject({ open: true, full: false, maxCompanions: 3 });
    expect(data.registration.form.privacyNotice).toContain("Name und E-Mail");
    const text = JSON.stringify(data);
    for (const leak of [event.id, fx.clubId, "attendeeCount", "waitlistCount", "createdBy", fx.users.board.userId]) expect(text).not.toContain(leak);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers an unknown, malformed or revoked link identically with 404 and stops guessers (invalid budget)", async () => {
    const ip = randomUUID();
    const { event, token } = await guestEvent();
    expect((await pub(`/events/${token}`)).status).toBe(200);
    expect((await fx.req(fx.users.board, `/events/${event.id}/public-link`, { method: "DELETE" })).status).toBe(204);
    const statuses: number[] = [];
    for (const t of [token, "x".repeat(43), "short", `${token}x`]) statuses.push((await pub(`/events/${t}`, { ip })).status);
    expect(statuses).toEqual([404, 404, 404, 404]);
    // The strict budget (20 invalid links per IP and hour) ends in 429.
    let last = 404;
    for (let i = 0; i < 25 && last === 404; i += 1) last = (await pub(`/events/${"y".repeat(43)}`, { ip })).status;
    expect(last).toBe(429);
  });

  it("runs the double opt-in: unconfirmed holds no seat, confirmation seats or waitlists, links are single-purpose", async () => {
    const { event, token } = await guestEvent({}, { maxCompanions: 3 });
    const a = email("a");
    // privacy not accepted / invalid answers are refused.
    expect((await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Anna", email: a, answers: { menu: "veg" } } })).status).toBe(422);
    const bad = await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Anna", email: a, privacyAccepted: true, answers: {} } });
    expect(bad.status).toBe(422);
    expect((await fx.json(bad)).error.details.fields.menu).toBe("required");
    // honeypot: same answer, nothing stored.
    const bot = await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Bot", email: email("bot"), privacyAccepted: true, answers: { menu: "veg" }, website: "http://spam" } });
    expect(bot.status).toBe(202);
    expect(await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, event.id))).toHaveLength(0);

    const ok = await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Anna", email: a, privacyAccepted: true, answers: { menu: "veg" }, partySize: 2 } });
    expect(ok.status).toBe(202);
    expect((await fx.json(ok)).data).toEqual({ status: "pending_confirmation" });
    const [pending] = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, event.id));
    expect(pending).toMatchObject({ status: "unbestaetigt", guestEmail: a, partySize: 2, guestConfirmedAt: null });
    expect(pending!.guestConfirmTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pending!.guestDeleteAfter!.getTime()).toBeLessThan(Date.now() + 49 * 3_600_000);
    // The unconfirmed row takes no seat.
    expect((await fx.json(await fx.req(fx.users.board, `/events/${event.id}`))).data.attendeeCount).toBe(0);

    const code = await confirmCodeFor(event.id, a);
    expect(code).toHaveLength(43);
    expect(pending!.guestConfirmTokenHash).not.toContain(code);
    // Registering the same address again refreshes the pending registration (no second row, a new code).
    expect((await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Anna", email: a.toUpperCase(), privacyAccepted: true, answers: { menu: "fleisch" }, partySize: 2 } })).status).toBe(202);
    expect(await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, event.id))).toHaveLength(1);
    const code2 = await confirmCodeFor(event.id, a);
    expect(code2).not.toBe(code);
    expect((await pub("/registrations/confirm", { method: "POST", body: { code } })).status).toBe(404);

    const confirmed = await pub("/registrations/confirm", { method: "POST", body: { code: code2 } });
    expect(confirmed.status).toBe(200);
    const done = (await fx.json(confirmed)).data;
    expect(done).toMatchObject({ status: "angemeldet", partySize: 2, alreadyConfirmed: false });
    expect(done.manageToken).toHaveLength(43);
    const replay = (await fx.json(await pub("/registrations/confirm", { method: "POST", body: { code: code2 } }))).data;
    expect(replay).toMatchObject({ alreadyConfirmed: true, manageToken: null });
    expect((await fx.json(await fx.req(fx.users.board, `/events/${event.id}`))).data.attendeeCount).toBe(2);

    // Second guest: all seats are gone, lands on the waitlist.
    const b = email("b");
    await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Bert", email: b, privacyAccepted: true, answers: { menu: "veg" } } });
    const confirmedB = (await fx.json(await pub("/registrations/confirm", { method: "POST", body: { code: await confirmCodeFor(event.id, b) } }))).data;
    expect(confirmedB.status).toBe("warteliste");
    expect((await fx.json(await pub(`/events/${token}`))).data.registration.full).toBe(true);

    // The management link shows only the own registration; the answers are editable.
    const view = (await fx.json(await pub(`/registrations/${done.manageToken}`))).data;
    expect(view).toMatchObject({ status: "angemeldet", partySize: 2, name: "Anna", answers: { menu: "fleisch" }, canChange: true });
    expect(JSON.stringify(view)).not.toContain(b);
    // Hashes only in the database.
    const [stored] = await db.select().from(eventAttendees).where(eq(eventAttendees.guestEmail, a));
    expect(stored!.guestTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.guestTokenHash).not.toContain(done.manageToken);

    // Changing the group size is checked against the seats; cancelling frees them and moves the waitlist up.
    expect((await pub(`/registrations/${done.manageToken}`, { method: "PATCH", body: { partySize: 3 } })).status).toBe(422);
    expect((await pub(`/registrations/${done.manageToken}`, { method: "PATCH", body: { partySize: 1, answers: { menu: "veg" } } })).status).toBe(200);
    expect((await pub(`/registrations/${done.manageToken}`, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(eventAttendees).where(eq(eventAttendees.guestEmail, a))).toHaveLength(0);
    expect(await db.select().from(formSubmissions).where(eq(formSubmissions.id, stored!.formSubmissionId!))).toHaveLength(0);
    const [promotedB] = await db.select().from(eventAttendees).where(eq(eventAttendees.guestEmail, b));
    expect(promotedB!.status).toBe("angemeldet");
    const promotionMails = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${event.id}%`), eq(messageDeliveries.eventKey, "event.promoted"), eq(messageDeliveries.address, b)));
    expect(promotionMails).toHaveLength(1);
    expect((await pub(`/registrations/${done.manageToken}`)).status).toBe(404);
  });

  it("re-issues the management link for an address that is already registered instead of revealing it (same 202), and limits mails per address", async () => {
    const { event, token } = await guestEvent({ capacity: 10 }, { formId: null });
    const g = email("again");
    const body = { name: "Gisela", email: g, privacyAccepted: true };
    await pub(`/events/${token}/registrations`, { method: "POST", body });
    const first = (await fx.json(await pub("/registrations/confirm", { method: "POST", body: { code: await confirmCodeFor(event.id, g) } }))).data;
    const again = await pub(`/events/${token}/registrations`, { method: "POST", body });
    expect(again.status).toBe(202);
    expect((await fx.json(again)).data).toEqual({ status: "pending_confirmation" });
    // The old management link stopped working, a mail with the new one was queued.
    expect((await pub(`/registrations/${first.manageToken}`)).status).toBe(404);
    const mails = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${event.id}%`), eq(messageDeliveries.eventKey, "event.guest_registered"), eq(messageDeliveries.address, g)));
    expect(mails.length).toBeGreaterThanOrEqual(2);
    // Third and fourth attempt within the hour: per-address limit.
    expect((await pub(`/events/${token}/registrations`, { method: "POST", body })).status).toBe(202);
    expect((await pub(`/events/${token}/registrations`, { method: "POST", body })).status).toBe(429);
  });

  it("rejects companions beyond the limit, closed registrations and cancelled events; tells confirmed guests when the event is cancelled", async () => {
    const { event, token } = await guestEvent({ capacity: 10 }, { formId: null, maxCompanions: 1 });
    const g = email("c");
    expect((await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Carl", email: g, privacyAccepted: true, partySize: 3 } })).status).toBe(422);
    await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Carl", email: g, privacyAccepted: true } });
    await pub("/registrations/confirm", { method: "POST", body: { code: await confirmCodeFor(event.id, g) } });
    const cancel = await fx.req(fx.users.board, `/events/${event.id}/cancel`, { method: "POST", body: { reason: "Regen" } });
    expect(cancel.status).toBe(200);
    const told = await db.select().from(messageDeliveries).where(and(like(messageDeliveries.refId, `${event.id}%`), eq(messageDeliveries.eventKey, "event.cancelled_guest"), eq(messageDeliveries.address, g)));
    expect(told).toHaveLength(1);
    expect((await fx.json(await pub(`/events/${token}`))).data.registration).toMatchObject({ open: false, closedReason: "cancelled" });
    const late = await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Dora", email: email("d"), privacyAccepted: true } });
    expect(late.status).toBe(409);
    expect((await fx.json(late)).error.details.code).toBe("registration_closed");
  });

  it("lets unconfirmed registrations expire (the code is dead after 48 hours)", async () => {
    const { event, token } = await guestEvent({ capacity: 10 }, { formId: null });
    const g = email("exp");
    await pub(`/events/${token}/registrations`, { method: "POST", body: { name: "Egon", email: g, privacyAccepted: true } });
    const code = await confirmCodeFor(event.id, g);
    await db.update(eventAttendees).set({ guestDeleteAfter: new Date(Date.now() - 1000) }).where(eq(eventAttendees.guestEmail, g));
    expect((await pub("/registrations/confirm", { method: "POST", body: { code } })).status).toBe(404);
  });

  it("does not let guest data of another event or club be reached with a foreign token", async () => {
    const one = await guestEvent({ capacity: 10 }, { formId: null });
    const two = await guestEvent({ capacity: 10 }, { formId: null });
    const g = email("x");
    await pub(`/events/${one.token}/registrations`, { method: "POST", body: { name: "Xaver", email: g, privacyAccepted: true } });
    const done = (await fx.json(await pub("/registrations/confirm", { method: "POST", body: { code: await confirmCodeFor(one.event.id, g) } }))).data;
    // The management token is bound to its registration, whatever event token is used next to it.
    expect((await fx.json(await pub(`/registrations/${done.manageToken}`))).data.event.title).toBe("Sommerfest");
    expect((await pub(`/registrations/${two.token}`)).status).toBe(404);
    expect((await pub(`/events/${done.manageToken}`)).status).toBe(404);
  });
});
