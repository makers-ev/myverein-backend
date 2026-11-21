import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { mediaFiles } from "../db/schema/media-files.js";
import { sponsors } from "../db/schema/sponsors.js";
import { makePng, PDF_BYTES } from "../lib/media-fixtures.js";
import { daysLeft, isExpiringSoon, sponsorStatus } from "../lib/sponsors.js";
import { createClub, dropClubs, installErrorHandler, requester } from "./forms-test-support.js";
import { mediaRoutes } from "./media.js";
import { sponsorRoutes } from "./sponsors.js";

/**
 * Sponsors and partners (Wave 15 B1): deny-by-default rights (read = board, write = sponsors:write), derived status, logo
 * through the media layer (private, signed URL only), contacts, audit.
 */

const app = new Hono();
app.route("/sponsors", sponsorRoutes);
app.route("/media", mediaRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const json = async (res: Response) => (await res.json()) as any;
const file = (bytes: Buffer, name: string, type: string) => new File([new Uint8Array(bytes)], name, { type });
const form = (f: File) => {
  const fd = new FormData();
  fd.append("file", f);
  return fd;
};

const isoOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe("sponsor status (pure)", () => {
  const today = "2026-06-15";
  it("derives planned / active / expired from the Berlin day", () => {
    expect(sponsorStatus({ startsOn: "2026-07-01", endsOn: null }, today)).toBe("geplant");
    expect(sponsorStatus({ startsOn: null, endsOn: null }, today)).toBe("aktiv");
    expect(sponsorStatus({ startsOn: "2026-01-01", endsOn: "2026-06-15" }, today)).toBe("aktiv");
    expect(sponsorStatus({ startsOn: "2026-01-01", endsOn: "2026-06-14" }, today)).toBe("abgelaufen");
  });
  it("flags active partnerships ending inside the window", () => {
    expect(daysLeft({ startsOn: null, endsOn: "2026-06-25" }, today)).toBe(10);
    expect(isExpiringSoon({ startsOn: null, endsOn: "2026-06-25" }, today, 30)).toBe(true);
    expect(isExpiringSoon({ startsOn: null, endsOn: "2026-09-25" }, today, 30)).toBe(false);
    expect(isExpiringSoon({ startsOn: null, endsOn: null }, today, 30)).toBe(false);
    expect(isExpiringSoon({ startsOn: null, endsOn: "2026-06-01" }, today, 30)).toBe(false);
  });
});

describe("sponsors API", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let other: Awaited<ReturnType<typeof createClub>>;

  beforeAll(async () => {
    club = await createClub("sponsor", suffix, { kasse: "kassenwart", beisitz: "beisitzer", trainer: "trainer", plain: null });
    other = await createClub("sponsor-other", suffix);
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId, other.clubId], [...club.userIds, ...other.userIds]);
    await closeDatabase();
  });

  it("is deny-by-default: plain members and trainers neither read nor write, beisitzer only reads", async () => {
    for (const who of [club.members.plain!, club.members.trainer!]) {
      expect((await call(who, "/sponsors", { clubId: club.clubId })).status).toBe(403);
      expect((await call(who, "/sponsors", { method: "POST", body: { name: "X" }, clubId: club.clubId })).status).toBe(403);
    }
    expect((await call(club.members.beisitz!, "/sponsors", { clubId: club.clubId })).status).toBe(200);
    expect((await call(club.members.beisitz!, "/sponsors", { method: "POST", body: { name: "X" }, clubId: club.clubId })).status).toBe(403);
  });

  it("creates sponsors with contacts, derives status and filters", async () => {
    const kasse = club.members.kasse!;
    const created = await call(kasse, "/sponsors", {
      method: "POST",
      clubId: club.clubId,
      body: { name: "Bäckerei Korn", website: "https://korn.example", consideration: "Bandenwerbung", startsOn: isoOffset(-100), endsOn: isoOffset(10), visibility: "oeffentlich", notes: "intern", contacts: [{ name: "Erika Korn", email: "Erika@Korn.example", isPrimary: true }, { name: "Max Korn", isPrimary: true }] },
    });
    expect(created.status).toBe(201);
    const body = (await json(created)).data;
    expect(body).toMatchObject({ name: "Bäckerei Korn", status: "aktiv", expiringSoon: true, daysLeft: 10, visibility: "oeffentlich", logoUrl: null, linkedAccount: null });
    expect(body.contacts).toHaveLength(2);
    expect(body.contacts.filter((x: { isPrimary: boolean }) => x.isPrimary)).toHaveLength(1);
    expect(body.contacts.find((x: { name: string }) => x.name === "Erika Korn").email).toBe("erika@korn.example");

    await call(kasse, "/sponsors", { method: "POST", clubId: club.clubId, body: { name: "Alt GmbH", startsOn: isoOffset(-400), endsOn: isoOffset(-5) } });
    await call(kasse, "/sponsors", { method: "POST", clubId: club.clubId, body: { name: "Zukunft AG", startsOn: isoOffset(30) } });

    const names = async (q: string) => (await json(await call(kasse, `/sponsors${q}`, { clubId: club.clubId }))).data.map((s: { name: string }) => s.name);
    expect(await names("?status=abgelaufen")).toEqual(["Alt GmbH"]);
    expect(await names("?status=geplant")).toEqual(["Zukunft AG"]);
    expect(await names("?status=laeuft_aus")).toEqual(["Bäckerei Korn"]);
    expect(await names("?visibility=oeffentlich")).toEqual(["Bäckerei Korn"]);
    expect(await names("?q=korn")).toEqual(["Bäckerei Korn"]);

    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "sponsor.create"), eq(auditLog.subjectId, body.id)));
    expect(audit?.clubId).toBe(club.clubId);
  });

  it("validates links and periods", async () => {
    const kasse = club.members.kasse!;
    expect((await call(kasse, "/sponsors", { method: "POST", clubId: club.clubId, body: { name: "X", website: "javascript:alert(1)" } })).status).toBe(422);
    expect((await call(kasse, "/sponsors", { method: "POST", clubId: club.clubId, body: { name: "X", startsOn: "2026-05-01", endsOn: "2026-04-01" } })).status).toBe(422);
    const [row] = await db.select().from(sponsors).where(and(eq(sponsors.clubId, club.clubId), eq(sponsors.name, "Zukunft AG")));
    const res = await call(kasse, `/sponsors/${row!.id}`, { method: "PATCH", clubId: club.clubId, body: { endsOn: isoOffset(1) } });
    expect(res.status).toBe(422);
    expect((await json(res)).error.details.code).toBe("invalid_period");
  });

  it("updates, scopes ids to the club and deletes", async () => {
    const kasse = club.members.kasse!;
    const [row] = await db.select().from(sponsors).where(and(eq(sponsors.clubId, club.clubId), eq(sponsors.name, "Alt GmbH")));
    const patched = await call(kasse, `/sponsors/${row!.id}`, { method: "PATCH", clubId: club.clubId, body: { endsOn: null, visibility: "oeffentlich" } });
    expect((await json(patched)).data).toMatchObject({ status: "aktiv", visibility: "oeffentlich", endsOn: null });
    // Another club's board cannot see or touch it.
    expect((await call(other.founder, `/sponsors/${row!.id}`, { clubId: other.clubId })).status).toBe(404);
    expect((await call(other.founder, `/sponsors/${row!.id}`, { method: "DELETE", clubId: other.clubId })).status).toBe(404);
    expect((await call(kasse, `/sponsors/${row!.id}`, { method: "DELETE", clubId: club.clubId })).status).toBe(204);
    expect((await call(kasse, `/sponsors/${row!.id}`, { clubId: club.clubId })).status).toBe(404);
  });

  it("stores the logo in the media layer (private, signed URL only) and replaces it", async () => {
    const kasse = club.members.kasse!;
    const [row] = await db.select().from(sponsors).where(and(eq(sponsors.clubId, club.clubId), eq(sponsors.name, "Bäckerei Korn")));
    expect((await call(kasse, `/sponsors/${row!.id}/logo`, { method: "PUT", clubId: club.clubId, form: form(file(PDF_BYTES, "x.pdf", "application/pdf")) })).status).toBe(422);
    expect((await call(club.members.beisitz!, `/sponsors/${row!.id}/logo`, { method: "PUT", clubId: club.clubId, form: form(file(makePng(), "l.png", "image/png")) })).status).toBe(403);

    const first = await call(kasse, `/sponsors/${row!.id}/logo`, { method: "PUT", clubId: club.clubId, form: form(file(makePng(), "logo.png", "image/png")) });
    expect(first.status).toBe(200);
    const firstUrl: string = (await json(first)).data.logoUrl;
    expect(firstUrl).toMatch(/\/media\/.+\?exp=\d+&sig=[0-9a-f]{64}$/);
    const [stored] = await db.select().from(sponsors).where(eq(sponsors.id, row!.id));
    const [media] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, stored!.logoKey!));
    expect(media).toMatchObject({ ownerType: "sponsor_logo", ownerId: row!.id, visibility: "private", sensitive: false, kind: "image" });

    // Unsigned: no access (private file); signed: served.
    const path = new URL(firstUrl).pathname;
    expect((await app.request(path)).status).toBe(403);
    const signed = await app.request(new URL(firstUrl).pathname + new URL(firstUrl).search);
    expect(signed.status).toBe(200);
    expect(signed.headers.get("cache-control")).toMatch(/^private/);

    const second = await call(kasse, `/sponsors/${row!.id}/logo`, { method: "PUT", clubId: club.clubId, form: form(file(makePng(), "logo2.png", "image/png")) });
    expect(second.status).toBe(200);
    const [old] = await db.select().from(mediaFiles).where(eq(mediaFiles.storageKey, stored!.logoKey!));
    expect(old!.deletedAt).not.toBeNull();

    expect((await call(kasse, `/sponsors/${row!.id}/logo`, { method: "DELETE", clubId: club.clubId })).status).toBe(204);
    const [cleared] = await db.select().from(sponsors).where(eq(sponsors.id, row!.id));
    expect(cleared!.logoKey).toBeNull();
  });

  it("manages contacts with a single primary contact", async () => {
    const kasse = club.members.kasse!;
    const [row] = await db.select().from(sponsors).where(and(eq(sponsors.clubId, club.clubId), eq(sponsors.name, "Bäckerei Korn")));
    const added = await call(kasse, `/sponsors/${row!.id}/contacts`, { method: "POST", clubId: club.clubId, body: { name: "Neu Kontakt", role: "Marketing", isPrimary: true } });
    expect(added.status).toBe(201);
    const contactId = (await json(added)).data.id;
    const list = (await json(await call(kasse, `/sponsors/${row!.id}`, { clubId: club.clubId }))).data.contacts;
    expect(list.filter((x: { isPrimary: boolean }) => x.isPrimary).map((x: { id: string }) => x.id)).toEqual([contactId]);
    expect((await call(kasse, `/sponsors/${row!.id}/contacts/${contactId}`, { method: "PATCH", clubId: club.clubId, body: { phone: "0123" } })).status).toBe(200);
    expect((await call(kasse, `/sponsors/${row!.id}/contacts/${contactId}`, { method: "DELETE", clubId: club.clubId })).status).toBe(204);
    expect((await call(kasse, `/sponsors/${row!.id}/contacts/${contactId}`, { method: "DELETE", clubId: club.clubId })).status).toBe(404);
  });
});
