import { createHash, randomUUID } from "node:crypto";

import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { meetingMinutes, meetingMinutesAmendments } from "../db/schema/assembly.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { meetingResolutions, meetings } from "../db/schema/meetings.js";
import { toAppError } from "../lib/errors.js";
import { meetingRoutes } from "./meetings.js";

/** Wave 11 B9: versions and state machine of the minutes, approval by a later resolution, immutability (app and trigger), amendments, export. */

const app = new Hono();
app.route("/meetings", meetingRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { userId: string; cookie: string };
const userIds: string[] = [];
let club: string;
let chair: Who;
let clerk: Who;
let plain: Who;
let mv1: string;
let mv2: string;
let mvEarlier: string;
let board: string;
let acceptedLater: string;
let rejectedLater: string;
let acceptedEarlier: string;

async function signUp(label: string): Promise<Who> {
  const email = `w11m-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `W11M ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const call = (who: Who, url: string, init: { method?: string; body?: object } = {}) =>
  app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (res: Response) => (await res.json()) as Json;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const meetingRow = async (type: string, title: string, at: Date) =>
  (await db.insert(meetings).values({ clubId: club, type, title, scheduledAt: at, status: "abgehalten" }).returning({ id: meetings.id }))[0]!.id;
const resolutionIn = async (meetingId: string, result: string) =>
  (await db.insert(meetingResolutions).values({ meetingId, description: "Genehmigung des Protokolls", votesFor: 5, votesAgainst: 1, votesAbstain: 0, result }).returning({ id: meetingResolutions.id }))[0]!.id;

/** Drafts, confirms with both roles and submits the minutes of a meeting. */
async function submitted(meetingId: string, content: string) {
  expect((await call(chair, `/meetings/${meetingId}/minutes`, { method: "PUT", body: { content } })).status).toBe(200);
  expect((await call(chair, `/meetings/${meetingId}/minutes/confirm`, { method: "POST", body: { role: "leitung" } })).status).toBe(200);
  expect((await call(clerk, `/meetings/${meetingId}/minutes/confirm`, { method: "POST", body: { role: "schriftfuehrung" } })).status).toBe(200);
  expect((await call(chair, `/meetings/${meetingId}/minutes/submit`, { method: "POST" })).status).toBe(200);
}

beforeAll(async () => {
  chair = await signUp("chair");
  clerk = await signUp("clerk");
  plain = await signUp("plain");
  club = (await auth.api.createOrganization({ body: { name: `TV Protokoll ${suffix}`, slug: `w11m-${suffix}`, userId: chair.userId } }))!.id;
  const chairMember = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, club), e(m.userId, chair.userId)) });
  await db.insert(clubRoles).values({ memberId: chairMember!.id, roleType: "vorsitz" });
  for (const [who, roleType] of [[clerk, "schriftfuehrer"], [plain, null]] as const) {
    const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
    if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
  }
  mvEarlier = await meetingRow("mitgliederversammlung", "MV 2024", new Date("2024-03-01T18:00:00Z"));
  mv1 = await meetingRow("mitgliederversammlung", "MV 2025", new Date("2025-03-01T18:00:00Z"));
  mv2 = await meetingRow("mitgliederversammlung", "MV 2026", new Date("2026-03-01T18:00:00Z"));
  board = await meetingRow("vorstandssitzung", "Vorstand intern", new Date("2025-04-01T18:00:00Z"));
  acceptedLater = await resolutionIn(mv2, "angenommen");
  rejectedLater = await resolutionIn(mv2, "abgelehnt");
  acceptedEarlier = await resolutionIn(mvEarlier, "angenommen");
}, 60_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("draft, confirmation and submission", () => {
  it("redirects PATCH minutes to the draft and keeps the draft away from plain members", async () => {
    const res = await call(chair, `/meetings/${mv1}`, { method: "PATCH", body: { minutes: "Erster Entwurf <b>" } });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ data: { minutes: "Erster Entwurf <b>", minutesStatus: "entwurf" } });
    const memberView = await json(await call(plain, `/meetings/${mv1}`));
    expect(memberView.data).toMatchObject({ minutes: null, minutesStatus: null });
    expect((await json(await call(plain, `/meetings/${mv1}/minutes`))).data).toMatchObject({ current: null, versions: [] });
    const manager = (await json(await call(chair, `/meetings/${mv1}/minutes`))).data;
    expect(manager.current).toMatchObject({ version: 1, status: "entwurf", contentHash: sha("Erster Entwurf <b>"), approved: false });
    expect(manager.versions).toHaveLength(1);
    expect((await call(plain, `/meetings/${mv1}/minutes`, { method: "PUT", body: { content: "x" } })).status).toBe(403);
  });

  it("edits the draft in place and needs both confirmations of the current text", async () => {
    await call(chair, `/meetings/${mv1}/minutes`, { method: "PUT", body: { content: "Protokoll der MV 2025" } });
    const early = await call(chair, `/meetings/${mv1}/minutes/submit`, { method: "POST" });
    expect(early.status).toBe(409);
    expect((await json(early)).error.details).toMatchObject({ code: "minutes_not_confirmed", missing: ["leitung", "schriftfuehrung"] });
    // Each confirmation belongs to its role (review M5): the secretary exists, so the chair cannot stand in for them.
    const wrong = await call(clerk, `/meetings/${mv1}/minutes/confirm`, { method: "POST", body: { role: "leitung" } });
    expect(wrong.status).toBe(403);
    expect((await json(wrong)).error.details.code).toBe("role_required");
    expect((await call(chair, `/meetings/${mv1}/minutes/confirm`, { method: "POST", body: { role: "schriftfuehrung" } })).status).toBe(403);
    expect((await call(chair, `/meetings/${mv1}/minutes/confirm`, { method: "POST", body: { role: "leitung" } })).status).toBe(200);
    // The same account cannot confirm twice for the two roles (it would need both roles, which the secretary rule forbids anyway).
    const same = await call(chair, `/meetings/${mv1}/minutes/confirm`, { method: "POST", body: { role: "leitung" } });
    expect((await json(same)).error.details.code).toBe("minutes_already_confirmed");
    expect((await call(plain, `/meetings/${mv1}/minutes/confirm`, { method: "POST", body: { role: "schriftfuehrung" } })).status).toBe(403);
    // A change of the text drops the confirmations.
    await call(chair, `/meetings/${mv1}/minutes`, { method: "PUT", body: { content: "Protokoll der MV 2025, korrigiert" } });
    expect((await json(await call(chair, `/meetings/${mv1}/minutes`))).data.current.confirmations).toEqual([]);
    await submitted(mv1, "Protokoll der MV 2025, korrigiert");
    const view = (await json(await call(chair, `/meetings/${mv1}/minutes`))).data;
    expect(view.current).toMatchObject({ status: "zur_genehmigung", version: 1 });
    expect(view.current.confirmations).toHaveLength(2);
    expect(view.approvalHint).toMatchObject({ id: expect.any(String) });
    const locked = await call(chair, `/meetings/${mv1}/minutes`, { method: "PUT", body: { content: "nachträglich" } });
    expect(locked.status).toBe(409);
    expect((await call(chair, `/meetings/${mv1}`, { method: "PATCH", body: { minutes: "nachträglich" } })).status).toBe(409);
  });
});

describe("approval by a resolution of a later meeting", () => {
  it("refuses an earlier meeting, a rejected resolution and a foreign resolution, then approves", async () => {
    const approve = (resolutionId: string) => call(chair, `/meetings/${mv1}/minutes/approve`, { method: "POST", body: { resolutionId } });
    expect((await json(await approve(acceptedEarlier))).error.details.code).toBe("approval_meeting_not_later");
    expect((await json(await approve(rejectedLater))).error.details.code).toBe("resolution_not_accepted");
    expect((await approve(randomUUID())).status).toBe(404);
    expect((await call(clerk, `/meetings/${mv1}/minutes/approve`, { method: "POST", body: { resolutionId: acceptedLater } })).status).toBe(200);
    const view = (await json(await call(plain, `/meetings/${mv1}/minutes`))).data;
    expect(view.current).toMatchObject({ status: "genehmigt", approved: true, approvedInMeetingId: mv2, approvedResolutionId: acceptedLater, content: "Protokoll der MV 2025, korrigiert" });
    expect(view.current.confirmations).toBeUndefined();
    expect((await json(await call(plain, `/meetings/${mv1}`))).data).toMatchObject({ minutes: "Protokoll der MV 2025, korrigiert", minutesStatus: "genehmigt" });
  });

  it("is immutable: the app refuses and so does the database", async () => {
    expect((await call(chair, `/meetings/${mv1}/minutes`, { method: "PUT", body: { content: "anders" } })).status).toBe(409);
    expect((await call(chair, `/meetings/${mv1}/minutes/reopen`, { method: "POST" })).status).toBe(409);
    expect((await call(chair, `/meetings/${mv1}`, { method: "DELETE" })).status).toBe(409);
    await expect(db.update(meetingMinutes).set({ content: "manipuliert" }).where(eq(meetingMinutes.meetingId, mv1))).rejects.toThrow();
    await expect(db.update(meetingMinutes).set({ status: "entwurf" }).where(eq(meetingMinutes.meetingId, mv1))).rejects.toThrow();
    await expect(db.update(meetingMinutes).set({ approvedAt: new Date() }).where(eq(meetingMinutes.meetingId, mv1))).rejects.toThrow();
    await expect(db.delete(meetingMinutes).where(eq(meetingMinutes.meetingId, mv1))).rejects.toThrow();
    const [row] = await db.select().from(meetingMinutes).where(eq(meetingMinutes.meetingId, mv1));
    expect(row!.content).toBe("Protokoll der MV 2025, korrigiert");
  });

  it("only lets the database approve from zur_genehmigung with a resolution", async () => {
    const other = await meetingRow("sonstige", "Treffen", new Date("2025-05-01T18:00:00Z"));
    await db.insert(meetingMinutes).values({ meetingId: other, version: 1, status: "entwurf", content: "x", contentHash: sha("x") });
    await expect(db.update(meetingMinutes).set({ status: "genehmigt", approvedAt: new Date(), approvedResolutionId: acceptedLater }).where(eq(meetingMinutes.meetingId, other))).rejects.toThrow();
    await db.update(meetingMinutes).set({ status: "zur_genehmigung" }).where(eq(meetingMinutes.meetingId, other));
    await expect(db.update(meetingMinutes).set({ status: "genehmigt", approvedAt: new Date() }).where(eq(meetingMinutes.meetingId, other))).rejects.toThrow();
    await db.update(meetingMinutes).set({ status: "genehmigt", approvedAt: new Date(), approvedResolutionId: acceptedLater }).where(eq(meetingMinutes.meetingId, other));
    // The approved meeting may still be deleted by cascade of the whole club (afterAll), and the approving meeting can vanish (FK set null).
    await db.update(meetingMinutes).set({ approvedInMeetingId: null }).where(eq(meetingMinutes.meetingId, other));
  });

  it("refuses a decision record (archiviert) as an editable draft", async () => {
    const record = await meetingRow("sonstige", "Umlaufbeschluss", new Date("2025-06-01T18:00:00Z"));
    await db.insert(meetingMinutes).values({ meetingId: record, version: 1, status: "archiviert", content: "Beschluss", contentHash: sha("Beschluss"), approvedAt: new Date() });
    const res = await call(chair, `/meetings/${record}/minutes`, { method: "PUT", body: { content: "anders" } });
    expect((await json(res)).error.details).toMatchObject({ code: "minutes_locked", status: "archiviert" });
  });
});

describe("amendments", () => {
  it("adds a Berichtigungsvermerk to the approved version and keeps it append-only", async () => {
    expect((await call(chair, `/meetings/${mv1}/minutes/amendments`, { method: "POST", body: { note: "  " } })).status).toBe(422);
    expect((await call(plain, `/meetings/${mv1}/minutes/amendments`, { method: "POST", body: { note: "Name berichtigt" } })).status).toBe(403);
    const res = await call(chair, `/meetings/${mv1}/minutes/amendments`, { method: "POST", body: { note: "Name berichtigt" } });
    expect(res.status).toBe(201);
    const view = (await json(await call(plain, `/meetings/${mv1}/minutes`))).data;
    expect(view.amendments).toMatchObject([{ version: 1, note: "Name berichtigt" }]);
    expect(view.current.content).toBe("Protokoll der MV 2025, korrigiert");
    await expect(db.update(meetingMinutesAmendments).set({ note: "anders" })).rejects.toThrow();
    await expect(db.delete(meetingMinutesAmendments)).rejects.toThrow();
    const none = await call(chair, `/meetings/${mv2}/minutes/amendments`, { method: "POST", body: { note: "zu früh" } });
    expect((await json(none)).error.details.code).toBe("minutes_not_approved");
  });

  it("archives approved minutes", async () => {
    const res = await call(chair, `/meetings/${mv1}/minutes/archive`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((await json(res)).data.current).toMatchObject({ status: "archiviert", approved: true });
    expect((await call(chair, `/meetings/${mv1}/minutes/archive`, { method: "POST" })).status).toBe(409);
  });
});

describe("failed approval", () => {
  it("reopens a submitted version as the next draft and supersedes the old one", async () => {
    await submitted(mv2, "Entwurf MV 2026");
    const res = await json(await call(chair, `/meetings/${mv2}/minutes/reopen`, { method: "POST" }));
    expect(res.data.current).toMatchObject({ version: 2, status: "entwurf", content: "Entwurf MV 2026", confirmations: [] });
    expect(res.data.versions).toMatchObject([{ version: 1, status: "archiviert", approved: false }, { version: 2, status: "entwurf" }]);
    // The superseded version was never approved: members see nothing.
    expect((await json(await call(plain, `/meetings/${mv2}/minutes`))).data.current).toBeNull();
  });
});

describe("visibility and export", () => {
  it("hides the minutes of a board meeting from members who are not invited", async () => {
    await call(chair, `/meetings/${board}/minutes`, { method: "PUT", body: { content: "Intern" } });
    expect((await call(plain, `/meetings/${board}/minutes`)).status).toBe(404);
    expect((await call(plain, `/meetings/${board}/minutes/export`)).status).toBe(404);
  });

  it("exports html (escaped) and markdown with the hash, private and without a draft for members", async () => {
    await call(chair, `/meetings/${mv2}/minutes`, { method: "PUT", body: { content: "Text <script>alert(1)</script>" } });
    expect((await call(plain, `/meetings/${mv2}/minutes/export`)).status).toBe(404);
    const html = await call(chair, `/meetings/${mv2}/minutes/export?format=html`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(html.headers.get("cache-control")).toContain("private");
    const body = await html.text();
    expect(body).not.toContain("<script>alert");
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain(sha("Text <script>alert(1)</script>"));
    const md = await call(plain, `/meetings/${mv1}/minutes/export?format=md`);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const text = await md.text();
    expect(text).toContain("# Protokoll: MV 2025");
    expect(text).toContain("## Beschlussfähigkeit".replace("Beschlussfähigkeit", "Anwesenheit und Beschlussfähigkeit"));
    expect(text).toContain("Name berichtigt");
    expect(text).toContain(sha("Protokoll der MV 2025, korrigiert"));
    expect((await call(plain, `/meetings/${mv1}/minutes/export?format=pdf`)).status).toBe(422);
    void sql;
  });
});

describe("database guards (migration 0052)", () => {
  it("lets new minutes start as a draft only and keeps the decision record insert possible", async () => {
    const other = await meetingRow("sonstige", "Guard", new Date("2025-07-01T18:00:00Z"));
    for (const status of ["genehmigt", "zur_genehmigung"]) {
      await expect(db.insert(meetingMinutes).values({ meetingId: other, version: 1, status, content: "x", contentHash: sha("x"), approvedAt: new Date() })).rejects.toThrow();
    }
    await expect(db.insert(meetingMinutes).values({ meetingId: other, version: 1, status: "archiviert", content: "x", contentHash: sha("x") })).rejects.toThrow();
    await db.insert(meetingMinutes).values({ meetingId: other, version: 1, status: "archiviert", content: "x", contentHash: sha("x"), approvedAt: new Date() });
  });
});
