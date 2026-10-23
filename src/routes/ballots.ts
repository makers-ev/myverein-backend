import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { BALLOT_AUDIENCES, BALLOT_MODES, BALLOT_STATUSES, ballotVoters, ballots, type BallotOptionRow, type BallotRow } from "../db/schema/assembly.js";
import { meetings } from "../db/schema/meetings.js";
import { MAJORITY_TOPICS } from "../lib/assembly-rules.js";
import { cancelBallot, castVote, closeBallot, countBallot, createBallot, deleteDraft, finalizeBallot, listVotes, loadBallot, myBallotState, openBallot, optionsOf, participationOf, phaseOf, settleBallot, updateBallot } from "../lib/ballots.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { callerClubMemberId } from "../lib/meeting-members.js";
import { denyGuests } from "../lib/meeting-access.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Digital ballots and circular resolutions (Wave 11 B5/B6, ADR-008). Managing (create, open, close, count, finalize,
 * cancel, the individual votes) needs `assembly:manage`; every member with an account reads the ballots they take part in
 * and votes (`POST /:id/vote`, the one legitimate member write). Guests and members of other clubs get 404. A secret ballot
 * never exposes who voted what: participation is a counter, the individual votes are anonymous and shuffled.
 */
export const ballotRoutes = new Hono<ClubEnv>();

ballotRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
ballotRoutes.use("*", sessionGuard);
ballotRoutes.use("*", clubGuard);

const validate = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  });

const uuid = z.string().uuid();
const isManager = (c: Context<ClubEnv>) => hasClubPermission(c.get("clubRoleTypes"), "assembly:manage");
function requireManager(c: Context<ClubEnv>) {
  if (!isManager(c)) throw new ForbiddenError("Missing assembly:manage permission");
}
function paramId(c: Context<ClubEnv>): string {
  const raw = c.req.param("id") ?? "";
  if (!uuid.safeParse(raw).success) throw new NotFoundError("Ballot not found");
  return raw;
}

/** The ballot if the caller may see it (404 otherwise, never 403): managers all, members everything but drafts of their assembly or circulars they vote on. */
async function loadVisible(c: Context<ClubEnv>, id: string): Promise<BallotRow> {
  denyGuests(c);
  const clubId = c.get("clubId");
  let row = await loadBallot(db, clubId, id);
  if (!isManager(c)) {
    if (row.status === "draft") throw new NotFoundError("Ballot not found");
    if (row.mode === "circular") {
      const me = await callerClubMemberId(db, clubId, c.get("membership").id);
      const [voter] = me ? await db.select({ id: ballotVoters.id }).from(ballotVoters).where(and(eq(ballotVoters.ballotId, id), eq(ballotVoters.clubMemberId, me))) : [];
      if (!voter) throw new NotFoundError("Ballot not found");
    }
  }
  if (row.status === "open" && row.closesAt && row.closesAt.getTime() <= Date.now()) row = await settleBallot(clubId, id);
  return row;
}

async function shape(c: Context<ClubEnv>, b: BallotRow, options: BallotOptionRow[], detail: boolean) {
  const manager = isManager(c);
  const showResult = b.status === "finalized" || (manager && ["counted", "finalized"].includes(b.status));
  const base = {
    id: b.id,
    mode: b.mode,
    kind: b.kind,
    meetingId: b.meetingId,
    agendaItemId: b.agendaItemId,
    electionId: b.electionId,
    round: b.round,
    title: b.title,
    description: b.description,
    secret: b.secret,
    topic: b.topic,
    majority: b.majority,
    maxChoices: b.maxChoices,
    audience: b.audience,
    status: b.status,
    phase: phaseOf(b),
    opensAt: b.opensAt,
    closesAt: b.closesAt,
    closedAt: b.closedAt,
    options: options.map((o) => ({ id: o.id, position: o.position, label: o.label, kind: o.kind, candidateClubMemberId: o.candidateClubMemberId })),
    result: showResult ? b.result : null,
    resultHash: b.status === "finalized" ? b.resultHash : null,
    finalizedAt: b.finalizedAt,
    createdAt: b.createdAt,
  };
  if (!detail) return base;
  const me = await callerClubMemberId(db, c.get("clubId"), c.get("membership").id);
  const meeting = b.meetingId ? await db.query.meetings.findFirst({ where: eq(meetings.id, b.meetingId), columns: { id: true, title: true, scheduledAt: true } }) : undefined;
  return {
    ...base,
    meeting: meeting ?? null,
    me: await myBallotState(b, me),
    // Aggregated only, also for a secret ballot: how many may vote and how many did.
    ...(manager ? { participation: await participationOf(b.id), opening: b.opening } : {}),
  };
}

const listQuerySchema = z.object({
  status: z.enum(BALLOT_STATUSES).optional(),
  mode: z.enum(BALLOT_MODES).optional(),
  meetingId: uuid.optional(),
  electionId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

ballotRoutes.get("/", async (c) => {
  denyGuests(c);
  const clubId = c.get("clubId");
  const query = listQuerySchema.safeParse(c.req.query());
  if (!query.success) throw new ValidationError("Invalid query", { details: query.error.issues });
  const q = query.data;
  let visible;
  if (!isManager(c)) {
    const me = await callerClubMemberId(db, clubId, c.get("membership").id);
    const mine = me ? inArray(ballots.id, db.select({ id: ballotVoters.ballotId }).from(ballotVoters).where(eq(ballotVoters.clubMemberId, me))) : undefined;
    visible = and(ne(ballots.status, "draft"), or(eq(ballots.mode, "in_session"), mine));
  }
  const rows = await db
    .select()
    .from(ballots)
    .where(and(eq(ballots.clubId, clubId), visible, q.status ? eq(ballots.status, q.status) : undefined, q.mode ? eq(ballots.mode, q.mode) : undefined, q.meetingId ? eq(ballots.meetingId, q.meetingId) : undefined, q.electionId ? eq(ballots.electionId, q.electionId) : undefined))
    .orderBy(desc(ballots.createdAt), desc(ballots.id))
    .limit(q.limit)
    .offset(q.offset);
  const data = [];
  for (const row of rows) {
    const settled = row.status === "open" && row.closesAt && row.closesAt.getTime() <= Date.now() ? await settleBallot(clubId, row.id) : row;
    data.push(await shape(c, settled, await optionsOf(db, row.id), false));
  }
  return c.json({ data });
});

const text = (max: number) => cleanText(z.string().trim().min(1).max(max));
const optionalDescription = z
  .union([cleanText(z.string().trim().max(4000), true), z.null()])
  .transform((v) => (v === "" ? null : v))
  .optional();
const instant = z.string().datetime({ offset: true }).transform((v) => new Date(v));

const bodyFields = {
  title: text(300),
  description: optionalDescription,
  secret: z.boolean(),
  topic: z.enum(MAJORITY_TOPICS),
  maxChoices: z.number().int().min(1).max(20),
  choices: z.array(text(200)).min(2).max(20),
  allowAbstain: z.boolean(),
  agendaItemId: z.union([uuid, z.null()]),
  audience: z.enum(BALLOT_AUDIENCES),
  closesAt: z.union([instant, z.null()]),
};

const createSchema = z.object({
  mode: z.enum(BALLOT_MODES).default("in_session"),
  meetingId: uuid.optional(),
  title: bodyFields.title,
  description: bodyFields.description,
  secret: bodyFields.secret.default(false),
  topic: bodyFields.topic.default("allgemein"),
  maxChoices: bodyFields.maxChoices.default(1),
  choices: bodyFields.choices.optional(),
  allowAbstain: bodyFields.allowAbstain.optional(),
  agendaItemId: bodyFields.agendaItemId.optional(),
  audience: bodyFields.audience.optional(),
  closesAt: bodyFields.closesAt.optional(),
});

ballotRoutes.post("/", validate(createSchema), async (c) => {
  requireManager(c);
  const body = c.req.valid("json");
  const row = await createBallot({ clubId: c.get("clubId"), actorUserId: c.get("user").id, ...body });
  return c.json({ data: await shape(c, row, await optionsOf(db, row.id), true) }, 201);
});

ballotRoutes.get("/:id", async (c) => {
  const row = await loadVisible(c, paramId(c));
  return c.json({ data: await shape(c, row, await optionsOf(db, row.id), true) });
});

const updateSchema = z
  .object({
    title: bodyFields.title.optional(),
    description: optionalDescription,
    secret: bodyFields.secret.optional(),
    topic: bodyFields.topic.optional(),
    maxChoices: bodyFields.maxChoices.optional(),
    choices: bodyFields.choices.optional(),
    allowAbstain: bodyFields.allowAbstain.optional(),
    agendaItemId: bodyFields.agendaItemId.optional(),
    audience: bodyFields.audience.optional(),
    closesAt: bodyFields.closesAt.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Nothing to change" });

ballotRoutes.patch("/:id", validate(updateSchema), async (c) => {
  requireManager(c);
  const id = paramId(c);
  const body = c.req.valid("json");
  const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
  const row = await updateBallot(c.get("clubId"), id, c.get("user").id, patch);
  return c.json({ data: await shape(c, row, await optionsOf(db, row.id), true) });
});

ballotRoutes.delete("/:id", async (c) => {
  requireManager(c);
  await deleteDraft(c.get("clubId"), paramId(c));
  return c.body(null, 204);
});

const openSchema = z.object({ opensAt: instant.optional(), closesAt: z.union([instant, z.null()]).optional() });

/** Opens the ballot: freezes the rules, checks the quorum again (session) and fixes the voter roll. */
ballotRoutes.post("/:id/open", validate(openSchema), async (c) => {
  requireManager(c);
  const body = c.req.valid("json");
  const { ballot, warnings } = await openBallot({ clubId: c.get("clubId"), ballotId: paramId(c), actorUserId: c.get("user").id, opensAt: body.opensAt, closesAt: body.closesAt });
  return c.json({ data: { ...(await shape(c, ballot, await optionsOf(db, ballot.id), true)), warnings } });
});

const voteSchema = z.object({ optionIds: z.array(uuid).min(1).max(20), forClubMemberId: uuid.optional() });

/** The member's own vote (or, as a proxy holder, the vote for a grantor). Answers without the choice: nothing about the content is echoed. */
ballotRoutes.post(
  "/:id/vote",
  rateLimit({ windowMs: 60_000, max: 100, key: (c) => `ballot-vote:${c.get("user")?.id ?? "anonymous"}` }),
  validate(voteSchema),
  async (c) => {
    denyGuests(c);
    const clubId = c.get("clubId");
    const id = paramId(c);
    await loadBallot(db, clubId, id);
    const me = await callerClubMemberId(db, clubId, c.get("membership").id);
    if (!me) throw new ForbiddenError("Only club members can vote", { details: { code: "not_eligible" } });
    const body = c.req.valid("json");
    const { forClubMemberId } = await castVote({ clubId, ballotId: id, callerClubMemberId: me, forClubMemberId: body.forClubMemberId, optionIds: body.optionIds });
    return c.json({ data: { ballotId: id, voted: true, forClubMemberId } }, 201);
  },
);

/** Ends the voting early and counts. */
ballotRoutes.post("/:id/close", async (c) => {
  requireManager(c);
  const clubId = c.get("clubId");
  const id = paramId(c);
  await closeBallot(clubId, id, c.get("user").id);
  const counted = await countBallot(clubId, id, c.get("user").id);
  return c.json({ data: await shape(c, counted, await optionsOf(db, id), true) });
});

/** Counts a closed ballot (the scheduler does the same shortly after the window ended). */
ballotRoutes.post("/:id/count", async (c) => {
  requireManager(c);
  const clubId = c.get("clubId");
  const id = paramId(c);
  await settleBallot(clubId, id);
  const counted = await countBallot(clubId, id, c.get("user").id);
  return c.json({ data: await shape(c, counted, await optionsOf(db, id), true) });
});

/** Freezes the result with its SHA-256 and writes the resolution into the meeting (a circular resolution gets its record and minutes). */
ballotRoutes.post("/:id/finalize", async (c) => {
  requireManager(c);
  const row = await finalizeBallot(c.get("clubId"), paramId(c), c.get("user").id);
  return c.json({ data: await shape(c, row, await optionsOf(db, row.id), true) });
});

ballotRoutes.post("/:id/cancel", async (c) => {
  requireManager(c);
  const row = await cancelBallot(c.get("clubId"), paramId(c), c.get("user").id);
  return c.json({ data: await shape(c, row, await optionsOf(db, row.id), true) });
});

/** The individual votes of an ended ballot: named for an open ballot, anonymous and in random order for a secret one. */
ballotRoutes.get("/:id/votes", async (c) => {
  requireManager(c);
  const b = await loadVisible(c, paramId(c));
  if (!["closed", "counted", "finalized"].includes(b.status)) throw new ConflictError("Votes are readable after the voting ended", { details: { code: "ballot_not_ended" } });
  return c.json({ data: { secret: b.secret, votes: await listVotes(b) } });
});
