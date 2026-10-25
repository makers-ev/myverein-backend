import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { ballots, electionCandidates, elections, type ElectionCandidateRow, type ElectionRow } from "../db/schema/assembly.js";
import { clubMembers } from "../db/schema/club-members.js";
import { MAJORITY_KINDS } from "../lib/assembly-rules.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ELECTION_ROLE_TYPES, answerElection, candidatesOf, createElection, createRound, decideElection, loadElection, proposeCandidate, removeCandidate, setCandidateStatus, updateElection } from "../lib/elections.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { denyGuests } from "../lib/meeting-access.js";
import { callerClubMemberId } from "../lib/meeting-members.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Elections (Wave 11 B7). The board (`assembly:manage`) sets up the office, the candidates and the rounds; the rounds are
 * ordinary ballots (`/ballots/:id/...`). Members read the election and answer for themselves (willing / withdraw, and
 * accept or decline the office when elected). Guests and other clubs get 404.
 */
export const electionRoutes = new Hono<ClubEnv>();

electionRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
electionRoutes.use("*", sessionGuard);
electionRoutes.use("*", clubGuard);

const validate = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  });

const uuid = z.string().uuid();
const isManager = (c: Context<ClubEnv>) => hasClubPermission(c.get("clubRoleTypes"), "assembly:manage");
function requireManager(c: Context<ClubEnv>) {
  if (!isManager(c)) throw new ForbiddenError("Missing assembly:manage permission");
}
function param(c: Context<ClubEnv>, name: string, what: string): string {
  const raw = c.req.param(name) ?? "";
  if (!uuid.safeParse(raw).success) throw new NotFoundError(`${what} not found`);
  return raw;
}

/** Members see the candidates who stand (willing or elected); the board sees every candidacy including proposals. */
const PUBLIC_CANDIDATE_STATUSES = ["willing", "elected", "accepted", "pending_account"];

async function shapeElection(c: Context<ClubEnv>, e: ElectionRow, detail: boolean) {
  const manager = isManager(c);
  const base = {
    id: e.id,
    meetingId: e.meetingId,
    roleType: e.roleType,
    departmentId: e.departmentId,
    seats: e.seats,
    termMonths: e.termMonths,
    electionLeadClubMemberId: e.electionLeadClubMemberId,
    status: e.status,
    decidedAt: e.decidedAt,
    createdAt: e.createdAt,
  };
  if (!detail) return base;
  const me = await callerClubMemberId(db, c.get("clubId"), c.get("membership").id);
  const all = await candidatesOf(db, e.id);
  const visible = manager ? all : all.filter((cand) => PUBLIC_CANDIDATE_STATUSES.includes(cand.status) || cand.clubMemberId === me);
  const people = await db
    .select({ id: clubMembers.id, displayName: clubMembers.displayName, accountId: clubMembers.memberId })
    .from(clubMembers)
    .where(inArray(clubMembers.id, [...visible.map((x) => x.clubMemberId), e.electionLeadClubMemberId].filter((v): v is string => !!v)));
  const byId = new Map(people.map((p) => [p.id, p]));
  const shapeCandidate = (cand: ElectionCandidateRow) => ({
    id: cand.id,
    clubMemberId: cand.clubMemberId,
    displayName: cand.clubMemberId ? (byId.get(cand.clubMemberId)?.displayName ?? null) : null,
    status: cand.status,
    ...(manager ? { proposedBy: cand.proposedBy, hasAccount: cand.clubMemberId ? byId.get(cand.clubMemberId)?.accountId != null : false } : {}),
  });
  const rounds = await db.select().from(ballots).where(and(eq(ballots.electionId, e.id), ne(ballots.status, "cancelled"))).orderBy(asc(ballots.round));
  const seated = all.filter((cand) => ["elected", "accepted", "pending_account"].includes(cand.status)).length;
  const own = all.find((cand) => cand.clubMemberId === me);
  return {
    ...base,
    electionLeadName: e.electionLeadClubMemberId ? (byId.get(e.electionLeadClubMemberId)?.displayName ?? null) : null,
    openSeats: Math.max(0, e.seats - seated),
    candidates: visible.map(shapeCandidate),
    rounds: rounds.map((r) => ({ ballotId: r.id, round: r.round, status: r.status, secret: r.secret, outcome: r.status === "finalized" ? ((r.result as { outcome?: string } | null)?.outcome ?? null) : null })),
    me: own ? { candidateId: own.id, status: own.status } : null,
    ...(manager ? { decision: e.decision } : {}),
  };
}

electionRoutes.get("/", async (c) => {
  denyGuests(c);
  const rows = await db.select().from(elections).where(eq(elections.clubId, c.get("clubId"))).orderBy(desc(elections.createdAt), desc(elections.id)).limit(200);
  return c.json({ data: await Promise.all(rows.map((e) => shapeElection(c, e, false))) });
});

const createSchema = z.object({
  meetingId: uuid.optional(),
  roleType: z.enum(ELECTION_ROLE_TYPES as [string, ...string[]]),
  departmentId: uuid.optional(),
  seats: z.number().int().min(1).max(20),
  termMonths: z.number().int().min(1).max(120).optional(),
  electionLeadClubMemberId: uuid.optional(),
});

electionRoutes.post("/", validate(createSchema), async (c) => {
  requireManager(c);
  const row = await createElection({ clubId: c.get("clubId"), actorUserId: c.get("user").id, ...c.req.valid("json") });
  return c.json({ data: await shapeElection(c, row, true) }, 201);
});

electionRoutes.get("/:id", async (c) => {
  denyGuests(c);
  return c.json({ data: await shapeElection(c, await loadElection(db, c.get("clubId"), param(c, "id", "Election")), true) });
});

const updateSchema = z
  .object({
    meetingId: uuid.optional(),
    seats: z.number().int().min(1).max(20).optional(),
    termMonths: z.union([z.number().int().min(1).max(120), z.null()]).optional(),
    electionLeadClubMemberId: z.union([uuid, z.null()]).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to change" });

electionRoutes.patch("/:id", validate(updateSchema), async (c) => {
  requireManager(c);
  const row = await updateElection(c.get("clubId"), param(c, "id", "Election"), c.get("user").id, c.req.valid("json"));
  return c.json({ data: await shapeElection(c, row, true) });
});

// --- Candidates --------------------------------------------------------------------------------------------------------------

const proposeSchema = z.object({ clubMemberId: uuid, willing: z.boolean().optional() });

/** The board records a proposal (or, with `willing`, a candidacy declared in the assembly). */
electionRoutes.post("/:id/candidates", validate(proposeSchema), async (c) => {
  requireManager(c);
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const me = await callerClubMemberId(db, clubId, c.get("membership").id);
  await proposeCandidate({ clubId, electionId: param(c, "id", "Election"), clubMemberId: body.clubMemberId, proposedBy: me, actorUserId: c.get("user").id, willing: body.willing });
  return c.json({ data: await shapeElection(c, await loadElection(db, clubId, param(c, "id", "Election")), true) }, 201);
});

const statusSchema = z.object({ status: z.enum(["willing", "declined", "withdrawn"]) });

/** The candidate declares willingness or withdraws; the board may do it for them (declared in the assembly). */
electionRoutes.patch("/:id/candidates/:candidateId", validate(statusSchema), async (c) => {
  denyGuests(c);
  const clubId = c.get("clubId");
  const electionId = param(c, "id", "Election");
  const candidateId = param(c, "candidateId", "Candidate");
  const manager = isManager(c);
  if (!manager) {
    const me = await callerClubMemberId(db, clubId, c.get("membership").id);
    const own = me ? await db.query.electionCandidates.findFirst({ where: and(eq(electionCandidates.id, candidateId), eq(electionCandidates.electionId, electionId)) }) : undefined;
    await loadElection(db, clubId, electionId);
    if (!own || own.clubMemberId !== me) throw new ForbiddenError("Only the candidate or the board can change a candidacy");
  }
  await setCandidateStatus({ clubId, electionId, candidateId, status: c.req.valid("json").status, actorUserId: c.get("user").id, manager });
  return c.json({ data: await shapeElection(c, await loadElection(db, clubId, electionId), true) });
});

electionRoutes.delete("/:id/candidates/:candidateId", async (c) => {
  requireManager(c);
  await removeCandidate(c.get("clubId"), param(c, "id", "Election"), param(c, "candidateId", "Candidate"), c.get("user").id);
  return c.body(null, 204);
});

// --- Rounds, decision, acceptance ----------------------------------------------------------------------------------------------

const roundSchema = z.object({
  candidateIds: z.array(uuid).min(1).max(50).optional(),
  secret: z.boolean().optional(),
  majority: z.enum(MAJORITY_KINDS).optional(),
  agendaItemId: z.union([uuid, z.null()]).optional(),
});

/** Sets up the next Wahlgang (or Stichwahl) as a draft ballot; open, close, count and finalize it through `/ballots/:id/...`. */
electionRoutes.post("/:id/rounds", validate(roundSchema), async (c) => {
  requireManager(c);
  const result = await createRound({ clubId: c.get("clubId"), electionId: param(c, "id", "Election"), actorUserId: c.get("user").id, ...c.req.valid("json") });
  return c.json({ data: result }, 201);
});

const decideSchema = z.object({ lot: z.object({ candidateIds: z.array(uuid).min(1).max(20), note: cleanText(z.string().trim().min(5).max(1000), true) }).optional() });

/** Makes the winners of the latest finalized round the elected candidates; a tie at the last seat needs `lot` (who won, how it was drawn). */
electionRoutes.post("/:id/decide", validate(decideSchema), async (c) => {
  requireManager(c);
  const clubId = c.get("clubId");
  const electionId = param(c, "id", "Election");
  const result = await decideElection({ clubId, electionId, actorUserId: c.get("user").id, lot: c.req.valid("json").lot });
  return c.json({ data: { ...result, election: await shapeElection(c, await loadElection(db, clubId, electionId), true) } });
});

const answerSchema = z.object({ accept: z.boolean().default(true) });

/** The elected person accepts or declines the office (the board can record it for them). Accepting writes the role with its term. */
electionRoutes.post("/:id/candidates/:candidateId/accept", validate(answerSchema), async (c) => {
  denyGuests(c);
  const clubId = c.get("clubId");
  const electionId = param(c, "id", "Election");
  const candidateId = param(c, "candidateId", "Candidate");
  const manager = isManager(c);
  const me = await callerClubMemberId(db, clubId, c.get("membership").id);
  const candidate = await db.query.electionCandidates.findFirst({ where: and(eq(electionCandidates.id, candidateId), eq(electionCandidates.electionId, electionId)) });
  await loadElection(db, clubId, electionId);
  if (!candidate) throw new NotFoundError("Candidate not found");
  const own = me !== null && candidate.clubMemberId === me;
  if (!own && !manager) throw new ForbiddenError("Only the elected person or the board can answer");
  const row = await answerElection({ clubId, electionId, candidateId, accept: c.req.valid("json").accept, actorUserId: c.get("user").id, onBehalf: !own });
  return c.json({ data: { candidateId: row.id, status: row.status, election: await shapeElection(c, await loadElection(db, clubId, electionId), true) } });
});
