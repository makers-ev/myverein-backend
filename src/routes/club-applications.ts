import { and, asc, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import { auth } from "../auth/auth.js";
import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMembers } from "../db/schema/club-members.js";
import { assertRejoinAllowed, DEFAULT_CATEGORY_KEY, type DbExecutor, ensureClubMember, findCategoryByKey, isUuid, lockCategoryShared } from "../lib/club-members.js";
import { clubMemberStatusHistory, type MemberCategoryRow } from "../db/schema/club-members.js";
import { nextMemberNumber } from "../lib/member-number.js";
import { planAcceptance } from "../lib/form-acceptance.js";
import { childDisplayName, ensureGuardianAccount, linkGuardian, type GuardianAccount } from "../lib/form-children.js";
import { formVersions, formSubmissions } from "../db/schema/forms.js";
import type { FormField } from "../lib/form-schema.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { applyAcceptance, compensateAbortedApproval, asDecisionBusy, assertSubmissionDecidable, consentEvidence, lockDecisionSubmission, rejectSubmission, type DecisionContext, type MappingReport } from "../lib/form-applications.js";
import { purgeMediaFile } from "../lib/media.js";
import { buildApplicationReview, listExtras } from "../lib/application-review.js";
import { scheduleLazyCleanup } from "../lib/form-sweeper.js";
import { cleanText } from "../lib/text-policy.js";
import { logger } from "../lib/logger.js";
import { effectiveStatus, isLeftStatus, todayBerlin, transitionMember } from "../lib/member-lifecycle.js";
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
const rejectBodySchema = z.object({
  // Internal note: stays with the board. `applicantMessage` is the only text the applicant gets to see.
  note: cleanText(z.string().trim().max(1000), true).nullish(),
  applicantMessage: cleanText(z.string().trim().max(1000), true).nullish(),
});

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

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The canonical club member row as returned by an approval. The storage key of the photo (media layer) never leaves the
 * server -- not even to the board: `hasPhoto` tells the client to read the member (`GET /club-members/:id`, signed URL
 * after that route's permission check) instead.
 */
function publicClubMember<T extends { photoKey: string | null }>(row: T): Omit<T, "photoKey"> & { hasPhoto: boolean } {
  const { photoKey, ...rest } = row;
  return { ...rest, hasPhoto: photoKey !== null };
}

clubApplicationRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const parsed = listQuerySchema.safeParse({ page: c.req.query("page"), pageSize: c.req.query("pageSize") });
  if (!parsed.success) throw new ValidationError("Invalid query", { details: parsed.error.issues });
  const { page, pageSize } = parsed.data;
  // Overdue data of this club (rejected applications' files / child answers) is cleaned lazily when the board looks at the queue.
  scheduleLazyCleanup({ clubId });
  const canReadSensitive = hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive");

  const where = and(eq(clubApplications.clubId, clubId), eq(clubApplications.status, "pending"));
  const [totalRow] = await db.select({ n: count() }).from(clubApplications).where(where);
  const rows = await db
    .select({
      id: clubApplications.id,
      userId: clubApplications.userId,
      name: user.name,
      email: user.email,
      category: clubApplications.category,
      birthDate: clubApplications.birthDate,
      status: clubApplications.status,
      onBehalfOf: clubApplications.onBehalfOf,
      createdAt: clubApplications.createdAt,
      formSubmissionId: clubApplications.formSubmissionId,
    })
    .from(clubApplications)
    .innerJoin(user, eq(user.id, clubApplications.userId))
    .where(where)
    .orderBy(asc(clubApplications.createdAt), asc(clubApplications.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // `legacy`: filed before the form builder (or by an old client): category/birth date only, no answers, no consent record.
  // `summary`: a few non-sensitive answers rendered against the version the applicant filled in; the full view is `GET /:id`.
  // `birthDate` stays in the shape but is null without members:read_sensitive.
  const extras = await listExtras(clubId, rows, new Map(rows.map((r) => [r.id, r.name])));
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: rows.map((r) => ({ ...r, birthDate: canReadSensitive ? r.birthDate : null, legacy: r.formSubmissionId === null, ...extras.get(r.id)! })), page, pageSize, total: totalRow?.n ?? 0 });
});

/**
 * Full review of one application (any status, so the board can look at a decided one): answers rendered against the ORIGINAL
 * version, mapping preview, files, consent evidence, duplicate hint. Answers of `sensitive` fields need
 * `members:read_sensitive` (redacted otherwise) and every delivery of them is audited with field keys, never values.
 */
clubApplicationRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");
  if (!isUuid(id)) throw new NotFoundError("Application not found");
  const application = await db.query.clubApplications.findFirst({ where: and(eq(clubApplications.id, id), eq(clubApplications.clubId, clubId)) });
  if (!application) throw new NotFoundError("Application not found");
  scheduleLazyCleanup({ clubId });

  const review = await buildApplicationReview(application, { clubId, canReadSensitive: hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive") });
  const { sensitiveKeysRead, ...data } = review;
  if (sensitiveKeysRead.length > 0) {
    await db.insert(auditLog).values({ eventType: "club_application.sensitive_read", subjectId: application.id, payload: { clubId, readBy: c.get("membership").id, formSubmissionId: application.formSubmissionId, fieldKeys: sensitiveKeysRead } });
  }
  c.header("Cache-Control", "private, no-store");
  return c.json({ data });
});

clubApplicationRoutes.post("/:id/approve", decisionBodyLimit, async (c) => {
  const clubId = c.get("clubId");
  const decider = c.get("membership");

  const override = overrideOf(await readOptionalBody(c, approveBodySchema));
  const application = await loadPendingApplication(c.req.param("id"), clubId);
  // A withdrawn / already decided submission is refused before any account membership is created.
  await assertSubmissionDecidable(db, application);
  await assertCategoryChoosable(clubId, override);
  if (application.onBehalfOf === "guardian") return c.json({ data: await approveChild(clubId, application, decider, override) });

  const existing = await db.query.member.findFirst({
    where: and(eq(member.organizationId, clubId), eq(member.userId, application.userId)),
  });
  if (existing) {
    // A former member (ausgetreten) who re-applied is re-admitted by reopening the existing club_members row.
    const former = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, existing.id) });
    // An external guest (guardian, `member.role = guest`) who applies for themself becomes a regular member.
    const promote = existing.role === "guest" && former !== undefined;
    if (!former || (!promote && effectiveStatus(former, todayBerlin()) !== "ausgetreten")) throw new ConflictError("Applicant is already a member of this club");
    return c.json(await readmit(clubId, application, existing, former, decider.id, override, promote));
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
    return c.json({ data: { application: result.application, member: createdMember, membership, clubMember: publicClubMember(clubMember), mapping: result.mapping } });
  } catch (err) {
    // The account membership (and the hook's club_members row) was created outside the transaction. Remove it again only
    // if it is provably still our untouched creation and nobody (e.g. an invitation merge) holds the account lock; after
    // a lock timeout / deadlock we never delete blindly.
    const removed = await compensateAbortedApproval({ id: createdMember.id, organizationId: clubId, userId: application.userId }).catch((cleanupErr) => {
      logger.error({ err: cleanupErr, memberId: createdMember.id }, "[club-applications] failed to remove member after aborted approval");
      return false;
    });
    if (!removed) logger.warn({ memberId: createdMember.id, applicationId: application.id }, "[club-applications] aborted approval left the new membership in place (changed or locked meanwhile)");
    throw asDecisionBusy(err);
  }
});

/**
 * Acceptance of an application a parent filed for a CHILD (Wave 8 B8): an account-less `club_members` row for the child
 * (no account is created for the child, no e-mail), the form mapped onto it exactly like for an adult, and the guardian link
 * child <- parent. The parent keeps their account membership or gets an external one (see `lib/form-children.ts`). The
 * applicant is the parent: nothing here touches the parent's own member record unless the parent is new to the club.
 *
 * Lock order (same as an adult acceptance, README "Locks"): submission -> application -> category (share) -> organization
 * row (member number) -> the child's new `club_members` row -> media -> custom field definitions -> values. The Better Auth
 * call for a new external parent runs before the transaction and is compensated like an adult's.
 */
async function approveChild(clubId: string, application: typeof clubApplications.$inferSelect, decider: { id: string }, override: CategoryOverride) {
  const today = todayBerlin();

  // Pre-flight without locks: the child must be nameable, BEFORE any account membership is created for the parent.
  const [pinned] = await db
    .select({ fields: formVersions.fields, answers: formSubmissions.answers })
    .from(formSubmissions)
    .innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId))
    .where(eq(formSubmissions.id, application.formSubmissionId ?? "00000000-0000-0000-0000-000000000000"))
    .limit(1);
  if (!pinned || childDisplayName(planAcceptance(pinned.fields as FormField[], pinned.answers)) === null) {
    throw new ConflictError("The application does not name the child (first and last name); reject it and ask the parent to apply again", { details: { code: "child_name_missing" } });
  }

  const guardian: GuardianAccount = await ensureGuardianAccount(clubId, application.userId);
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      const context = await lockDecisionSubmission(tx, application);
      if (!context) throw new ConflictError("Application has already been decided");
      const [decided] = await tx
        .update(clubApplications)
        .set({ status: "approved", decidedAt: new Date(), decidedBy: decider.id })
        .where(and(eq(clubApplications.id, application.id), eq(clubApplications.status, "pending")))
        .returning();
      if (!decided) throw new ConflictError("Application has already been decided");

      const category = (await chooseCategory(tx, clubId, override, application.category)) ?? (await findCategoryByKey(tx, clubId, DEFAULT_CATEGORY_KEY));
      const name = childDisplayName(planAcceptance(context.version.fields as FormField[], context.sub.answers));
      if (!name) throw new ConflictError("The application does not name the child", { details: { code: "child_name_missing" } });

      const [child] = await tx
        .insert(clubMembers)
        .values({ clubId, memberId: null, lastUserId: null, displayName: name, memberNumber: await nextMemberNumber(tx, clubId), categoryId: category?.id ?? null, status: "aktiv", joinedAt: today })
        .returning();
      await tx.insert(clubMemberStatusHistory).values({ clubMemberId: child!.id, fromStatus: null, toStatus: "aktiv", toCategoryId: category?.id ?? null, effectiveOn: today, reason: "Aufnahmeantrag (Kind)", changedBy: decider.id });

      const applied = await applyAcceptance(tx, { clubId, context, clubMemberId: child!.id, decidedBy: decider.id });
      const link = await linkGuardian(tx, { clubId, guardian, childClubMemberId: child!.id, decidedBy: decider.id });
      const [finalApplication] = await tx.update(clubApplications).set({ clubMemberId: child!.id }).where(eq(clubApplications.id, application.id)).returning();

      await tx.insert(auditLog).values({
        eventType: "club_application.approve",
        subjectId: application.id,
        // Ids, field keys and counts only -- never the child's name or any answer.
        payload: {
          clubId,
          userId: application.userId,
          guardianMemberId: guardian.account.id,
          clubMemberId: child!.id,
          decidedBy: decider.id,
          onBehalfOf: "guardian",
          guardianCreated: guardian.created,
          guardianLinked: link.linked,
          memberNumber: applied.clubMember.memberNumber,
          formSubmissionId: context.sub.id,
          formVersionId: context.version.id,
          mapped: { targets: applied.mapping.applied, customFields: applied.mapping.customFields, skipped: applied.mapping.skipped.length },
          consent: consentEvidence(context, child!.id),
        },
      });
      return { application: finalApplication!, clubMember: applied.clubMember, mapping: applied.mapping, purge: applied.purge, linked: link.linked };
    });
    await Promise.all(result.purge.map((key) => purgeMediaFile(key)));
    return {
      application: result.application,
      // The child has no account; the parent's account membership is reported under `guardian`.
      member: null,
      clubMember: publicClubMember(result.clubMember),
      guardian: { memberId: guardian.account.id, userId: application.userId, createdAsExternal: guardian.created, linked: true },
      mapping: result.mapping,
    };
  } catch (err) {
    if (guardian.created) {
      const removed = await compensateAbortedApproval({ id: guardian.account.id, organizationId: clubId, userId: application.userId }).catch((cleanupErr) => {
        logger.error({ err: cleanupErr, memberId: guardian.account.id }, "[club-applications] failed to remove guardian membership after aborted approval");
        return false;
      });
      if (!removed) logger.warn({ memberId: guardian.account.id, applicationId: application.id }, "[club-applications] aborted child approval left the guardian membership in place");
    }
    // The parent's account membership vanished under us (FK of the guardian link): the same retryable busy answer.
    const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "23503") throw new ConflictError("The guardian's membership changed while the application was being decided; try again", { details: { code: "decision_busy" } });
    throw asDecisionBusy(err);
  }
}

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
  promoteGuest = false,
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
      const currentStatus = effectiveStatus(former, today);
      let done: { row: typeof clubMembers.$inferSelect };
      if (promoteGuest && currentStatus === "aktiv") {
        // A legacy guest row that is already `aktiv`: no status change, only the category the board chose.
        done = { row: category ? (await tx.update(clubMembers).set({ categoryId: category.id, updatedAt: new Date() }).where(eq(clubMembers.id, former.id)).returning())[0]! : former };
      } else {
        done = await transitionMember(
          tx,
          clubId,
          former.id,
          { toStatus: "aktiv", reopen: isLeftStatus(currentStatus), reason: promoteGuest ? "Aufnahme als Mitglied (zuvor externe Rolle)" : "Wiederaufnahme per Aufnahmeantrag", category: category ?? undefined },
          deciderId,
          today,
        );
      }
      if (promoteGuest) {
        // Guest-specific leftovers go: the account becomes a regular member (the role erziehungsberechtigt and guardian links stay).
        await tx.update(member).set({ role: "member" }).where(eq(member.id, account.id));
        // A guest row was created without a member number (see ensureGuardianAccount): the member gets one now.
        const number = former.memberNumber ?? (await nextMemberNumber(tx, clubId));
        await tx.update(clubMembers).set({ joinedAt: today, memberNumber: number, updatedAt: new Date() }).where(eq(clubMembers.id, former.id));
      }
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
        payload: { clubId, userId: application.userId, memberId: account.id, clubMemberId: former.id, decidedBy: deciderId, ...(promoteGuest ? { promotedGuest: true } : { readmission: true }), ...(context ? auditOfMapping(context, mapping!) : {}) },
      });
      return { application: finalApplication!, clubMember, mapping, purge };
    });
    await Promise.all(result.purge.map((key) => purgeMediaFile(key)));
    const { clubMember } = result;
    // The category the member actually has now (board override / mapped answer / unchanged), not the applicant's request.
    const actual = clubMember.categoryId ? await db.query.memberCategories.findFirst({ where: (t, { eq: same }) => same(t.id, clubMember.categoryId!), columns: { key: true } }) : undefined;
    return {
      data: {
        application: result.application,
        member: { ...account, role: promoteGuest ? "member" : account.role },
        membership: {
          id: clubMember.id,
          memberId: account.id,
          memberNumber: clubMember.memberNumber,
          category: actual?.key ?? application.category,
          joinedAt: clubMember.joinedAt,
          leftAt: clubMember.leftAt,
          birthDate: clubMember.birthDate,
          emergencyContactName: clubMember.emergencyContactName,
          emergencyContactPhone: clubMember.emergencyContactPhone,
          createdAt: clubMember.createdAt,
          updatedAt: clubMember.updatedAt,
        },
        clubMember: publicClubMember(clubMember),
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

  const { note, applicantMessage } = await readOptionalBody(c, rejectBodySchema);
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
      if (context) await rejectSubmission(tx, context, decider.id, { applicantMessage: applicantMessage?.trim() || null, internalNote: note?.trim() || null });

      await tx.insert(auditLog).values({
        eventType: "club_application.reject",
        subjectId: application.id,
        payload: { clubId, userId: application.userId, decidedBy: decider.id, ...(context ? { formSubmissionId: context.sub.id, hasNote: Boolean(note?.trim()), hasApplicantMessage: Boolean(applicantMessage?.trim()) } : {}) },
      });
      return row;
    });
    return c.json({ data: { application: decided } });
  } catch (err) {
    throw asDecisionBusy(err);
  }
});
