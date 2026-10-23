import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { ballots, meetingMinutes } from "../db/schema/assembly.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { jobs } from "../db/schema/jobs.js";
import { meetingResolutions, meetings } from "../db/schema/meetings.js";
import { emptyAssemblyRules } from "../lib/assembly-rules.js";
import { handleBallotNotify, runBallotSweep } from "../lib/ballot-jobs.js";
import { ensureDefaultCategories } from "../lib/club-members.js";
import { toAppError } from "../lib/errors.js";
import { ballotRoutes } from "./ballots.js";
import { meetingRoutes } from "./meetings.js";

/** Wave 11 B6: circular resolutions (window, voter groups, participation / unanimity, sweep, decision record, reminder). Real Postgres. */

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
let outsider: Who;

const RULES = {
  ...emptyAssemblyRules(),
  abstainCountsAs: "not_counted" as const,
  votingStatuses: ["aktiv" as const],
  votingMinAge: 16,
  circularAllowed: true,
  circularUnanimity: false,
  circularMinParticipation: 0.5,
  majorityByTopic: { ...emptyAssemblyRules().majorityByTopic, allgemein: "einfach" as const },
};

async function signUp(label: string): Promise<Who> {
  const email = `w11c-${label}-${suffix}@example.com`;
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
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const optionOf = (ballot: Json, kind: string) => (ballot.options as Json[]).find((o) => o.kind === kind)!.id as string;
const detail = async (who: Who, id: string) => (await json(await call(who, `/ballots/${id}`))).data as Json;
const vote = (who: Who, id: string, optionIds: string[], extra: object = {}) => call(who, `/ballots/${id}/vote`, { method: "POST", body: { optionIds, ...extra } });

async function circular(body: object = {}): Promise<Json> {
  const res = await call(clerk, "/ballots", { method: "POST", body: { mode: "circular", title: "Anschaffung eines Zeltes", description: "Das Zelt kostet 800 Euro.", closesAt: inDays(2), ...body } });
  expect(res.status).toBe(201);
  const created = (await json(res)).data as Json;
  const opened = await call(clerk, `/ballots/${created.id}/open`, { method: "POST", body: {} });
  expect(opened.status).toBe(200);
  return (await json(opened)).data as Json;
}
const expire = (id: string) => db.execute(sql`update ballots set closes_at = now() - interval '1 second' where id = ${id}`);

beforeAll(async () => {
  chair = await signUp("chair");
  clerk = await signUp("clerk");
  plain = await signUp("plain");
  outsider = await signUp("outsider");
  club = (await auth.api.createOrganization({ body: { name: `TV Umlauf ${suffix}`, slug: `w11c-${suffix}`, userId: chair.userId } }))!.id;
  otherClub = (await auth.api.createOrganization({ body: { name: `TV Fremd ${suffix}`, slug: `w11c-x-${suffix}`, userId: outsider.userId } }))!.id;
  const accountOf = async (who: Who, clubId: string) => (await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, clubId), e(m.userId, who.userId)) }))!;
  await db.insert(clubRoles).values({ memberId: (await accountOf(chair, club)).id, roleType: "vorsitz" });
  await db.insert(clubRoles).values({ memberId: (await accountOf(outsider, otherClub)).id, roleType: "vorsitz" });
  for (const [who, roleType] of [[clerk, "schriftfuehrer"], [plain, null]] as const) {
    const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
    if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
  }
  await ensureDefaultCategories(club);
  const categories = await db.select().from(memberCategories).where(eq(memberCategories.clubId, club));
  const aktiv = categories.find((c) => c.key === "aktiv")!.id;
  for (const who of [chair, clerk, plain]) {
    const [row] = await db.update(clubMembers).set({ categoryId: aktiv, birthDate: "1985-03-03", status: "aktiv" }).where(eq(clubMembers.memberId, (await accountOf(who, club)).id)).returning();
    who.clubMemberId = row!.id;
  }
  await db.insert(clubMembers).values(["Anna", "Bert", "Cora"].map((displayName) => ({ clubId: club, displayName, categoryId: aktiv, birthDate: "1990-01-01", joinedAt: "2020-01-01" })));
  await db.insert(clubSettings).values({ clubId: club, assemblyRules: RULES }).onConflictDoUpdate({ target: clubSettings.clubId, set: { assemblyRules: RULES } });
}, 90_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(organization).where(eq(organization.id, otherClub));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

describe("circular resolution switches", () => {
  it("is off until the club allows it and needs its parameters", async () => {
    await setRules({ ...RULES, circularAllowed: false });
    const denied = await call(clerk, "/ballots", { method: "POST", body: { mode: "circular", title: "Umlauf" } });
    expect(denied.status).toBe(422);
    expect((await json(denied)).error.details.code).toBe("circular_not_allowed");
    await setRules({ ...RULES, circularUnanimity: null });
    const draft = (await json(await call(clerk, "/ballots", { method: "POST", body: { mode: "circular", title: "Umlauf", closesAt: inDays(2) } }))).data as Json;
    const refused = await call(clerk, `/ballots/${draft.id}/open`, { method: "POST", body: {} });
    expect(refused.status).toBe(422);
    expect((await json(refused)).error.details).toMatchObject({ code: "assembly_rules_incomplete", missing: ["circularUnanimity"] });
    await setRules(RULES);
    // The window is mandatory; a circular resolution has no meeting of its own before it is final.
    const noWindow = await call(clerk, `/ballots/${draft.id}/open`, { method: "POST", body: {} });
    expect(noWindow.status).toBe(200);
    const withMeeting = await call(clerk, "/ballots", { method: "POST", body: { mode: "circular", title: "x", meetingId: randomUUID() } });
    expect(withMeeting.status).toBe(422);
    await call(clerk, `/ballots/${draft.id}/cancel`, { method: "POST" });
  });
});

describe("circular resolution of all voting members", () => {
  it("is visible to its voters only, takes own votes only and ends with the window", async () => {
    const b = await circular();
    expect(b).toMatchObject({ mode: "circular", audience: "all_voting_members", phase: "voting", participation: { eligible: 6, voted: 0 } });
    expect(b.opening).toMatchObject({ eligible: 6, withoutAccount: 3 });
    expect(((await json(await call(plain, "/ballots?mode=circular"))).data as Json[]).map((x) => x.id)).toContain(b.id);
    expect([403, 404]).toContain((await call(outsider, `/ballots/${b.id}`)).status);
    expect((await call(outsider, `/ballots/${b.id}`, { club: otherClub })).status).toBe(404);

    const d = await detail(plain, b.id);
    expect(d.me).toMatchObject({ eligible: true, canVote: true, checkedIn: null });
    // No check-in and no proxy for a circular resolution.
    const proxy = await vote(plain, b.id, [optionOf(d, "yes")], { forClubMemberId: chair.clubMemberId });
    expect(proxy.status).toBe(403);
    expect((await json(proxy)).error.details.code).toBe("proxy_not_allowed");
    expect((await vote(plain, b.id, [optionOf(d, "yes")])).status).toBe(201);
    expect((await vote(plain, b.id, [optionOf(d, "no")])).status).toBe(409);
    expect((await vote(chair, b.id, [optionOf(d, "yes")])).status).toBe(201);

    await expire(b.id);
    const late = await vote(clerk, b.id, [optionOf(d, "yes")]);
    expect(late.status).toBe(409);
    expect((await json(late)).error.details.code).toBe("ballot_closed");

    // The scheduler closes, counts and (circular only) finalizes by itself.
    expect(await runBallotSweep({ clubId: club })).toEqual({ closed: 1, counted: 1, finalized: 1, reminders: 0 });
    const done = await detail(plain, b.id);
    // Two of six took part: below the minimum participation, so no decision.
    expect(done).toMatchObject({ status: "finalized", result: { outcome: "nicht_beschlussfaehig", reason: "participation", yes: 2, eligible: 6, participants: 2 } });
    expect(done.resultHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("decides by majority above the minimum participation and records the decision as a meeting with minutes and resolution", async () => {
    const b = await circular({ title: "Neues Zelt" });
    const d = await detail(plain, b.id);
    await vote(plain, b.id, [optionOf(d, "yes")]);
    await vote(chair, b.id, [optionOf(d, "yes")]);
    await vote(clerk, b.id, [optionOf(d, "no")]);
    await expire(b.id);
    await runBallotSweep({ clubId: club });
    const done = await detail(clerk, b.id);
    expect(done).toMatchObject({ status: "finalized", result: { outcome: "angenommen", yes: 2, no: 1, participants: 3 } });
    expect(done.meetingId).toBeTruthy();
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, done.meetingId));
    expect(meeting).toMatchObject({ clubId: club, type: "sonstige", status: "protokolliert", title: "Umlaufbeschluss: Neues Zelt" });
    const [minutes] = await db.select().from(meetingMinutes).where(eq(meetingMinutes.meetingId, meeting!.id));
    expect(minutes).toMatchObject({ version: 1, status: "archiviert" });
    expect(minutes!.content).toContain("Neues Zelt");
    expect(minutes!.content).toContain(done.resultHash);
    expect(minutes!.content).toContain("angenommen");
    const [resolution] = await db.select().from(meetingResolutions).where(eq(meetingResolutions.ballotId, b.id));
    expect(resolution).toMatchObject({ meetingId: meeting!.id, votesFor: 2, votesAgainst: 1, result: "angenommen", source: "digital" });
    // A sweep that runs twice changes nothing.
    expect(await runBallotSweep({ clubId: club })).toEqual({ closed: 0, counted: 0, finalized: 0, reminders: 0 });
  });

  it("needs every eligible member with unanimity; members without an account cannot say yes, so it fails honestly", async () => {
    await setRules({ ...RULES, circularUnanimity: true, circularMinParticipation: null });
    const b = await circular({ title: "Einstimmig" });
    const d = await detail(plain, b.id);
    for (const who of [chair, clerk, plain]) await vote(who, b.id, [optionOf(d, "yes")]);
    await expire(b.id);
    await runBallotSweep({ clubId: club });
    expect((await detail(chair, b.id)).result).toMatchObject({ outcome: "abgelehnt", reason: "unanimity", yes: 3, eligible: 6 });
    await setRules(RULES);
  });

  it("can be closed early by the board, which counts it at once", async () => {
    const b = await circular({ title: "Vorzeitig" });
    const d = await detail(plain, b.id);
    await vote(plain, b.id, [optionOf(d, "yes")]);
    expect((await call(plain, `/ballots/${b.id}/close`, { method: "POST" })).status).toBe(403);
    const closed = (await json(await call(clerk, `/ballots/${b.id}/close`, { method: "POST" }))).data as Json;
    expect(closed).toMatchObject({ status: "counted", result: { participants: 1 } });
    // The sweep finalizes it, nobody else needs to.
    await runBallotSweep({ clubId: club });
    expect((await detail(plain, b.id)).status).toBe("finalized");
  });
});

describe("circular resolution of the board", () => {
  it("is read-scoped to the board: voters are the board accounts and the record is a board meeting", async () => {
    const b = await circular({ title: "Vorstandsumlauf", audience: "board" });
    expect(b).toMatchObject({ audience: "board", participation: { eligible: 2, voted: 0 } });
    // plain holds no board role: not a voter, so the ballot does not exist for them.
    expect((await call(plain, `/ballots/${b.id}`)).status).toBe(404);
    expect(((await json(await call(plain, "/ballots"))).data as Json[]).map((x) => x.id)).not.toContain(b.id);
    const d = await detail(chair, b.id);
    expect((await vote(plain, b.id, [optionOf(d, "yes")])).status).toBe(403);
    await vote(chair, b.id, [optionOf(d, "yes")]);
    await vote(clerk, b.id, [optionOf(d, "yes")]);
    await expire(b.id);
    await runBallotSweep({ clubId: club });
    const done = await detail(clerk, b.id);
    expect(done.result).toMatchObject({ outcome: "angenommen", eligible: 2, participants: 2 });
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, done.meetingId));
    expect(meeting!.type).toBe("vorstandssitzung");
    expect((await call(plain, `/meetings/${meeting!.id}`)).status).toBe(404);
    expect((await call(chair, `/meetings/${meeting!.id}`)).status).toBe(200);
    expect((await call(clerk, `/meetings/${meeting!.id}`)).status).toBe(200);
  });
});

describe("reminder", () => {
  it("is scheduled once, shortly before the window ends, for circular resolutions", async () => {
    const b = await circular({ title: "Erinnerung", closesAt: inDays(5) });
    expect(await runBallotSweep({ clubId: club })).toMatchObject({ reminders: 0 });
    await db.execute(sql`update ballots set closes_at = now() + interval '12 hours' where id = ${b.id}`);
    expect(await runBallotSweep({ clubId: club })).toMatchObject({ reminders: 1 });
    expect(await runBallotSweep({ clubId: club })).toMatchObject({ reminders: 0 });
    const queued = await db.select().from(jobs).where(and(eq(jobs.type, "ballot_notify"), eq(jobs.dedupeKey, `ballot_reminder:${b.id}`)));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toEqual({ kind: "reminder", ballotId: b.id });
    // The call to vote was queued when the ballot opened.
    expect((await db.select().from(jobs).where(eq(jobs.dedupeKey, `ballot_opened:${b.id}`)))).toHaveLength(1);
    // The handlers run without error; for a ballot that is no longer open they send nothing.
    const job = (kind: string) => ({ id: randomUUID(), type: "ballot_notify", payload: { kind, ballotId: b.id }, attempt: 1, maxAttempts: 5 });
    await expect(handleBallotNotify(job("opened"))).resolves.toBeUndefined();
    await expect(handleBallotNotify(job("reminder"))).resolves.toBeUndefined();
    await call(clerk, `/ballots/${b.id}/cancel`, { method: "POST" });
    await expect(handleBallotNotify(job("reminder"))).resolves.toBeUndefined();
    expect((await db.select({ status: ballots.status }).from(ballots).where(eq(ballots.id, b.id)))[0]!.status).toBe("cancelled");
  });
});
