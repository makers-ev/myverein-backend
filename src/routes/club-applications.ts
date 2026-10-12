import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { auth } from "../auth/auth.js";
import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMembers } from "../db/schema/club-members.js";
import { assertRejoinAllowed, type DbExecutor, ensureClubMember, isUuid, lockCategoryShared } from "../lib/club-members.js";
import type { MemberCategoryRow } from "../db/schema/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { applyAcceptance, asDecisionBusy, assertSubmissionDecidable, consentEvidence, lockDecisionSubmission, rejectSubmission, type DecisionContext, type MappingReport } from "../lib/form-applications.js";
import { purgeMediaFile } from "../lib/media.js";
import { cleanText } from "../lib/text-policy.js";
import { logger } from "../lib/logger.js";
import { effectiveStatus, todayBerlin, transitionMember } from "../lib/member-lifecycle.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Board-side decision queue for Aufnahmeantraege created by
 * POST /club-members/apply. Every route needs `members:write`.
 */
export const clubApplicationRoutes = new Hono<ClubEnv>();

clubApplicationRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubApplicationRoutes.use("*", sessionGuard);
clubApplicationRoutes.use("*", clubGuard);
clubApplicationRoutes.use("*", async (c, next) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) {
    throw new ForbiddenError("Missing members:write permission");
  }
  await next();
});

/** Loads an application scoped to the caller's club (404 otherwise, never leaking other clubs' ids) and ensures it is still pending. */
async function loadPendingApplication(id: string, clubId: string) {
  // A non-uuid id can't match a uuid column (and would make Postgres throw) -- treat it as unknown.
  if (!isUuid(id)) throw new NotFoundError("Application not found");

  const application = await db.query.clubApplications.findFirst({
    where: and(eq(clubApplications.id, id), eq(clubApplications.clubId, clubId)),
  });
  if (!application) throw new NotFoundError("Application not found");
  if (application.status !== "pending") throw new ConflictError("Application has already been decided");
  return application;
}


const decisionBodyLimit = bodyLimit({
  maxSize: 16 * 1024,
  onError: () => {
    throw new ValidationError("Request body too large");
  },
});

/** Optional JSON body: absent / empty is `{}`; anything else must parse and match (422). */
async function readOptionalBody<S extends z.ZodType>(c: { req: { text(): Promise<string> } }, schema: S): Promise<z.infer<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ValidationError("Invalid request body");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError("Invalid request body", { details: parsed.error.issues });
  return parsed.data;
}

const approveBodySchema = z.object({
  // The board may change the category the applicant chose (id or key of an active category of this club).
  categoryId: z.uuid().optional(),
  categoryKey: z.string().trim().min(1).max(50).optional(),
});
const rejectBodySchema = z.object({ note: cleanText(z.string().trim().max(1000), true).nullish() });

type CategoryOverride = { id: string } | { key: string } | null;
const overrideOf = (body: z.infer<typeof approveBodySchema>): CategoryOverride => (body.categoryId ? { id: body.categoryId } : body.categoryKey ? { key: body.categoryKey } : null);

/** Pre-flight (no lock) for an explicit category choice: a bad choice is a 422 BEFORE an account membership is created. */
async function assertCategoryChoosable(clubId: string, override: CategoryOverride): Promise<void> {
  if (!override) return;
  const row = await db.query.memberCategories.findFirst({
    where: (t, { and: both, eq: same }) => both(same(t.clubId, clubId), "id" in override ? same(t.id, override.id) : same(t.key, override.key.toLowerCase())),
  });
  if (!row || row.archivedAt) throw new ValidationError("Unknown or archived category");
}

/**
 * The category an accepted member gets, share-locked (lock order: categories before member rows). An explicit choice
 * of the board must be active (422); the applicant's own choice is tolerated: archived or gone since, the member keeps
 * the club default.
 */
async function chooseCategory(tx: DbExecutor, clubId: string, override: CategoryOverride, applicantKey: string): Promise<MemberCategoryRow | null> {
  if (override) {
    const row = await lockCategoryShared(tx, clubId, override);
    if (!row || row.archivedAt) throw new ValidationError("Unknown or archived category");
    return row;
  }
  const row = await lockCategoryShared(tx, clubId, { key: applicantKey });
  return row && !row.archivedAt ? row : null;
}

clubApplicationRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");

  const rows = await db
    .select({
      id: clubApplications.id,
      userId: clubApplications.userId,
      name: user.name,
      email: user.email,
      category: clubApplications.category,
      birthDate: clubApplications.birthDate,
      status: clubApplications.status,
      createdAt: clubApplications.createdAt,
      formSubmissionId: clubApplications.formSubmissionId,
    })
    .from(clubApplications)
    .innerJoin(user, eq(user.id, clubApplications.userId))
    .where(and(eq(clubApplications.clubId, clubId), eq(clubApplications.status, "pending")))
    .orderBy(asc(clubApplications.createdAt), asc(clubApplications.id));

  // `legacy`: filed before the form builder (or by an old client): category/birth date only, no answers, no consent record.
  return c.json({ data: rows.map((r) => ({ ...r, legacy: r.formSubmissionId === null })) });
});

clubApplicationRoutes.post("/:id/approve", decisionBodyLimit, async (c) => {
  const clubId = c.get("clubId");
  const decider = c.get("membership");

  const override = overrideOf(await readOptionalBody(c, approveBodySchema));
  const application = await loadPendingApplication(c.req.param("id"), clubId);
  // A withdrawn / already decided submission is refused before any account membership is created.
  await assertSubmissionDecidable(db, application);
  await assertCategoryChoosable(clubId, override);

  const existing = await db.query.member.findFirst({
    where: and(eq(member.organizationId, clubId), eq(member.userId, application.userId)),
  });
  if (existing) {
    // A former member (ausgetreten) who re-applied is re-admitted by reopening the existing club_members row.
    const former = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, existing.id) });
    if (!former || effectiveStatus(former, todayBerlin()) !== "ausgetreten") throw new ConflictError("Applicant is already a member of this club");
    return c.json(await readmit(clubId, application, existing, former, decider.id, override));
  }
  // Excluded / deceased persons cannot be re-admitted by an application; the board must reopen them first.
  await assertRejoinAllowed(db, clubId, application.userId);

  // addMember returns the created member row directly (not wrapped), see
  // node_modules/better-auth/dist/plugins/organization/routes/crud-members.mjs.
  // It runs outside our transaction; if it throws, nothing below executes and
  // the application stays pending.
  let createdMember;
  try {
    createdMember = await auth.api.addMember({
      body: { userId: application.userId, organizationId: clubId, role: "member" },
    });
  } catch (err) {
    // A concurrent approval may have created the member in the meantime.
    const nowMember = await db.query.member.findFirst({
      where: and(eq(member.organizationId, clubId), eq(member.userId, application.userId)),
    });
    if (nowMember) throw new ConflictError("Applicant is already a member of this club");
    throw err;
  }
  if (!createdMember) throw new ConflictError("Could not create membership");

  const today = todayBerlin();
  try {
    const result = await db.transaction(async (tx) => {
      // A decision that meets a concurrent account merge fails fast (409 decision_busy) instead of hanging.
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      // Lock order (README "Aufnahme-Integration"): submission -> application -> category -> member row -> ...
      const context = await lockDecisionSubmission(tx, application);
      // Claim the application: only one concurrent decision can flip it out of 'pending'.
      const [decided] = await tx
        .update(clubApplications)
        .set({ status: "approved", decidedAt: new Date(), decidedBy: decider.id })
        .where(and(eq(clubApplications.id, application.id), eq(clubApplications.status, "pending")))
        .returning();
      if (!decided) throw new ConflictError("Application has already been decided");

      const category = await chooseCategory(tx, clubId, override, application.category);
      // The Better Auth afterAddMember hook normally created the club_members row already (default category);
      // ensureClubMember covers a hook that did not run, then the application's choices are applied on top.
      const ensured = await ensureClubMember(tx, createdMember, { categoryKey: application.category, birthDate: application.birthDate, joinedAt: today });
      const [base] = await tx
        .update(clubMembers)
        .set({ ...(category ? { categoryId: category.id } : {}), birthDate: application.birthDate ?? ensured.birthDate, joinedAt: today, status: "aktiv", updatedAt: new Date() })
        .where(eq(clubMembers.id, ensured.id))
        .returning();

      let clubMember = base!;
      let mapping: MappingReport | null = null;
      let purge: string[] = [];
      if (context) {
        const applied = await applyAcceptance(tx, { clubId, context, clubMemberId: clubMember.id, decidedBy: decider.id });
        clubMember = applied.clubMember;
        mapping = applied.mapping;
        purge = applied.purge;
      }
      const [finalApplication] = await tx.update(clubApplications).set({ clubMemberId: clubMember.id }).where(eq(clubApplications.id, application.id)).returning();

      await tx.insert(auditLog).values({
        eventType: "club_application.approve",
        subjectId: application.id,
        // Ids, field keys and counts only -- never answer values.
        payload: {
          clubId,
          userId: application.userId,
          memberId: createdMember.id,
          clubMemberId: clubMember.id,
          decidedBy: decider.id,
          memberNumber: clubMember.memberNumber,
          ...(context ? auditOfMapping(context, mapping!) : {}),
        },
      });

      return { application: finalApplication!, clubMember, categoryKey: category?.key ?? application.category, mapping, purge };
    });
    await Promise.all(result.purge.map((key) => purgeMediaFile(key)));

    // `membership` is the pre-Wave-7 shape (deprecated, kept for existing clients); `clubMember` is the canonical row.
    const { clubMember } = result;
    const membership = {
      id: clubMember.id,
      memberId: createdMember.id,
      memberNumber: clubMember.memberNumber,
      category: result.categoryKey,
      joinedAt: clubMember.joinedAt,
      leftAt: clubMember.leftAt,
      birthDate: clubMember.birthDate,
      emergencyContactName: clubMember.emergencyContactName,
      emergencyContactPhone: clubMember.emergencyContactPhone,
      createdAt: clubMember.createdAt,
      updatedAt: clubMember.updatedAt,
    };
    return c.json({ data: { application: result.application, member: createdMember, membership, clubMember, mapping: result.mapping } });
  } catch (err) {
    // The member row (and the club_members row the hook created for it) was created outside the transaction --
    // best-effort removal so a failed approval doesn't leave a half-joined member while the application is still
    // pending. The club_members row goes first: its member_id FK is ON DELETE SET NULL and would otherwise leave
    // an account-less ghost member behind.
    await db
      .delete(clubMembers)
      .where(eq(clubMembers.memberId, createdMember.id))
      .catch((cleanupErr) => logger.error({ err: cleanupErr, memberId: createdMember.id }, "[club-applications] failed to remove club member after aborted approval"));
    await db
      .delete(member)
      .where(eq(member.id, createdMember.id))
      .catch((cleanupErr) => logger.error({ err: cleanupErr, memberId: createdMember.id }, "[club-applications] failed to remove member after aborted approval"));
    throw asDecisionBusy(err);
  }
});

/** Audit payload of an accepted form application: ids, mapped target names and counts, consent evidence (a text hash). */
function auditOfMapping(context: DecisionContext, mapping: MappingReport) {
  return {
    formSubmissionId: context.sub.id,
    formVersionId: context.version.id,
    mapped: { targets: mapping.applied, customFields: mapping.customFields, skipped: mapping.skipped.length },
    consent: consentEvidence(context),
  };
}

/**
 * Re-admission of a former member (status ausgetreten, account membership still present): no new account membership,
 * the existing club_members row is reopened (history entry with reason) and the application's category applied.
 */
async function readmit(
  clubId: string,
  application: typeof clubApplications.$inferSelect,
  account: typeof member.$inferSelect,
  former: typeof clubMembers.$inferSelect,
  deciderId: string,
  override: CategoryOverride,
) {
  const today = todayBerlin();
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      const context = await lockDecisionSubmission(tx, application);
      const [decided] = await tx
        .update(clubApplications)
        .set({ status: "approved", decidedAt: new Date(), decidedBy: deciderId })
        .where(and(eq(clubApplications.id, application.id), eq(clubApplications.status, "pending")))
        .returning();
      if (!decided) throw new ConflictError("Application has already been decided");

      const category = await chooseCategory(tx, clubId, override, application.category);
      const done = await transitionMember(
        tx,
        clubId,
        former.id,
        { toStatus: "aktiv", reopen: true, reason: "Wiederaufnahme per Aufnahmeantrag", category: category ?? undefined },
        deciderId,
        today,
      );
      let clubMember = application.birthDate && !context
        ? (await tx.update(clubMembers).set({ birthDate: application.birthDate, updatedAt: new Date() }).where(eq(clubMembers.id, former.id)).returning())[0]!
        : done.row;
      let mapping: MappingReport | null = null;
      let purge: string[] = [];
      if (context) {
        const applied = await applyAcceptance(tx, { clubId, context, clubMemberId: former.id, decidedBy: deciderId });
        clubMember = applied.clubMember;
        mapping = applied.mapping;
        purge = applied.purge;
      }
      const [finalApplication] = await tx.update(clubApplications).set({ clubMemberId: former.id }).where(eq(clubApplications.id, application.id)).returning();
      await tx.insert(auditLog).values({
        eventType: "club_application.approve",
        subjectId: application.id,
        payload: { clubId, userId: application.userId, memberId: account.id, clubMemberId: former.id, decidedBy: deciderId, readmission: true, ...(context ? auditOfMapping(context, mapping!) : {}) },
      });
      return { application: finalApplication!, clubMember, mapping, purge };
    });
    await Promise.all(result.purge.map((key) => purgeMediaFile(key)));
    const { clubMember } = result;
    return {
      data: {
        application: result.application,
        member: account,
        membership: {
          id: clubMember.id,
          memberId: account.id,
          memberNumber: clubMember.memberNumber,
          category: application.category,
          joinedAt: clubMember.joinedAt,
          leftAt: clubMember.leftAt,
          birthDate: clubMember.birthDate,
          emergencyContactName: clubMember.emergencyContactName,
          emergencyContactPhone: clubMember.emergencyContactPhone,
          createdAt: clubMember.createdAt,
          updatedAt: clubMember.updatedAt,
        },
        clubMember,
        mapping: result.mapping,
      },
    };
  } catch (err) {
    // The reopened row vanished under us: the applicant's account was merged into another record meanwhile (invitation).
    if (err instanceof NotFoundError && err.message === "Member not found") {
      throw new ConflictError("The member record changed while the application was being decided; try again", { details: { code: "decision_busy" } });
    }
    throw asDecisionBusy(err);
  }
}

clubApplicationRoutes.post("/:id/reject", decisionBodyLimit, async (c) => {
  const clubId = c.get("clubId");
  const decider = c.get("membership");

  const { note } = await readOptionalBody(c, rejectBodySchema);
  const application = await loadPendingApplication(c.req.param("id"), clubId);
  await assertSubmissionDecidable(db, application);

  try {
    const decided = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      const context = await lockDecisionSubmission(tx, application);
      const [row] = await tx
        .update(clubApplications)
        .set({ status: "rejected", decidedAt: new Date(), decidedBy: decider.id })
        .where(and(eq(clubApplications.id, application.id), eq(clubApplications.status, "pending")))
        .returning();
      if (!row) throw new ConflictError("Application has already been decided");
      if (context) await rejectSubmission(tx, context, decider.id, note?.trim() ? note.trim() : null);

      await tx.insert(auditLog).values({
        eventType: "club_application.reject",
        subjectId: application.id,
        payload: { clubId, userId: application.userId, decidedBy: decider.id, ...(context ? { formSubmissionId: context.sub.id, hasNote: Boolean(note?.trim()) } : {}) },
      });
      return row;
    });
    return c.json({ data: { application: decided } });
  } catch (err) {
    throw asDecisionBusy(err);
  }
});
