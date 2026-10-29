import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { documentFolders, documentPermissions, documents } from "../db/schema/documents.js";
import { locations } from "../db/schema/locations.js";
import { clubOverviewRoutes } from "./club-overview.js";
import { createEventFixture, HOUR, type EventFixture } from "./event-test-support.js";

/** Wave 14 S2: GET /clubs/:clubId/search (rights per group, escaping, limits, club scoping). */
let fx: EventFixture;
type Hit = { id: string; title?: string; name?: string; startsAt?: string; folderId?: string | null; departmentNames?: string[] };
type Search = { members?: Hit[]; events: Hit[]; documents: Hit[]; locations: Hit[] };
const search = (who: { cookie: string }, qs: string, club = fx.clubId) => fx.req(who, `/clubs/${club}/search${qs}`);
const data = async (res: Response) => (await fx.json<{ data: Search }>(res)).data;
let boardFolder: string;

beforeAll(async () => {
  fx = await createEventFixture("search", [["/clubs", clubOverviewRoutes]]);
  const [folder] = await db.insert(documentFolders).values({ clubId: fx.clubId, name: "Vorstand" }).returning();
  boardFolder = folder!.id;
  await db.insert(documentPermissions).values({ clubId: fx.clubId, folderId: boardFolder, subjectType: "rolle", roleType: "vorsitz", level: "lesen" });
  const [open] = await db.insert(documentFolders).values({ clubId: fx.clubId, name: "Offen" }).returning();
  await db.insert(documentPermissions).values({ clubId: fx.clubId, folderId: open!.id, subjectType: "rolle", roleType: "mitglied", level: "lesen" });
  const doc = (title: string, folderId: string | null, extra: Partial<typeof documents.$inferInsert> = {}) => ({ clubId: fx.clubId, scope: "verein", folderId, kind: "upload", title, ...extra });
  await db.insert(documents).values([
    doc("Zeltplan Sommer", open!.id),
    doc("Zeltplan Vorstand", boardFolder),
    doc("Zeltplan Papierkorb", open!.id, { status: "papierkorb", trashedAt: new Date() }),
    doc("Rabatt 100% Zelt", open!.id),
  ]);
  await db.insert(locations).values([{ clubId: fx.clubId, name: "Zeltplatz" }, { clubId: fx.otherClubId, name: "Zeltplatz Fremd" }]);
  await fx.addEvent({ calendarId: fx.calClub, title: "Zeltlager", startsAt: new Date(Date.now() + 48 * HOUR) });
  await fx.addEvent({ calendarId: fx.otherCalendar, title: "Zeltlager Fremd", startsAt: new Date(Date.now() + 48 * HOUR) });
  await db.insert(clubMembers).values([
    { clubId: fx.clubId, displayName: "Zelda Aktiv", status: "aktiv", joinedAt: "2020-01-01" },
    { clubId: fx.clubId, displayName: "Zelda Ehemalig", status: "ausgetreten", joinedAt: "2010-01-01", leftAt: "2015-01-01" },
  ]);
}, 60_000);
afterAll(async () => fx.cleanup());

describe("GET /clubs/:clubId/search", () => {
  it("rejects short queries with QUERY_TOO_SHORT and keeps unknown limits harmless", async () => {
    for (const qs of ["", "?q=", "?q=a", "?q=%20a%20"]) {
      const res = await search(fx.users.member1, qs);
      expect(res.status, qs).toBe(400);
      const body = await fx.json<{ error: { code: string; details: { code: string } } }>(res);
      expect(body.error.code).toBe("QUERY_TOO_SHORT");
      expect(body.error.details.code).toBe("query_too_short");
    }
    expect((await search(fx.users.member1, "?q=ze&limit=abc")).status).toBe(200);
  });

  it("is 404 for a foreign club and 401 without a session", async () => {
    expect((await search(fx.users.outsider, "?q=zelt")).status).toBe(404);
    expect((await fx.app.request(`/clubs/${fx.clubId}/search?q=zelt`)).status).toBe(401);
  });

  it("finds in all groups for a plain member within their rights, never trash, board folders or foreign clubs", async () => {
    const res = await search(fx.users.member1, "?q=zelt");
    expect(res.headers.get("cache-control")).toContain("private");
    const body = await data(res);
    expect(body.events.map((e) => e.title)).toEqual(["Zeltlager"]);
    expect(body.locations.map((l) => l.name)).toEqual(["Zeltplatz"]);
    expect(body.documents.map((d) => d.title).sort()).toEqual(["Rabatt 100% Zelt", "Zeltplan Sommer"]);
    expect(body.documents[0]).toHaveProperty("folderId");
    expect(body.members).toEqual([]);
  });

  it("shows board folders only to the board and hides trash from everyone", async () => {
    const body = await data(await search(fx.users.board, "?q=zeltplan"));
    expect(body.documents.map((d) => d.title).sort()).toEqual(["Zeltplan Sommer", "Zeltplan Vorstand"].sort());
    expect(body.documents.map((d) => d.title)).not.toContain("Zeltplan Papierkorb");
  });

  it("applies the member list visibility: former members only for member managers, departments listed", async () => {
    const plain = await data(await search(fx.users.member1, "?q=zelda"));
    expect(plain.members!.map((m) => m.name)).toEqual(["Zelda Aktiv"]);
    const board = await data(await search(fx.users.board, "?q=zelda"));
    expect(board.members!.map((m) => m.name)).toEqual(["Zelda Aktiv", "Zelda Ehemalig"]);
    await fx.addAccountless("Zora Sport", { departmentId: fx.deptA });
    const withDept = await data(await search(fx.users.member1, "?q=zora"));
    expect(withDept.members).toEqual([{ id: expect.any(String), name: "Zora Sport", departmentNames: ["Abteilung A"] }]);
  });

  it("escapes LIKE metacharacters and honours limit", async () => {
    expect((await data(await search(fx.users.member1, "?q=100%25"))).documents.map((d) => d.title)).toEqual(["Rabatt 100% Zelt"]);
    expect((await data(await search(fx.users.member1, "?q=__"))).documents).toEqual([]);
    expect((await data(await search(fx.users.member1, "?q=%25%25"))).documents).toEqual([]);
    for (let i = 0; i < 12; i += 1) await db.insert(locations).values({ clubId: fx.clubId, name: `Halle ${i}` });
    expect((await data(await search(fx.users.member1, "?q=halle"))).locations).toHaveLength(5);
    expect((await data(await search(fx.users.member1, "?q=halle&limit=50"))).locations).toHaveLength(10);
    expect((await data(await search(fx.users.member1, "?q=halle&limit=2"))).locations).toHaveLength(2);
  });

  it("omits members and documents for external guests", async () => {
    const guest = await fx.addGuest("Gast Suche");
    const body = await data(await search(guest, "?q=zelt"));
    expect(body.members).toBeUndefined();
    expect(body.documents).toEqual([]);
    expect(body.locations.map((l) => l.name)).toEqual(["Zeltplatz"]);
  });
});
