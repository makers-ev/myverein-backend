import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";

import { auth } from "../auth/auth.js";
import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMemberships } from "../db/schema/club-memberships.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { nextMemberNumber } from "../lib/member-number.js";
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
  if (existing) throw new ConflictError("Applicant is already a member of this club");

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

  try {
    const result = await db.transaction(async (tx) => {
      // Claim the application first: only one concurrent decision can flip it out of 'pending'.
      const [decided] = await tx
        .update(clubApplications)
        .set({ status: "approved", decidedAt: new Date(), decidedBy: decider.id })
        .where(and(eq(clubApplications.id, application.id), eq(clubApplications.status, "pending")))
        .returning();
      if (!decided) throw new ConflictError("Application has already been decided");

      const memberNumber = await nextMemberNumber(tx, clubId);
      const [membership] = await tx
        .insert(clubMemberships)
        .values({
          memberId: createdMember.id,
          memberNumber,
          category: application.category,
          birthDate: application.birthDate,
          joinedAt: new Date().toISOString().slice(0, 10),
        })
        .returning();

      await tx.insert(auditLog).values({
        eventType: "club_application.approve",
        subjectId: application.id,
        payload: { clubId, userId: application.userId, memberId: createdMember.id, decidedBy: decider.id, memberNumber },
      });

      return { application: decided, membership };
    });

    return c.json({ data: { application: result.application, member: createdMember, membership: result.membership } });
  } catch (err) {
    // The member row was created outside the transaction -- best-effort removal so a failed approval doesn't leave
    // a member without a club_memberships row while the application is still pending.
    await db.delete(member).where(eq(member.id, createdMember.id)).catch(() => undefined);
    throw err;
  }
});

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
