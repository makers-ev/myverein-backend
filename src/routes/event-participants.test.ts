import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { forms, formVersions } from "../db/schema/forms.js";
import { createEventFixture, type EventFixture, type TestUser } from "./event-test-support.js";

/** Participant list, CSV export and organiser status changes (Wave 12 B15). */
describe("event participants", () => {
  let fx: EventFixture;
  let eventA: string;
  let eventB: string;
  let third: TestUser;
  let attendee: Record<"m1" | "m2" | "m3", string>;
  const rsvp = (who: TestUser, id: string, body: unknown) => fx.req(who, `/events/${id}/rsvp`, { method: "POST", body });
  const list = (who: { cookie: string }, id: string) => fx.req(who, `/events/${id}/registrations`);

  beforeAll(async () => {
    fx = await createEventFixture("part");
    const [form] = await db.insert(forms).values({ clubId: fx.clubId, purpose: "veranstaltungsanmeldung", name: "Lager" }).returning();
    await db.insert(formVersions).values({
      formId: form!.id,
      version: 1,
      status: "published",
      publishedAt: new Date(),
      fields: [
        { key: "bemerkung", type: "text", label: "Bemerkung" },
        { key: "allergien", type: "text", label: "Allergien", sensitive: true },
      ],
    });
    const eventAId = (await fx.addEvent({ calendarId: fx.calA, capacity: 2 })).id;
    const eventBId = (await fx.addEvent({ calendarId: fx.calB, capacity: 2 })).id;
    eventA = eventAId;
    eventB = eventBId;
    for (const id of [eventA, eventB]) await fx.req(fx.users.board, `/events/${id}/registration`, { method: "PUT", body: { enabled: true, formId: form!.id, maxCompanions: 2 } });
    third = await fx.addAccount("Dritter");
    await rsvp(fx.users.member1, eventA, { answers: { bemerkung: "=HYPERLINK(\"http://x\")", allergien: "Erdnuesse" } });
    await rsvp(fx.users.member2, eventA, { answers: { bemerkung: "bringt Kuchen" } });
    await rsvp(third, eventA, { answers: { allergien: "keine" }, partySize: 1 });
    const rows = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, eventA));
    const idOf = (u: TestUser) => rows.find((r) => r.memberId === u.memberId)!.id;
    attendee = { m1: idOf(fx.users.member1), m2: idOf(fx.users.member2), m3: idOf(third) };
  }, 60_000);
  afterAll(async () => fx.cleanup());

  it("lists registrations for registrations:read within the department scope and hides everything from plain members", async () => {
    expect((await list(fx.users.member1, eventA)).status).toBe(403);
    expect((await list(fx.users.outsider, eventA)).status).toBe(404);
    expect((await list(fx.users.trainerA, eventB)).status).toBe(403);
    const res = await list(fx.users.trainerA, eventA);
    expect(res.status).toBe(200);
    const { data } = await fx.json(res);
    expect(data).toMatchObject({ capacity: 2, seatsTaken: 2, seatsWaiting: 1, sensitiveVisible: false });
    expect(data.registrations.map((r: any) => r.displayName)).toEqual(["Mitglied Eins", "Mitglied Zwei", "Dritter"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(data.registrations[2].status).toBe("warteliste");
  });

  it("shows sensitive answers only with members:read_sensitive and audits that read", async () => {
    const trainer = (await fx.json(await list(fx.users.trainerA, eventA))).data;
    expect(JSON.stringify(trainer)).not.toContain("Erdnuesse");
    expect(trainer.fields.map((f: any) => f.key)).toEqual(["bemerkung"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const before = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, eventA), eq(auditLog.eventType, "event_registration.read_sensitive")));
    const board = (await fx.json(await list(fx.users.board, eventA))).data;
    expect(board.sensitiveVisible).toBe(true);
    expect(board.registrations[0].answers).toMatchObject({ allergien: "Erdnuesse" });
    expect(board.fields.map((f: any) => f.key).sort()).toEqual(["allergien", "bemerkung"]); // eslint-disable-line @typescript-eslint/no-explicit-any
    const after = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, eventA), eq(auditLog.eventType, "event_registration.read_sensitive")));
    expect(after.length).toBe(before.length + 1);
  });

  it("exports CSV with a choice of columns, neutralises formulas and audits the export", async () => {
    const res = await fx.req(fx.users.board, `/events/${eventA}/registrations.csv?columns=name,status,bemerkung,allergien`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text).toContain("Name;Status;Bemerkung;Allergien");
    expect(text).toContain("'=HYPERLINK");
    expect(text).not.toMatch(/;=HYPERLINK/);
    expect(text).toContain("Erdnuesse");
    // Trainers get the CSV without the sensitive column; asking for it is an error.
    const trainer = await fx.req(fx.users.trainerA, `/events/${eventA}/registrations.csv`);
    expect(await trainer.text()).not.toContain("Erdnuesse");
    expect((await fx.req(fx.users.trainerA, `/events/${eventA}/registrations.csv?columns=allergien`)).status).toBe(422);
    expect((await fx.req(fx.users.member1, `/events/${eventA}/registrations.csv`)).status).toBe(403);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.subjectId, eventA), eq(auditLog.eventType, "event_registration.export")));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it("lets only calendars:write change a status; seats are checked unless forced; cancelling moves the waitlist up", async () => {
    const patch = (who: { cookie: string }, id: string, status: string, extra: object = {}) => fx.req(who, `/events/${eventA}/registrations/${id}`, { method: "PATCH", body: { status, ...extra } });
    expect((await patch(fx.users.trainerA, attendee.m3, "angemeldet")).status).toBe(403);
    expect((await patch(fx.users.member1, attendee.m3, "angemeldet")).status).toBe(403);
    expect((await patch(fx.users.outsider, attendee.m3, "angemeldet")).status).toBe(404);
    expect((await patch(fx.users.board, crypto.randomUUID(), "angemeldet")).status).toBe(404);
    const full = await patch(fx.users.board, attendee.m3, "angemeldet");
    expect(full.status).toBe(409);
    expect((await fx.json(full)).error.details.code).toBe("capacity_exceeded");
    expect((await patch(fx.users.board, attendee.m3, "angemeldet", { force: true })).status).toBe(200);
    expect((await fx.json(await list(fx.users.board, eventA))).data.seatsTaken).toBe(3);
    // Back to the waitlist, then remove a confirmed person: the waiting one moves up.
    expect((await patch(fx.users.board, attendee.m3, "warteliste")).status).toBe(200);
    expect((await patch(fx.users.board, attendee.m1, "abgesagt")).status).toBe(200);
    const after = (await fx.json(await list(fx.users.board, eventA))).data;
    expect(after.registrations.map((r: any) => [r.displayName, r.status])).toEqual([["Mitglied Zwei", "angemeldet"], ["Dritter", "angemeldet"]]); // eslint-disable-line @typescript-eslint/no-explicit-any
    // A registration of another event is not reachable through this one.
    const foreign = (await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, eventB)))[0];
    expect(foreign).toBeUndefined();
    expect((await fx.req(fx.users.board, `/events/${eventB}/registrations/${attendee.m2}`, { method: "PATCH", body: { status: "abgesagt" } })).status).toBe(404);
  });
});
