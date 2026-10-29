import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { clubOverviewRoutes } from "./club-overview.js";
import { createEventFixture, HOUR, type EventFixture } from "./event-test-support.js";

/** Wave 14 N2/S2: GET /clubs/:clubId/today (scoped to the caller, `board`/`setup` only with the matching permission). */
let fx: EventFixture;
type Today = {
  generatedAt: string;
  openRsvps: Array<{ eventId: string; title: string; startsAt: string }>;
  cancelled: Array<{ eventId: string; title: string; startsAt: string }>;
  unreadAnnouncements: number;
  dueReturns: Array<{ loanId: string; itemName: string; dueAt: string }>;
  openBallots: number;
  board?: Record<string, number>;
  setup?: { done: string[]; open: string[] };
};
const today = async (who: { cookie: string }, club = fx.clubId) => fx.req(who, `/clubs/${club}/today`);

beforeAll(async () => {
  fx = await createEventFixture("today", [["/clubs", clubOverviewRoutes]]);
}, 60_000);
afterAll(async () => fx.cleanup());

describe("GET /clubs/:clubId/today", () => {
  it("answers 404 for a foreign club and 401 without a session", async () => {
    expect((await today(fx.users.outsider)).status).toBe(404);
    expect((await fx.app.request(`/clubs/${fx.clubId}/today`)).status).toBe(401);
  });

  it("lists open RSVPs, drops answered and out-of-window events, and lists cancellations", async () => {
    const open = await fx.addEvent({ calendarId: fx.calClub, title: "Offen", startsAt: new Date(Date.now() + 2 * HOUR) });
    const answered = await fx.addEvent({ calendarId: fx.calClub, title: "Zugesagt", startsAt: new Date(Date.now() + 3 * HOUR) });
    await fx.addEvent({ calendarId: fx.calClub, title: "Zu spaet", startsAt: new Date(Date.now() + 20 * 24 * HOUR) });
    await fx.addEvent({ calendarId: fx.calClub, title: "Vorbei", startsAt: new Date(Date.now() - 5 * HOUR) });
    const cancelled = await fx.addEvent({ calendarId: fx.calClub, title: "Abgesagt", startsAt: new Date(Date.now() + 4 * HOUR), cancelledAt: new Date() });
    await db.insert(eventAttendees).values({ eventId: answered.id, memberId: fx.users.member1.memberId, status: "angemeldet" });

    const body = await fx.json<{ data: Today }>(await today(fx.users.member1));
    const titles = body.data.openRsvps.map((e) => e.title);
    expect(titles).toContain("Offen");
    expect(titles).not.toContain("Zugesagt");
    expect(titles).not.toContain("Zu spaet");
    expect(titles).not.toContain("Vorbei");
    expect(titles).not.toContain("Abgesagt");
    expect(body.data.openRsvps.find((e) => e.eventId === open.id)).toMatchObject({ eventId: open.id, title: "Offen" });
    expect(body.data.cancelled.map((e) => e.eventId)).toEqual([cancelled.id]);
    expect(typeof body.data.generatedAt).toBe("string");
    // Another member still has "Zugesagt" open: the answer is per caller.
    const other = await fx.json<{ data: Today }>(await today(fx.users.member2));
    expect(other.data.openRsvps.map((e) => e.title)).toContain("Zugesagt");
  });

  it("caps the lists at 10", async () => {
    for (let i = 0; i < 12; i += 1) await fx.addEvent({ calendarId: fx.calClub, title: `Massen ${i}`, startsAt: new Date(Date.now() + (10 + i) * HOUR) });
    const body = await fx.json<{ data: Today }>(await today(fx.users.member2));
    expect(body.data.openRsvps).toHaveLength(10);
  });

  it("hides events of calendars the caller cannot see", async () => {
    await fx.addEvent({ calendarId: fx.otherCalendar, title: "Fremder Verein", startsAt: new Date(Date.now() + HOUR) });
    const body = await fx.json<{ data: Today }>(await today(fx.users.member1));
    expect(body.data.openRsvps.map((e) => e.title)).not.toContain("Fremder Verein");
  });

  it("lists own loans due within 3 days or overdue only", async () => {
    const [item] = await db.insert(inventoryItems).values({ clubId: fx.clubId, name: "Beamer", condition: "gut" }).returning();
    const [other] = await db.insert(inventoryItems).values({ clubId: fx.clubId, name: "Zelt", condition: "gut" }).returning();
    const [soon] = await db.insert(inventoryLoans).values({ itemId: item!.id, memberId: fx.users.member1.memberId, dueAt: new Date(Date.now() + 24 * HOUR) }).returning();
    await db.insert(inventoryLoans).values({ itemId: other!.id, memberId: fx.users.member1.memberId, dueAt: new Date(Date.now() + 10 * 24 * HOUR) });
    await db.insert(inventoryLoans).values({ itemId: other!.id, memberId: fx.users.member2.memberId, dueAt: new Date(Date.now() - HOUR) });
    const body = await fx.json<{ data: Today }>(await today(fx.users.member1));
    expect(body.data.dueReturns).toEqual([{ loanId: soon!.id, itemName: "Beamer", dueAt: expect.any(String) }]);
  });

  it("shows the board block only with the matching permissions", async () => {
    const [applicant] = [fx.users.member2];
    await db.insert(clubApplications).values({ userId: applicant.userId, clubId: fx.clubId, status: "pending", onBehalfOf: "guardian" });
    const plain = await fx.json<{ data: Today }>(await today(fx.users.member1));
    expect(plain.data.board).toBeUndefined();
    expect(plain.data.setup).toBeUndefined();

    const board = await fx.json<{ data: Today }>(await today(fx.users.board));
    expect(board.data.board).toMatchObject({ openApplications: expect.any(Number), openExits: 0, maintenanceDue: 0, memberCount: expect.any(Number) });
    expect(board.data.board!.openApplications).toBeGreaterThanOrEqual(1);
    expect(board.data.setup?.open).toEqual(["logo", "location"]);
    expect(board.data.setup?.done).toEqual(expect.arrayContaining(["departments", "calendar", "members"]));
    expect(board.data.setup?.open).toContain("location");

    // A trainer holds none of members:write / inventory:write / club_stats:read / club_info:write.
    const trainer = await fx.json<{ data: Today }>(await today(fx.users.trainerA));
    expect(trainer.data.board).toBeUndefined();
    expect(trainer.data.setup).toBeUndefined();
  });

  it("gives external guests an empty personal part and never a board block", async () => {
    const guest = await fx.addGuest("Gast Heute");
    const body = await fx.json<{ data: Today }>(await today(guest));
    expect(body.data.openBallots).toBe(0);
    expect(body.data.board).toBeUndefined();
    expect(body.data.openRsvps).toEqual([]);
  });

  it("keeps the Cache-Control private", async () => {
    expect((await today(fx.users.member1)).headers.get("cache-control")).toContain("private");
    await db.delete(eventAttendees).where(eq(eventAttendees.memberId, fx.users.member1.memberId));
  });
});
