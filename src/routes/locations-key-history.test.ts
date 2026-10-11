import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubMembers } from "../db/schema/club-members.js";
import { locationKeyHistory, locationKeyHolders } from "../db/schema/locations.js";
import { unlinkAccount } from "../lib/member-invites.js";
import { toAppError } from "../lib/errors.js";
import { locationRoutes } from "./locations.js";

/** Wave 7 B14: key handover history (written by the key-holder routes, read with locations:read_access) and the WLAN security type. */

const app = new Hono();
app.route("/locations", locationRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Actor = { userId: string; cookie: string; memberId: string };

async function signUp(label: string): Promise<{ userId: string; cookie: string }> {
  const email = `loc-b14-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Name ${label}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0] };
}

describe("location key history and wifi security (B14)", () => {
  let clubId: string;
  let otherClubId: string;
  let board: Actor;
  let leader: Actor; // abteilungsleitung: locations:read_access, no write
  let plain: Actor;
  let guest: Actor;
  let holder: Actor;
  let outsider: { userId: string; cookie: string };
  let locationId: string;
  const userIds: string[] = [];

  const call = (who: { cookie: string }, path: string, init: { method?: string; body?: unknown; club?: string } = {}) =>
    app.request(`/locations${path}${path.includes("?") ? "&" : "?"}clubId=${init.club ?? clubId}`, {
      method: init.method ?? "GET",
      headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
    });
  const json = async (res: Response) => (await res.json()) as Json;
  const history = async (query = "") => json(await call(board, `/${locationId}/key-history${query}`));

  async function join(label: string, role: "member" | "guest", clubRole?: string): Promise<Actor> {
    const base = await signUp(label);
    userIds.push(base.userId);
    await auth.api.addMember({ body: { userId: base.userId, organizationId: clubId, role } });
    const m = (await db.query.member.findFirst({ where: (t, { and, eq }) => and(eq(t.organizationId, clubId), eq(t.userId, base.userId)) }))!;
    if (clubRole) await db.insert(clubRoles).values({ memberId: m.id, roleType: clubRole });
    return { ...base, memberId: m.id };
  }

  beforeAll(async () => {
    const founder = await signUp("board");
    outsider = await signUp("outsider");
    userIds.push(founder.userId, outsider.userId);
    clubId = (await auth.api.createOrganization({ body: { name: `B14 ${suffix}`, slug: `b14-${suffix}`, userId: founder.userId } }))!.id;
    otherClubId = (await auth.api.createOrganization({ body: { name: `B14 other ${suffix}`, slug: `b14-other-${suffix}`, userId: outsider.userId } }))!.id;
    const boardMember = (await db.query.member.findFirst({ where: (t, { and, eq }) => and(eq(t.organizationId, clubId), eq(t.userId, founder.userId)) }))!;
    await db.insert(clubRoles).values({ memberId: boardMember.id, roleType: "vorsitz" });
    board = { ...founder, memberId: boardMember.id };
    leader = await join("leader", "member", "abteilungsleitung");
    plain = await join("plain", "member");
    guest = await join("guest", "guest");
    holder = await join("holder", "member");

    const loc = await call(board, "", { method: "POST", body: { name: "Vereinsheim" } });
    locationId = (await json(loc)).data.id;
  }, 60_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    await db.delete(organization).where(eq(organization.id, otherClubId));
    for (const id of userIds) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  describe("key history", () => {
    it("records who received a key, when, which key and the note when a key holder is added", async () => {
      const res = await call(board, `/${locationId}/key-holders`, { method: "POST", body: { memberId: holder.memberId, keyLabel: "Schluessel Nr. 3", note: "Gegen Unterschrift" } });
      expect(res.status).toBe(201);
      expect((await json(res)).data).toMatchObject({ memberId: holder.memberId, keyLabel: "Schluessel Nr. 3" });

      const { data, total } = await history();
      expect(total).toBe(1);
      expect(data[0]).toMatchObject({
        action: "issued",
        memberId: holder.memberId,
        memberName: "Name holder",
        keyLabel: "Schluessel Nr. 3",
        note: "Gegen Unterschrift",
        recordedBy: board.memberId,
        recordedByName: "Name board",
      });
      expect(new Date(data[0].createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(data[0]).not.toHaveProperty("locationId");
    });

    it("does not write a history entry for a rejected duplicate and keeps holder + history consistent", async () => {
      const dup = await call(board, `/${locationId}/key-holders`, { method: "POST", body: { memberId: holder.memberId } });
      expect(dup.status).toBe(409);
      expect((await history()).total).toBe(1);
      const foreign = await call(board, `/${locationId}/key-holders`, { method: "POST", body: { memberId: "does-not-exist" } });
      expect(foreign.status).toBe(422);
      expect((await history()).total).toBe(1);
    });

    it("records the return with the key label of the issue and an optional note", async () => {
      const res = await call(board, `/${locationId}/key-holders/${holder.memberId}`, { method: "DELETE", body: { note: "Zurueck, Schloss getauscht" } });
      expect(res.status).toBe(204);
      const { data, total } = await history();
      expect(total).toBe(2);
      expect(data[0]).toMatchObject({ action: "returned", memberId: holder.memberId, keyLabel: "Schluessel Nr. 3", note: "Zurueck, Schloss getauscht", recordedBy: board.memberId });
      expect(data[1].action).toBe("issued"); // newest first
    });

    it("accepts a DELETE without body, rejects a malformed one without changing anything", async () => {
      await call(board, `/${locationId}/key-holders`, { method: "POST", body: { memberId: holder.memberId } });
      const bad = await call(board, `/${locationId}/key-holders/${holder.memberId}`, { method: "DELETE", body: "{not json" });
      expect(bad.status).toBe(422);
      const tooLong = await call(board, `/${locationId}/key-holders/${holder.memberId}`, { method: "DELETE", body: { note: "x".repeat(501) } });
      expect(tooLong.status).toBe(422);
      expect((await history()).total).toBe(3);
      expect((await call(board, `/${locationId}/key-holders/${holder.memberId}`, { method: "DELETE" })).status).toBe(204);
      const { data, total } = await history();
      expect(total).toBe(4);
      expect(data[0]).toMatchObject({ action: "returned", note: null, keyLabel: null });
      expect((await call(board, `/${locationId}/key-holders/${holder.memberId}`, { method: "DELETE" })).status).toBe(404);
      expect((await history()).total).toBe(4);
    });

    it("keeps the audit trail free of notes and names", async () => {
      const audits = (await db.select().from(auditLog)).filter((a) => a.eventType.startsWith("location_key_holder.") && (a.payload as Json | null)?.locationId === locationId);
      expect(audits.length).toBe(4);
      expect(JSON.stringify(audits.map((a) => a.payload))).not.toMatch(/Unterschrift|Schloss|Name holder/);
    });

    it("filters by member and pages the result", async () => {
      expect((await history(`?memberId=${holder.memberId}`)).total).toBe(4);
      expect((await history("?memberId=nobody")).total).toBe(0);
      const page = await history("?pageSize=3&page=2");
      expect(page).toMatchObject({ page: 2, pageSize: 3, total: 4 });
      expect(page.data).toHaveLength(1);
      expect((await call(board, `/${locationId}/key-history?pageSize=0`)).status).toBe(422);
    });

    it("is access info: locations:write / locations:read_access (abteilungsleitung) may read it, plain members and guests may not, other clubs get 404", async () => {
      expect((await call(leader, `/${locationId}/key-history`)).status).toBe(200);
      expect((await call(plain, `/${locationId}/key-history`)).status).toBe(403);
      expect((await call(guest, `/${locationId}/key-history`)).status).toBe(403);
      expect((await call(outsider, `/${locationId}/key-history`)).status).toBe(404); // no member of this club at all
      expect((await call(outsider, `/${locationId}/key-history`, { club: otherClubId })).status).toBe(403); // no access rights in the own club
      const outsiderMember = (await db.query.member.findFirst({ where: (t, { and, eq }) => and(eq(t.organizationId, otherClubId), eq(t.userId, outsider.userId)) }))!;
      await db.insert(clubRoles).values({ memberId: outsiderMember.id, roleType: "vorsitz" });
      expect((await call(outsider, `/${locationId}/key-history`, { club: otherClubId })).status).toBe(404); // foreign location id: IDOR
    });

    it("only locations:write may issue or take back keys", async () => {
      for (const who of [plain, guest]) {
        expect((await call(who, `/${locationId}/key-holders`, { method: "POST", body: { memberId: holder.memberId } })).status).toBe(403);
        expect((await call(who, `/${locationId}/key-holders/${holder.memberId}`, { method: "DELETE" })).status).toBe(403);
      }
      expect((await history()).total).toBe(4);
    });

    it("rejects an oversized DELETE body", async () => {
      const res = await call(board, `/${locationId}/key-holders/${holder.memberId}`, { method: "DELETE", body: JSON.stringify({ note: "x".repeat(10_000) }) });
      expect(res.status).toBe(422);
    });

    it("writes a 'returned' entry (note 'Konto entfernt') when an account is unlinked while it holds a key", async () => {
      const keeper = await join("keeper", "member");
      await call(board, `/${locationId}/key-holders`, { method: "POST", body: { memberId: keeper.memberId, keyLabel: "Nr. 9" } });
      const clubMember = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, keeper.memberId) }))!;
      await unlinkAccount(clubId, clubMember.id, board.memberId, true, ["vorsitz"]);
      const rows = (await db.select().from(locationKeyHistory).where(eq(locationKeyHistory.locationId, locationId))).filter((r) => r.memberName === "Name keeper");
      expect(rows.map((r) => r.action).sort()).toEqual(["issued", "returned"]);
      expect(rows.find((r) => r.action === "returned")).toMatchObject({ note: "Konto entfernt", keyLabel: "Nr. 9", recordedBy: board.memberId });
      expect(await db.query.locationKeyHolders.findFirst({ where: eq(locationKeyHolders.memberId, keeper.memberId) })).toBeUndefined();
    });

    it("keeps history entries when the account is removed (names are snapshots), and drops them with the location", async () => {
      const temp = await join("temp", "member");
      await call(board, `/${locationId}/key-holders`, { method: "POST", body: { memberId: temp.memberId } });
      await db.delete(user).where(eq(user.id, temp.userId));
      const rows = await db.select().from(locationKeyHistory).where(eq(locationKeyHistory.locationId, locationId));
      const mine = rows.filter((r) => r.memberName === "Name temp");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.memberId).toBeNull();

      const loc = await json(await call(board, "", { method: "POST", body: { name: "Kurzlebig" } }));
      await call(board, `/${loc.data.id}/key-holders`, { method: "POST", body: { memberId: board.memberId } });
      await call(board, `/${loc.data.id}`, { method: "DELETE" });
      expect(await db.select().from(locationKeyHistory).where(eq(locationKeyHistory.locationId, loc.data.id))).toHaveLength(0);
    });
  });

  describe("key holders with names", () => {
    it("shows memberName (club member, also departed) and keyLabel to write/read_access callers, nothing to plain members", async () => {
      const gone = await join("gone", "member");
      const loc = (await json(await call(board, "", { method: "POST", body: { name: "Mit Namen" } }))).data.id as string;
      await call(board, `/${loc}/key-holders`, { method: "POST", body: { memberId: gone.memberId, keyLabel: "Nr. 7" } });
      await call(board, `/${loc}/key-holders`, { method: "POST", body: { memberId: leader.memberId } });
      await db.update(clubMembers).set({ status: "ausgetreten", displayName: "Gone Person" }).where(eq(clubMembers.memberId, gone.memberId));

      const asBoard = (await json(await call(board, `/${loc}`))).data.keyHolders as Json[];
      expect(asBoard.find((k) => k.memberId === gone.memberId)).toMatchObject({ memberName: "Gone Person", keyLabel: "Nr. 7" });
      expect(asBoard.find((k) => k.memberId === leader.memberId)).toMatchObject({ keyLabel: null });
      const asLeader = (await json(await call(leader, `/${loc}`))).data.keyHolders as Json[];
      expect(asLeader).toHaveLength(2);

      const asPlain = (await json(await call(plain, `/${loc}`))).data;
      expect(asPlain.keyHolders).toEqual([]);
      expect(asPlain.accessRestricted).toBe(true);
    });

    it("falls back to the key-history snapshot name, else null, when no club member row exists", async () => {
      const noRow = await join("norow", "member");
      const loc = (await json(await call(board, "", { method: "POST", body: { name: "Ohne Mitglied" } }))).data.id as string;
      await call(board, `/${loc}/key-holders`, { method: "POST", body: { memberId: noRow.memberId } });
      await db.delete(clubMembers).where(eq(clubMembers.memberId, noRow.memberId));
      let holders = (await json(await call(board, `/${loc}`))).data.keyHolders as Json[];
      expect(holders[0]!.memberName).toBe("Name norow");

      await db.delete(locationKeyHistory).where(eq(locationKeyHistory.locationId, loc));
      holders = (await json(await call(board, `/${loc}`))).data.keyHolders as Json[];
      expect(holders[0]!.memberName).toBeNull();
    });
  });

  describe("wifi security type", () => {
    const wifi = (body: Json) => call(board, `/${locationId}/wifi`, { method: "POST", body });

    it("derives the type for legacy clients: password -> wpa, no password -> open", async () => {
      const withPw = await json(await wifi({ label: "Mit", ssid: "Heim", password: "geheim" }));
      expect(withPw.data).toMatchObject({ security: "wpa", password: "geheim", qrPayload: "WIFI:T:WPA;S:Heim;P:geheim;;" });
      const open = await json(await wifi({ label: "Offen", ssid: "Gast" }));
      expect(open.data).toMatchObject({ security: "open", password: "", qrPayload: "WIFI:T:nopass;S:Gast;;" });
      const emptyPw = await json(await wifi({ label: "Leer", ssid: "Gast2", password: "" }));
      expect(emptyPw.data.security).toBe("open");
    });

    it("stores wpa3 and wep and builds the QR payload for them", async () => {
      const wpa3 = await json(await wifi({ label: "Neu", ssid: "Neu;Netz", password: "p:w", security: "wpa3" }));
      expect(wpa3.data).toMatchObject({ security: "wpa3", qrPayload: "WIFI:T:SAE;S:Neu\\;Netz;P:p\\:w;;" });
      const wep = await json(await wifi({ label: "Alt", ssid: "Alt", password: "12345", security: "wep" }));
      expect(wep.data.qrPayload).toBe('WIFI:T:WEP;S:Alt;P:"12345";;'); // all-hex value is quoted
    });

    it("validates: unknown type 422, password required unless open, open never keeps a password", async () => {
      expect((await wifi({ label: "x", ssid: "x", password: "pw", security: "wpa2" })).status).toBe(422);
      expect((await wifi({ label: "x", ssid: "x", security: "wpa3" })).status).toBe(422);
      expect((await wifi({ label: "x", ssid: "x", password: "", security: "wep" })).status).toBe(422);
      const open = await json(await wifi({ label: "OffenMitPw", ssid: "o", password: "ignored", security: "open" }));
      expect(open.data).toMatchObject({ security: "open", password: "" });
    });

    it("PATCH changes the type and keeps password/type consistent", async () => {
      const created = (await json(await wifi({ label: "Patch", ssid: "p", password: "pw1" }))).data;
      const patch = (body: Json) => call(board, `/${locationId}/wifi/${created.id}`, { method: "PATCH", body });

      expect((await json(await patch({ security: "wpa3" }))).data).toMatchObject({ security: "wpa3", password: "pw1" });
      expect((await json(await patch({ security: "open" }))).data).toMatchObject({ security: "open", password: "" });
      expect((await patch({ security: "wpa" })).status).toBe(422); // password was dropped with 'open'
      expect((await json(await patch({ security: "wpa", password: "pw2" }))).data).toMatchObject({ security: "wpa", password: "pw2" });
      expect((await json(await patch({ password: "" }))).data).toMatchObject({ security: "open", password: "" }); // legacy: emptying means open
      expect((await json(await patch({ password: "pw3" }))).data).toMatchObject({ security: "wpa", password: "pw3" }); // legacy: a password on an open network means wpa
      expect((await json(await patch({ label: "Umbenannt" }))).data).toMatchObject({ security: "wpa", label: "Umbenannt" });
      expect((await patch({ security: "nope" })).status).toBe(422);
    });

    it("lists security + qrPayload with the existing visibility scoping", async () => {
      await wifi({ label: "Nur Vorstand", ssid: "vorstand-net", password: "vp", visibility: "vorstand", security: "wpa3" });
      const asPlain = await json(await call(plain, `/${locationId}/wifi`));
      expect(asPlain.data.every((w: Json) => typeof w.security === "string" && typeof w.qrPayload === "string")).toBe(true);
      expect(asPlain.data.map((w: Json) => w.label)).not.toContain("Nur Vorstand");
      const asLeader = await json(await call(leader, `/${locationId}/wifi`));
      expect(asLeader.data.map((w: Json) => w.label)).toContain("Nur Vorstand");
    });
  });
});
