import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { auth } from "../auth/auth.js";
import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberships } from "../db/schema/club-memberships.js";
import { CLUB_ROLE_TYPES, hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const clubMemberRoutes = new Hono<ClubEnv>();

clubMemberRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));

/**
 * Loads a membership's club_memberships sidecar row + club_roles + basic
 * user fields, and shapes it into the API response -- optionally hiding
 * "sensitive" fields (birth date, emergency contact, member number) when the
 * caller has neither `members:read_sensitive` nor is looking at their own
 * row. Shared by the list and detail handlers so the two can't drift.
 */
async function shapeMember(memberRow: typeof member.$inferSelect, includeSensitive: boolean) {
  const [userRow, membershipRow, roleRows] = await Promise.all([
    db.query.user.findFirst({ where: eq(user.id, memberRow.userId) }),
    db.query.clubMemberships.findFirst({ where: eq(clubMemberships.memberId, memberRow.id) }),
    db.query.clubRoles.findMany({ where: eq(clubRoles.memberId, memberRow.id) }),
  ]);

  return {
    id: memberRow.id,
    userId: memberRow.userId,
    name: userRow?.name ?? null,
    email: userRow?.email ?? null,
    orgRole: memberRow.role,
    category: membershipRow?.category ?? null,
    joinedAt: membershipRow?.joinedAt ?? null,
    leftAt: membershipRow?.leftAt ?? null,
    roles: roleRows.map((r) => ({ id: r.id, roleType: r.roleType, departmentId: r.departmentId, termEndsAt: r.termEndsAt })),
    ...(includeSensitive
      ? {
          memberNumber: membershipRow?.memberNumber ?? null,
          birthDate: membershipRow?.birthDate ?? null,
          emergencyContactName: membershipRow?.emergencyContactName ?? null,
          emergencyContactPhone: membershipRow?.emergencyContactPhone ?? null,
        }
      : {}),
  };
}

// --- Aufnahmeantrag ---------------------------------------------------
// Session-only (no clubGuard -- the applicant isn't a member yet).
//
// Wave 1 deliberately simplifies "digitaler Aufnahmeantrag" (Concept -
// MyVerein §2) to an immediate self-service join instead of a pending-
// approval queue: there is no `status: pending` on club_memberships (see
// Data Model - MyVerein Backend §3), so a request is granted membership
// right away. The board can still correct a wrong join afterwards via
// PATCH /:memberId (e.g. setting `leftAt`). A real approval workflow is a
// documented gap for a later wave, not silently dropped -- see README §
// "Known Gaps".
const applySchema = z.object({
  clubId: z.string().min(1),
  category: z.enum(["aktiv", "passiv", "foerdernd", "ehrenmitglied", "jugend"]).default("aktiv"),
  birthDate: z.string().date().optional(),
});

clubMemberRoutes.post(
  "/apply",
  sessionGuard,
  zValidator("json", applySchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const currentUser = c.get("user");
    const body = c.req.valid("json");

    const existing = await db.query.member.findFirst({
      where: and(eq(member.organizationId, body.clubId), eq(member.userId, currentUser.id)),
    });
    if (existing) throw new ConflictError("Already a member of this club");

    // addMember returns the created member row directly (not wrapped),
    // see node_modules/better-auth/dist/plugins/organization/routes/
    // crud-members.mjs's `return ctx.json(createdMember)`.
    const createdMember = await auth.api.addMember({
      body: { userId: currentUser.id, organizationId: body.clubId, role: "member" },
    });
    if (!createdMember) throw new ConflictError("Could not create membership");

    const [membership] = await db
      .insert(clubMemberships)
      .values({
        memberId: createdMember.id,
        category: body.category,
        joinedAt: new Date().toISOString().slice(0, 10),
        birthDate: body.birthDate,
      })
      .returning();

    await db.insert(auditLog).values({
      eventType: "club_member.apply",
      subjectId: createdMember.id,
      payload: { clubId: body.clubId, userId: currentUser.id, category: body.category },
    });

    return c.json({ data: { member: createdMember, membership } }, 201);
  },
);

// Registered AFTER the /apply handler above -- Hono only invokes a
// registered middleware if the entries matched before it for this request
// called next(), and /apply's handler returns a response directly (no
// membership to guard yet). Every route below this line runs through
// sessionGuard + clubGuard first.
clubMemberRoutes.use("/*", sessionGuard);
clubMemberRoutes.use("/*", clubGuard);

clubMemberRoutes.get("/me", async (c) => {
  const membership = c.get("membership");
  const shaped = await shapeMember(membership, true);
  return c.json({ data: shaped });
});

const updateSelfSchema = z.object({
  birthDate: z.string().date().optional(),
  emergencyContactName: z.string().max(200).optional(),
  emergencyContactPhone: z.string().max(50).optional(),
});

clubMemberRoutes.patch(
  "/me",
  zValidator("json", updateSelfSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const membership = c.get("membership");
    const body = c.req.valid("json");

    const [row] = await db
      .update(clubMemberships)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(clubMemberships.memberId, membership.id))
      .returning();

    return c.json({ data: row });
  },
);

clubMemberRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  const includeSensitive = hasClubPermission(roleTypes, "members:read_sensitive");

  const rows = await db.query.member.findMany({ where: eq(member.organizationId, clubId) });
  const shaped = await Promise.all(rows.map((row) => shapeMember(row, includeSensitive)));

  return c.json({ data: shaped });
});

clubMemberRoutes.get("/:memberId", async (c) => {
  const clubId = c.get("clubId");
  const callerMembership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const memberId = c.req.param("memberId");

  const row = await db.query.member.findFirst({ where: and(eq(member.id, memberId), eq(member.organizationId, clubId)) });
  if (!row) throw new NotFoundError("Member not found");

  const includeSensitive = row.id === callerMembership.id || hasClubPermission(roleTypes, "members:read_sensitive");
  return c.json({ data: await shapeMember(row, includeSensitive) });
});

const updateMemberSchema = z.object({
  memberNumber: z.string().max(50).optional(),
  category: z.enum(["aktiv", "passiv", "foerdernd", "ehrenmitglied", "jugend"]).optional(),
  leftAt: z.string().date().nullable().optional(),
  birthDate: z.string().date().optional(),
  emergencyContactName: z.string().max(200).optional(),
  emergencyContactPhone: z.string().max(50).optional(),
});

clubMemberRoutes.patch(
  "/:memberId",
  zValidator("json", updateMemberSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "members:write")) {
      throw new ForbiddenError("Missing members:write permission");
    }

    const memberId = c.req.param("memberId");
    const body = c.req.valid("json");

    const row = await db.query.member.findFirst({ where: and(eq(member.id, memberId), eq(member.organizationId, clubId)) });
    if (!row) throw new NotFoundError("Member not found");

    const [updated] = await db
      .update(clubMemberships)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(clubMemberships.memberId, memberId))
      .returning();

    await db.insert(auditLog).values({
      eventType: "club_member.update",
      subjectId: memberId,
      payload: { clubId, changes: body },
    });

    return c.json({ data: updated });
  },
);

// --- Role assignment ----------------------------------------------------

const assignRoleSchema = z.object({
  roleType: z.enum(CLUB_ROLE_TYPES),
  departmentId: z.string().uuid().optional(),
  termEndsAt: z.string().date().optional(),
});

clubMemberRoutes.get("/:memberId/roles", async (c) => {
  const clubId = c.get("clubId");
  const memberId = c.req.param("memberId");

  const row = await db.query.member.findFirst({ where: and(eq(member.id, memberId), eq(member.organizationId, clubId)) });
  if (!row) throw new NotFoundError("Member not found");

  const rows = await db.query.clubRoles.findMany({ where: eq(clubRoles.memberId, memberId) });
  return c.json({ data: rows });
});

clubMemberRoutes.post(
  "/:memberId/roles",
  zValidator("json", assignRoleSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "roles:write")) {
      throw new ForbiddenError("Missing roles:write permission");
    }

    const memberId = c.req.param("memberId");
    const body = c.req.valid("json");

    const row = await db.query.member.findFirst({ where: and(eq(member.id, memberId), eq(member.organizationId, clubId)) });
    if (!row) throw new NotFoundError("Member not found");

    const [created] = await db.insert(clubRoles).values({ memberId, ...body }).returning();

    await db.insert(auditLog).values({
      eventType: "club_role.assign",
      subjectId: memberId,
      payload: { clubId, roleType: body.roleType, departmentId: body.departmentId },
    });

    return c.json({ data: created }, 201);
  },
);

clubMemberRoutes.delete("/:memberId/roles/:roleId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "roles:write")) {
    throw new ForbiddenError("Missing roles:write permission");
  }

  const memberId = c.req.param("memberId");
  const roleId = c.req.param("roleId");

  const row = await db.query.member.findFirst({ where: and(eq(member.id, memberId), eq(member.organizationId, clubId)) });
  if (!row) throw new NotFoundError("Member not found");

  const existing = await db.query.clubRoles.findFirst({ where: and(eq(clubRoles.id, roleId), eq(clubRoles.memberId, memberId)) });
  if (!existing) throw new NotFoundError("Role assignment not found");

  await db.delete(clubRoles).where(eq(clubRoles.id, roleId));

  await db.insert(auditLog).values({
    eventType: "club_role.revoke",
    subjectId: memberId,
    payload: { clubId, roleId, roleType: existing.roleType },
  });

  return c.body(null, 204);
});

// --- Guardian links (externe Rolle: Erziehungsberechtigte) --------------
// Board-managed only (members:write) -- a guardian must never be able to
// self-grant visibility into an arbitrary member's data, see Data Model -
// MyVerein Backend §6.

const guardianLinkSchema = z.object({ guardianMemberId: z.string().min(1) });

clubMemberRoutes.get("/:memberId/guardians", async (c) => {
  const clubId = c.get("clubId");
  const memberId = c.req.param("memberId");

  const row = await db.query.member.findFirst({ where: and(eq(member.id, memberId), eq(member.organizationId, clubId)) });
  if (!row) throw new NotFoundError("Member not found");

  const rows = await db.query.guardianLinks.findMany({ where: eq(guardianLinks.wardMemberId, memberId) });
  return c.json({ data: rows });
});

clubMemberRoutes.post(
  "/:memberId/guardians",
  zValidator("json", guardianLinkSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "members:write")) {
      throw new ForbiddenError("Missing members:write permission");
    }

    const wardMemberId = c.req.param("memberId");
    const { guardianMemberId } = c.req.valid("json");

    const [ward, guardian] = await Promise.all([
      db.query.member.findFirst({ where: and(eq(member.id, wardMemberId), eq(member.organizationId, clubId)) }),
      db.query.member.findFirst({ where: and(eq(member.id, guardianMemberId), eq(member.organizationId, clubId)) }),
    ]);
    if (!ward) throw new NotFoundError("Member not found");
    if (!guardian) throw new NotFoundError("Guardian member not found in this club");

    const [created] = await db.insert(guardianLinks).values({ guardianMemberId, wardMemberId }).returning();

    await db.insert(auditLog).values({
      eventType: "guardian_link.create",
      subjectId: wardMemberId,
      payload: { clubId, guardianMemberId },
    });

    return c.json({ data: created }, 201);
  },
);

clubMemberRoutes.delete("/:memberId/guardians/:guardianMemberId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "members:write")) {
    throw new ForbiddenError("Missing members:write permission");
  }

  const wardMemberId = c.req.param("memberId");
  const guardianMemberId = c.req.param("guardianMemberId");

  const ward = await db.query.member.findFirst({ where: and(eq(member.id, wardMemberId), eq(member.organizationId, clubId)) });
  if (!ward) throw new NotFoundError("Member not found");

  const existing = await db.query.guardianLinks.findFirst({
    where: and(eq(guardianLinks.wardMemberId, wardMemberId), eq(guardianLinks.guardianMemberId, guardianMemberId)),
  });
  if (!existing) throw new NotFoundError("Guardian link not found");

  await db.delete(guardianLinks).where(and(eq(guardianLinks.wardMemberId, wardMemberId), eq(guardianLinks.guardianMemberId, guardianMemberId)));

  await db.insert(auditLog).values({
    eventType: "guardian_link.delete",
    subjectId: wardMemberId,
    payload: { clubId, guardianMemberId },
  });

  return c.body(null, 204);
});
