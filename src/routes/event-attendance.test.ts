import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { absenceReports } from "../db/schema/absences.js";
import { eventAttendance } from "../db/schema/event-attendance.js";
import { clubMemberDepartments } from "../db/schema/club-members.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { createEventFixture, HOUR, type EventFixture } from "./event-test-support.js";

/** Attendance list (Wave 12 B10/B11): roster, batch recording, members without account, supervisors, closing, rights and department scope. */
describe("event attendance", () => {
  let fx: EventFixture;
  let eventA: string;
  let eventB: string;
  let kid: string;
  let adult: string;
  let absentKid: string;
  const day = (d: Date) => d.toISOString().slice(0, 10);

  beforeAll(async () => {
    fx = await createEventFixture("att");
    kid = await fx.addAccountless("Kind Klein", { birthDate: "2018-05-05", departmentId: fx.deptA });
    adult = await fx.addAccountless("Erwachsene Gross", { birthDate: "1990-01-01", departmentId: fx.deptA });
    absentKid = await fx.addAccountless("Kind Fehlt", { birthDate: "2017-03-03", departmentId: fx.deptA });
    await db.insert(absenceReports).values({ clubId: fx.clubId, clubMemberId: absentKid, kind: "krank", startsOn: day(new Date(Date.now() - 2 * 86_400_000)), endsOn: day(new Date(Date.now() + 5 * 86_400_000)), note: "Grippe" });
    eventA = (await fx.addEvent({ calendarId: fx.calA, startsAt: new Date(Date.now() - HOUR), endsAt: new Date(Date.now() + HOUR) })).id;
    eventB = (await fx.addEvent({ calendarId: fx.calB, startsAt: new Date(Date.now() - HOUR) })).id;
  }, 60_000);
  afterAll(async () => fx.cleanup());

  const get = (who: { cookie: string }, id: string) => fx.req(who, `/events/${id}/attendance`);
  const put = (who: { cookie: string }, id: string, body: unknown) => fx.req(who, `/events/${id}/attendance`, { method: "PUT", body });

  it("denies a plain member (403) and an outsider club (404); a department trainer only reads/writes own-department events", async () => {
    expect((await get(fx.users.member1, eventA)).status).toBe(403);
    expect((await put(fx.users.member1, eventA, { entries: [{ clubMemberId: kid, status: "anwesend" }] })).status).toBe(403);
    expect((await get(fx.users.outsider, eventA)).status).toBe(404);
    expect((await get(fx.users.trainerA, eventA)).status).toBe(200);
    expect((await get(fx.users.trainerA, eventB)).status).toBe(403);
    expect((await put(fx.users.trainerA, eventB, { entries: [{ clubMemberId: kid, status: "anwesend" }] })).status).toBe(403);
    expect((await get(fx.users.board, eventB)).status).toBe(200);
  });

  it("builds the roster from the department, includes members without account and pre-fills absence reports as entschuldigt without any reason", async () => {
    const res = await get(fx.users.trainerA, eventA);
    const { data } = await fx.json(res);
    const byId = new Map<string, any>(data.entries.map((e: any) => [e.clubMemberId, e])); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(byId.get(kid).hasAccount).toBe(false);
    expect(byId.get(kid).status).toBeNull();
    expect(byId.get(kid).isMinor).toBe(true);
    expect(byId.get(adult).isMinor).toBe(false);
    expect(byId.get(absentKid)).toMatchObject({ status: "entschuldigt", source: "meldung", prefilled: true });
    expect(JSON.stringify(data)).not.toMatch(/Grippe|krank/i);
    expect(data.summary.entschuldigt).toBe(1);
    expect(data.canWrite).toBe(true);
  });

  it("records a batch, warns about minors without supervision, takes supervisors and counts", async () => {
    const res = await put(fx.users.trainerA, eventA, { entries: [{ clubMemberId: kid, status: "anwesend" }, { clubMemberId: adult, status: "unentschuldigt" }, { guestName: "Probeschueler", status: "anwesend" }] });
    expect(res.status).toBe(200);
    const { data } = await fx.json(res);
    expect(data.summary).toMatchObject({ anwesend: 2, unentschuldigt: 1 });
    expect(data.supervisionWarning).toBe(true);
    expect(data.minorsPresent).toBe(1);
    expect(data.entries.find((e: any) => e.guestName === "Probeschueler")).toBeTruthy(); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(data.tracking).toBe(true);

    const sup = await fx.req(fx.users.trainerA, `/events/${eventA}/attendance/supervisors`, { method: "PUT", body: { clubMemberIds: [fx.users.trainerA.clubMemberId] } });
    expect(sup.status).toBe(200);
    expect((await fx.json(sup)).data.supervisionWarning).toBe(false);

    // Unknown / foreign club member and duplicates are refused.
    const bad = await put(fx.users.trainerA, eventA, { entries: [{ clubMemberId: crypto.randomUUID(), status: "anwesend" }] });
    expect(bad.status).toBe(422);
  });

  it("removes an entry again (status null) and keeps the absence pre-fill source meldung when stored", async () => {
    const res = await put(fx.users.trainerA, eventA, { entries: [{ clubMemberId: adult, status: null }, { clubMemberId: absentKid, status: "entschuldigt" }] });
    const { data } = await fx.json(res);
    expect(data.entries.find((e: any) => e.clubMemberId === adult).status).toBeNull(); // eslint-disable-line @typescript-eslint/no-explicit-any
    const rows = await db.select().from(eventAttendance).where(eq(eventAttendance.clubMemberId, absentKid));
    expect(rows[0]).toMatchObject({ status: "entschuldigt", source: "meldung" });
  });

  it("includes confirmed RSVPs on the roster", async () => {
    const guestParent = await fx.addAccountless("Nur Angemeldet");
    await db.insert(eventAttendees).values({ eventId: eventA, clubMemberId: guestParent, status: "angemeldet" });
    await db.insert(eventAttendees).values({ eventId: eventA, memberId: fx.users.member1.memberId, status: "angemeldet" });
    const { data } = await fx.json(await get(fx.users.board, eventA));
    const ids = data.entries.map((e: any) => e.clubMemberId); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(ids).toContain(guestParent);
    expect(ids).toContain(fx.users.member1.clubMemberId);
    expect(data.entries.find((e: any) => e.clubMemberId === guestParent).rsvp).toBe("angemeldet"); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  it("closes the list; later changes need a reason and are logged; closing twice is a 409", async () => {
    const close = await fx.req(fx.users.leaderA, `/events/${eventA}/attendance/close`, { method: "POST", body: { markOpenAs: "unentschuldigt" } });
    expect(close.status).toBe(200);
    const closed = (await fx.json(close)).data;
    expect(closed.closed).toBe(true);
    expect(closed.summary.offen).toBe(0);
    expect((await fx.req(fx.users.leaderA, `/events/${eventA}/attendance/close`, { method: "POST", body: {} })).status).toBe(409);

    const noReason = await put(fx.users.trainerA, eventA, { entries: [{ clubMemberId: kid, status: "entschuldigt" }] });
    expect(noReason.status).toBe(409);
    expect((await fx.json(noReason)).error.details.code).toBe("reason_required");
    const withReason = await put(fx.users.trainerA, eventA, { entries: [{ clubMemberId: kid, status: "entschuldigt" }], reason: "Eltern haben nachtraeglich abgesagt" });
    expect(withReason.status).toBe(200);
    const { data } = await fx.json(withReason);
    expect(data.corrections).toHaveLength(1);
    expect(data.corrections[0]).toMatchObject({ oldStatus: "anwesend", newStatus: "entschuldigt" });
  });

  it("does not let a trainer of another department or a member of the other club touch the list", async () => {
    await db.delete(clubMemberDepartments).where(eq(clubMemberDepartments.clubMemberId, kid));
    expect((await put(fx.users.outsider, eventA, { entries: [{ clubMemberId: kid, status: "anwesend" }] })).status).toBe(404);
  });
});
