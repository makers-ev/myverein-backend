import { randomUUID } from "node:crypto";

import { and, eq, inArray, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { ballotVotesOpen, ballotVotesSecret, ballotVoters, ballots } from "../db/schema/assembly.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { meetingResolutions } from "../db/schema/meetings.js";
import { emptyAssemblyRules } from "../lib/assembly-rules.js";
import { ensureDefaultCategories } from "../lib/club-members.js";
import { toAppError } from "../lib/errors.js";
import { ballotRoutes } from "./ballots.js";
import { meetingRoutes } from "./meetings.js";

/** Wave 11 B5: ballots (open / secret), double votes, window, quorum, proxies, count and finalize. Real Postgres. */

const app = new Hono();
app.route("/meetings", meetingRoutes);
app.route("/ballots", ballotRoutes);
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
let young: Who;
let outsider: Who;
const cm: Record<string, string> = {};
let meetingId: string;

const RULES = {
  ...emptyAssemblyRules(),
  invitationMinDays: 14,
  invitationDeliveryBufferDays: 0,
  invitationForm: "textform" as const,
  agendaRequiredInInvitation: false,
  quorumMode: "fraction" as const,
  quorumValue: 0.5,
  abstainCountsAs: "not_counted" as const,
  proxyAllowed: true,
  maxProxiesPerPerson: 1,
  votingStatuses: ["aktiv" as const, "probe" as const],
  votingMinAge: 16,
  majorityByTopic: { ...emptyAssemblyRules().majorityByTopic, allgemein: "einfach" as const, satzungsaenderung: "drei_viertel" as const, wahl: "einfach" as const },
};

async function signUp(label: string): Promise<Who> {
  const email = `w11b-${label}-${suffix}@example.com`;
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
const setRules = (rules: object) => db.update(clubSettings).set({ assemblyRules: rules }).where(eq(clubSettings.clubId, club));
const checkIn = (ids: string[], present = true) => call(chair, `/meetings/${meetingId}/attendance`, { method: "PATCH", body: ids.map((clubMemberId) => ({ clubMemberId, present })) });

const create = async (body: object = {}) => {
  const res = await call(clerk, "/ballots", { method: "POST", body: { meetingId, title: "Antrag", ...body } });
  expect(res.status).toBe(201);
  return (await json(res)).data as Json;
};
const open = (id: string, body: object = {}) => call(clerk, `/ballots/${id}/open`, { method: "POST", body });
const detail = async (who: Who, id: string) => (await json(await call(who, `/ballots/${id}`))).data as Json;
const optionOf = (ballot: Json, kind: string) => (ballot.options as Json[]).find((o) => o.kind === kind)!.id as string;
const vote = (who: Who, id: string, optionIds: string[], extra: object = {}) => call(who, `/ballots/${id}/vote`, { method: "POST", body: { optionIds, ...extra } });

beforeAll(async () => {
  chair = await signUp("chair");
  clerk = await signUp("clerk");
  plain = await signUp("plain");
  young = await signUp("young");
  outsider = await signUp("outsider");
  club = (await auth.api.createOrganization({ body: { name: `TV Abstimmung ${suffix}`, slug: `w11b-${suffix}`, userId: chair.userId } }))!.id;
  otherClub = (await auth.api.createOrganization({ body: { name: `TV Fremd ${suffix}`, slug: `w11b-x-${suffix}`, userId: outsider.userId } }))!.id;
  const accountOf = async (who: Who, clubId: string) => (await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, clubId), e(m.userId, who.userId)) }))!;
  await db.insert(clubRoles).values({ memberId: (await accountOf(chair, club)).id, roleType: "vorsitz" });
  await db.insert(clubRoles).values({ memberId: (await accountOf(outsider, otherClub)).id, roleType: "vorsitz" });
  for (const [who, roleType] of [[clerk, "schriftfuehrer"], [plain, null], [young, null]] as const) {
    const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
    if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
  }
  await ensureDefaultCategories(club);
  const categories = await db.select().from(memberCategories).where(eq(memberCategories.clubId, club));
  const cat = (key: string) => categories.find((c) => c.key === key)!.id;
  for (const [name, who, category] of [["chair", chair, "aktiv"], ["clerk", clerk, "aktiv"], ["plain", plain, "aktiv"], ["young", young, "jugend"]] as const) {
    const account = await accountOf(who, club);
    const [row] = await db.update(clubMembers).set({ categoryId: cat(category), birthDate: name === "young" ? "2015-01-01" : "1985-03-03", status: "aktiv" }).where(eq(clubMembers.memberId, account.id)).returning();
    who.clubMemberId = row!.id;
    cm[name] = row!.id;
  }
  const rows = await db
    .insert(clubMembers)
    .values([
      { clubId: club, displayName: "Anna", categoryId: cat("aktiv"), birthDate: "1990-01-01", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Bert", categoryId: cat("aktiv"), birthDate: "1991-01-01", joinedAt: "2020-01-01" },
      { clubId: club, displayName: "Cora", categoryId: cat("aktiv"), birthDate: "1992-01-01", joinedAt: "2020-01-01" },
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

describe("opening a ballot", () => {
  it("creates a draft with Ja / Nein / Enthaltung; only assembly:manage manages", async () => {
    expect((await call(plain, "/ballots", { method: "POST", body: { meetingId, title: "Antrag" } })).status).toBe(403);
    const b = await create({ description: "Der Beitrag steigt." });
    expect(b).toMatchObject({ status: "draft", phase: "draft", mode: "in_session", secret: false, topic: "allgemein", maxChoices: 1 });
    expect((b.options as Json[]).map((o) => o.kind)).toEqual(["yes", "no", "abstain"]);
    // Drafts are invisible to members.
    expect((await call(plain, `/ballots/${b.id}`)).status).toBe(404);
    expect(((await json(await call(plain, "/ballots"))).data as Json[]).some((x) => x.id === b.id)).toBe(false);
    expect(((await json(await call(clerk, "/ballots"))).data as Json[]).some((x) => x.id === b.id)).toBe(true);
    const patched = await call(clerk, `/ballots/${b.id}`, { method: "PATCH", body: { title: "Antrag 1" } });
    expect((await json(patched)).data.title).toBe("Antrag 1");
    expect((await call(clerk, `/ballots/${b.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("checks the quorum whenever a ballot is opened, and freezes the voting roll on the first opening", async () => {
    const b = await create();
    const refused = await open(b.id);
    expect(refused.status).toBe(409);
    expect((await json(refused)).error.details).toMatchObject({ code: "not_quorate", quorum: { result: "nicht_beschlussfaehig", represented: 0 } });
    expect((await checkIn([cm.chair!, cm.clerk!, cm.plain!])).status).toBe(200);
    const ok = await open(b.id);
    expect(ok.status).toBe(200);
    const opened = (await json(ok)).data as Json;
    expect(opened).toMatchObject({ status: "open", phase: "voting", majority: "einfach", participation: { eligible: 6, voted: 0 } });
    expect(opened.opening).toMatchObject({ eligible: 6, quorum: { result: "beschlussfaehig" } });
    const [{ frozen }] = (await db.execute(sql`select voting_roll_frozen_at is not null as frozen from meetings where id = ${meetingId}`)).rows as Array<{ frozen: boolean }>;
    expect(frozen).toBe(true);
    // Leaving the room later does not matter for a ballot that is already open, but the next opening checks again.
    const noReason = await call(clerk, `/ballots/${b.id}/cancel`, { method: "POST" });
    expect((await json(noReason)).error.details.code).toBe("reason_required");
    await call(clerk, `/ballots/${b.id}/cancel`, { method: "POST", body: { reason: "Falsch geöffnet" } });
    const [cancelled] = await db.select({ reason: ballots.cancelReason }).from(ballots).where(eq(ballots.id, b.id));
    expect(cancelled!.reason).toBe("Falsch geöffnet");
    await checkIn([cm.clerk!, cm.plain!], false);
    const next = await create();
    expect((await open(next.id)).status).toBe(409);
    await checkIn([cm.clerk!, cm.plain!]);
    await call(clerk, `/ballots/${next.id}`, { method: "DELETE" });
  });

  it("refuses to open while the statute parameters are incomplete, and blocks statute-level topics without an announced agenda item", async () => {
    await setRules({ ...RULES, abstainCountsAs: null });
    const a = await create();
    const refused = await open(a.id);
    expect(refused.status).toBe(422);
    expect((await json(refused)).error.details).toMatchObject({ code: "assembly_rules_incomplete", missing: ["abstainCountsAs"] });
    await setRules({ ...RULES, agendaRequiredInInvitation: true });
    // The topic comes from the agenda item and cannot be chosen freely (review M2).
    expect((await call(clerk, "/ballots", { method: "POST", body: { meetingId, title: "Frei", topic: "satzungsaenderung" } })).status).toBe(422);
    const item = (await json(await call(clerk, `/meetings/${meetingId}/agenda-items`, { method: "POST", body: { title: "Satzung", voteKind: "resolution", topic: "satzungsaenderung" } }))).data;
    const mismatch = await call(clerk, "/ballots", { method: "POST", body: { meetingId, title: "Falsch", agendaItemId: item.id, topic: "allgemein" } });
    expect((await json(mismatch)).error.details).toMatchObject({ code: "topic_mismatch", agendaItemTopic: "satzungsaenderung" });
    const statute = await create({ agendaItemId: item.id });
    expect(statute.topic).toBe("satzungsaenderung");
    const blocked = await open(statute.id);
    expect(blocked.status).toBe(422);
    expect((await json(blocked)).error.details.code).toBe("agenda_item_not_announced");
    // A plain resolution is only warned about, and the warning travels into the result.
    const plainTopic = await open(a.id);
    expect(plainTopic.status).toBe(200);
    expect((await json(plainTopic)).data.warnings).toEqual(["no_invitation", "agenda_item_not_announced"]);
    await setRules(RULES);
    for (const id of [a.id, statute.id]) await call(clerk, `/ballots/${id}/cancel`, { method: "POST", body: { reason: "Testende" } });
  });

  it("keeps the digital secret ballot switched off until the club allows it", async () => {
    const res = await call(clerk, "/ballots", { method: "POST", body: { meetingId, title: "Geheim", secret: true } });
    expect(res.status).toBe(422);
    expect((await json(res)).error.details.code).toBe("secret_ballot_not_allowed");
  });
});

describe("voting (open ballot)", () => {
  let ballotId: string;
  let yes: string;
  let no: string;
  let abstain: string;

  it("lets only checked-in members of the voting roll vote, exactly once, even in parallel", async () => {
    const b = await create({ title: "Offene Abstimmung" });
    ballotId = b.id;
    expect((await open(b.id)).status).toBe(200);
    const d = await detail(plain, b.id);
    yes = optionOf(d, "yes");
    no = optionOf(d, "no");
    abstain = optionOf(d, "abstain");
    expect(d.me).toMatchObject({ eligible: true, hasVoted: false, canVote: true, checkedIn: true });

    // Not on the roll (Jugend) and not checked in.
    expect((await vote(young, b.id, [yes])).status).toBe(403);
    expect((await json(await vote(young, b.id, [yes]))).error.details.code).toBe("not_eligible");
    await checkIn([cm.plain!], false);
    const absent = await vote(plain, b.id, [yes]);
    expect(absent.status).toBe(403);
    expect((await json(absent)).error.details.code).toBe("not_checked_in");
    await checkIn([cm.plain!]);

    // Invalid selections never burn the vote.
    expect((await vote(plain, b.id, [yes, no])).status).toBe(422);
    expect((await vote(plain, b.id, [randomUUID()])).status).toBe(422);
    expect((await vote(plain, b.id, [])).status).toBe(422);

    const results = await Promise.all(Array.from({ length: 50 }, () => vote(plain, b.id, [yes])));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const others = results.filter((r) => r.status !== 201);
    expect(others).toHaveLength(49);
    expect(new Set(others.map((r) => r.status))).toEqual(new Set([409]));
    expect((await json(others[0]!)).error.details.code).toBe("already_voted");
    const rows = await db.select().from(ballotVotesOpen).where(eq(ballotVotesOpen.ballotId, b.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clubMemberId).toBe(cm.plain);
    expect((await detail(plain, b.id)).me).toMatchObject({ hasVoted: true, canVote: false, ownVoteOptionIds: [yes] });
  });

  it("answers the vote without echoing the choice and keeps the participation aggregated", async () => {
    const res = await vote(chair, ballotId, [no]);
    expect(res.status).toBe(201);
    expect(Object.keys((await json(res)).data).sort()).toEqual(["ballotId", "forClubMemberId", "voted"]);
    expect((await detail(clerk, ballotId)).participation).toMatchObject({ eligible: 6, voted: 2 });
    expect((await detail(plain, ballotId)).participation).toBeUndefined();
    // Votes are not readable while the ballot runs, for nobody.
    expect((await call(clerk, `/ballots/${ballotId}/votes`)).status).toBe(409);
    expect((await call(plain, `/ballots/${ballotId}/votes`)).status).toBe(403);
  });

  it("lets a proxy holder vote for the grantor and nobody else", async () => {
    const proxy = await call(plain, `/meetings/${meetingId}/proxies`, { method: "POST", body: { holderClubMemberId: cm.clerk } });
    // plain is present: the proxy giver must be absent.
    expect(proxy.status).toBe(409);
    expect((await call(clerk, `/meetings/${meetingId}/proxies`, { method: "POST", body: { holderClubMemberId: cm.clerk, grantorClubMemberId: cm.Anna, proofSource: "Vollmacht liegt vor" } })).status).toBe(201);
    const d = await detail(clerk, ballotId);
    expect(d.me.proxies).toEqual([expect.objectContaining({ grantorClubMemberId: cm.Anna, hasVoted: false })]);
    expect((await vote(chair, ballotId, [yes], { forClubMemberId: cm.Anna })).status).toBe(403);
    expect((await json(await vote(chair, ballotId, [yes], { forClubMemberId: cm.Anna }))).error.details.code).toBe("no_proxy");
    expect((await vote(clerk, ballotId, [yes], { forClubMemberId: cm.Anna })).status).toBe(201);
    expect((await vote(clerk, ballotId, [yes], { forClubMemberId: cm.Anna })).status).toBe(409);
    expect((await vote(clerk, ballotId, [abstain])).status).toBe(201);
    const [anna] = await db.select().from(ballotVoters).where(and(eq(ballotVoters.ballotId, ballotId), eq(ballotVoters.clubMemberId, cm.Anna!)));
    expect(anna).toMatchObject({ hasVoted: true, castByClubMemberId: cm.clerk });
  });

  it("enforces the window with the database clock", async () => {
    const b = await create({ title: "Fenster" });
    expect((await open(b.id)).status).toBe(200);
    const yesId = optionOf(await detail(chair, b.id), "yes");
    // Not started yet.
    await db.execute(sql`update ballots set opens_at = now() + interval '1 hour' where id = ${b.id}`);
    const early = await vote(chair, b.id, [yesId]);
    expect(early.status).toBe(409);
    expect((await json(early)).error.details.code).toBe("ballot_not_started");
    expect((await detail(chair, b.id)).phase).toBe("scheduled");
    // Exactly at closes_at is already too late; one second before is fine.
    await db.execute(sql`update ballots set opens_at = now() - interval '1 hour', closes_at = now() where id = ${b.id}`);
    const late = await vote(chair, b.id, [yesId]);
    expect(late.status).toBe(409);
    expect((await json(late)).error.details.code).toBe("ballot_closed");
    await db.execute(sql`update ballots set closes_at = now() + interval '5 seconds' where id = ${b.id}`);
    expect((await vote(chair, b.id, [yesId])).status).toBe(201);
    // Once the window is over the read materializes the end (no scheduler needed).
    await db.execute(sql`update ballots set closes_at = now() - interval '1 second' where id = ${b.id}`);
    expect((await detail(chair, b.id)).status).toBe("closed");
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from audit_log where event_type = 'ballot.close' and subject_id = ${b.id}`)).rows as Array<{ n: number }>;
    expect(n).toBe(1);
    // The voting is over: the result is finalized, never withdrawn (review M3).
    const cancelLate = await call(clerk, `/ballots/${b.id}/cancel`, { method: "POST", body: { reason: "zu spaet" } });
    expect(cancelLate.status).toBe(409);
    expect((await json(cancelLate)).error.details).toMatchObject({ code: "ballot_not_cancellable", status: "closed" });
  });

  it("closes, counts and finalizes: named votes for the board, result for members only when final, resolution with checksum", async () => {
    expect((await call(plain, `/ballots/${ballotId}/close`, { method: "POST" })).status).toBe(403);
    const closed = await call(clerk, `/ballots/${ballotId}/close`, { method: "POST" });
    expect(closed.status).toBe(200);
    const counted = (await json(closed)).data as Json;
    expect(counted).toMatchObject({ status: "counted", result: { outcome: "angenommen", yes: 2, no: 1, abstain: 1, participants: 4, eligible: 6, quorum: "beschlussfaehig", flags: { unannouncedAgendaItem: true } } });
    // A closed ballot takes no more votes; members see no result before it is final.
    expect((await vote(clerk, ballotId, [yes])).status).toBe(409);
    expect((await detail(plain, ballotId)).result).toBeNull();
    const votes = (await json(await call(clerk, `/ballots/${ballotId}/votes`))).data;
    expect(votes.secret).toBe(false);
    expect((votes.votes as Json[]).find((v) => v.clubMemberId === cm.plain)).toMatchObject({ displayName: expect.any(String), optionId: yes });
    expect((await call(plain, `/ballots/${ballotId}/votes`)).status).toBe(403);

    const finalized = await call(clerk, `/ballots/${ballotId}/finalize`, { method: "POST" });
    expect(finalized.status).toBe(200);
    const final = (await json(finalized)).data as Json;
    expect(final).toMatchObject({ status: "finalized", result: { final: true } });
    expect(final.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await detail(plain, ballotId)).result).toMatchObject({ outcome: "angenommen" });
    const [resolution] = await db.select().from(meetingResolutions).where(eq(meetingResolutions.ballotId, ballotId));
    expect(resolution).toMatchObject({ meetingId, votesFor: 2, votesAgainst: 1, votesAbstain: 1, result: "angenommen", source: "digital" });
    expect(resolution!.description).toContain("nicht in der Einladung angekündigt");
    expect((await call(clerk, `/ballots/${ballotId}/finalize`, { method: "POST" })).status).toBe(409);
    expect((await call(clerk, `/ballots/${ballotId}/cancel`, { method: "POST" })).status).toBe(409);
  });

  it("never leaks a ballot across clubs or to guests", async () => {
    expect([403, 404]).toContain((await call(outsider, `/ballots/${ballotId}`)).status);
    expect((await call(outsider, `/ballots/${ballotId}`, { club: otherClub })).status).toBe(404);
    expect((await vote(outsider, ballotId, [yes], {})).status).not.toBe(201);
    expect((await call(outsider, `/ballots/${ballotId}/finalize`, { method: "POST", club: otherClub })).status).toBe(404);
  });
});

describe("secret ballot (ADR option A)", () => {
  let secretId: string;

  it("stores votes without member, voter-roll link or timestamp, and audits nothing per vote", async () => {
    await setRules({ ...RULES, secretBallotDigitalAllowed: true });
    const b = await create({ title: "Geheime Wahl", secret: true });
    secretId = b.id;
    expect((await open(b.id)).status).toBe(200);
    const d = await detail(plain, b.id);
    const [yes, no] = [optionOf(d, "yes"), optionOf(d, "no")];
    // Anna, Bert and Cora have no account: the three accounts vote.
    for (const [who, option] of [[chair, yes], [clerk, no], [plain, yes]] as const) expect((await vote(who, b.id, [option])).status).toBe(201);
    expect((await vote(plain, b.id, [no])).status).toBe(409);

    const rows = await db.select().from(ballotVotesSecret).where(eq(ballotVotesSecret.ballotId, b.id));
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0]!).sort()).toEqual(["ballotId", "id", "optionId"]);
    const voters = await db.select().from(ballotVoters).where(and(eq(ballotVoters.ballotId, b.id), eq(ballotVoters.hasVoted, true)));
    expect(voters).toHaveLength(3);
    // A secret ballot does not echo the own vote.
    expect((await detail(plain, b.id)).me).toMatchObject({ hasVoted: true, ownVoteOptionIds: null });
    // Only the lifecycle of the ballot is audited, never a vote.
    const audit = await db.select({ eventType: auditLog.eventType, payload: auditLog.payload }).from(auditLog).where(and(eq(auditLog.subjectId, b.id), like(auditLog.eventType, "ballot.%")));
    expect(audit.map((a) => a.eventType).sort()).toEqual(["ballot.create", "ballot.open"]);
    expect(JSON.stringify(audit)).not.toContain(cm.plain!);
  });

  it("has no column or constraint that could link a vote to a person or to the order of voting", async () => {
    const cols = (await db.execute(sql`select column_name from information_schema.columns where table_name = 'ballot_votes_secret' order by column_name`)).rows.map((r) => (r as Json).column_name);
    expect(cols).toEqual(["ballot_id", "id", "option_id"]);
    const fks = (await db.execute(sql`select confrelid::regclass::text as target from pg_constraint where conrelid = 'ballot_votes_secret'::regclass and contype = 'f' order by 1`)).rows.map((r) => (r as Json).target);
    expect(fks).toEqual(["ballot_options", "ballot_options", "ballots"]);
    const idDefault = (await db.execute(sql`select column_default from information_schema.columns where table_name = 'ballot_votes_secret' and column_name = 'id'`)).rows[0] as Json;
    expect(idDefault.column_default).toContain("gen_random_uuid");
  });

  it("closes, counts and hands out the individual votes anonymously and in random order", async () => {
    const closed = await call(clerk, `/ballots/${secretId}/close`, { method: "POST" });
    expect((await json(closed)).data.result).toMatchObject({ outcome: "angenommen", yes: 2, no: 1, participants: 3 });
    const orders = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const votes = (await json(await call(clerk, `/ballots/${secretId}/votes`))).data;
      expect(votes.secret).toBe(true);
      expect((votes.votes as Json[]).every((v) => Object.keys(v).join() === "optionId")).toBe(true);
      orders.add((votes.votes as Json[]).map((v) => v.optionId).join());
    }
    expect(orders.size).toBeGreaterThan(1);
    await setRules(RULES);
  });
});

describe("ballot results by majority", () => {
  it("rejects a motion that misses the statute majority and reports a missing quorum for the result", async () => {
    await setRules({ ...RULES, majorityByTopic: { ...RULES.majorityByTopic, allgemein: "drei_viertel" } });
    const b = await create({ title: "Drei Viertel" });
    expect((await open(b.id)).status).toBe(200);
    const d = await detail(chair, b.id);
    await vote(chair, b.id, [optionOf(d, "yes")]);
    await vote(clerk, b.id, [optionOf(d, "yes")]);
    await vote(plain, b.id, [optionOf(d, "no")]);
    const counted = (await json(await call(clerk, `/ballots/${b.id}/close`, { method: "POST" }))).data;
    expect(counted).toMatchObject({ majority: "drei_viertel", result: { outcome: "abgelehnt", yes: 2, no: 1 } });
    await setRules(RULES);
  });

  it("freezes the rules at opening: a later change of the statute does not change a running ballot", async () => {
    const b = await create({ title: "Snapshot" });
    expect((await open(b.id)).status).toBe(200);
    await setRules({ ...RULES, majorityByTopic: { ...RULES.majorityByTopic, allgemein: "einstimmig" } });
    const d = await detail(chair, b.id);
    expect(d.majority).toBe("einfach");
    await vote(chair, b.id, [optionOf(d, "yes")]);
    await vote(clerk, b.id, [optionOf(d, "no")]);
    await vote(plain, b.id, [optionOf(d, "yes")]);
    expect((await json(await call(clerk, `/ballots/${b.id}/close`, { method: "POST" }))).data.result.outcome).toBe("angenommen");
    await setRules(RULES);
  });

  it("supports free options with the relative majority and reports ties instead of deciding them", async () => {
    const b = await create({ title: "Ort der Feier", choices: ["Halle", "Wiese"] });
    expect((await open(b.id)).status).toBe(200);
    const d = await detail(chair, b.id);
    const [halle, wiese] = (d.options as Json[]).filter((o) => o.kind === "choice").map((o) => o.id as string);
    await vote(chair, b.id, [halle!]);
    await vote(clerk, b.id, [wiese!]);
    const counted = (await json(await call(clerk, `/ballots/${b.id}/close`, { method: "POST" }))).data;
    expect(counted.result).toMatchObject({ form: "choice", outcome: "gleichstand", tiedOptionIds: expect.arrayContaining([halle, wiese]) });
    const rows = await db.select({ status: ballots.status }).from(ballots).where(eq(ballots.id, b.id));
    expect(rows[0]!.status).toBe("counted");
  });
});
