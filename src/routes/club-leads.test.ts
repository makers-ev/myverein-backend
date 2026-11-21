import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDatabase, db } from "../db/client.js";
import { clubLeads } from "../db/schema/club-leads.js";
import { clubMemberDepartments, clubMembers } from "../db/schema/club-members.js";
import { clubPublicProfiles } from "../db/schema/club-public-profiles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { departments } from "../db/schema/departments.js";
import { EMPTY_CONTENT } from "../lib/public-profile.js";
import { publishNotice } from "../lib/privacy-notice.js";
import { clubLeadsOld } from "../lib/retention/categories.js";
import { clubLeadRoutes } from "./club-leads.js";
import { createClub, dropClubs, installErrorHandler, requester, type Account } from "./forms-test-support.js";
import { publicClubRoutes } from "./public-clubs.js";

vi.mock("../lib/email.js", () => ({ sendEmail: async () => undefined }));

/**
 * Interested people and trial training (Wave 15 B4): public intake (opt-in only, honeypot, rate limits, merge of duplicates,
 * board notice, no data leak), board pipeline (rights, status flow, waitlist per department, conversion into a member record).
 */

const app = new Hono();
app.route("/public", publicClubRoutes);
app.route("/club-leads", clubLeadRoutes);
installErrorHandler(app);
const call = requester(app);
const suffix = Date.now();
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely typed response helper
const json = async (res: Response) => (await res.json()) as any;
const post = (slug: string, body: unknown, ip = randomUUID()) => app.request(`/public/clubs/${slug}/leads`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

describe("club leads", () => {
  let club: Awaited<ReturnType<typeof createClub>>;
  let board: Account;
  let deptA: string;
  let deptB: string;
  let hiddenDept: string;
  const lead = (over: Record<string, unknown> = {}) => ({ name: "Ina Neu", email: `ina-${suffix}@example.com`, privacyAccepted: true, ...over });

  beforeAll(async () => {
    club = await createClub("leads", suffix, { abt: "abteilungsleitung", kasse: "kassenwart", plain: null });
    board = club.founder;
    const [a] = await db.insert(departments).values({ clubId: club.clubId, name: "Fußball" }).returning();
    const [b] = await db.insert(departments).values({ clubId: club.clubId, name: "Tennis" }).returning();
    const [h] = await db.insert(departments).values({ clubId: club.clubId, name: "Intern" }).returning();
    deptA = a!.id;
    deptB = b!.id;
    hiddenDept = h!.id;
  }, 60_000);

  afterAll(async () => {
    await dropClubs([club.clubId], club.userIds);
    await closeDatabase();
  });

  it("accepts enquiries only for a live page with the form switched on (same 404 otherwise)", async () => {
    const unknown = await post(`nope-${suffix}`, lead());
    expect(unknown.status).toBe(404);
    expect((await post(club.slug, lead())).status).toBe(404);
    const content = { ...EMPTY_CONTENT, departmentIds: [deptA, deptB], leadFormEnabled: false, trialTrainingEnabled: true };
    await db.insert(clubPublicProfiles).values({ clubId: club.clubId, ...content, published: content, publishedAt: new Date() });
    await db.insert(clubSettings).values({ clubId: club.clubId, publicProfileEnabled: true }).onConflictDoUpdate({ target: clubSettings.clubId, set: { publicProfileEnabled: true } });
    expect((await post(club.slug, lead())).status).toBe(404);
    const on = { ...content, leadFormEnabled: true };
    await db.update(clubPublicProfiles).set({ published: on, leadFormEnabled: true }).where(eq(clubPublicProfiles.clubId, club.clubId));
    // Form switched on but no published privacy notice: still the same 404, and the page does not offer the form.
    expect((await post(club.slug, lead())).status).toBe(404);
    const page = await json(await app.request(`/public/clubs/${club.slug}`, { headers: { "x-forwarded-for": randomUUID() } }));
    expect(page.data.leadForm).toMatchObject({ enabled: false, privacyNotice: null });
    await publishNotice(club.clubId, "Datenschutzhinweis des Vereins: Wir verarbeiten deine Anfrage nur, um dich zu kontaktieren. Verantwortlich ist der Vorstand.", club.founder.userId);
  });

  it("validates, ignores the honeypot and stores a new lead with a board notice", async () => {
    expect((await post(club.slug, lead({ privacyAccepted: false }))).status).toBe(422);
    expect((await post(club.slug, lead({ email: "kaputt" }))).status).toBe(422);
    const bot = await post(club.slug, lead({ email: `bot-${suffix}@example.com`, website: "http://spam" }));
    expect(bot.status).toBe(202);
    expect((await db.select().from(clubLeads).where(eq(clubLeads.email, `bot-${suffix}@example.com`))).length).toBe(0);

    const res = await post(club.slug, lead({ departmentId: deptA, message: "Ich möchte schnuppern", trialRequested: true }));
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ data: { status: "received" } });
    const [row] = await db.select().from(clubLeads).where(and(eq(clubLeads.clubId, club.clubId), eq(clubLeads.email, `ina-${suffix}@example.com`)));
    expect(row).toMatchObject({ status: "neu", source: "oeffentliche_seite", departmentId: deptA, trialRequested: true, requestCount: 1 });
    expect(row!.privacyAcceptedAt).not.toBeNull();
    const notices = await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, "lead.new"), eq(messageDeliveries.refId, row!.id)));
    expect(notices.length).toBeGreaterThan(0);
  });

  it("merges duplicates of an open lead and ignores departments the page does not offer", async () => {
    const res = await post(club.slug, lead({ departmentId: hiddenDept, message: "Noch eine Frage" }));
    expect(res.status).toBe(202);
    const rows = await db.select().from(clubLeads).where(and(eq(clubLeads.clubId, club.clubId), eq(clubLeads.email, `ina-${suffix}@example.com`)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestCount: 2, departmentId: deptA });
    expect(rows[0]!.message).toContain("Noch eine Frage");
    const other = await post(club.slug, lead({ name: "Otto", email: `otto-${suffix}@example.com`, departmentId: hiddenDept }));
    expect(other.status).toBe(202);
    const [otto] = await db.select().from(clubLeads).where(eq(clubLeads.email, `otto-${suffix}@example.com`));
    expect(otto!.departmentId).toBeNull();
  });

  it("rate limits per client and per address", async () => {
    process.env.PUBLIC_LEAD_IP_LIMIT_PER_HOUR = "2";
    const ip = randomUUID();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(club.slug, lead({ email: `rl-${i}-${suffix}@example.com` }), ip)).status);
    expect(statuses).toEqual([202, 202, 429]);
    delete process.env.PUBLIC_LEAD_IP_LIMIT_PER_HOUR;
    const same = [];
    for (let i = 0; i < 4; i++) same.push((await post(club.slug, lead({ email: `same-${suffix}@example.com` }))).status);
    expect(same).toEqual([202, 202, 202, 429]);
  });

  it("keeps the pipeline to leads:write", async () => {
    for (const who of [club.members.plain!, club.members.kasse!]) expect((await call(who, "/club-leads", { clubId: club.clubId })).status).toBe(403);
    const list = await json(await call(club.members.abt!, `/club-leads?q=ina-${suffix}`, { clubId: club.clubId }));
    expect(list.total).toBe(1);
    expect(list.data[0]).toMatchObject({ name: "Ina Neu", status: "neu", department: { id: deptA, name: "Fußball" }, waitlisted: false });
  });

  it("follows the status flow and refuses shortcuts", async () => {
    const [row] = await db.select().from(clubLeads).where(eq(clubLeads.email, `otto-${suffix}@example.com`));
    const patch = (body: unknown) => call(board, `/club-leads/${row!.id}`, { method: "PATCH", clubId: club.clubId, body });
    expect((await patch({ status: "kontaktiert", notes: "Angerufen" })).status).toBe(200);
    expect((await patch({ status: "probetraining", trialOn: "2030-05-01" })).status).toBe(200);
    const bad = await patch({ status: "neu" });
    expect(bad.status).toBe(409);
    expect((await json(bad)).error.details.code).toBe("invalid_status_transition");
    const shortcut = await patch({ status: "mitglied" });
    expect(shortcut.status).toBe(422);
    expect((await json(shortcut)).error.details.code).toBe("use_convert");
    expect((await patch({ status: "abgelehnt" })).status).toBe(200);
    expect((await patch({ status: "neu" })).status).toBe(200);
  });

  it("keeps waitlists per department in order", async () => {
    const make = async (name: string, departmentId: string) => (await json(await call(board, "/club-leads", { method: "POST", clubId: club.clubId, body: { name, departmentId } }))).data.id as string;
    const ids = [await make("Erste", deptB), await make("Zweite", deptB), await make("Dritte", deptA)];
    for (const id of ids) expect((await call(board, `/club-leads/${id}`, { method: "PATCH", clubId: club.clubId, body: { waitlisted: true } })).status).toBe(200);
    const wl = (await json(await call(board, "/club-leads/waitlist", { clubId: club.clubId }))).data;
    const tennis = wl.find((g: { department: { name: string } | null }) => g.department?.name === "Tennis");
    expect(tennis.leads.map((l: { name: string; position: number }) => `${l.position}:${l.name}`)).toEqual(["1:Erste", "2:Zweite"]);
    const only = (await json(await call(board, `/club-leads/waitlist?departmentId=${deptA}`, { clubId: club.clubId }))).data;
    expect(only).toHaveLength(1);
    expect((await call(board, "/club-leads", { method: "POST", clubId: club.clubId, body: { name: "X Y", departmentId: randomUUID() } })).status).toBe(422);
  });

  it("converts a lead into a member record (interessent, department, no number) exactly once", async () => {
    const [row] = await db.select().from(clubLeads).where(and(eq(clubLeads.clubId, club.clubId), eq(clubLeads.email, `ina-${suffix}@example.com`)));
    const res = await call(board, `/club-leads/${row!.id}/convert`, { method: "POST", clubId: club.clubId });
    expect(res.status).toBe(201);
    const { lead: converted, clubMemberId } = (await json(res)).data;
    expect(converted).toMatchObject({ status: "mitglied", convertedClubMemberId: clubMemberId, waitlisted: false });
    const member = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, clubMemberId) });
    expect(member).toMatchObject({ status: "interessent", memberNumber: null, displayName: "Ina Neu", contactEmail: `ina-${suffix}@example.com`, memberId: null });
    const depts = await db.select().from(clubMemberDepartments).where(eq(clubMemberDepartments.clubMemberId, clubMemberId));
    expect(depts.map((d) => d.departmentId)).toEqual([deptA]);
    const again = await call(board, `/club-leads/${row!.id}/convert`, { method: "POST", clubId: club.clubId });
    expect(again.status).toBe(409);
    expect((await json(again)).error.details.code).toBe("lead_already_converted");
    expect((await call(board, `/club-leads/${row!.id}`, { method: "DELETE", clubId: club.clubId })).status).toBe(204);
  });
  it("deletes leads after the retention period since the last change (rule club_leads)", async () => {
    const old = new Date(Date.now() - 200 * 86_400_000);
    const [stale] = await db.insert(clubLeads).values({ clubId: club.clubId, name: "Alt", source: "manuell", updatedAt: old, lastRequestAt: old, createdAt: old }).returning();
    const dry = await clubLeadsOld({ clubId: club.clubId, days: 180, now: new Date(), dryRun: true });
    expect(dry.scanned).toBe(1);
    const real = await clubLeadsOld({ clubId: club.clubId, days: 180, now: new Date(), dryRun: false });
    expect(real.affected).toBe(1);
    expect(await db.query.clubLeads.findFirst({ where: eq(clubLeads.id, stale!.id) })).toBeUndefined();
    expect((await db.select().from(clubLeads).where(eq(clubLeads.clubId, club.clubId))).length).toBeGreaterThan(0);
  });
});
