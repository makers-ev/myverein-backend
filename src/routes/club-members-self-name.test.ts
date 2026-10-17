import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { toAppError } from "../lib/errors.js";
import { clubMemberRoutes } from "./club-members.js";

/** PATCH /club-members/me: names and display name (self-service), rule shared with the application mapping. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Actor = { userId: string; cookie: string };
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function signUp(tag: string): Promise<Actor> {
  const email = `selfname-${tag}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `Konto ${tag}` } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

describe("self-service names", () => {
  let clubId: string;
  let plain: Actor;
  let other: Actor;
  let guest: Actor;
  let former: Actor;
  let otherRowId: string;
  const users: string[] = [];

  const patch = (who: Actor, body: object) =>
    app.request(`/club-members/me?clubId=${clubId}`, { method: "PATCH", headers: { cookie: who.cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const rowOf = async (who: Actor) => {
    const m = await db.query.member.findFirst({ where: (mm, { and: a, eq: e }) => a(e(mm.organizationId, clubId), e(mm.userId, who.userId)) });
    return (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, m!.id) }))!;
  };

  beforeAll(async () => {
    [plain, other, guest, former] = await Promise.all([signUp("plain"), signUp("other"), signUp("guest"), signUp("former")]);
    users.push(plain.userId, other.userId, guest.userId, former.userId);
    const club = await auth.api.createOrganization({ body: { name: `Self Name ${suffix}`, slug: `self-name-${suffix}`, userId: plain.userId } });
    clubId = club!.id;
    await auth.api.addMember({ body: { userId: other.userId, organizationId: clubId, role: "member" } });
    await auth.api.addMember({ body: { userId: guest.userId, organizationId: clubId, role: "guest" } });
    await auth.api.addMember({ body: { userId: former.userId, organizationId: clubId, role: "member" } });
    otherRowId = (await rowOf(other)).id;
  }, 30_000);

  afterAll(async () => {
    await db.delete(organization).where(eq(organization.id, clubId));
    for (const id of users) await db.delete(user).where(eq(user.id, id));
    await closeDatabase();
  });

  it("sets both names, recomputes the display name and returns the values", async () => {
    const res = await patch(other, { firstName: "  Ada ", lastName: "Lovelace" });
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { data: Json }).data;
    expect(body).toMatchObject({ firstName: "Ada", lastName: "Lovelace", name: "Ada Lovelace" });
    const row = await rowOf(other);
    expect(row).toMatchObject({ firstName: "Ada", lastName: "Lovelace", displayName: "Ada Lovelace" });
    // The audit entry holds field names only, never the names.
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_member.update_self"), eq(auditLog.subjectId, row.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toEqual({ clubId, changedFields: ["displayName", "firstName", "lastName"] });
    expect(JSON.stringify(audits[0]!.payload)).not.toContain("Lovelace");
  });

  it("a single name or clearing a name keeps the previous display name; changing one name with the other present recomputes", async () => {
    const before = (await rowOf(plain)).displayName;
    expect((await patch(plain, { firstName: "Grace" })).status).toBe(200);
    expect(await rowOf(plain)).toMatchObject({ firstName: "Grace", lastName: null, displayName: before });

    expect((await patch(plain, { lastName: "Hopper" })).status).toBe(200);
    expect(await rowOf(plain)).toMatchObject({ firstName: "Grace", lastName: "Hopper", displayName: "Grace Hopper" });

    expect((await patch(plain, { lastName: "" })).status).toBe(200); // "" clears
    expect(await rowOf(plain)).toMatchObject({ firstName: "Grace", lastName: null, displayName: "Grace Hopper" });
    expect((await patch(plain, { firstName: null })).status).toBe(200);
    expect(await rowOf(plain)).toMatchObject({ firstName: null, lastName: null, displayName: "Grace Hopper" });

    expect((await patch(plain, { firstName: "Grace", lastName: "Murray-Hopper" })).status).toBe(200);
    expect((await rowOf(plain)).displayName).toBe("Grace Murray-Hopper");
  });

  it("accepts an explicit display name (wins over the computed one) and refuses to clear it", async () => {
    expect((await patch(plain, { firstName: "Anna", lastName: "Beispiel", displayName: "Anna B." })).status).toBe(200);
    expect(await rowOf(plain)).toMatchObject({ firstName: "Anna", lastName: "Beispiel", displayName: "Anna B." });
    expect((await patch(plain, { displayName: "Anna Beispiel-Muster" })).status).toBe(200);
    expect(await rowOf(plain)).toMatchObject({ firstName: "Anna", displayName: "Anna Beispiel-Muster" });
    for (const bad of [{ displayName: "" }, { displayName: "   " }, { displayName: null }, { displayName: "x".repeat(201) }]) {
      expect((await patch(plain, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await rowOf(plain)).displayName).toBe("Anna Beispiel-Muster");
  });

  it("rejects control and bidi characters and over-long names, and leaves the row untouched", async () => {
    const before = await rowOf(plain);
    for (const bad of [
      { firstName: "Ada\u0000" },
      { lastName: "Love\nlace" },
      { firstName: "‮evil" },
      { displayName: "Ada Lovelace" },
      { firstName: "x".repeat(101) },
      { lastName: "y".repeat(101) },
    ]) {
      expect((await patch(plain, bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect(await rowOf(plain)).toEqual(before);
  });

  it("only changes the caller's own row, ignores non-self fields and writes no audit entry for a no-op", async () => {
    const otherBefore = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, otherRowId) });
    const res = await patch(plain, { firstName: "Anna", memberNumber: "HACK-1", status: "ausgetreten", categoryKey: "ehrenmitglied" });
    expect(res.status).toBe(200);
    expect(await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, otherRowId) })).toEqual(otherBefore);
    const mine = await rowOf(plain);
    expect(mine.memberNumber).not.toBe("HACK-1");
    expect(mine.status).toBe("aktiv");
    const count = (await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_member.update_self"), eq(auditLog.subjectId, mine.id)))).length;
    expect((await patch(plain, { firstName: "Anna" })).status).toBe(200);
    expect((await db.select().from(auditLog).where(and(eq(auditLog.eventType, "club_member.update_self"), eq(auditLog.subjectId, mine.id)))).length).toBe(count);
  });

  it("keeps other self-service fields working together with names", async () => {
    const res = await patch(other, { firstName: "Ada", lastName: "King", city: "London", birthDate: "1990-12-10" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Json }).data).toMatchObject({ name: "Ada King", city: "London", birthDate: "1990-12-10" });
  });

  it("external guests update their own names as before; former members get 404", async () => {
    const res = await patch(guest, { firstName: "Gast", lastName: "Eltern" });
    expect(res.status).toBe(200);
    expect(await rowOf(guest)).toMatchObject({ displayName: "Gast Eltern" });

    expect((await patch(former, { firstName: "Alt" })).status).toBe(200);
    await db.update(clubMembers).set({ status: "ausgetreten", leftAt: "2020-01-01" }).where(eq(clubMembers.id, (await rowOf(former)).id));
    expect((await patch(former, { firstName: "Neu", lastName: "Name" })).status).toBe(404);
    expect((await rowOf(former)).lastName).toBeNull();
  });

  it("other members see the display name but not the split names", async () => {
    const plainRow = await rowOf(plain);
    const res = await app.request(`/club-members/${plainRow.id}?clubId=${clubId}`, { headers: { cookie: other.cookie } });
    expect(res.status).toBe(200);
    const body = ((await res.json()) as { data: Json }).data;
    expect(body.name).toBe(plainRow.displayName);
    expect(body).not.toHaveProperty("firstName");
    expect(body).not.toHaveProperty("lastName");
  });
});
