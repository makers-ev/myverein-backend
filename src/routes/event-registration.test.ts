import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { forms, formSubmissions, formVersions } from "../db/schema/forms.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { events } from "../db/schema/events.js";
import { createEventFixture, type EventFixture, type TestUser } from "./event-test-support.js";

/** Registration with party size, form answers, "for somebody else", FIFO first-fit waitlist and parallel capacity (Wave 12 B13). */
describe("event registration", () => {
  let fx: EventFixture;
  let formId: string;
  let versionId: string;
  const rsvp = (who: { cookie: string }, eventId: string, body?: unknown, query = "") => fx.req(who, `/events/${eventId}/rsvp${query}`, { method: "POST", ...(body === undefined ? {} : { body }) });
  const event = (calendarId: string, extra: Partial<typeof events.$inferInsert> = {}) => fx.addEvent({ calendarId, capacity: 5, ...extra });
  const settings = (eventId: string, body: unknown, who = fx.users.board) => fx.req(who, `/events/${eventId}/registration`, { method: "PUT", body });
  const counts = async (eventId: string) => {
    const { data } = await fx.json(await fx.req(fx.users.board, `/events/${eventId}`));
    return { attendees: data.attendeeCount as number, waiting: data.waitlistCount as number };
  };

  beforeAll(async () => {
    fx = await createEventFixture("reg");
    const [form] = await db.insert(forms).values({ clubId: fx.clubId, purpose: "veranstaltungsanmeldung", name: "Sommerfest" }).returning();
    formId = form!.id;
    const [version] = await db
      .insert(formVersions)
      .values({
        formId,
        version: 1,
        status: "published",
        publishedAt: new Date(),
        fields: [
          { key: "allergies", type: "text", label: "Allergien", required: true, sensitive: true },
          { key: "shirt", type: "select", label: "Groesse", options: [{ value: "m", label: "M" }, { value: "l", label: "L" }] },
        ],
      })
      .returning();
    versionId = version!.id;
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("only calendars:write may change the settings; foreign clubs and unknown forms are 404", async () => {
    const e = await event(fx.calClub);
    expect((await settings(e.id, { enabled: true }, fx.users.member1)).status).toBe(403);
    expect((await settings(e.id, { enabled: true }, fx.users.trainerA)).status).toBe(403);
    expect((await settings(e.id, { enabled: true }, fx.users.outsider)).status).toBe(404);
    expect((await settings(e.id, { enabled: true, formId: crypto.randomUUID() })).status).toBe(404);
    const ok = await settings(e.id, { enabled: true, formId, maxCompanions: 3, guestRetentionDays: 14 });
    expect(ok.status).toBe(200);
    const view = (await fx.json(ok)).data;
    expect(view).toMatchObject({ enabled: true, open: true, maxCompanions: 3 });
    expect(view.form.formVersionId).toBe(versionId);
    // Members read the rules; only managers see the management part.
    const asMember = (await fx.json(await fx.req(fx.users.member1, `/events/${e.id}/registration`))).data;
    expect(asMember.canManage).toBe(false);
    expect(asMember.manage).toBeUndefined();
    const asBoard = (await fx.json(await fx.req(fx.users.board, `/events/${e.id}/registration`))).data;
    expect(asBoard.manage).toMatchObject({ formId, guestRetentionDays: 14, publicLinkActive: false });
  });

  it("validates the answers against the pinned form and stores them as a submission", async () => {
    const e = await event(fx.calClub);
    await settings(e.id, { enabled: true, formId, maxCompanions: 2 });
    const missing = await rsvp(fx.users.member1, e.id, {});
    expect(missing.status).toBe(422);
    expect((await fx.json(missing)).error.details.fields.allergies).toBe("required");
    expect((await rsvp(fx.users.member1, e.id, { answers: { allergies: "keine", nope: 1 } })).status).toBe(422);
    const ok = await rsvp(fx.users.member1, e.id, { answers: { allergies: "Nuesse", shirt: "m" }, partySize: 2 });
    expect(ok.status).toBe(200);
    expect((await fx.json(ok)).data).toMatchObject({ status: "angemeldet", partySize: 2 });
    const own = (await fx.json(await fx.req(fx.users.member1, `/events/${e.id}/rsvp`))).data;
    expect(own).toMatchObject({ status: "angemeldet", partySize: 2, answers: { allergies: "Nuesse", shirt: "m" } });
    const [row] = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, e.id));
    const [sub] = await db.select().from(formSubmissions).where(eq(formSubmissions.id, row!.formSubmissionId!));
    expect(sub).toMatchObject({ status: "submitted", formVersionId: versionId, clubId: fx.clubId });
    // Too many companions, and answers where no form exists.
    expect((await rsvp(fx.users.member2, e.id, { answers: { allergies: "x" }, partySize: 4 })).status).toBe(422);
    const plain = await event(fx.calClub);
    expect((await rsvp(fx.users.member2, plain.id, { answers: { allergies: "x" } })).status).toBe(422);
    expect((await rsvp(fx.users.member2, plain.id, { partySize: 2 })).status).toBe(422);
    // Withdrawing removes the answers as well.
    expect((await fx.req(fx.users.member1, `/events/${e.id}/rsvp`, { method: "DELETE" })).status).toBe(204);
    expect(await db.select().from(formSubmissions).where(eq(formSubmissions.id, sub!.id))).toHaveLength(0);
  });

  it("keeps old clients working: no body, no registration settings, one seat", async () => {
    const e = await event(fx.calClub);
    const res = await rsvp(fx.users.member1, e.id);
    expect(res.status).toBe(200);
    expect((await fx.json(res)).data.status).toBe("angemeldet");
    expect(await counts(e.id)).toEqual({ attendees: 1, waiting: 0 });
  });

  it("refuses new registrations after the deadline but still allows withdrawing", async () => {
    const e = await event(fx.calClub);
    await settings(e.id, { enabled: true, deadlineAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await rsvp(fx.users.member1, e.id)).status).toBe(200);
    await settings(e.id, { enabled: true, deadlineAt: new Date(Date.now() - 60_000).toISOString() });
    const late = await rsvp(fx.users.member2, e.id);
    expect(late.status).toBe(409);
    expect((await fx.json(late)).error.details.code).toBe("registration_closed");
    expect((await fx.req(fx.users.member1, `/events/${e.id}/rsvp`, { method: "DELETE" })).status).toBe(204);
  });

  it("counts seats by party size, waits groups that do not fit and moves the first one that fits up (FIFO first-fit)", async () => {
    const e = await event(fx.calClub, { capacity: 4 });
    await settings(e.id, { enabled: true, maxCompanions: 3 });
    const [a, b, c, d] = [await fx.addAccount("Gruppe A"), await fx.addAccount("Gruppe B"), await fx.addAccount("Gruppe C"), await fx.addAccount("Gruppe D")];
    expect((await fx.json(await rsvp(a, e.id, { partySize: 2 }))).data.status).toBe("angemeldet");
    expect((await fx.json(await rsvp(b, e.id, { partySize: 3 }))).data.status).toBe("warteliste");
    expect((await fx.json(await rsvp(c, e.id, { partySize: 2 }))).data.status).toBe("angemeldet");
    expect((await fx.json(await rsvp(d, e.id, { partySize: 2 }))).data.status).toBe("warteliste");
    expect(await counts(e.id)).toEqual({ attendees: 4, waiting: 5 });
    expect((await rsvp(a, e.id, { partySize: 5 })).status).toBe(422);
    // Group of 5 is larger than the whole event.
    expect((await rsvp(fx.users.member1, e.id, { partySize: 5 })).status).toBe(422);
    // A frees 2 seats: B (3) does not fit, D (2) is the first that does.
    expect((await fx.req(a, `/events/${e.id}/rsvp`, { method: "DELETE" })).status).toBe(204);
    const status = async (who: TestUser) => (await fx.json(await fx.req(who, `/events/${e.id}/rsvp`))).data?.status;
    expect(await status(b)).toBe("warteliste");
    expect(await status(d)).toBe("angemeldet");
    expect(await counts(e.id)).toEqual({ attendees: 4, waiting: 3 });
    // More room moves B up.
    const patch = await fx.req(fx.users.board, `/events/${e.id}`, { method: "PATCH", body: { capacity: 8 } });
    expect(patch.status).toBe(200);
    expect(await status(b)).toBe("angemeldet");
    // A confirmed person cannot grow beyond the room (and keeps the seat).
    const full = await event(fx.calClub, { capacity: 3 });
    await settings(full.id, { enabled: true, maxCompanions: 3 });
    await rsvp(fx.users.member1, full.id, { partySize: 2 });
    await rsvp(fx.users.member2, full.id, { partySize: 1 });
    const grow = await rsvp(fx.users.member1, full.id, { partySize: 3 });
    expect(grow.status).toBe(409);
    expect((await fx.json(grow)).error.details.code).toBe("party_size_unavailable");
    expect((await fx.json(await fx.req(fx.users.member1, `/events/${full.id}/rsvp`))).data).toMatchObject({ status: "angemeldet", partySize: 2 });
  });

  it("registers somebody else: the board anybody, a guardian only the own ward without account", async () => {
    const e = await event(fx.calA, { capacity: 10 });
    const kid = await fx.addAccountless("Kind Anmeldung", { birthDate: "2017-01-01", departmentId: fx.deptA });
    const stranger = await fx.addAccountless("Fremdes Kind", { birthDate: "2017-01-01", departmentId: fx.deptA });
    const parent = fx.users.member1;
    await db.insert(guardianLinks).values({ guardianMemberId: parent.memberId, wardClubMemberId: kid, confirmedAt: new Date(), validFrom: "2020-01-01" });

    // A plain member cannot register another member; neither can the guardian a child that is not theirs.
    expect((await rsvp(fx.users.member2, e.id, {}, `?forClubMemberId=${kid}`)).status).toBe(403);
    expect((await rsvp(parent, e.id, {}, `?forClubMemberId=${stranger}`)).status).toBe(403);
    const res = await rsvp(parent, e.id, { forClubMemberId: kid, partySize: 1 });
    expect(res.status).toBe(200);
    const row = (await db.select().from(eventAttendees).where(eq(eventAttendees.clubMemberId, kid)))[0]!;
    expect(row).toMatchObject({ status: "angemeldet", memberId: null, registeredByMemberId: parent.memberId });
    expect((await fx.json(await fx.req(parent, `/events/${e.id}/rsvp?forClubMemberId=${kid}`))).data.status).toBe("angemeldet");
    // The ward's answer shows in the guardian's own list too, and the guardian route keeps working on it.
    const wards = await fx.json(await fx.req(parent, `/guardian/wards/${kid}/events?from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)}`));
    expect(wards.data.find((x: any) => x.id === e.id).response).toBe("angemeldet"); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect((await fx.req(parent, `/guardian/wards/${kid}/events/${e.id}/response`, { method: "PUT", body: { status: "abgesagt" } })).status).toBe(200);
    expect(await db.select().from(eventAttendees).where(eq(eventAttendees.clubMemberId, kid))).toHaveLength(0);

    // The board registers a member without account.
    const adult = await fx.addAccountless("Erwachsen Anmeldung");
    expect((await rsvp(fx.users.board, e.id, { forClubMemberId: adult })).status).toBe(200);
    expect(await db.select().from(eventAttendees).where(eq(eventAttendees.clubMemberId, adult))).toHaveLength(1);
    // The same person answering both ways never takes two seats.
    expect((await fx.req(fx.users.board, `/events/${e.id}/rsvp?forClubMemberId=${adult}`, { method: "DELETE" })).status).toBe(204);
    expect(await counts(e.id)).toEqual({ attendees: 0, waiting: 0 });
  });

  it("never overbooks under parallel registrations (single seats and mixed party sizes)", async () => {
    const accounts = await Promise.all(Array.from({ length: 8 }, (_, i) => fx.addAccount(`Parallel ${i}`)));
    const single = await event(fx.calClub, { capacity: 3 });
    const results = await Promise.all(accounts.map((a) => rsvp(a, single.id)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const states = await Promise.all(results.map(async (r) => (await fx.json(r)).data.status as string));
    expect(states.filter((s) => s === "angemeldet")).toHaveLength(3);
    expect(states.filter((s) => s === "warteliste")).toHaveLength(5);
    expect(await counts(single.id)).toEqual({ attendees: 3, waiting: 5 });

    const mixed = await event(fx.calClub, { capacity: 5 });
    await settings(mixed.id, { enabled: true, maxCompanions: 3 });
    const sizes = [3, 2, 2, 1, 4, 1, 2, 3];
    const mixedResults = await Promise.all(accounts.map((a, i) => rsvp(a, mixed.id, { partySize: sizes[i] })));
    expect(mixedResults.every((r) => r.status === 200)).toBe(true);
    const confirmed = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, mixed.id));
    const seats = confirmed.filter((r) => r.status === "angemeldet").reduce((n, r) => n + r.partySize, 0);
    expect(seats).toBeLessThanOrEqual(5);
    expect(seats).toBeGreaterThan(0);

    // Parallel withdrawals promote everybody who fits exactly once.
    await Promise.all(confirmed.filter((r) => r.status === "angemeldet").map((r) => fx.req(accounts[accounts.findIndex((a) => a.memberId === r.memberId)]!, `/events/${mixed.id}/rsvp`, { method: "DELETE" })));
    const after = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, mixed.id));
    expect(after.filter((r) => r.status === "angemeldet").reduce((n, r) => n + r.partySize, 0)).toBeLessThanOrEqual(5);
  });

  it("saves cost and tracking on the event (display only)", async () => {
    const e = await event(fx.calClub);
    const res = await fx.req(fx.users.board, `/events/${e.id}`, { method: "PATCH", body: { costNote: "5 Euro pro Person, bar vor Ort", costCents: 500, attendanceTracking: true } });
    expect((await fx.json(res)).data).toMatchObject({ costNote: "5 Euro pro Person, bar vor Ort", costCents: 500, attendanceTracking: true });
    const view = (await fx.json(await fx.req(fx.users.member1, `/events/${e.id}/registration`))).data;
    expect(view).toMatchObject({ costNote: "5 Euro pro Person, bar vor Ort", costCents: 500 });
  });
});
