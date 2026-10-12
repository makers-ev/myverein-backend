import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { auth } from "../auth/auth.js";
import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMembers } from "../db/schema/club-members.js";
import { assertRejoinAllowed, ensureClubMember, findCategoryByKey } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new NotFoundError("Application not found");

  const application = await db.query.clubApplications.findFirst({
    where: and(eq(clubApplications.id, id), eq(clubApplications.clubId, clubId)),
  });
  if (!application) throw new NotFoundError("Application not found");
  if (application.status !== "pending") throw new ConflictError("Application has already been decided");
  return application;
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
    })
    .from(clubApplications)
    .innerJoin(user, eq(user.id, clubApplications.userId))
    .where(and(eq(clubApplications.clubId, clubId), eq(clubApplications.status, "pending")))
    .orderBy(asc(clubApplications.createdAt), asc(clubApplications.id));

  return c.json({ data: rows });
});

clubApplicationRoutes.post("/:id/approve", async (c) => {
  const clubId = c.get("clubId");
  const decider = c.get("membership");

  const application = await loadPendingApplication(c.req.param("id"), clubId);

  const existing = await db.query.member.findFirst({
    where: and(eq(member.organizationId, clubId), eq(member.userId, application.userId)),
  });
  if (existing) {
    // A former member (ausgetreten) who re-applied is re-admitted by reopening the existing club_members row.
    const former = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, existing.id) });
    if (!former || effectiveStatus(former, todayBerlin()) !== "ausgetreten") throw new ConflictError("Applicant is already a member of this club");
    return c.json(await readmit(c.get("clubId"), application, existing, former, decider.id));
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
      // Claim the application first: only one concurrent decision can flip it out of 'pending'.
      const [decided] = await tx
        .update(clubApplications)
        .set({ status: "approved", decidedAt: new Date(), decidedBy: decider.id })
        .where(and(eq(clubApplications.id, application.id), eq(clubApplications.status, "pending")))
        .returning();
      if (!decided) throw new ConflictError("Application has already been decided");

      // The Better Auth afterAddMember hook normally created the club_members row already (default category);
      // ensureClubMember covers a hook that did not run, then the application's choices are applied on top.
      const ensured = await ensureClubMember(tx, createdMember, { categoryKey: application.category, birthDate: application.birthDate, joinedAt: today });
      const category = await findCategoryByKey(tx, clubId, application.category);
      const [clubMember] = await tx
        .update(clubMembers)
        .set({ ...(category ? { categoryId: category.id } : {}), birthDate: application.birthDate ?? ensured.birthDate, joinedAt: today, status: "aktiv", updatedAt: new Date() })
        .where(eq(clubMembers.id, ensured.id))
        .returning();
      const memberNumber = clubMember!.memberNumber;

      await tx.insert(auditLog).values({
        eventType: "club_application.approve",
        subjectId: application.id,
        payload: { clubId, userId: application.userId, memberId: createdMember.id, clubMemberId: clubMember!.id, decidedBy: decider.id, memberNumber },
      });

      return { application: decided, clubMember: clubMember!, categoryKey: category?.key ?? application.category };
    });

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
    return c.json({ data: { application: result.application, member: createdMember, membership, clubMember } });
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
    throw err;
  }
});

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
) {
  const today = todayBerlin();
  const result = await db.transaction(async (tx) => {
    const [decided] = await tx
      .update(clubApplications)
      .set({ status: "approved", decidedAt: new Date(), decidedBy: deciderId })
      .where(and(eq(clubApplications.id, application.id), eq(clubApplications.status, "pending")))
      .returning();
    if (!decided) throw new ConflictError("Application has already been decided");

    const category = await findCategoryByKey(tx, clubId, application.category);
    const done = await transitionMember(
      tx,
      clubId,
      former.id,
      { toStatus: "aktiv", reopen: true, reason: "Wiederaufnahme per Aufnahmeantrag", category: category && !category.archivedAt ? category : undefined },
      deciderId,
      today,
    );
    const [clubMember] = application.birthDate
      ? await tx.update(clubMembers).set({ birthDate: application.birthDate, updatedAt: new Date() }).where(eq(clubMembers.id, former.id)).returning()
      : [done.row];
    await tx.insert(auditLog).values({
      eventType: "club_application.approve",
      subjectId: application.id,
      payload: { clubId, userId: application.userId, memberId: account.id, clubMemberId: former.id, decidedBy: deciderId, readmission: true },
    });
    return { application: decided, clubMember: clubMember! };
  });
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
    },
  };
}

clubApplicationRoutes.post("/:id/reject", async (c) => {
  const clubId = c.get("clubId");
  const decider = c.get("membership");

  const application = await loadPendingApplication(c.req.param("id"), clubId);

  const decided = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(clubApplications)
      .set({ status: "rejected", decidedAt: new Date(), decidedBy: decider.id })
      .where(and(eq(clubApplications.id, application.id), eq(clubApplications.status, "pending")))
      .returning();
    if (!row) throw new ConflictError("Application has already been decided");

    await tx.insert(auditLog).values({
      eventType: "club_application.reject",
      subjectId: application.id,
      payload: { clubId, userId: application.userId, decidedBy: decider.id },
    });
    return row;
  });

  return c.json({ data: { application: decided } });
});
