import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { meetingInvitationDeliveries } from "../db/schema/assembly.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { messageDeliveries } from "../db/schema/communication.js";
import { meetingInvitees, meetings } from "../db/schema/meetings.js";
import { emptyAssemblyRules } from "../lib/assembly-rules.js";
import { toAppError } from "../lib/errors.js";
import { meetingRoutes } from "./meetings.js";

/** Wave 11 B3: agenda items, invitation with period check and proof of delivery, post list. Real Postgres, no mocks. */

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
let otherClub: string;
let chair: Who; // vorsitz: assembly:manage + members:read_sensitive
let clerk: Who; // schriftfuehrer: assembly:manage, no members:read_sensitive
let plain: Who;
let outsider: Who;
const cm: Record<string, string> = {};

async function signUp(label: string): Promise<Who> {
  const email = `w11i-${label}-${suffix}@example.com`;
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name: `W11 ${label}` } });
  userIds.push(created.id);
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const call = (who: Who, url: string, init: { method?: string; body?: object; club?: string } = {}) =>
  app.request(`${url}${url.includes("?") ? "&" : "?"}clubId=${init.club ?? club}`, {
    method: init.method ?? "GET",
    headers: { cookie: who.cookie, "x-forwarded-for": randomUUID(), "content-type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
const json = async (res: Response) => (await res.json()) as Json;
const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const RULES = { ...emptyAssemblyRules(), invitationMinDays: 14, invitationDeliveryBufferDays: 3, invitationForm: "textform" as const, agendaRequiredInInvitation: true, quorumMode: "none" as const, abstainCountsAs: "not_counted" as const, proxyAllowed: false, votingStatuses: ["aktiv" as const], votingMinAge: 16, majorityByTopic: { ...emptyAssemblyRules().majorityByTopic, allgemein: "einfach" as const } };

async function newMeeting(who: Who, scheduledAt: string | null, type = "mitgliederversammlung") {
  const res = await call(who, "/meetings", { method: "POST", body: { type, title: "Jahreshauptversammlung", ...(scheduledAt ? { scheduledAt } : {}) } });
  return (await json(res)).data.id as string;
}
const addItem = async (who: Who, meetingId: string, title: string, extra: object = {}) => json(await call(who, `/meetings/${meetingId}/agenda-items`, { method: "POST", body: { title, ...extra } }));

beforeAll(async () => {
  chair = await signUp("chair");
  clerk = await signUp("clerk");
  plain = await signUp("plain");
  outsider = await signUp("outsider");
  club = (await auth.api.createOrganization({ body: { name: `TV Einladung ${suffix}`, slug: `w11i-${suffix}`, userId: chair.userId } }))!.id;
  otherClub = (await auth.api.createOrganization({ body: { name: `TV Fremd ${suffix}`, slug: `w11i-x-${suffix}`, userId: outsider.userId } }))!.id;
  const chairMember = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, club), e(m.userId, chair.userId)) });
  await db.insert(clubRoles).values({ memberId: chairMember!.id, roleType: "vorsitz" });
  const outsiderMember = await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, otherClub), e(m.userId, outsider.userId)) });
  await db.insert(clubRoles).values({ memberId: outsiderMember!.id, roleType: "vorsitz" });
  for (const [who, roleType] of [[clerk, "schriftfuehrer"], [plain, null]] as const) {
    const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
    if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
  }
  // Members without an account: one with a contact e-mail (shared with a sibling), one with an address only, one that left.
  const rows = await db
    .insert(clubMembers)
    .values([
      { clubId: club, displayName: "Bea Mail", contactEmail: "familie@example.test", street: "Weg 1", postalCode: "10115", city: "Berlin", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Ben Mail", contactEmail: "Familie@example.test", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "=HYPERLINK(\"http://evil\")", street: "Pfad 2", postalCode: "20095", city: "Hamburg", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Ausgetreten", status: "ausgetreten", leftAt: "2023-01-01", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Interessent", status: "interessent", joinedAt: "2020-01-01" },
    ])
    .returning();
  for (const r of rows) cm[r.displayName] = r.id;
  await db.insert(clubSettings).values({ clubId: club, assemblyRules: RULES }).onConflictDoUpdate({ target: clubSettings.clubId, set: { assemblyRules: RULES } });
}, 90_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(organization).where(eq(organization.id, otherClub));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("agenda items", () => {
  let meetingId: string;
  it("lets the board build and order the agenda; members only see announced items", async () => {
    meetingId = await newMeeting(chair, inDays(40));
    const a = await addItem(chair, meetingId, "Begrüßung");
    const b = await addItem(chair, meetingId, "Wahl des Vorstands", { voteKind: "election" });
    const c = await addItem(chair, meetingId, "Berichte", { position: 2, description: "Kassenbericht" });
    expect([a.data.position, b.data.position, c.data.position]).toEqual([1, 2, 2]);
    expect(b.data.topic).toBe("wahl");
    const list = (await json(await call(chair, `/meetings/${meetingId}/agenda-items`))).data as Json[];
    expect(list.map((i) => i.title)).toEqual(["Begrüßung", "Berichte", "Wahl des Vorstands"]);
    expect(list.map((i) => i.position)).toEqual([1, 2, 3]);
    expect((await json(await call(plain, `/meetings/${meetingId}/agenda-items`))).data).toEqual([]);
    const moved = await call(chair, `/meetings/${meetingId}/agenda-items/${b.data.id}`, { method: "PATCH", body: { position: 1, title: "Wahlen" } });
    expect(moved.status).toBe(200);
    const after = (await json(await call(chair, `/meetings/${meetingId}/agenda-items`))).data as Json[];
    expect(after.map((i) => i.title)).toEqual(["Wahlen", "Begrüßung", "Berichte"]);
    const gone = await call(chair, `/meetings/${meetingId}/agenda-items/${a.data.id}`, { method: "DELETE" });
    expect(gone.status).toBe(204);
    expect(((await json(await call(chair, `/meetings/${meetingId}/agenda-items`))).data as Json[]).map((i) => i.position)).toEqual([1, 2]);
  });

  it("denies writing to everybody without assembly:manage / meetings:write and hides other clubs", async () => {
    expect((await call(plain, `/meetings/${meetingId}/agenda-items`, { method: "POST", body: { title: "X" } })).status).toBe(403);
    expect((await call(outsider, `/meetings/${meetingId}/agenda-items`, { club: otherClub })).status).toBe(404);
    expect((await call(chair, `/meetings/${meetingId}/agenda-items`, { method: "POST", body: { title: "" } })).status).toBe(422);
  });
});

describe("invitation", () => {
  it("refuses to send while the statute parameters are incomplete", async () => {
    const other = await signUp("lonely");
    const lonelyClub = (await auth.api.createOrganization({ body: { name: `TV Leer ${suffix}`, slug: `w11i-l-${suffix}`, userId: other.userId } }))!.id;
    const m = await db.query.member.findFirst({ where: (mm, { and: a, eq: e }) => a(e(mm.organizationId, lonelyClub), e(mm.userId, other.userId)) });
    await db.insert(clubRoles).values({ memberId: m!.id, roleType: "vorsitz" });
    const created = await json(await call(other, "/meetings", { method: "POST", club: lonelyClub, body: { type: "mitgliederversammlung", title: "MV", scheduledAt: inDays(60) } }));
    const res = await call(other, `/meetings/${created.data.id}/invitations`, { method: "POST", club: lonelyClub, body: {} });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.details.code).toBe("assembly_rules_incomplete");
    expect(body.error.details.missing).toContain("invitationMinDays");
    const preview = await json(await call(other, `/meetings/${created.data.id}/invitations/preview`, { club: lonelyClub }));
    expect(preview.data.missingRules).toContain("invitationMinDays");
    await db.delete(organization).where(eq(organization.id, lonelyClub));
  });

  it("answers 422 with the earliest valid date when the period is violated, and lets assembly:manage send with a reason", async () => {
    const meetingId = await newMeeting(chair, inDays(10));
    await addItem(chair, meetingId, "Berichte");
    const preview = await json(await call(chair, `/meetings/${meetingId}/invitations/preview`));
    expect(preview.data.period).toMatchObject({ ok: false, reason: "too_late", requiredDays: 17 });
    const refused = await call(chair, `/meetings/${meetingId}/invitations`, { method: "POST", body: {} });
    expect(refused.status).toBe(422);
    const details = (await json(refused)).error.details;
    expect(details).toMatchObject({ code: "invitation_period_violated", reason: "too_late", requiredDays: 17 });
    expect(details.earliestMeetingDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(details.latestSendDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await call(chair, `/meetings/${meetingId}/invitations`, { method: "POST", body: { exceptionReason: "kurz" } })).status).toBe(422);
    const sent = await call(chair, `/meetings/${meetingId}/invitations`, { method: "POST", body: { exceptionReason: "Dringender Beschluss wegen Hallenmiete" } });
    expect(sent.status).toBe(201);
    const data = (await json(sent)).data;
    expect(data).toMatchObject({ version: 1, kind: "einladung", exceptionReason: "Dringender Beschluss wegen Hallenmiete" });
    expect(data.periodCheck.ok).toBe(false);
    // The members' view never shows the exception reason.
    const latest = (await json(await call(plain, `/meetings/${meetingId}/invitations/latest`))).data;
    expect(latest.exceptionReason).toBeUndefined();
    expect(latest.content.agenda).toHaveLength(1);
  });

  it("requires the agenda when the statute asks for it, a date and a planned mitgliederversammlung", async () => {
    const empty = await newMeeting(chair, inDays(60));
    const noAgenda = await json(await call(chair, `/meetings/${empty}/invitations`, { method: "POST", body: {} }));
    expect(noAgenda.error.details.code).toBe("agenda_required");
    const undated = await newMeeting(chair, null);
    expect((await json(await call(chair, `/meetings/${undated}/invitations`, { method: "POST", body: {} }))).error.details.code).toBe("meeting_not_planned");
    const board = await newMeeting(chair, inDays(60), "vorstandssitzung");
    expect((await json(await call(chair, `/meetings/${board}/invitations`, { method: "POST", body: {} }))).error.details.code).toBe("invitation_not_supported");
  });

  let meetingId: string;
  let invitationId: string;

  it("sends to members with and without account, freezes the content and keeps a proof per member and channel", async () => {
    meetingId = await newMeeting(chair, inDays(45));
    const first = await addItem(chair, meetingId, "Begrüßung");
    await addItem(chair, meetingId, "Satzungsänderung", { voteKind: "resolution", topic: "satzungsaenderung" });
    const sent = await call(chair, `/meetings/${meetingId}/invitations`, { method: "POST", body: { message: "Bitte zahlreich erscheinen." } });
    expect(sent.status).toBe(201);
    const data = (await json(sent)).data;
    invitationId = data.id;
    expect(data).toMatchObject({ version: 1, kind: "einladung", exceptionReason: null });
    expect(data.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.rulesSnapshot).toMatchObject({ invitationMinDays: 14 });
    expect(data.content).toMatchObject({ title: "Jahreshauptversammlung", message: "Bitte zahlreich erscheinen." });
    expect(data.content.agenda.map((a: Json) => a.title)).toEqual(["Begrüßung", "Satzungsänderung"]);

    // 3 accounts (chair, clerk, plain) + Bea + Ben + the one with an address only; neither the one who left nor the interested person.
    const detail = (await json(await call(chair, `/meetings/${meetingId}/invitations/${invitationId}`))).data;
    expect(detail.recipientCount).toBe(6);
    const byMember = (name: string) => (detail.deliveries as Json[]).filter((d) => d.displayName === name).map((d) => `${d.channel}:${d.status}`).sort();
    expect(byMember("W11 chair")).toEqual(["email:queued", "inapp:sent"]);
    expect(byMember("Bea Mail")).toEqual(["email:queued"]);
    // Ben shares the address of Bea: covered by her mail, no second mail, no post.
    expect(byMember("Ben Mail")).toEqual(["email:queued"]);
    expect(byMember('=HYPERLINK("http://evil")')).toEqual(["post:queued"]);
    expect(byMember("Ausgetreten")).toEqual([]);
    expect(byMember("Interessent")).toEqual([]);
    expect(await db.select().from(messageDeliveries).where(and(eq(messageDeliveries.eventKey, "meeting.invitation"), eq(messageDeliveries.refId, invitationId), eq(messageDeliveries.channel, "email")))).toHaveLength(4);

    // Everybody invited can answer and is in the invitee list; the meeting carries the rules of the first invitation.
    expect(await db.select().from(meetingInvitees).where(eq(meetingInvitees.meetingId, meetingId))).toHaveLength(6);
    const [row] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    expect(row!.rulesSnapshot).toMatchObject({ invitationMinDays: 14 });
    // Announced items are now fixed.
    const items = (await json(await call(plain, `/meetings/${meetingId}/agenda-items`))).data as Json[];
    expect(items).toHaveLength(2);
    expect((await call(chair, `/meetings/${meetingId}/agenda-items/${first.data.id}`, { method: "PATCH", body: { title: "Anders" } })).status).toBe(409);
    expect((await call(chair, `/meetings/${meetingId}/agenda-items/${first.data.id}`, { method: "DELETE" })).status).toBe(409);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "meeting_invitation.send"), eq(auditLog.subjectId, meetingId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ version: 1, recipients: 6, periodException: false });
  });

  it("derives the status from the dispatcher; a failed mail of one member does not touch the others and moves them to the post list", async () => {
    await db.update(messageDeliveries).set({ status: "sent", sentAt: new Date() }).where(and(eq(messageDeliveries.eventKey, "meeting.invitation"), eq(messageDeliveries.refId, invitationId), eq(messageDeliveries.channel, "email")));
    await db.update(messageDeliveries).set({ status: "failed", errorCode: "smtp_rejected" }).where(and(eq(messageDeliveries.eventKey, "meeting.invitation"), eq(messageDeliveries.refId, invitationId), eq(messageDeliveries.clubMemberId, cm["Bea Mail"]!), eq(messageDeliveries.channel, "email")));
    const detail = (await json(await call(chair, `/meetings/${meetingId}/invitations/${invitationId}`))).data;
    const of = (name: string) => (detail.deliveries as Json[]).filter((d) => d.displayName === name).map((d) => `${d.channel}:${d.status}`).sort();
    expect(of("W11 chair")).toEqual(["email:sent", "inapp:sent"]);
    expect(of("Bea Mail")).toEqual(["email:failed", "post:queued"]);
    // Ben was covered by the failed mail of Bea: same outcome, also on the post list.
    expect(of("Ben Mail")).toEqual(["email:failed", "post:queued"]);
    const failed = (detail.deliveries as Json[]).find((d) => d.displayName === "Bea Mail" && d.channel === "email");
    expect(failed.errorCode).toBe("smtp_rejected");
    const filtered = (await json(await call(chair, `/meetings/${meetingId}/invitations/${invitationId}?channel=post&status=queued&limit=2`))).data;
    expect(filtered.deliveries).toHaveLength(2);
    expect(detail.summary).toEqual(expect.arrayContaining([{ channel: "post", status: "queued", count: 3 }]));
  });

  it("exports the post list only with members:read_sensitive, escapes formulas and audits it", async () => {
    const url = `/meetings/${meetingId}/invitations/${invitationId}/post-list.csv`;
    expect((await call(clerk, url)).status).toBe(403);
    expect((await call(plain, url)).status).toBe(403);
    const res = await call(chair, url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    expect(text).toContain("'=HYPERLINK");
    expect(text).toContain("Pfad 2");
    expect(text).toContain("Bea Mail");
    expect(text).not.toContain("W11 chair");
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "meeting_invitation.export"), eq(auditLog.subjectId, invitationId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({ rows: 3 });
  });

  it("marks letters as posted (selected members, then the rest)", async () => {
    const url = `/meetings/${meetingId}/invitations/${invitationId}/deliveries/mark-posted`;
    expect((await call(plain, url, { method: "POST", body: {} })).status).toBe(403);
    const one = await json(await call(clerk, url, { method: "POST", body: { clubMemberIds: [cm["Bea Mail"]!] } }));
    expect(one.data.marked).toBe(1);
    const rest = await json(await call(clerk, url, { method: "POST", body: {} }));
    expect(rest.data.marked).toBe(2);
    const rows = await db.select().from(meetingInvitationDeliveries).where(and(eq(meetingInvitationDeliveries.invitationId, invitationId), eq(meetingInvitationDeliveries.channel, "post")));
    expect(rows.every((r) => r.status === "manual_posted" && r.postedAt !== null)).toBe(true);
    // Nothing queued any more: the next export is empty.
    const csv = await (await call(chair, `/meetings/${meetingId}/invitations/${invitationId}/post-list.csv`)).text();
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });

  it("sends a Nachtrag as a new version with its own period check and only for new agenda items", async () => {
    expect((await json(await call(chair, `/meetings/${meetingId}/invitations`, { method: "POST", body: {} }))).error.details.code).toBe("nothing_to_add");
    await addItem(chair, meetingId, "Verschiedenes");
    const res = await call(chair, `/meetings/${meetingId}/invitations`, { method: "POST", body: {} });
    expect(res.status).toBe(201);
    const data = (await json(res)).data;
    expect(data).toMatchObject({ version: 2, kind: "nachtrag" });
    expect(data.content.agenda).toHaveLength(3);
    const list = (await json(await call(clerk, `/meetings/${meetingId}/invitations`))).data as Json[];
    expect(list.map((i) => i.version)).toEqual([1, 2]);
    // The first version stays as it was sent.
    expect(list[0]!.contentHash).not.toBe(list[1]!.contentHash);
    expect(((await json(await call(plain, `/meetings/${meetingId}/invitations/latest`))).data).version).toBe(2);
  });

  it("keeps the proof away from members and other clubs", async () => {
    expect((await call(plain, `/meetings/${meetingId}/invitations`)).status).toBe(403);
    expect((await call(plain, `/meetings/${meetingId}/invitations/${invitationId}`)).status).toBe(403);
    expect((await call(plain, `/meetings/${meetingId}/invitations`, { method: "POST", body: {} })).status).toBe(403);
    expect((await call(plain, `/meetings/${meetingId}/invitations/preview`)).status).toBe(403);
    expect((await call(outsider, `/meetings/${meetingId}/invitations/${invitationId}`, { club: otherClub })).status).toBe(404);
    expect((await call(outsider, `/meetings/${meetingId}/invitations/${invitationId}/post-list.csv`, { club: otherClub })).status).toBe(404);
    expect((await call(chair, `/meetings/${meetingId}/invitations/${randomUUID()}`)).status).toBe(404);
  });

  it("answers the schriftlich statute form with a post entry for everybody", async () => {
    await db.update(clubSettings).set({ assemblyRules: { ...RULES, invitationForm: "schriftlich" } }).where(eq(clubSettings.clubId, club));
    const id = await newMeeting(chair, inDays(50));
    await addItem(chair, id, "Begrüßung");
    const data = (await json(await call(chair, `/meetings/${id}/invitations`, { method: "POST", body: {} }))).data;
    const post = (await json(await call(chair, `/meetings/${id}/invitations/${data.id}?channel=post&limit=100`))).data.deliveries as Json[];
    expect(post).toHaveLength(6);
    await db.update(clubSettings).set({ assemblyRules: RULES }).where(eq(clubSettings.clubId, club));
  });
});

describe("moving the date after the invitation (review M1)", () => {
  it("re-checks the period from the first invitation and records an exception", async () => {
    const meetingId = await newMeeting(chair, inDays(30));
    await addItem(chair, meetingId, "Berichte");
    expect((await call(chair, `/meetings/${meetingId}/invitations`, { method: "POST", body: {} })).status).toBe(201);
    // Later is fine, too early (10 days < 14 + 3) is refused with the facts.
    expect((await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { scheduledAt: inDays(40) } })).status).toBe(200);
    const refused = await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { scheduledAt: inDays(10) } });
    expect(refused.status).toBe(422);
    expect((await json(refused)).error.details).toMatchObject({ code: "invitation_period_violated", requiredDays: 17 });
    expect((await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { scheduledAt: null } })).status).toBe(422);
    const ok = await json(await call(chair, `/meetings/${meetingId}`, { method: "PATCH", body: { scheduledAt: inDays(10), exceptionReason: "Hallenvermieter kann nur dann" } }));
    expect(ok.data.scheduleExceptions).toHaveLength(1);
    expect(ok.data.scheduleExceptions[0]).toMatchObject({ reason: "Hallenvermieter kann nur dann", requiredDays: 17 });
    // A meeting that was never invited moves freely.
    const free = await newMeeting(chair, inDays(30));
    expect((await call(chair, `/meetings/${free}`, { method: "PATCH", body: { scheduledAt: inDays(3) } })).status).toBe(200);
  });
});
