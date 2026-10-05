import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import { clubMemberships } from "../db/schema/club-memberships.js";
import { CLUB_ROLE_TYPES, clubPermissionsFor, hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { nextMemberNumber } from "../lib/member-number.js";
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
// Writes ONLY to club_applications (status "pending"); no member /
// club_memberships row is created here. A board member with `members:write`
// decides via /club-applications (approve creates the member + membership,
// reject leaves no trace besides the decided application row). This replaces
// the Wave 1 simplification of granting membership immediately. A user may
// re-apply after a rejection, but never hold two pending applications for the
// same club (partial unique index).
const applySchema = z
  .object({
    // clubId (raw organization id) or clubSlug (human-shareable, e.g. a
    // club posts "demo-sportverein" on its own website/flyer) -- a mobile
    // join screen only ever has the slug, never the raw id.
    clubId: z.string().min(1).optional(),
    clubSlug: z.string().min(1).optional(),
    category: z.enum(["aktiv", "passiv", "foerdernd", "ehrenmitglied", "jugend"]).default("aktiv"),
    birthDate: z.string().date().optional(),
  })
  .refine((body) => body.clubId ?? body.clubSlug, { message: "clubId or clubSlug is required" });

clubMemberRoutes.post(
  "/apply",
  sessionGuard,
  zValidator("json", applySchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const currentUser = c.get("user");
    const body = c.req.valid("json");

    const clubId = body.clubId ?? (await db.query.organization.findFirst({ where: eq(organization.slug, body.clubSlug!) }))?.id;
    if (!clubId) throw new NotFoundError("Club not found");

    const existing = await db.query.member.findFirst({
      where: and(eq(member.organizationId, clubId), eq(member.userId, currentUser.id)),
    });
    if (existing) throw new ConflictError("Already a member of this club");

    let application;
    try {
      [application] = await db
        .insert(clubApplications)
        .values({ userId: currentUser.id, clubId, category: body.category, birthDate: body.birthDate })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("An application for this club is already pending");
      throw err;
    }

    await db.insert(auditLog).values({
      eventType: "club_member.apply",
      subjectId: application.id,
      payload: { clubId, userId: currentUser.id, category: body.category },
    });

    return c.json({ data: { application } }, 201);
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
  return c.json({ data: { ...shaped, permissions: clubPermissionsFor(c.get("clubRoleTypes")) } });
});

/**
 * Update the membership sidecar, creating it first for members that joined without /apply (e.g. the club founder).
 * A newly created row gets an automatic member number (see member-number.ts) unless the caller passed
 * `memberNumber` explicitly (including null) -- the board can still override it manually afterwards.
 */
async function upsertMembership(memberRow: typeof member.$inferSelect, values: Partial<typeof clubMemberships.$inferInsert>) {
  return db.transaction(async (tx) => {
    const existing = await tx.query.clubMemberships.findFirst({ where: eq(clubMemberships.memberId, memberRow.id) });
    const generated =
      !existing && values.memberNumber === undefined ? { memberNumber: await nextMemberNumber(tx, memberRow.organizationId) } : {};

    const [row] = await tx
      .insert(clubMemberships)
      .values({ memberId: memberRow.id, joinedAt: memberRow.createdAt.toISOString().slice(0, 10), ...generated, ...values })
      .onConflictDoUpdate({ target: clubMemberships.memberId, set: { ...values, updatedAt: new Date() } })
      .returning();
    return row;
  });
}

const updateSelfSchema = z.object({
  birthDate: z.string().date().nullable().optional(),
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

    const row = await upsertMembership(membership, body);

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
  memberNumber: z.string().max(50).nullable().optional(),
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

    const updated = await upsertMembership(row, body);

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

    let created;
    try {
      [created] = await db.insert(clubRoles).values({ memberId, ...body }).returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("Member already holds this role");
      throw err;
    }

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
