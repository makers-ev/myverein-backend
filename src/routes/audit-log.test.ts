import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";
import { auditLogRoutes } from "./audit-log.js";
import { clubMemberRoutes } from "./club-members.js";
import { clubSettingsRoutes } from "./club-settings.js";

/** Wave 10 B2: club audit log API (privacy:read), member view, aggregated read audit, CSV export. */

const app = new Hono();
app.route("/club-members", clubMemberRoutes);
app.route("/club-settings", clubSettingsRoutes);
app.route("/audit-log", auditLogRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { userId: string; cookie: string; memberId?: string };
const userIds: string[] = [];
let clubA: string;
let clubB: string;
let boardA: Who;
let boardB: Who;
let trainerA: Who;
let plainA: Who;
let plainClubMemberId: string;
let foreignClubMemberId: string;

async function signUp(label: string): Promise<Who> {
  const email = `b2-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `B2 ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const call = (who: Who, club: string, url: string, init: { method?: string; body?: object } = {}) =>
  app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { ...(who.cookie ? { cookie: who.cookie } : {}), "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (res: Response) => (await res.json()) as Json;
const countEntries = async (club: string, eventType: string) => (await db.select().from(auditLog).where(and(eq(auditLog.clubId, club), eq(auditLog.eventType, eventType)))).length;

async function addMember(club: string, who: Who, roleType: string | null) {
  const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
  who.memberId = account.id;
  if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
}

beforeAll(async () => {
  boardA = await signUp("boardA");
  boardB = await signUp("boardB");
  trainerA = await signUp("trainerA");
  plainA = await signUp("plainA");
  clubA = (await auth.api.createOrganization({ body: { name: `Audit A ${suffix}`, slug: `b2a-${suffix}`, userId: boardA.userId } }))!.id;
  clubB = (await auth.api.createOrganization({ body: { name: `Audit B ${suffix}`, slug: `b2b-${suffix}`, userId: boardB.userId } }))!.id;
  for (const [club, who] of [[clubA, boardA], [clubB, boardB]] as const) {
    const m = await db.query.member.findFirst({ where: (t, { and: a, eq: e }) => a(e(t.organizationId, club), e(t.userId, who.userId)) });
    who.memberId = m!.id;
    await db.insert(clubRoles).values({ memberId: m!.id, roleType: "vorsitz" });
  }
  await addMember(clubA, trainerA, "trainer");
  await addMember(clubA, plainA, null);
  plainClubMemberId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, plainA.memberId!) }))!.id;
  foreignClubMemberId = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, boardB.memberId!) }))!.id;
}, 60_000);

afterAll(async () => {
  await db.delete(auditLog).where(inArray(auditLog.clubId, [clubA, clubB]));
  await db.delete(organization).where(inArray(organization.id, [clubA, clubB]));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("audit entries carry club and actor", () => {
  it("records club_id and actor_user_id of a mutation made through the API", async () => {
    const res = await call(boardA, clubA, "/club-settings", { method: "PATCH", body: { allowSelfLoans: false } });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubA), eq(auditLog.eventType, "club_settings.update")));
    expect(row).toMatchObject({ clubId: clubA, actorUserId: boardA.userId, subjectId: clubA });
    expect(row!.payload).toEqual({ clubId: clubA, changedFields: ["allowSelfLoans"], changedBy: boardA.memberId });
  });

  it("records the member a change is about (member view)", async () => {
    const res = await call(boardA, clubA, `/club-members/${plainClubMemberId}`, { method: "PATCH", body: { city: "Hamburg" } });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubA), eq(auditLog.subjectMemberId, plainClubMemberId), eq(auditLog.eventType, "club_member.update")));
    expect(row).toMatchObject({ actorUserId: boardA.userId });
    expect(JSON.stringify(row!.payload)).not.toContain("Hamburg");
  });
});

describe("GET /audit-log", () => {
  it("is for privacy:read only (403 for trainer and member, 401 without session)", async () => {
    for (const who of [trainerA, plainA]) {
      expect((await call(who, clubA, "/audit-log")).status).toBe(403);
      expect((await call(who, clubA, "/audit-log/export")).status).toBe(403);
      expect((await call(who, clubA, `/audit-log/members/${plainClubMemberId}`)).status).toBe(403);
    }
    expect((await call({ userId: "", cookie: "" }, clubA, "/audit-log")).status).toBe(401);
  });

  it("lists the own club newest first with actor, kind and filters", async () => {
    const res = await json(await call(boardA, clubA, "/audit-log"));
    expect(res.total).toBeGreaterThanOrEqual(2);
    const times = res.data.map((e: Json) => e.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const update = res.data.find((e: Json) => e.eventType === "club_settings.update");
    expect(update).toMatchObject({ kind: "change", actor: { userId: boardA.userId, name: "B2 boardA" } });

    const byType = await json(await call(boardA, clubA, "/audit-log?type=club_member.*"));
    expect(byType.data.length).toBeGreaterThan(0);
    for (const e of byType.data) expect(e.eventType.startsWith("club_member.")).toBe(true);
    const byActor = await json(await call(boardA, clubA, `/audit-log?actorId=${boardA.userId}&type=club_settings.update`));
    expect(byActor.data).toHaveLength(1);
    const bySubject = await json(await call(boardA, clubA, `/audit-log?subjectId=${clubA}`));
    expect(bySubject.data.every((e: Json) => e.subjectId === clubA)).toBe(true);
    const future = await json(await call(boardA, clubA, "/audit-log?from=2999-01-01"));
    expect(future.total).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect((await json(await call(boardA, clubA, `/audit-log?from=${today}&to=${today}`))).total).toBeGreaterThan(0);
    expect((await call(boardA, clubA, "/audit-log?from=nonsense")).status).toBe(422);
    expect((await call(boardA, clubA, "/audit-log?pageSize=101")).status).toBe(422);
  });

  it("pages", async () => {
    const first = await json(await call(boardA, clubA, "/audit-log?pageSize=1&page=1"));
    const second = await json(await call(boardA, clubA, "/audit-log?pageSize=1&page=2"));
    expect(first.data).toHaveLength(1);
    expect(second.data).toHaveLength(1);
    expect(first.data[0].id).not.toBe(second.data[0].id);
  });

  it("never shows entries of another club and answers 404 for a club the caller is not in", async () => {
    await call(boardB, clubB, "/club-settings", { method: "PATCH", body: { allowSelfLoans: false } });
    const own = await json(await call(boardA, clubA, "/audit-log?pageSize=100"));
    expect(own.data.some((e: Json) => e.actor?.userId === boardB.userId)).toBe(false);
    const theirs = await json(await call(boardB, clubB, "/audit-log?pageSize=100"));
    expect(theirs.data.some((e: Json) => e.actor?.userId === boardA.userId)).toBe(false);
    expect((await call(boardB, clubA, "/audit-log")).status).toBe(404);
  });
});

describe("member view", () => {
  it("shows who changed and who saw the data of one member", async () => {
    await call(boardA, clubA, `/club-members/${plainClubMemberId}`); // read of sensitive data
    const res = await json(await call(boardA, clubA, `/audit-log/members/${plainClubMemberId}`));
    expect(res.member.id).toBe(plainClubMemberId);
    const kinds = new Set(res.data.map((e: Json) => e.kind));
    expect(kinds).toEqual(new Set(["change", "read"]));
    expect(res.data.every((e: Json) => e.subjectMember.id === plainClubMemberId)).toBe(true);
    const seen = await json(await call(boardA, clubA, `/audit-log/members/${plainClubMemberId}?kind=read`));
    expect(seen.data.length).toBeGreaterThan(0);
    expect(seen.data.every((e: Json) => e.kind === "read" && e.actor.userId === boardA.userId)).toBe(true);
    const changed = await json(await call(boardA, clubA, `/audit-log/members/${plainClubMemberId}?kind=change`));
    expect(changed.data.every((e: Json) => e.kind === "change")).toBe(true);
  });

  it("answers 404 for a member of another club or an unknown id", async () => {
    expect((await call(boardA, clubA, `/audit-log/members/${foreignClubMemberId}`)).status).toBe(404);
    expect((await call(boardA, clubA, `/audit-log/members/${randomUUID()}`)).status).toBe(404);
    expect((await call(boardA, clubA, "/audit-log/members/not-a-uuid")).status).toBe(404);
  });
});

describe("read audit of sensitive member data", () => {
  it("writes ONE aggregated entry per list request and one per detail request, never for own data or without the permission", async () => {
    const before = await countEntries(clubA, "club_member.sensitive_read");
    expect((await call(boardA, clubA, "/club-members?pageSize=100")).status).toBe(200);
    expect(await countEntries(clubA, "club_member.sensitive_read")).toBe(before + 1);
    const [list] = (await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubA), eq(auditLog.eventType, "club_member.sensitive_read")))).filter((r) => (r.payload as Json).scope === "list");
    expect(list).toMatchObject({ actorUserId: boardA.userId, subjectId: null });
    expect((list!.payload as Json).count).toBeGreaterThanOrEqual(2);

    expect((await call(boardA, clubA, `/club-members/${plainClubMemberId}`)).status).toBe(200);
    expect(await countEntries(clubA, "club_member.sensitive_read")).toBe(before + 2);

    // No sensitive fields delivered: nothing is written.
    expect((await call(plainA, clubA, "/club-members?pageSize=100")).status).toBe(200);
    expect((await call(plainA, clubA, `/club-members/${plainClubMemberId}`)).status).toBe(200);
    expect(await countEntries(clubA, "club_member.sensitive_read")).toBe(before + 2);
  });
});

describe("GET /audit-log/export", () => {
  it("exports the filtered log as CSV, writes an export entry and never leaks other clubs", async () => {
    const res = await call(boardA, clubA, "/audit-log/export?type=club_settings.update");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const text = await res.text();
    const lines = text.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Zeitpunkt;Ereignis;Art;Akteur;Person;Objekt-ID;Details");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("club_settings.update");
    expect(lines[1]).toContain("geändert");
    expect(text).not.toContain(clubB);
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.clubId, clubA), eq(auditLog.eventType, "audit_log.export")));
    expect(entry).toMatchObject({ actorUserId: boardA.userId });
    expect((entry!.payload as Json).filters).toEqual(["type"]);
    expect((await call(boardA, clubA, "/audit-log/export.csv")).status).toBe(200);
  });
});
