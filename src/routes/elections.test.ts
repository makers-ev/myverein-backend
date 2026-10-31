import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoleTerms, electionCandidates, elections } from "../db/schema/assembly.js";
import { clubMembers, memberCategories } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { meetingResolutions } from "../db/schema/meetings.js";
import { emptyAssemblyRules } from "../lib/assembly-rules.js";
import { ensureDefaultCategories } from "../lib/club-members.js";
import { addMonths, grantPendingElectionRoles } from "../lib/elections.js";
import { toAppError } from "../lib/errors.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { ballotRoutes } from "./ballots.js";
import { electionRoutes } from "./elections.js";
import { meetingRoutes } from "./meetings.js";

/** Wave 11 B7: elections (rounds as ballots, tie lot, Stichwahl), acceptance and the feedback into the role model. Real Postgres. */

const app = new Hono();
app.route("/meetings", meetingRoutes);
app.route("/ballots", ballotRoutes);
app.route("/elections", electionRoutes);
app.onError((err, c) => {
  const appError = toAppError(err);
  return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
});

const suffix = Date.now();
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Who = { userId: string; cookie: string; clubMemberId?: string; accountId?: string };
const userIds: string[] = [];
let club: string;
let otherClub: string;
let chair: Who;
let clerk: Who;
let p1: Who;
let p2: Who;
let p3: Who;
let outsider: Who;
let dora: string;
let meetingId: string;
let aktiv: string;

const RULES = {
  ...emptyAssemblyRules(),
  invitationMinDays: 14,
  invitationDeliveryBufferDays: 0,
  invitationForm: "textform" as const,
  agendaRequiredInInvitation: false,
  quorumMode: "fraction" as const,
  quorumValue: 0.5,
  abstainCountsAs: "not_counted" as const,
  proxyAllowed: false,
  votingStatuses: ["aktiv" as const],
  votingMinAge: 16,
  majorityByTopic: { ...emptyAssemblyRules().majorityByTopic, allgemein: "einfach" as const, wahl: "einfach" as const },
};

async function signUp(label: string): Promise<Who> {
  const email = `w11e-${label}-${suffix}@example.com`;
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

const newElection = async (body: object = {}): Promise<Json> => {
  const res = await call(clerk, "/elections", { method: "POST", body: { meetingId, roleType: "kassenwart", seats: 1, termMonths: 24, ...body } });
  expect(res.status).toBe(201);
  return (await json(res)).data as Json;
};
const election = async (who: Who, id: string) => (await json(await call(who, `/elections/${id}`))).data as Json;
const candidate = (e: Json, clubMemberId: string) => (e.candidates as Json[]).find((c) => c.clubMemberId === clubMemberId)!;
const stand = async (id: string, who: string[]) => {
  for (const clubMemberId of who) expect((await call(clerk, `/elections/${id}/candidates`, { method: "POST", body: { clubMemberId, willing: true } })).status).toBe(201);
};
const optionFor = (ballot: Json, clubMemberId: string) => (ballot.options as Json[]).find((o) => o.candidateClubMemberId === clubMemberId)!.id as string;
const ballot = async (id: string) => (await json(await call(clerk, `/ballots/${id}`))).data as Json;
const vote = (who: Who, id: string, optionIds: string[]) => call(who, `/ballots/${id}/vote`, { method: "POST", body: { optionIds } });

/** Runs one round: set up, open, let `votes` vote (who -> candidates' club member ids), close, finalize. */
async function runRound(electionId: string, votes: Array<[Who, string[]]>, round: object = {}): Promise<string> {
  const created = await call(clerk, `/elections/${electionId}/rounds`, { method: "POST", body: round });
  expect(created.status).toBe(201);
  const ballotId = (await json(created)).data.ballotId as string;
  const opened = await call(clerk, `/ballots/${ballotId}/open`, { method: "POST", body: {} });
  expect(opened.status).toBe(200);
  const b = (await json(opened)).data as Json;
  for (const [who, picks] of votes) expect((await vote(who, ballotId, picks.map((p) => optionFor(b, p)))).status).toBe(201);
  expect((await call(clerk, `/ballots/${ballotId}/close`, { method: "POST" })).status).toBe(200);
  expect((await call(clerk, `/ballots/${ballotId}/finalize`, { method: "POST" })).status).toBe(200);
  return ballotId;
}

beforeAll(async () => {
  [chair, clerk, p1, p2, p3, outsider] = [await signUp("chair"), await signUp("clerk"), await signUp("p1"), await signUp("p2"), await signUp("p3"), await signUp("outsider")];
  club = (await auth.api.createOrganization({ body: { name: `TV Wahl ${suffix}`, slug: `w11e-${suffix}`, userId: chair.userId } }))!.id;
  otherClub = (await auth.api.createOrganization({ body: { name: `TV Fremd ${suffix}`, slug: `w11e-x-${suffix}`, userId: outsider.userId } }))!.id;
  const accountOf = async (who: Who, clubId: string) => (await db.query.member.findFirst({ where: (m, { and: a, eq: e }) => a(e(m.organizationId, clubId), e(m.userId, who.userId)) }))!;
  await db.insert(clubRoles).values({ memberId: (await accountOf(chair, club)).id, roleType: "vorsitz" });
  await db.insert(clubRoles).values({ memberId: (await accountOf(outsider, otherClub)).id, roleType: "vorsitz" });
  for (const [who, roleType] of [[clerk, "schriftfuehrer"], [p1, null], [p2, null], [p3, null]] as const) {
    const account = (await auth.api.addMember({ body: { userId: who.userId, organizationId: club, role: "member" } }))!;
    if (roleType) await db.insert(clubRoles).values({ memberId: account.id, roleType });
  }
  await ensureDefaultCategories(club);
  aktiv = (await db.select().from(memberCategories).where(and(eq(memberCategories.clubId, club), eq(memberCategories.key, "aktiv"))))[0]!.id;
  for (const who of [chair, clerk, p1, p2, p3]) {
    const account = await accountOf(who, club);
    who.accountId = account.id;
    const [row] = await db.update(clubMembers).set({ categoryId: aktiv, birthDate: "1985-03-03", status: "aktiv" }).where(eq(clubMembers.memberId, account.id)).returning();
    who.clubMemberId = row!.id;
  }
  dora = (await db.insert(clubMembers).values({ clubId: club, displayName: "Dora", categoryId: aktiv, birthDate: "1990-01-01", joinedAt: "2020-01-01" }).returning())[0]!.id;
  await db.insert(clubSettings).values({ clubId: club, assemblyRules: RULES }).onConflictDoUpdate({ target: clubSettings.clubId, set: { assemblyRules: RULES } });
  meetingId = (await json(await call(chair, "/meetings", { method: "POST", body: { type: "mitgliederversammlung", title: "MV mit Wahlen", scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } }))).data.id;
  const present = await call(chair, `/meetings/${meetingId}/attendance`, { method: "PATCH", body: [chair, clerk, p1, p2, p3].map((w) => ({ clubMemberId: w.clubMemberId, present: true })) });
  expect(present.status).toBe(200);
}, 90_000);

afterAll(async () => {
  await db.delete(organization).where(eq(organization.id, club));
  await db.delete(organization).where(eq(organization.id, otherClub));
  await db.delete(user).where(inArray(user.id, userIds));
  await closeDatabase();
});

it("adds months with the end of the month kept", () => {
  expect(addMonths("2026-10-23", 24)).toBe("2028-10-23");
  expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
  expect(addMonths("2026-12-15", 3)).toBe("2027-03-15");
});

describe("setting up an election", () => {
  it("is managed by assembly:manage only and validates the office", async () => {
    expect((await call(p1, "/elections", { method: "POST", body: { roleType: "kassenwart", seats: 1 } })).status).toBe(403);
    const guardian = await call(clerk, "/elections", { method: "POST", body: { roleType: "erziehungsberechtigt", seats: 1 } });
    expect(guardian.status).toBe(422);
    const noDepartment = await call(clerk, "/elections", { method: "POST", body: { roleType: "abteilungsleitung", seats: 1 } });
    expect((await json(noDepartment)).error.details.code).toBe("department_required");
    const withDepartment = await call(clerk, "/elections", { method: "POST", body: { roleType: "kassenwart", seats: 1, departmentId: randomUUID() } });
    expect((await json(withDepartment)).error.details.code).toBe("department_not_allowed");
    expect((await call(clerk, "/elections", { method: "POST", body: { roleType: "kassenwart", seats: 1, meetingId: randomUUID() } })).status).toBe(404);
  });

  it("keeps the election lead out of the candidate list, shows members only who stands", async () => {
    const e = await newElection({ electionLeadClubMemberId: dora });
    expect(e).toMatchObject({ status: "planned", seats: 1, termMonths: 24, openSeats: 1, electionLeadName: "Dora" });
    const lead = await call(clerk, `/elections/${e.id}/candidates`, { method: "POST", body: { clubMemberId: dora } });
    expect(lead.status).toBe(409);
    expect((await json(lead)).error.details.code).toBe("lead_is_candidate");
    expect((await call(clerk, `/elections/${e.id}/candidates`, { method: "POST", body: { clubMemberId: p1.clubMemberId } })).status).toBe(201);
    expect((await call(clerk, `/elections/${e.id}/candidates`, { method: "POST", body: { clubMemberId: p1.clubMemberId } })).status).toBe(409);
    expect((await call(p1, `/elections/${e.id}/candidates`, { method: "POST", body: { clubMemberId: p2.clubMemberId } })).status).toBe(403);
    // A proposal is not public until the person declares willingness.
    expect((await election(p2, e.id)).candidates).toEqual([]);
    expect((await election(p1, e.id)).candidates).toEqual([expect.objectContaining({ clubMemberId: p1.clubMemberId, status: "proposed" })]);
    const cand = candidate(await election(clerk, e.id), p1.clubMemberId!);
    expect((await call(p2, `/elections/${e.id}/candidates/${cand.id}`, { method: "PATCH", body: { status: "willing" } })).status).toBe(403);
    expect((await call(p1, `/elections/${e.id}/candidates/${cand.id}`, { method: "PATCH", body: { status: "willing" } })).status).toBe(200);
    expect((await election(p2, e.id)).candidates).toEqual([expect.objectContaining({ clubMemberId: p1.clubMemberId, status: "willing" })]);
    // Withdrawing and the board changing the lead: the new lead must not be a candidate either.
    expect((await call(clerk, `/elections/${e.id}`, { method: "PATCH", body: { electionLeadClubMemberId: p1.clubMemberId } })).status).toBe(409);
    expect((await call(clerk, `/elections/${e.id}`, { method: "PATCH", body: { seats: 2 } })).status).toBe(200);
    expect([403, 404]).toContain((await call(outsider, `/elections/${e.id}`)).status);
    expect((await call(outsider, `/elections/${e.id}`, { club: otherClub })).status).toBe(404);
  });
});

describe("a round that ties: lot, acceptance, role and term history", () => {
  let e: Json;
  let previousHolderRole: string;

  it("blocks an election round without an announced agenda item when the statute asks for it", async () => {
    e = await newElection({ electionLeadClubMemberId: dora });
    await stand(e.id, [p1.clubMemberId!, p2.clubMemberId!]);
    // plain old holder of the office, with an open term
    previousHolderRole = (await db.insert(clubRoles).values({ memberId: p3.accountId!, roleType: "kassenwart" }).returning())[0]!.id;
    await db.insert(clubRoleTerms).values({ clubId: club, clubMemberId: p3.clubMemberId!, roleType: "kassenwart", startsOn: "2022-01-01" });

    await setRules({ ...RULES, agendaRequiredInInvitation: true });
    const round = await json(await call(clerk, `/elections/${e.id}/rounds`, { method: "POST", body: {} }));
    const blocked = await call(clerk, `/ballots/${round.data.ballotId}/open`, { method: "POST", body: {} });
    expect(blocked.status).toBe(422);
    expect((await json(blocked)).error.details.code).toBe("agenda_item_not_announced");
    await setRules(RULES);
    expect((await call(clerk, `/ballots/${round.data.ballotId}/cancel`, { method: "POST" })).status).toBe(200);
  });

  it("runs the round, refuses a second pending round and a decision before the round is final", async () => {
    const created = await json(await call(clerk, `/elections/${e.id}/rounds`, { method: "POST", body: {} }));
    expect(created.data.round).toBe(1);
    const again = await call(clerk, `/elections/${e.id}/rounds`, { method: "POST", body: {} });
    expect(again.status).toBe(409);
    expect((await json(again)).error.details.code).toBe("round_pending");
    const b = await ballot(created.data.ballotId);
    expect(b).toMatchObject({ kind: "election", electionId: e.id, round: 1, topic: "wahl", maxChoices: 1 });
    expect((b.options as Json[]).map((o) => o.kind)).toEqual(["candidate", "candidate", "abstain"]);
    expect((await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: {} })).status).toBe(409);
    expect((await call(clerk, `/ballots/${created.data.ballotId}/open`, { method: "POST", body: {} })).status).toBe(200);
    const opened = await ballot(created.data.ballotId);
    expect((await vote(chair, created.data.ballotId, [optionFor(opened, p1.clubMemberId!)])).status).toBe(201);
    expect((await vote(clerk, created.data.ballotId, [optionFor(opened, p2.clubMemberId!)])).status).toBe(201);
    // One seat, one vote each: a tie.
    expect((await call(clerk, `/ballots/${created.data.ballotId}/close`, { method: "POST" })).status).toBe(200);
    expect((await call(clerk, `/ballots/${created.data.ballotId}/finalize`, { method: "POST" })).status).toBe(200);
    expect((await ballot(created.data.ballotId)).result).toMatchObject({ form: "choice", outcome: "gleichstand" });
    // The election's rounds list shows the outcome; the board cannot start another round before deciding this one.
    expect((await election(p1, e.id)).rounds).toEqual([expect.objectContaining({ round: 1, status: "finalized", outcome: "gleichstand" })]);
    const next = await call(clerk, `/elections/${e.id}/rounds`, { method: "POST", body: {} });
    expect((await json(next)).error.details.code).toBe("round_not_decided");
  });

  it("never decides a tie silently: it needs a documented lot among the tied candidates", async () => {
    const detail = await election(clerk, e.id);
    const c1 = candidate(detail, p1.clubMemberId!);
    const c2 = candidate(detail, p2.clubMemberId!);
    const missing = await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: {} });
    expect(missing.status).toBe(409);
    expect((await json(missing)).error.details).toMatchObject({ code: "tie_needs_lot", openSeats: 1, tiedCandidateIds: expect.arrayContaining([c1.id, c2.id]) });
    const wrong = await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: { lot: { candidateIds: [c1.id, c2.id], note: "Beide gezogen" } } });
    expect((await json(wrong)).error.details.code).toBe("invalid_lot");
    expect((await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: { lot: { candidateIds: [c2.id], note: "kurz" } } })).status).toBe(422);
    const decided = await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: { lot: { candidateIds: [c2.id], note: "Losentscheid durch die Wahlleitung vor der Versammlung" } } });
    expect(decided.status).toBe(200);
    expect((await json(decided)).data).toMatchObject({ round: 1, filled: true, electedCandidateIds: [c2.id], election: { status: "decided", openSeats: 0 } });
    expect((await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: {} })).status).toBe(409);
    const stored = (await db.select().from(elections).where(eq(elections.id, e.id)))[0]!;
    expect((stored.decision as Json).rounds[0].lot.note).toContain("Losentscheid");
    const [resolution] = await db.select().from(meetingResolutions).where(eq(meetingResolutions.meetingId, meetingId));
    expect(resolution).toBeTruthy();
    expect((await call(clerk, `/elections/${e.id}/rounds`, { method: "POST", body: {} })).status).toBe(409);
    // Nothing is written to the roles before the person accepts.
    expect(await db.query.clubRoles.findFirst({ where: and(eq(clubRoles.memberId, p2.accountId!), eq(clubRoles.roleType, "kassenwart")) })).toBeUndefined();
  });

  it("writes the role with its term when the elected person accepts, and ends the previous holder", async () => {
    const detail = await election(p2, e.id);
    const c2 = candidate(detail, p2.clubMemberId!);
    expect(c2.status).toBe("elected");
    expect((await call(p1, `/elections/${e.id}/candidates/${c2.id}/accept`, { method: "POST", body: {} })).status).toBe(403);
    const accepted = await call(p2, `/elections/${e.id}/candidates/${c2.id}/accept`, { method: "POST", body: { accept: true } });
    expect(accepted.status).toBe(200);
    expect((await json(accepted)).data).toMatchObject({ status: "accepted", election: { status: "closed" } });

    const role = await db.query.clubRoles.findFirst({ where: and(eq(clubRoles.memberId, p2.accountId!), eq(clubRoles.roleType, "kassenwart")) });
    expect(role?.termEndsAt).toBe(addMonths(todayBerlin(), 24));
    const terms = await db.select().from(clubRoleTerms).where(and(eq(clubRoleTerms.clubId, club), eq(clubRoleTerms.roleType, "kassenwart")));
    expect(terms.find((t) => t.clubMemberId === p2.clubMemberId)).toMatchObject({ startsOn: todayBerlin(), endsOn: null, electionId: e.id });
    expect(terms.find((t) => t.clubMemberId === p3.clubMemberId)).toMatchObject({ endsOn: todayBerlin() });
    expect(await db.query.clubRoles.findFirst({ where: eq(clubRoles.id, previousHolderRole) })).toBeUndefined();
  });
});

describe("Stichwahl: a round without a winner is recorded, the next round narrows the field", () => {
  it("elects in round two with a narrowed field after round one reached no majority", async () => {
    const e = await newElection({ roleType: "beisitzer", termMonths: undefined });
    await stand(e.id, [p1.clubMemberId!, p2.clubMemberId!, p3.clubMemberId!]);
    const first = await runRound(
      e.id,
      [[chair, [p1.clubMemberId!]], [clerk, [p1.clubMemberId!]], [p1, [p2.clubMemberId!]], [p2, [p2.clubMemberId!]], [p3, [p3.clubMemberId!]]],
      { majority: "absolut" },
    );
    expect((await ballot(first)).result).toMatchObject({ outcome: "kein_ergebnis", participants: 5 });
    const none = await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: {} });
    expect(none.status).toBe(200);
    expect((await json(none)).data).toMatchObject({ round: 1, electedCandidateIds: [], filled: false });
    expect((await election(clerk, e.id)).status).toBe("running");

    const detail = await election(clerk, e.id);
    const stichwahl = [candidate(detail, p1.clubMemberId!).id, candidate(detail, p2.clubMemberId!).id];
    // Only willing candidates can stand: the third was not part of the narrowed list.
    const second = await runRound(e.id, [[chair, [p1.clubMemberId!]], [clerk, [p1.clubMemberId!]], [p1, [p1.clubMemberId!]], [p2, [p2.clubMemberId!]], [p3, [p1.clubMemberId!]]], { candidateIds: stichwahl, majority: "absolut" });
    expect((await ballot(second)).round).toBe(2);
    expect((await ballot(second)).options).toHaveLength(3);
    const decided = await json(await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: {} }));
    expect(decided.data).toMatchObject({ round: 2, filled: true, electedCandidateIds: [stichwahl[0]] });
    // No term end for an office without a term; the role exists after acceptance.
    expect((await call(p1, `/elections/${e.id}/candidates/${stichwahl[0]}/accept`, { method: "POST", body: {} })).status).toBe(200);
    expect((await db.query.clubRoles.findFirst({ where: and(eq(clubRoles.memberId, p1.accountId!), eq(clubRoles.roleType, "beisitzer")) }))?.termEndsAt).toBeNull();
    const decisions = await db.select().from(meetingResolutions).where(eq(meetingResolutions.meetingId, meetingId));
    expect(decisions.map((d) => d.result)).toEqual(expect.arrayContaining(["kein Ergebnis", "gewählt"]));
  });
});

describe("elected without an account, and declining", () => {
  it("is accepted with 'account pending' and gets the role once the account is linked", async () => {
    const e = await newElection({ roleType: "stellv_vorsitz" });
    await stand(e.id, [dora]);
    await runRound(e.id, [[chair, [dora]], [clerk, [dora]]]);
    await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: {} });
    const c = candidate(await election(clerk, e.id), dora);
    expect(c).toMatchObject({ status: "elected", hasAccount: false });
    const accepted = await json(await call(clerk, `/elections/${e.id}/candidates/${c.id}/accept`, { method: "POST", body: {} }));
    expect(accepted.data).toMatchObject({ status: "pending_account", election: { status: "decided" } });

    // The account arrives (invitation accepted): the role follows without anybody doing anything.
    const late = await signUp("dora");
    const account = (await auth.api.addMember({ body: { userId: late.userId, organizationId: club, role: "member" } }))!;
    // Joining the club created a row of its own; the invitation flow merges it into the existing member, as done here.
    await db.delete(clubMembers).where(eq(clubMembers.memberId, account.id));
    await db.update(clubMembers).set({ memberId: account.id }).where(eq(clubMembers.id, dora));
    expect(await db.transaction((tx) => grantPendingElectionRoles(tx, club, dora))).toBe(1);
    expect(await db.query.clubRoles.findFirst({ where: and(eq(clubRoles.memberId, account.id), eq(clubRoles.roleType, "stellv_vorsitz")) })).toBeTruthy();
    expect((await election(clerk, e.id))).toMatchObject({ status: "closed" });
    expect((await db.select().from(electionCandidates).where(eq(electionCandidates.id, c.id)))[0]!.status).toBe("accepted");
    // Running it again changes nothing.
    expect(await db.transaction((tx) => grantPendingElectionRoles(tx, club, dora))).toBe(0);
  });

  it("reopens the seat when the elected person declines", async () => {
    const e = await newElection({ roleType: "schriftfuehrer" });
    await stand(e.id, [p1.clubMemberId!]);
    await runRound(e.id, [[chair, [p1.clubMemberId!]]]);
    await call(clerk, `/elections/${e.id}/decide`, { method: "POST", body: {} });
    const c = candidate(await election(clerk, e.id), p1.clubMemberId!);
    const declined = await json(await call(p1, `/elections/${e.id}/candidates/${c.id}/accept`, { method: "POST", body: { accept: false } }));
    expect(declined.data).toMatchObject({ status: "declined", election: { status: "running", openSeats: 1 } });
    expect(await db.query.clubRoles.findFirst({ where: and(eq(clubRoles.memberId, p1.accountId!), eq(clubRoles.roleType, "schriftfuehrer")) })).toBeUndefined();
    // Only an elected candidate answers.
    expect((await call(p1, `/elections/${e.id}/candidates/${c.id}/accept`, { method: "POST", body: {} })).status).toBe(409);
  });
});
