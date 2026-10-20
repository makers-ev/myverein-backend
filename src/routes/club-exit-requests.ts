import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubExitRequests, EXIT_KINDS, EXIT_STATUSES, type ClubExitRequestRow } from "../db/schema/club-exit-requests.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { locationKeyHolders, locations } from "../db/schema/locations.js";
import { type DbExecutor, ensureClubMember, isUuid, resolveClubMember } from "../lib/club-members.js";
import { loadClubSettings } from "../lib/club-settings.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { notifyExitDecision, notifyExitRequestToBoard } from "../lib/decision-notify.js";
import { addDays, earliestExitDate } from "../lib/exit-notice.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { closeExitSubmission, currentExitDefinition, insertExitSubmission, loadExitSubmission, prepareExitAnswers, type PreparedExitAnswers } from "../lib/form-exit.js";
import { renderAnswers } from "../lib/form-review.js";
import { ANSWERS_BODY_LIMIT, applicantCategories } from "../lib/forms.js";
import { assertExitAllowed } from "../lib/member-protection.js";
import { effectiveStatus, isLeftStatus, todayBerlin, transitionMember } from "../lib/member-lifecycle.js";
import type { FormField } from "../lib/form-schema.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Exit workflow (Wave 7 B6): cancellation by the member (needs the board's approval) and cancellation / exclusion
 * recorded by the board. See README "Exit workflow" for the rules; the status change itself always goes through
 * `transitionMember` (same history, same Stichtag derivation as `POST /club-members/:id/transition`).
 */
export const clubExitRequestRoutes = new Hono<ClubEnv>();

clubExitRequestRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubExitRequestRoutes.use("*", sessionGuard);
clubExitRequestRoutes.use("*", clubGuard);

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const canWrite = (c: { get(k: "clubRoleTypes"): string[] }) => hasClubPermission(c.get("clubRoleTypes"), "members:write");

function requireWrite(c: { get(k: "clubRoleTypes"): string[] }) {
  if (!canWrite(c)) throw new ForbiddenError("Missing members:write permission");
}

/** Latest date a member may request (sanity cap, 3 years). */
const MAX_FUTURE_DAYS = 3 * 366;

/** Locks one club_members row (`FOR UPDATE`) inside `tx`; 404 if it vanished or belongs to another club. */
async function lockMember(tx: DbExecutor, clubId: string, id: string): Promise<ClubMemberRow> {
  const [row] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, id), eq(clubMembers.clubId, clubId))).for("update");
  if (!row) throw new NotFoundError("Member not found");
  return row;
}

/** An exit is "scheduled" while a stored live status carries a `left_at` in the future. */
function hasScheduledExit(row: ClubMemberRow, today: string): boolean {
  return row.leftAt !== null && row.leftAt > today && !isLeftStatus(row.status);
}

type RequestWithMember = { request: ClubExitRequestRow; member: ClubMemberRow };

async function loadRequest(clubId: string, idParam: string, executor: DbExecutor = db): Promise<RequestWithMember> {
  if (!isUuid(idParam)) throw new NotFoundError("Exit request not found");
  const [row] = await executor
    .select({ request: clubExitRequests, member: clubMembers })
    .from(clubExitRequests)
    .innerJoin(clubMembers, eq(clubMembers.id, clubExitRequests.clubMemberId))
    .where(and(eq(clubExitRequests.id, idParam), eq(clubMembers.clubId, clubId)));
  if (!row) throw new NotFoundError("Exit request not found");
  return row;
}

interface NoticeSettings {
  noticePeriodDays: number | null;
  noticeMode: string | null;
}

/**
 * Request shape (stable contract, see README). `earliestEffectiveOn` / `proposedEffectiveOn` are only present for
 * cancellations: the earliest date the notice rules allow (from the request date and the CURRENT club settings) and the
 * date an approval without override would use (`max(desiredEffectiveOn, earliest)`).
 */
function shapeRequest(request: ClubExitRequestRow, member: ClubMemberRow, settings: NoticeSettings) {
  const cancellation = request.kind === "cancellation";
  const earliest = cancellation ? earliestExitDate(request.requestedOn, settings) : null;
  return {
    id: request.id,
    clubMemberId: request.clubMemberId,
    memberName: member.displayName,
    hasAccount: member.memberId !== null,
    kind: request.kind,
    status: request.status,
    requestedBy: request.requestedBy,
    requestedOn: request.requestedOn,
    desiredEffectiveOn: request.desiredEffectiveOn,
    effectiveOn: request.effectiveOn,
    earliestEffectiveOn: earliest,
    proposedEffectiveOn: earliest !== null ? (request.desiredEffectiveOn && request.desiredEffectiveOn > earliest ? request.desiredEffectiveOn : earliest) : null,
    reason: request.reason,
    // The exit form the member filled in (answers: `GET /club-exit-requests/:id`); NULL for a request without a form.
    formSubmissionId: request.formSubmissionId,
    decidedBy: request.decidedBy,
    decidedAt: request.decidedAt,
    decisionNote: request.decisionNote,
    createdAt: request.createdAt,
  };
}

/**
 * Return checklist, computed live: open loans and key holder entries of the member's ACCOUNT in this club. Both are
 * bound to the account (ADR-003), so a member without account always has an empty checklist.
 */
async function returnChecklist(clubId: string, accountMemberId: string | null) {
  if (!accountMemberId) return { openLoans: [], keys: [], isEmpty: true };
  const now = Date.now();
  const [loans, keys] = await Promise.all([
    db
      .select({ id: inventoryLoans.id, itemId: inventoryItems.id, itemName: inventoryItems.name, borrowedAt: inventoryLoans.borrowedAt, dueAt: inventoryLoans.dueAt })
      .from(inventoryLoans)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLoans.itemId))
      .where(and(eq(inventoryLoans.memberId, accountMemberId), eq(inventoryItems.clubId, clubId), isNull(inventoryLoans.returnedAt)))
      .orderBy(inventoryLoans.borrowedAt, inventoryLoans.id),
    db
      .select({ id: locationKeyHolders.id, locationId: locations.id, locationName: locations.name })
      .from(locationKeyHolders)
      .innerJoin(locations, eq(locations.id, locationKeyHolders.locationId))
      .where(and(eq(locationKeyHolders.memberId, accountMemberId), eq(locations.clubId, clubId)))
      .orderBy(locations.name, locationKeyHolders.id),
  ]);
  return {
    openLoans: loans.map((l) => ({ ...l, overdue: l.dueAt !== null && l.dueAt.getTime() < now })),
    keys,
    isEmpty: loans.length === 0 && keys.length === 0,
  };
}

// --- Notice preview ----------------------------------------------------------------------

const previewQuerySchema = z.object({ requestedOn: z.string().date().optional() });

/** Any member: "if I cancel on <requestedOn> (default today), the earliest exit is <earliestEffectiveOn>". */
clubExitRequestRoutes.get("/preview", zValidator("query", previewQuerySchema, validationHook), async (c) => {
  const today = todayBerlin();
  const requestedOn = c.req.valid("query").requestedOn ?? today;
  if (requestedOn < today) throw new ValidationError("requestedOn must not be in the past");
  if (requestedOn > addDays(today, MAX_FUTURE_DAYS)) throw new ValidationError("requestedOn is too far in the future");
  const settings = await loadClubSettings(db, c.get("clubId"));
  return c.json({
    data: {
      requestedOn,
      noticePeriodDays: settings.noticePeriodDays,
      noticeMode: settings.noticeMode,
      earliestEffectiveOn: earliestExitDate(requestedOn, settings),
    },
  });
});

// --- Exit form -------------------------------------------------------------------------------

/** Any member: the published exit form (`austritt`) to render before `POST /` with `answers`. Definition only, no admin data. */
clubExitRequestRoutes.get("/form", async (c) => {
  c.header("Cache-Control", "private, no-cache");
  return c.json({ data: await currentExitDefinition(c.get("clubId")) });
});

// --- Own requests ----------------------------------------------------------------------------

clubExitRequestRoutes.get("/mine", async (c) => {
  const clubId = c.get("clubId");
  const own = await ensureClubMember(db, c.get("membership"));
  const [settings, rows] = await Promise.all([
    loadClubSettings(db, clubId),
    db.select().from(clubExitRequests).where(eq(clubExitRequests.clubMemberId, own.id)).orderBy(desc(clubExitRequests.createdAt), desc(clubExitRequests.id)),
  ]);
  return c.json({ data: rows.map((r) => shapeRequest(r, own, settings)) });
});

// --- Board queue ---------------------------------------------------------------------------------

const listQuerySchema = z.object({
  status: z.enum(EXIT_STATUSES).optional(),
  kind: z.enum(EXIT_KINDS).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

clubExitRequestRoutes.get("/", zValidator("query", listQuerySchema, validationHook), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const query = c.req.valid("query");
  const where = and(eq(clubMembers.clubId, clubId), query.status ? eq(clubExitRequests.status, query.status) : undefined, query.kind ? eq(clubExitRequests.kind, query.kind) : undefined);

  const [totalRow] = await db.select({ n: count() }).from(clubExitRequests).innerJoin(clubMembers, eq(clubMembers.id, clubExitRequests.clubMemberId)).where(where);
  const [settings, rows] = await Promise.all([
    loadClubSettings(db, clubId),
    db
      .select({ request: clubExitRequests, member: clubMembers })
      .from(clubExitRequests)
      .innerJoin(clubMembers, eq(clubMembers.id, clubExitRequests.clubMemberId))
      .where(where)
      .orderBy(desc(clubExitRequests.createdAt), desc(clubExitRequests.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
  ]);
  return c.json({ data: rows.map((r) => shapeRequest(r.request, r.member, settings)), page: query.page, pageSize: query.pageSize, total: totalRow?.n ?? 0 });
});

/** Board, requester or the member concerned; everybody else gets the same 404 as for an unknown id. */
clubExitRequestRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  const { request, member } = await loadRequest(clubId, c.req.param("id"));
  const involved = request.requestedBy === actor.id || member.memberId === actor.id;
  if (!canWrite(c) && !involved) throw new NotFoundError("Exit request not found");

  const [settings, checklist, submission] = await Promise.all([loadClubSettings(db, clubId), returnChecklist(clubId, member.memberId), loadExitSubmission(clubId, request.formSubmissionId)]);
  // The answers rendered against the version the member filled in. `sensitive` fields: members:read_sensitive or the submitter.
  const canReadSensitive = hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive") || submission?.sub.submittedByUserId === c.get("user").id;
  const rendered = submission
    ? {
        id: submission.sub.id,
        formVersionId: submission.version.id,
        version: submission.version.version,
        submittedAt: submission.sub.submittedAt,
        answers: renderAnswers(submission.version.fields as FormField[], submission.sub.answers, { categories: await applicantCategories(clubId), canReadSensitive }),
      }
    : null;
  const delivered = rendered && submission && submission.sub.submittedByUserId !== c.get("user").id ? rendered.answers.filter((a) => a.sensitive && a.answered && !a.redacted).map((a) => a.key) : [];
  if (delivered.length > 0 && submission) {
    // Keys only, never values (same trail as the application review).
    await db.insert(auditLog).values({ eventType: "club_exit_request.sensitive_read", subjectId: request.id, payload: { clubId, readBy: actor.id, formSubmissionId: submission.sub.id, fieldKeys: delivered } });
  }
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: { ...shapeRequest(request, member, settings), checklist, submission: rendered } });
});

// --- Create ----------------------------------------------------------------------------------------

const createSchema = z.object({
  // Board only: the member the request is about. Omitted (or the caller's own row) = the caller cancels their own membership.
  clubMemberId: z.string().uuid().optional(),
  kind: z.enum(EXIT_KINDS).optional(),
  // Member cancellation: the date the member asks for (clamped up to the earliest date the notice rules allow).
  desiredEffectiveOn: z.string().date().nullable().optional(),
  // Board: the date the exit takes effect (cancellation: not before the earliest date; exclusion: today or earlier).
  effectiveOn: z.string().date().nullable().optional(),
  reason: z.string().trim().max(2000).nullable().optional(),
  // Wave 8 B9: the answers of the club's exit form (`GET /club-exit-requests/form`), validated by the form engine. Optional:
  // a request without them behaves exactly as before. They never influence the dates, which come from `club_settings`.
  answers: z.unknown().optional(),
  formVersionId: z.uuid().optional(),
});

const createBodyLimit = bodyLimit({
  maxSize: ANSWERS_BODY_LIMIT,
  onError: () => {
    throw new ValidationError("Request body too large");
  },
});

clubExitRequestRoutes.post("/", createBodyLimit, zValidator("json", createSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  const body = c.req.valid("json");
  const today = todayBerlin();
  const kind = body.kind ?? "cancellation";
  const reason = body.reason?.trim() ? body.reason.trim() : null;

  const own = await ensureClubMember(db, actor);
  const targetId = body.clubMemberId ?? own.id;
  const selfCancellation = targetId === own.id && kind === "cancellation";
  if (body.formVersionId !== undefined && body.answers === undefined) throw new ValidationError("answers are required together with formVersionId");
  if (body.answers !== undefined && kind !== "cancellation") throw new ValidationError("The exit form belongs to a cancellation; an exclusion has no answers");

  if (!selfCancellation) {
    // Recording a cancellation for someone else (e.g. a member without account) or excluding anyone is a board action.
    requireWrite(c);
    if (kind === "exclusion" && targetId === own.id) throw new ValidationError("You cannot exclude yourself");
  }

  // Form answers are validated before any lock is taken (a bad form is a 422/409 without side effects).
  const prepared: PreparedExitAnswers | null = body.answers === undefined ? null : await prepareExitAnswers(clubId, body.answers, body.formVersionId);
  // Only an explicit `reason` parameter lands in the request (and, on approval, the status history). The answers of the form,
  // including any free text or sensitive field, live in the submission only; the board reads them in the review view.
  const requestReason = reason;

  const settings = await loadClubSettings(db, clubId);
  const earliest = earliestExitDate(today, settings);

  if (selfCancellation) {
    if (body.effectiveOn != null) throw new ValidationError("effectiveOn is reserved for the board; send desiredEffectiveOn");
    if (body.desiredEffectiveOn != null && body.desiredEffectiveOn > addDays(today, MAX_FUTURE_DAYS)) throw new ValidationError("desiredEffectiveOn is too far in the future");

    const created = await db.transaction(async (tx) => {
      const row = await lockMember(tx, clubId, own.id);
      await assertExitAllowed(tx, row, c.get("clubRoleTypes"));
      await assertCanLeave(tx, row, today);
      // The submission is written only after all checks passed; if the request insert fails (double submit), it rolls back with it.
      const submission = prepared ? await insertExitSubmission(tx, prepared, { clubId, submittedByUserId: c.get("user").id, subjectClubMemberId: row.id }) : null;
      const [inserted] = await insertRequest(tx, {
        clubMemberId: row.id,
        kind: "cancellation",
        requestedBy: actor.id,
        requestedOn: today,
        desiredEffectiveOn: body.desiredEffectiveOn ?? null,
        reason: requestReason,
        formSubmissionId: submission?.id ?? null,
      });
      await tx.insert(auditLog).values({
        eventType: "club_exit_request.create",
        subjectId: inserted!.id,
        // Ids only: the answers (reason text, ...) are never part of an audit entry.
        payload: { clubId, clubMemberId: row.id, kind: "cancellation", requestedBy: actor.id, desiredEffectiveOn: inserted!.desiredEffectiveOn, ...(submission ? { formSubmissionId: submission.id, formVersionId: submission.formVersionId } : {}) },
      });
      return { request: inserted!, member: row };
    });
    await notifyExitDecision({ clubId, requestId: created.request.id, clubMemberId: created.member.id, kind: "received", earliestOn: earliest, today });
    await notifyExitRequestToBoard({ clubId, requestId: created.request.id, clubMemberId: created.member.id, desiredEffectiveOn: created.request.desiredEffectiveOn });
    return c.json({ data: { ...shapeRequest(created.request, created.member, settings), adjustedToEarliest: body.desiredEffectiveOn != null && body.desiredEffectiveOn < earliest } }, 201);
  }

  // --- Board path: the decision is made by the caller, so the request is recorded as approved right away. ---
  const target = await resolveClubMember(clubId, targetId);
  if (kind === "exclusion" && !reason) throw new ValidationError("An exclusion requires a reason");
  if (body.desiredEffectiveOn != null) throw new ValidationError("desiredEffectiveOn is for member requests; send effectiveOn");

  let effectiveOn: string;
  if (kind === "cancellation") {
    effectiveOn = body.effectiveOn ?? earliest;
    if (effectiveOn < earliest) throw new ValidationError("effectiveOn is before the earliest date allowed by the notice period", { details: { earliestEffectiveOn: earliest } });
    if (effectiveOn > addDays(today, MAX_FUTURE_DAYS)) throw new ValidationError("effectiveOn is too far in the future");
  } else {
    effectiveOn = body.effectiveOn ?? today;
    if (effectiveOn > today) throw new ValidationError("An exclusion takes effect immediately; effectiveOn must not be in the future");
  }

  const result = await db.transaction(async (tx) => {
    // Lock order everywhere in this file: member row first, then request rows.
    const row = await lockMember(tx, clubId, target.id);
    await assertExitAllowed(tx, row, c.get("clubRoleTypes"));
    if (kind === "cancellation") await assertCanLeave(tx, row, today);
    else if (isLeftStatus(effectiveStatus(row, today))) throw new ConflictError("Member has already left the club");

    if (kind === "exclusion") {
      // An exclusion overrides a cancellation that has not been decided yet.
      const replaced = await tx
        .update(clubExitRequests)
        .set({ status: "rejected", decidedBy: actor.id, decidedAt: new Date(), decisionNote: "Ersetzt durch Ausschluss" })
        .where(and(eq(clubExitRequests.clubMemberId, row.id), eq(clubExitRequests.status, "pending")))
        .returning({ formSubmissionId: clubExitRequests.formSubmissionId });
      for (const r of replaced) await closeExitSubmission(tx, r.formSubmissionId, "rejected", actor.id);
    }

    const submission = prepared ? await insertExitSubmission(tx, prepared, { clubId, submittedByUserId: c.get("user").id, subjectClubMemberId: row.id }) : null;
    const [inserted] = await insertRequest(tx, {
      clubMemberId: row.id,
      kind,
      requestedBy: actor.id,
      requestedOn: today,
      effectiveOn,
      reason: requestReason,
      formSubmissionId: submission?.id ?? null,
      status: "approved",
      decidedBy: actor.id,
      decidedAt: new Date(),
    });
    const done = await transitionMember(tx, clubId, row.id, { toStatus: kind === "exclusion" ? "ausgeschlossen" : "ausgetreten", effectiveOn, reason: requestReason }, actor.id, today);
    // The board recorded the cancellation itself: the answers are decided with it.
    await closeExitSubmission(tx, submission?.id ?? null, "accepted", actor.id);
    await tx.insert(auditLog).values({
      eventType: "club_exit_request.create",
      subjectId: inserted!.id,
      payload: { clubId, clubMemberId: row.id, kind, requestedBy: actor.id, decidedBy: actor.id, effectiveOn, status: "approved", ...(submission ? { formSubmissionId: submission.id, formVersionId: submission.formVersionId } : {}) },
    });
    return { request: inserted!, member: done.row, transition: done };
  });

  await notifyExitDecision({ clubId, requestId: result.request.id, clubMemberId: result.member.id, kind: kind === "exclusion" ? "exclusion" : "accepted", effectiveOn, note: kind === "exclusion" ? reason : null, today });
  return c.json(
    {
      data: shapeRequest(result.request, result.member, settings),
      transition: { kind: result.transition.kind, fromStatus: result.transition.fromStatus, toStatus: result.transition.toStatus, effectiveOn: result.transition.effectiveOn },
    },
    201,
  );
});

/** The member must still belong to the club and have neither an open request nor a scheduled exit (409 otherwise). */
async function assertCanLeave(tx: DbExecutor, row: ClubMemberRow, today: string): Promise<void> {
  if (isLeftStatus(effectiveStatus(row, today))) throw new ConflictError("Member has already left the club");
  if (hasScheduledExit(row, today)) throw new ConflictError("An exit is already scheduled for this member", { details: { code: "exit_already_scheduled", leftAt: row.leftAt } });
  const pending = await tx.query.clubExitRequests.findFirst({ where: and(eq(clubExitRequests.clubMemberId, row.id), eq(clubExitRequests.status, "pending")) });
  if (pending) throw new ConflictError("There is already an open exit request for this member", { details: { code: "exit_request_pending", requestId: pending.id } });
}

async function insertRequest(tx: DbExecutor, values: typeof clubExitRequests.$inferInsert) {
  try {
    return await tx.insert(clubExitRequests).values(values).returning();
  } catch (err) {
    // The partial unique index (one pending request per member) is the last line of defence against a double submit.
    if (isUniqueViolation(err)) throw new ConflictError("There is already an open exit request for this member", { details: { code: "exit_request_pending" } });
    throw err;
  }
}

// --- Decide ---------------------------------------------------------------------------------------------

const approveSchema = z.object({
  // Overrides the proposed date; must not be before the earliest date allowed by the notice rules.
  effectiveOn: z.string().date().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

clubExitRequestRoutes.post("/:id/approve", zValidator("json", approveSchema, validationHook), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  const body = c.req.valid("json");
  const today = todayBerlin();

  const loaded = await loadRequest(clubId, c.req.param("id"));
  if (loaded.request.status !== "pending") throw new ConflictError("Exit request has already been decided");
  // Four eyes: the requester never decides their own request (board-recorded requests are created approved, never here).
  if (loaded.request.requestedBy === actor.id) throw new ForbiddenError("You cannot approve your own request", { details: { code: "self_approval" } });
  const settings = await loadClubSettings(db, clubId);

  let effectiveOn: string;
  if (loaded.request.kind === "cancellation") {
    const earliest = earliestExitDate(loaded.request.requestedOn, settings);
    const proposed = loaded.request.desiredEffectiveOn && loaded.request.desiredEffectiveOn > earliest ? loaded.request.desiredEffectiveOn : earliest;
    effectiveOn = body.effectiveOn ?? proposed;
    if (effectiveOn < earliest) throw new ValidationError("effectiveOn is before the earliest date allowed by the notice period", { details: { earliestEffectiveOn: earliest } });
    if (effectiveOn > addDays(today, MAX_FUTURE_DAYS)) throw new ValidationError("effectiveOn is too far in the future");
  } else {
    effectiveOn = body.effectiveOn ?? today;
    if (effectiveOn > today) throw new ValidationError("An exclusion takes effect immediately; effectiveOn must not be in the future");
  }

  const result = await db.transaction(async (tx) => {
    // Member row first (same order as create / withdraw), then the request.
    const memberRow = await lockMember(tx, clubId, loaded.request.clubMemberId);
    await assertExitAllowed(tx, memberRow, c.get("clubRoleTypes"));
    if (loaded.request.kind === "cancellation" && hasScheduledExit(memberRow, today)) {
      throw new ConflictError("An exit is already scheduled for this member", { details: { code: "exit_already_scheduled", leftAt: memberRow.leftAt } });
    }
    // Claim: only one concurrent decision can move the request out of 'pending'.
    const [claimed] = await tx
      .update(clubExitRequests)
      .set({ status: "approved", decidedBy: actor.id, decidedAt: new Date(), decisionNote: body.note?.trim() || null, effectiveOn })
      .where(and(eq(clubExitRequests.id, loaded.request.id), eq(clubExitRequests.status, "pending")))
      .returning();
    if (!claimed) throw new ConflictError("Exit request has already been decided");
    await closeExitSubmission(tx, claimed.formSubmissionId, "accepted", actor.id);

    // Same transition logic as POST /club-members/:id/transition: a future date becomes a scheduled exit (status stays,
    // left_at is set), today or earlier takes effect at once. A failure (member already left, ...) rolls the claim back.
    const done = await transitionMember(
      tx,
      clubId,
      loaded.request.clubMemberId,
      { toStatus: claimed.kind === "exclusion" ? "ausgeschlossen" : "ausgetreten", effectiveOn, reason: claimed.reason },
      actor.id,
      today,
    );
    await tx.insert(auditLog).values({
      eventType: "club_exit_request.approve",
      subjectId: claimed.id,
      payload: { clubId, clubMemberId: claimed.clubMemberId, kind: claimed.kind, effectiveOn, transitionKind: done.kind, decidedBy: actor.id },
    });
    return { request: claimed, member: done.row, transition: done };
  });

  await notifyExitDecision({
    clubId,
    requestId: result.request.id,
    clubMemberId: result.request.clubMemberId,
    kind: result.request.kind === "exclusion" ? "exclusion" : "accepted",
    effectiveOn,
    note: result.request.kind === "exclusion" ? result.request.reason : result.request.decisionNote,
    today,
  });
  return c.json({
    data: shapeRequest(result.request, result.member, settings),
    transition: { kind: result.transition.kind, fromStatus: result.transition.fromStatus, toStatus: result.transition.toStatus, effectiveOn: result.transition.effectiveOn },
  });
});

const rejectSchema = z.object({ note: z.string().trim().min(1).max(1000) });

clubExitRequestRoutes.post("/:id/reject", zValidator("json", rejectSchema, validationHook), async (c) => {
  requireWrite(c);
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  const { note } = c.req.valid("json");

  const loaded = await loadRequest(clubId, c.req.param("id"));
  const settings = await loadClubSettings(db, clubId);
  const rejected = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(clubExitRequests)
      .set({ status: "rejected", decidedBy: actor.id, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(clubExitRequests.id, loaded.request.id), eq(clubExitRequests.status, "pending")))
      .returning();
    if (!row) throw new ConflictError("Exit request has already been decided");
    await closeExitSubmission(tx, row.formSubmissionId, "rejected", actor.id);
    await tx.insert(auditLog).values({
      eventType: "club_exit_request.reject",
      subjectId: row.id,
      payload: { clubId, clubMemberId: row.clubMemberId, kind: row.kind, decidedBy: actor.id },
    });
    return row;
  });
  await notifyExitDecision({ clubId, requestId: rejected.id, clubMemberId: rejected.clubMemberId, kind: "rejected", note, today: todayBerlin() });
  return c.json({ data: shapeRequest(rejected, loaded.member, settings) });
});

// --- Withdraw --------------------------------------------------------------------------------------------

const withdrawSchema = z.object({ note: z.string().trim().max(1000).nullable().optional() });

/**
 * Requester or board. A pending request is simply closed; an approved cancellation that is not effective yet is taken
 * back together with the scheduled exit (`left_at` cleared via the same transition logic). Once the exit date has been
 * reached, or for an exclusion, the member can only be brought back by the board (`transition` with `reopen`).
 */
clubExitRequestRoutes.post("/:id/withdraw", zValidator("json", withdrawSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  const note = c.req.valid("json").note?.trim() || null;
  const today = todayBerlin();

  const loaded = await loadRequest(clubId, c.req.param("id"));
  // The "requester" privilege belongs to the member's own cancellation; a request the board recorded for someone needs members:write.
  const isRequester = loaded.request.requestedBy === actor.id && loaded.member.memberId === actor.id;
  if (!isRequester && !canWrite(c)) {
    // Someone concerned (the member) learns they may not; everybody else cannot tell the request exists.
    if (loaded.member.memberId === actor.id) throw new ForbiddenError("Only the requester or the board can withdraw this request");
    throw new NotFoundError("Exit request not found");
  }
  const settings = await loadClubSettings(db, clubId);

  const result = await db.transaction(async (tx) => {
    const memberRow = await lockMember(tx, clubId, loaded.request.clubMemberId);
    const [current] = await tx.select().from(clubExitRequests).where(eq(clubExitRequests.id, loaded.request.id)).for("update");
    if (!current || !["pending", "approved"].includes(current.status)) throw new ConflictError("Exit request can no longer be withdrawn");

    if (current.status === "approved") {
      if (current.kind === "exclusion") throw new ConflictError("An exclusion cannot be withdrawn; reopen the member instead");
      const row = memberRow;
      if (!hasScheduledExit(row, today)) throw new ConflictError("The exit is already effective; reopen the member instead");
      if (row.leftAt !== current.effectiveOn) throw new ConflictError("The scheduled exit does not belong to this request");
      // Sending the stored status again while an exit is scheduled takes the exit back (kind "cancel_exit").
      await transitionMember(tx, clubId, row.id, { toStatus: row.status as never, reason: "Kündigung widerrufen" }, actor.id, today);
    }

    const [withdrawn] = await tx
      .update(clubExitRequests)
      .set({ status: "withdrawn", decisionNote: note ?? current.decisionNote })
      .where(and(eq(clubExitRequests.id, current.id), inArray(clubExitRequests.status, ["pending", "approved"])))
      .returning();
    if (!withdrawn) throw new ConflictError("Exit request can no longer be withdrawn");
    await closeExitSubmission(tx, withdrawn.formSubmissionId, "withdrawn", null);
    await tx.insert(auditLog).values({
      eventType: "club_exit_request.withdraw",
      subjectId: withdrawn.id,
      payload: { clubId, clubMemberId: withdrawn.clubMemberId, kind: withdrawn.kind, previousStatus: current.status, withdrawnBy: actor.id },
    });
    return withdrawn;
  });

  const member = (await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, loaded.request.clubMemberId) })) ?? loaded.member;
  return c.json({ data: shapeRequest(result, member, settings) });
});
