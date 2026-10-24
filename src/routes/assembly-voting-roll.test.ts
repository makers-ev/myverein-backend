import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { ballots, meetingVotingRoll } from "../db/schema/assembly.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { emptyAssemblyRules } from "../lib/assembly-rules.js";
import { ensureDefaultCategories } from "../lib/club-members.js";
import { toAppError } from "../lib/errors.js";
import { meetingRoutes } from "./meetings.js";

/** Wave 11 B4: voting roll (derive, freeze, override), check-in, proxies by the statute rules, quorum. Real Postgres. */

const app = new Hono();
app.route("/meetings", meetingRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { userId: string; cookie: string; clubMemberId?: string };
const userIds: string[] = [];
let club: string;
let otherClub: string;
let chair: Who;
let clerk: Who;
let plain: Who;
let outsider: Who;
const cm: Record<string, string> = {};
let meetingId: string;

const RULES = { ...emptyAssemblyRules(), invitationMinDays: 14, invitationDeliveryBufferDays: 0, invitationForm: "textform" as const, agendaRequiredInInvitation: false, quorumMode: "fraction" as const, quorumValue: 0.5, abstainCountsAs: "not_counted" as const, proxyAllowed: true, maxProxiesPerPerson: 1, votingStatuses: ["aktiv" as const, "probe" as const], votingMinAge: 16, majorityByTopic: { ...emptyAssemblyRules().majorityByTopic, allgemein: "einfach" as const } };

async function signUp(label: string): Promise<Who> {
  const email = `w11r-${label}-${suffix}@example.com`;
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
const checkIn = (ids: string[], present = true) => call(chair, `/meetings/${meetingId}/attendance`, { method: "PATCH", body: ids.map((clubMemberId) => ({ clubMemberId, present })) });
const quorum = async () => (await json(await call(plain, `/meetings/${meetingId}/quorum`))).data as Json;
const setRules = (rules: object) => db.update(clubSettings).set({ assemblyRules: rules }).where(eq(clubSettings.clubId, club));

beforeAll(async () => {
  chair = await signUp("chair");
  clerk = await signUp("clerk");
  plain = await signUp("plain");
  outsider = await signUp("outsider");
  club = (await auth.api.createOrganization({ body: { name: `TV Stimmrecht ${suffix}`, slug: `w11r-${suffix}`, userId: chair.userId } }))!.id;
  otherClub = (await auth.api.createOrganization({ body: { name: `TV Fremd ${suffix}`, slug: `w11r-x-${suffix}`, userId: outsider.userId } }))!.id;
  const accountOf = async (who: Who, clubId: string) => (await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, clubId), e(m.userId, who.userId)) }))!;
  await db.insert(clubRoles).values({ memberId: (await accountOf(chair, club)).id, roleType: "vorsitz" });
  await db.insert(clubRoles).values({ memberId: (await accountOf(outsider, otherClub)).id, roleType: "vorsitz" });
  for (const [who, roleType] of [[clerk, "schriftfuehrer"], [plain, null]] as const) {
    const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
    if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
  }
  await ensureDefaultCategories(club);
  const categories = await db.select().from(memberCategories).where(eq(memberCategories.clubId, club));
  const cat = (key: string) => categories.find((c) => c.key === key)!.id;
  // The three accounts: adults in the voting category.
  for (const who of [chair, clerk, plain]) {
    const account = await accountOf(who, club);
    const [row] = await db.update(clubMembers).set({ categoryId: cat("aktiv"), birthDate: "1985-03-03", status: "aktiv" }).where(eq(clubMembers.memberId, account.id)).returning();
    who.clubMemberId = row!.id;
    cm[who === chair ? "chair" : who === clerk ? "clerk" : "plain"] = row!.id;
  }
  const rows = await db
    .insert(clubMembers)
    .values([
      { clubId: club, displayName: "Anna", categoryId: cat("aktiv"), birthDate: "1990-01-01", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Bert", categoryId: cat("aktiv"), birthDate: "1991-01-01", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Cora", categoryId: cat("aktiv"), birthDate: "1992-01-01", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Kid", categoryId: cat("jugend"), birthDate: "2015-01-01", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Minor", categoryId: cat("aktiv"), birthDate: "2015-01-01", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Ruhend", categoryId: cat("aktiv"), birthDate: "1980-01-01", status: "ruhend", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Gone", categoryId: cat("aktiv"), birthDate: "1980-01-01", status: "ausgetreten", leftAt: "2022-01-01", joinedAt: "2020-01-01" },
    ])
    .returning();
  for (const r of rows) cm[r.displayName] = r.id;
  await db.insert(clubSettings).values({ clubId: club, assemblyRules: RULES }).onConflictDoUpdate({ target: clubSettings.clubId, set: { assemblyRules: RULES } });
  const created = await json(await call(chair, "/meetings", { method: "POST", body: { type: "mitgliederversammlung", title: "MV", scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } }));
  meetingId = created.data.id;
}, 90_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(organization).where(eq(organization.id, otherClub));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("voting right and voting roll", () => {
  it("derives the right live before the roll is frozen and tells every member their own entry", async () => {
    const roll = (await json(await call(clerk, `/meetings/${meetingId}/voting-roll`))).data;
    expect(roll).toMatchObject({ frozen: false, frozenAt: null, eligibleTotal: 6 });
    const basis = Object.fromEntries((roll.entries as Json[]).map((e) => [e.displayName, `${e.eligible}:${e.basis}`]));
    expect(basis).toMatchObject({ Anna: "true:ok", Kid: "false:category", Minor: "false:min_age", Ruhend: "false:status" });
    expect(basis.Gone).toBeUndefined();
    expect((await json(await call(plain, `/meetings/${meetingId}/voting-roll/me`))).data).toMatchObject({ frozen: false, eligible: true, basis: "ok" });
    expect((await call(plain, `/meetings/${meetingId}/voting-roll`)).status).toBe(403);
    const only = (await json(await call(clerk, `/meetings/${meetingId}/voting-roll?eligible=false`))).data.entries as Json[];
    expect(only.every((e) => e.eligible === false)).toBe(true);
  });

  it("answers the quorum from the live derivation: nobody present is not a quorum", async () => {
    expect(await quorum()).toMatchObject({ rollFrozen: false, eligibleTotal: 6, presentEligible: 0, represented: 0, required: 3, result: "nicht_beschlussfaehig" });
  });

  it("refuses to freeze while the voting parameters are not stated", async () => {
    await setRules({ ...RULES, votingStatuses: null });
    const res = await call(chair, `/meetings/${meetingId}/voting-roll/freeze`, { method: "POST" });
    expect(res.status).toBe(422);
    expect((await json(res)).error.details).toMatchObject({ code: "assembly_rules_incomplete", missing: ["votingStatuses"] });
    expect((await json(await call(plain, `/meetings/${meetingId}/voting-roll/me`))).data.basis).toBe("rules_missing");
    await setRules(RULES);
  });

  it("freezes once with the basis of every entry; only assembly:manage may", async () => {
    expect((await call(plain, `/meetings/${meetingId}/voting-roll/freeze`, { method: "POST" })).status).toBe(403);
    const res = await call(clerk, `/meetings/${meetingId}/voting-roll/freeze`, { method: "POST" });
    expect(res.status).toBe(201);
    expect((await json(res)).data).toMatchObject({ frozen: true, total: 9, eligible: 6 });
    const again = await call(clerk, `/meetings/${meetingId}/voting-roll/freeze`, { method: "POST" });
    expect(again.status).toBe(409);
    expect((await json(again)).error.details.code).toBe("voting_roll_frozen");
    // A later change of the master data does not touch the frozen roll.
    await db.update(clubMembers).set({ status: "ruhend" }).where(eq(clubMembers.id, cm.Anna!));
    expect((await json(await call(clerk, `/meetings/${meetingId}/voting-roll`))).data).toMatchObject({ frozen: true, eligibleTotal: 6 });
    await db.update(clubMembers).set({ status: "aktiv" }).where(eq(clubMembers.id, cm.Anna!));
  });

  it("changes a frozen entry only with a reason, audited, and not through the attendance flag", async () => {
    const url = `/meetings/${meetingId}/voting-roll/${cm.Kid}`;
    expect((await call(plain, url, { method: "PATCH", body: { eligible: true, reason: "Beschluss des Vorstands" } })).status).toBe(403);
    expect((await call(clerk, url, { method: "PATCH", body: { eligible: true, reason: "kurz" } })).status).toBe(422);
    expect((await call(clerk, url, { method: "PATCH", body: { eligible: true } })).status).toBe(422);
    const res = await call(clerk, url, { method: "PATCH", body: { eligible: true, reason: "Ehrenmitglied mit Stimmrecht laut Beschluss 12/2025" } });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(meetingVotingRoll).where(and(eq(meetingVotingRoll.meetingId, meetingId), eq(meetingVotingRoll.clubMemberId, cm.Kid!)));
    expect(row).toMatchObject({ eligible: true, basis: "override", overrideReason: "Ehrenmitglied mit Stimmrecht laut Beschluss 12/2025" });
    expect((await quorum()).eligibleTotal).toBe(7);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "meeting_voting_roll.override"), eq(auditLog.subjectId, meetingId)));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.payload)).not.toContain("Ehrenmitglied");
    const flag = await call(clerk, `/meetings/${meetingId}/attendance`, { method: "PATCH", body: [{ clubMemberId: cm.Kid, hasVotingRight: false }] });
    expect(flag.status).toBe(422);
    expect((await json(flag)).error.details.code).toBe("use_voting_roll_override");
    expect((await call(clerk, `/meetings/${meetingId}/voting-roll/${randomUUID()}`, { method: "PATCH", body: { eligible: true, reason: "Unbekannte Person" } })).status).toBe(404);
  });
});

describe("check-in and quorum", () => {
  it("checks members in and out (also without account) and counts only voting members", async () => {
    expect((await checkIn([cm.chair!, cm.Anna!])).status).toBe(200);
    expect(await quorum()).toMatchObject({ rollFrozen: true, eligibleTotal: 7, presentEligible: 2, represented: 2, required: 4, result: "nicht_beschlussfaehig" });
    // Ruhend is present but has no voting right: does not count.
    await checkIn([cm.Ruhend!, cm.Bert!, cm.Cora!]);
    expect(await quorum()).toMatchObject({ presentEligible: 4, represented: 4, result: "beschlussfaehig" });
    const list = (await json(await call(chair, `/meetings/${meetingId}/attendance`))).data as Json[];
    const anna = list.find((r) => r.clubMemberId === cm.Anna)!;
    expect(anna).toMatchObject({ present: true, hasVotingRight: true, checkInMethod: "schriftfuehrer", memberId: null });
    expect(list.find((r) => r.clubMemberId === cm.Ruhend)!.hasVotingRight).toBe(false);
    await checkIn([cm.Cora!], false);
    const left = ((await json(await call(chair, `/meetings/${meetingId}/attendance`))).data as Json[]).find((r) => r.clubMemberId === cm.Cora)!;
    expect(left).toMatchObject({ present: false });
    expect(left.leftAt).toBeTruthy();
    expect(left.checkedInAt).toBeTruthy();
    expect(await quorum()).toMatchObject({ represented: 3, result: "nicht_beschlussfaehig" });
    // Coming back clears the leaving time.
    await checkIn([cm.Cora!]);
    expect(((await json(await call(chair, `/meetings/${meetingId}/attendance`))).data as Json[]).find((r) => r.clubMemberId === cm.Cora)!.leftAt).toBeNull();
  });

  it("reports missing quorum rules instead of guessing", async () => {
    await setRules({ ...RULES, quorumMode: null });
    expect((await quorum()).result).toBe("regeln_fehlen");
    await setRules(RULES);
  });
});

describe("proxies", () => {
  const give = (who: Who, body: object) => call(who, `/meetings/${meetingId}/proxies`, { method: "POST", body });

  it("lets a member give their own proxy to a voting member present, and counts it in the quorum", async () => {
    const before = (await quorum()).represented;
    const res = await give(plain, { holderClubMemberId: cm.chair });
    expect(res.status).toBe(201);
    expect((await quorum())).toMatchObject({ proxiesRepresented: 1, represented: before + 1 });
    const mine = (await json(await call(plain, `/meetings/${meetingId}/proxies`))).data as Json[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ grantorClubMemberId: cm.plain, holderClubMemberId: cm.chair, holderName: "W11 chair" });
    // The board sees all proxies, a member only their own.
    expect(((await json(await call(clerk, `/meetings/${meetingId}/proxies`))).data as Json[]).length).toBe(1);
    expect(((await json(await call(chair, `/meetings/${meetingId}/proxies`))).data as Json[]).length).toBe(1);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "meeting_proxy.grant"), eq(auditLog.subjectId, meetingId)));
    expect(audit[0]!.payload).toMatchObject({ byBoard: false });
  });

  it("applies the statute: maximum per holder, no self proxy, voting right of both, giver not present, no chains", async () => {
    // The chair already holds one proxy (maximum 1).
    const max = await give(clerk, { holderClubMemberId: cm.chair });
    expect(max.status).toBe(409);
    expect((await json(max)).error.details).toMatchObject({ code: "max_proxies_reached", max: 1 });
    expect((await give(clerk, { holderClubMemberId: cm.clerk })).status).toBe(422);
    expect((await json(await give(clerk, { holderClubMemberId: cm.Minor }))).error.details.code).toBe("holder_not_eligible");
    // Somebody who is present cannot give a proxy.
    expect((await json(await give(chair, { holderClubMemberId: cm.Anna }))).error.details.code).toBe("grantor_present");
    // A holder cannot give a proxy themselves, nor can a giver hold one.
    await call(chair, `/meetings/${meetingId}/attendance`, { method: "PATCH", body: [{ clubMemberId: cm.chair, present: false }] });
    expect((await json(await give(chair, { holderClubMemberId: cm.Anna }))).error.details.code).toBe("grantor_is_holder");
    await call(chair, `/meetings/${meetingId}/attendance`, { method: "PATCH", body: [{ clubMemberId: cm.chair, present: true }] });
    expect((await json(await give(clerk, { holderClubMemberId: cm.plain }))).error.details.code).toBe("holder_is_grantor");
    expect((await give(clerk, { holderClubMemberId: randomUUID() })).status).toBe(404);
  });

  it("lets only assembly:manage record a proxy for somebody else, and only the giver or the board withdraw it", async () => {
    const forOther = await give(plain, { grantorClubMemberId: cm.Bert, holderClubMemberId: cm.Anna });
    expect(forOther.status).toBe(403);
    const byBoard = await give(clerk, { grantorClubMemberId: cm.Ruhend, holderClubMemberId: cm.Anna, proofSource: "Vollmacht per E-Mail" });
    expect(byBoard.status).toBe(422);
    expect((await json(byBoard)).error.details.code).toBe("grantor_not_eligible");
    await checkIn([cm.Bert!], false);
    // Review M9: the board needs a documented proof.
    const noProof = await give(clerk, { grantorClubMemberId: cm.Bert, holderClubMemberId: cm.Anna });
    expect((await json(noProof)).error.details.code).toBe("proof_required");
    const ok = await give(clerk, { grantorClubMemberId: cm.Bert, holderClubMemberId: cm.Anna, proofSource: "Vollmacht per E-Mail" });
    expect(ok.status).toBe(201);
    // Giving a new holder replaces the old one.
    expect((await call(plain, `/meetings/${meetingId}/proxies/${cm.Bert}`, { method: "DELETE" })).status).toBe(403);
    expect((await call(clerk, `/meetings/${meetingId}/proxies/${cm.Bert}`, { method: "DELETE" })).status).toBe(204);
    expect((await call(clerk, `/meetings/${meetingId}/proxies/${cm.Bert}`, { method: "DELETE" })).status).toBe(404);
    expect((await call(plain, `/meetings/${meetingId}/proxies/${cm.plain}`, { method: "DELETE" })).status).toBe(204);
    expect((await quorum()).proxiesRepresented).toBe(0);
    // Not while a secret ballot of the meeting is open (review M9).
    const [secret] = await db.insert(ballots).values({ clubId: club, meetingId, title: "Geheim", status: "open", mode: "in_session", kind: "resolution", topic: "allgemein", secret: true, maxChoices: 1, createdBy: chair.userId }).returning({ id: ballots.id });
    const during = await give(clerk, { grantorClubMemberId: cm.Bert, holderClubMemberId: cm.Anna, proofSource: "Vollmacht per E-Mail" });
    expect(during.status).toBe(409);
    expect((await json(during)).error.details.code).toBe("secret_ballot_open");
    await db.delete(ballots).where(eq(ballots.id, secret!.id));
    const revoke = await db.select().from(auditLog).where(and(eq(auditLog.eventType, "meeting_proxy.revoke"), eq(auditLog.subjectId, meetingId)));
    expect(revoke).toHaveLength(2);
  });

  it("follows the statute switches: not allowed, or not stated", async () => {
    await setRules({ ...RULES, proxyAllowed: false, maxProxiesPerPerson: null });
    expect((await json(await give(plain, { holderClubMemberId: cm.chair }))).error.details.code).toBe("proxy_not_allowed");
    await setRules({ ...RULES, proxyAllowed: null, maxProxiesPerPerson: null });
    expect((await json(await give(plain, { holderClubMemberId: cm.chair }))).error.details.code).toBe("assembly_rules_incomplete");
    await setRules(RULES);
  });

  it("only exists for the general assembly and never across clubs", async () => {
    const board = (await json(await call(chair, "/meetings", { method: "POST", body: { type: "sonstige", title: "Treffen" } }))).data.id;
    expect((await json(await call(plain, `/meetings/${board}/proxies`, { method: "POST", body: { holderClubMemberId: cm.chair } }))).error.details.code).toBe("proxy_not_supported");
    expect((await call(outsider, `/meetings/${meetingId}/proxies`, { method: "POST", club: otherClub, body: { holderClubMemberId: cm.chair } })).status).toBe(404);
    expect((await call(outsider, `/meetings/${meetingId}/quorum`, { club: otherClub })).status).toBe(404);
    expect((await call(outsider, `/meetings/${meetingId}/voting-roll`, { club: otherClub })).status).toBe(404);
  });
});

describe("invitation audience", () => {
  it("can invite only the members who may vote", async () => {
    const all = (await json(await call(chair, `/meetings/${meetingId}/invitations/preview`))).data;
    const voting = (await json(await call(chair, `/meetings/${meetingId}/invitations/preview?audience=voting_members`))).data;
    expect(all.recipients.total).toBeGreaterThan(voting.recipients.total);
    expect(voting.recipients.total).toBe(7);
    expect((await call(chair, `/meetings/${meetingId}/invitations/preview?audience=nobody`)).status).toBe(422);
  });
});
