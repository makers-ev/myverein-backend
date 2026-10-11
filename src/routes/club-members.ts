import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubApplications } from "../db/schema/club-applications.js";
import {
  clubMemberDepartments,
  clubMembers,
  clubMemberStatusHistory,
  memberCategories,
  type ClubMemberRow,
  type MemberCategoryRow,
} from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { ASSIGNABLE_ROLE_TYPES, IMPLICIT_ROLE_TYPE, clubPermissionsFor, hasClubPermission } from "../lib/club-permissions.js";
import { ensureClubMember, ensureDefaultCategories, findCategoryByKey, isUuid, markDetachedMembersLeft, memberNumberTaken, resolveClubMember } from "../lib/club-members.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { nextMemberNumber } from "../lib/member-number.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const clubMemberRoutes = new Hono<ClubEnv>();

clubMemberRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));

const today = () => new Date().toISOString().slice(0, 10);

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

/**
 * Shapes club_members rows into the API response (stable contract, see README "Club members API").
 *
 * Always present: id (= club_members.id), memberId (Better Auth member.id | null), userId, hasAccount, name,
 * status, category (KEY string -- kept for older clients), categoryId, categoryName, categoryObject, joinedAt,
 * leftAt, orgRole, roles, departments.
 * Only for the member's own row or callers with `members:read_sensitive`: email (account e-mail), contactEmail,
 * memberNumber, birthDate, street, postalCode, city, phone, emergencyContactName/Phone.
 *
 * Batch-loads everything it needs, so the list endpoint does not run N+1 queries.
 */
async function shapeClubMembers(rows: ClubMemberRow[], caller: { memberId: string; canReadSensitive: boolean }, forceSensitive = false) {
  if (rows.length === 0) return [];

  const memberIds = rows.map((r) => r.memberId).filter((v): v is string => v !== null);
  const categoryIds = [...new Set(rows.map((r) => r.categoryId).filter((v): v is string => v !== null))];

  const [accountRows, roleRows, categoryRows, departmentRows] = await Promise.all([
    memberIds.length > 0
      ? db.select({ member, email: user.email, userName: user.name }).from(member).innerJoin(user, eq(user.id, member.userId)).where(inArray(member.id, memberIds))
      : Promise.resolve([]),
    memberIds.length > 0 ? db.select().from(clubRoles).where(inArray(clubRoles.memberId, memberIds)) : Promise.resolve([]),
    categoryIds.length > 0 ? db.select().from(memberCategories).where(inArray(memberCategories.id, categoryIds)) : Promise.resolve([]),
    db
      .select({ clubMemberId: clubMemberDepartments.clubMemberId, id: departments.id, name: departments.name, since: clubMemberDepartments.since, until: clubMemberDepartments.until })
      .from(clubMemberDepartments)
      .innerJoin(departments, eq(departments.id, clubMemberDepartments.departmentId))
      .where(inArray(clubMemberDepartments.clubMemberId, rows.map((r) => r.id)))
      .orderBy(asc(departments.name), asc(clubMemberDepartments.since)),
  ]);

  const accountById = new Map(accountRows.map((a) => [a.member.id, a]));
  const rolesByMember = new Map<string, typeof roleRows>();
  for (const r of roleRows) rolesByMember.set(r.memberId, [...(rolesByMember.get(r.memberId) ?? []), r]);
  const categoryById = new Map<string, MemberCategoryRow>(categoryRows.map((c) => [c.id, c]));
  const departmentsByMember = new Map<string, Array<{ id: string; name: string; since: string; until: string | null }>>();
  for (const d of departmentRows) {
    departmentsByMember.set(d.clubMemberId, [...(departmentsByMember.get(d.clubMemberId) ?? []), { id: d.id, name: d.name, since: d.since, until: d.until }]);
  }

  return rows.map((row) => {
    const account = row.memberId ? accountById.get(row.memberId) : undefined;
    const category = row.categoryId ? categoryById.get(row.categoryId) : undefined;
    const sensitive = forceSensitive || caller.canReadSensitive || (row.memberId !== null && row.memberId === caller.memberId);

    return {
      id: row.id,
      memberId: row.memberId,
      userId: account?.member.userId ?? null,
      hasAccount: account !== undefined,
      name: row.displayName,
      status: row.status,
      // `category` stays the category KEY string (what the clubs-members contract returned before Wave 7);
      // the richer forms are additive.
      category: category?.key ?? null,
      categoryId: row.categoryId,
      categoryName: category?.name ?? null,
      categoryObject: category ? { id: category.id, key: category.key, name: category.name, votingRight: category.votingRight } : null,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
      orgRole: account?.member.role ?? null,
      roles: (account ? (rolesByMember.get(account.member.id) ?? []) : []).map((r) => ({ id: r.id, roleType: r.roleType, departmentId: r.departmentId, termEndsAt: r.termEndsAt })),
      departments: departmentsByMember.get(row.id) ?? [],
      ...(sensitive
        ? {
            email: account?.email ?? null,
            contactEmail: row.contactEmail,
            memberNumber: row.memberNumber,
            birthDate: row.birthDate,
            street: row.street,
            postalCode: row.postalCode,
            city: row.city,
            phone: row.phone,
            emergencyContactName: row.emergencyContactName,
            emergencyContactPhone: row.emergencyContactPhone,
          }
        : {}),
    };
  });
}

type ShapedMember = Awaited<ReturnType<typeof shapeClubMembers>>[number];

async function shapeOne(row: ClubMemberRow, caller: { memberId: string; canReadSensitive: boolean }, forceSensitive = false): Promise<ShapedMember> {
  return (await shapeClubMembers([row], caller, forceSensitive))[0]!;
}

function callerOf(c: { get(k: "membership"): { id: string }; get(k: "clubRoleTypes"): string[] }) {
  return { memberId: c.get("membership").id, canReadSensitive: hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive") };
}

/** Roles (and other login-bound features) need a linked account: a member without an account answers 409. */
function requireAccount(row: ClubMemberRow): string {
  if (!row.memberId) throw new ConflictError("Member has no account");
  return row.memberId;
}

/** Optional free-text field: trimmed, "" becomes null, null clears. */
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v));
/** Manually assigned member number: 1-50 characters, no control characters. */
const memberNumberText = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((v) => ![...v].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127), { message: "must not contain control characters" });
const optDate = z.string().date().nullable().optional();
const optEmail = z
  .string()
  .trim()
  .max(320)
  .email()
  .nullable()
  .optional();

/** Resolves a category reference (id or key) within the club; unknown/archived categories are a 422. */
async function resolveCategory(clubId: string, ref: { categoryId?: string; categoryKey?: string }): Promise<MemberCategoryRow | undefined> {
  let row: MemberCategoryRow | null | undefined;
  if (ref.categoryId !== undefined) {
    row = await db.query.memberCategories.findFirst({ where: and(eq(memberCategories.id, ref.categoryId), eq(memberCategories.clubId, clubId)) });
  } else if (ref.categoryKey !== undefined) {
    await ensureDefaultCategories(clubId);
    row = await findCategoryByKey(db, clubId, ref.categoryKey);
  } else {
    return undefined;
  }
  if (!row || row.archivedAt) throw new ValidationError("Unknown or archived category");
  return row;
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

// --- Self-service ---------------------------------------------------------

clubMemberRoutes.get("/me", async (c) => {
  const membership = c.get("membership");
  // Safety net for accounts whose club_members row is missing (normally created by the Better Auth hook).
  const row = await ensureClubMember(db, membership);
  const shaped = await shapeOne(row, callerOf(c), true);
  return c.json({ data: { ...shaped, clubMemberId: row.id, permissions: clubPermissionsFor(c.get("clubRoleTypes")) } });
});

const updateSelfSchema = z.object({
  birthDate: optDate,
  emergencyContactName: optText(200),
  emergencyContactPhone: optText(50),
  street: optText(200),
  postalCode: optText(20),
  city: optText(120),
  phone: optText(50),
  contactEmail: optEmail,
});

/** Drops keys the client did not send (undefined) so a PATCH only touches what it names. */
function definedOnly<T extends Record<string, unknown>>(body: T): Partial<T> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<T>;
}

clubMemberRoutes.patch("/me", zValidator("json", updateSelfSchema, validationHook), async (c) => {
  const membership = c.get("membership");
  const changes = definedOnly(c.req.valid("json"));

  const current = await ensureClubMember(db, membership);
  const [updated] = await db
    .update(clubMembers)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(clubMembers.id, current.id))
    .returning();

  return c.json({ data: await shapeOne(updated!, callerOf(c), true) });
});

// --- Member list / detail / create / update --------------------------------

clubMemberRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");

  // Repair accounts that joined through a path that bypassed the Better Auth hook (should not happen; cheap check).
  const missing = await db
    .select({ row: member })
    .from(member)
    .leftJoin(clubMembers, eq(clubMembers.memberId, member.id))
    .where(and(eq(member.organizationId, clubId), isNull(clubMembers.id)));
  for (const { row } of missing) {
    try {
      await ensureClubMember(db, row);
    } catch (err) {
      logger.error({ err, memberId: row.id, clubId }, "[club-members] could not repair missing club_members row");
    }
  }
  await markDetachedMembersLeft(db, clubId).catch((err) => logger.error({ err, clubId }, "[club-members] could not close detached members"));

  const rows = await db.select().from(clubMembers).where(eq(clubMembers.clubId, clubId)).orderBy(asc(clubMembers.displayName), asc(clubMembers.id));
  return c.json({ data: await shapeClubMembers(rows, callerOf(c)) });
});

const createMemberSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    firstName: optText(100),
    lastName: optText(100),
    categoryId: z.string().uuid().optional(),
    categoryKey: z.string().trim().min(1).max(50).optional(),
    // Only "live" statuses can be assigned at creation; leaving the club goes through the exit workflow.
    status: z.enum(["interessent", "probe", "aktiv", "ruhend"]).optional(),
    joinedAt: z.string().date().optional(),
    memberNumber: memberNumberText.optional(),
    birthDate: optDate,
    street: optText(200),
    postalCode: optText(20),
    city: optText(120),
    phone: optText(50),
    contactEmail: optEmail,
    emergencyContactName: optText(200),
    emergencyContactPhone: optText(50),
  })
  .refine((body) => body.categoryId !== undefined || body.categoryKey !== undefined, { message: "categoryId or categoryKey is required", path: ["categoryId"] });

clubMemberRoutes.post("/", zValidator("json", createMemberSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const { categoryId, categoryKey, memberNumber, displayName, status, joinedAt, ...rest } = c.req.valid("json");
  const category = await resolveCategory(clubId, { categoryId, categoryKey });

  const created = await db.transaction(async (tx) => {
    let number: string;
    if (memberNumber !== undefined) {
      if (await memberNumberTaken(tx, clubId, memberNumber)) throw new ConflictError("Member number is already in use");
      number = memberNumber;
    } else {
      number = await nextMemberNumber(tx, clubId);
    }

    const [row] = await tx
      .insert(clubMembers)
      .values({ ...definedOnly(rest), clubId, displayName, memberNumber: number, categoryId: category!.id, status: status ?? "aktiv", joinedAt: joinedAt ?? today() })
      .returning();

    await tx.insert(clubMemberStatusHistory).values({
      clubMemberId: row!.id,
      fromStatus: null,
      toStatus: row!.status,
      toCategoryId: category!.id,
      effectiveOn: row!.joinedAt,
      reason: "created",
      changedBy: actor.id,
    });
    await tx.insert(auditLog).values({
      eventType: "club_member.create",
      subjectId: row!.id,
      payload: { clubId, memberNumber: number, categoryId: category!.id, status: row!.status, createdBy: actor.id },
    });
    return row!;
  });

  return c.json({ data: await shapeOne(created, callerOf(c)) }, 201);
});

clubMemberRoutes.get("/:id", async (c) => {
  const row = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  return c.json({ data: await shapeOne(row, callerOf(c)) });
});

const updateMemberSchema = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  firstName: optText(100),
  lastName: optText(100),
  // `memberNumber: null` clears the number, but only when the field is explicitly present in the body.
  memberNumber: z.union([memberNumberText, z.literal("").transform(() => null), z.null()]).optional(),
  categoryId: z.string().uuid().optional(),
  // Older clients send the category key as `category`; categoryKey is the explicit alias.
  category: z.string().trim().min(1).max(50).optional(),
  categoryKey: z.string().trim().min(1).max(50).optional(),
  // Legacy field kept for existing clients. The status workflow (B5/B6) owns real exits.
  leftAt: optDate,
  birthDate: optDate,
  street: optText(200),
  postalCode: optText(20),
  city: optText(120),
  phone: optText(50),
  contactEmail: optEmail,
  emergencyContactName: optText(200),
  emergencyContactPhone: optText(50),
  // Status changes are not possible here (they need date/reason/history, see the status workflow).
  status: z.never({ error: "status cannot be changed via PATCH /club-members/:id" }).optional(),
});

clubMemberRoutes.patch("/:id", zValidator("json", updateMemberSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const target = await resolveClubMember(clubId, c.req.param("id"));
  const { categoryId, category: categoryKeyLegacy, categoryKey, ...fields } = c.req.valid("json");
  const category = await resolveCategory(clubId, { categoryId, categoryKey: categoryKey ?? categoryKeyLegacy });
  const changes = definedOnly(fields);

  const updated = await db.transaction(async (tx) => {
    if (typeof changes.memberNumber === "string" && changes.memberNumber !== target.memberNumber && (await memberNumberTaken(tx, clubId, changes.memberNumber, target.id))) {
      throw new ConflictError("Member number is already in use");
    }
    const [row] = await tx
      .update(clubMembers)
      .set({ ...changes, ...(category ? { categoryId: category.id } : {}), updatedAt: new Date() })
      .where(and(eq(clubMembers.id, target.id), eq(clubMembers.clubId, clubId)))
      .returning();

    await tx.insert(auditLog).values({
      eventType: "club_member.update",
      subjectId: target.id,
      // Field names only -- master data (address, phone, birth date) must not be copied into the audit log.
      payload: { clubId, changedFields: [...Object.keys(changes), ...(category ? ["categoryId"] : [])], changedBy: actor.id },
    });
    return row!;
  });

  return c.json({ data: await shapeOne(updated, callerOf(c)) });
});

// --- Department assignment ---------------------------------------------------

const assignDepartmentSchema = z.object({ departmentId: z.string().uuid(), since: z.string().date().optional() });

clubMemberRoutes.get("/:id/departments", async (c) => {
  const row = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  const rows = await db
    .select({ id: departments.id, name: departments.name, since: clubMemberDepartments.since, until: clubMemberDepartments.until })
    .from(clubMemberDepartments)
    .innerJoin(departments, eq(departments.id, clubMemberDepartments.departmentId))
    .where(eq(clubMemberDepartments.clubMemberId, row.id))
    .orderBy(asc(departments.name), asc(clubMemberDepartments.since));
  return c.json({ data: rows });
});

clubMemberRoutes.post("/:id/departments", zValidator("json", assignDepartmentSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const target = await resolveClubMember(clubId, c.req.param("id"));
  const body = c.req.valid("json");
  const department = await db.query.departments.findFirst({ where: and(eq(departments.id, body.departmentId), eq(departments.clubId, clubId)) });
  if (!department) throw new NotFoundError("Department not found");

  let created;
  try {
    [created] = await db
      .insert(clubMemberDepartments)
      .values({ clubMemberId: target.id, departmentId: department.id, since: body.since ?? today() })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Member is already assigned to this department");
    throw err;
  }

  await db.insert(auditLog).values({ eventType: "club_member.department_assign", subjectId: target.id, payload: { clubId, departmentId: department.id } });
  return c.json({ data: { id: department.id, name: department.name, since: created!.since, until: created!.until } }, 201);
});

// Ends the open assignment (sets `until`, default today) so the history stays; re-assigning later creates a new row.
clubMemberRoutes.delete("/:id/departments/:departmentId", async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const target = await resolveClubMember(clubId, c.req.param("id"));
  const departmentId = c.req.param("departmentId");
  if (!isUuid(departmentId)) throw new NotFoundError("Department assignment not found");
  const untilParam = c.req.query("until");
  const until = untilParam === undefined ? today() : z.string().date().safeParse(untilParam).data;
  if (until === undefined) throw new ValidationError("until must be a date (YYYY-MM-DD)");

  const [ended] = await db
    .update(clubMemberDepartments)
    .set({ until })
    .where(and(eq(clubMemberDepartments.clubMemberId, target.id), eq(clubMemberDepartments.departmentId, departmentId), isNull(clubMemberDepartments.until)))
    .returning();
  if (!ended) throw new NotFoundError("Department assignment not found");

  await db.insert(auditLog).values({ eventType: "club_member.department_remove", subjectId: target.id, payload: { clubId, departmentId, until } });
  return c.body(null, 204);
});

// --- Role assignment (needs a linked account) ----------------------------------

const assignRoleSchema = z.object({
  // `mitglied` is implicit (clubGuard) and cannot be assigned -> 422 via enum validation.
  roleType: z.enum(ASSIGNABLE_ROLE_TYPES),
  departmentId: z.string().uuid().optional(),
  termEndsAt: z.string().date().optional(),
});

clubMemberRoutes.get("/:id/roles", async (c) => {
  const row = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  const rows = await db.query.clubRoles.findMany({ where: eq(clubRoles.memberId, requireAccount(row)) });
  // `data` = stored (revocable) club_roles rows only; the implicit base role is listed separately.
  return c.json({ data: rows, implicit: [IMPLICIT_ROLE_TYPE] });
});

clubMemberRoutes.post("/:id/roles", zValidator("json", assignRoleSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "roles:write")) throw new ForbiddenError("Missing roles:write permission");

  const row = await resolveClubMember(clubId, c.req.param("id"));
  const memberId = requireAccount(row);
  const body = c.req.valid("json");

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
    payload: { clubId, clubMemberId: row.id, roleType: body.roleType, departmentId: body.departmentId },
  });

  return c.json({ data: created }, 201);
});

clubMemberRoutes.delete("/:id/roles/:roleId", async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "roles:write")) throw new ForbiddenError("Missing roles:write permission");

  const row = await resolveClubMember(clubId, c.req.param("id"));
  const memberId = requireAccount(row);
  const roleId = c.req.param("roleId");

  const existing = isUuid(roleId) ? await db.query.clubRoles.findFirst({ where: and(eq(clubRoles.id, roleId), eq(clubRoles.memberId, memberId)) }) : undefined;
  if (!existing) throw new NotFoundError("Role assignment not found");
  if (existing.roleType === IMPLICIT_ROLE_TYPE) throw new ConflictError("The implicit role mitglied cannot be revoked");

  await db.delete(clubRoles).where(eq(clubRoles.id, roleId));

  await db.insert(auditLog).values({
    eventType: "club_role.revoke",
    subjectId: memberId,
    payload: { clubId, clubMemberId: row.id, roleId, roleType: existing.roleType },
  });

  return c.body(null, 204);
});

// --- Guardian links (externe Rolle: Erziehungsberechtigte) --------------------
// Board-managed only (members:write) -- a guardian must never be able to
// self-grant visibility into an arbitrary member's data, see Data Model -
// MyVerein Backend §6. The ward is a club_members row (may have no account);
// the guardian must have an account (ADR-003).

const guardianLinkSchema = z.object({
  // A club_members.id (preferred) or, for older clients, the guardian's Better Auth member.id.
  guardianMemberId: z.string().min(1),
});

type GuardianLinkRow = typeof guardianLinks.$inferSelect;

function shapeGuardianLink(link: GuardianLinkRow, ward: ClubMemberRow, guardian: ClubMemberRow | null) {
  return {
    id: link.id,
    guardianMemberId: link.guardianMemberId,
    guardianClubMemberId: guardian?.id ?? null,
    guardianName: guardian?.displayName ?? null,
    wardClubMemberId: link.wardClubMemberId,
    // Compatibility: the ward's account id (null for members without an account).
    wardMemberId: ward.memberId,
    createdAt: link.createdAt,
  };
}

clubMemberRoutes.get("/:id/guardians", async (c) => {
  const ward = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  const caller = callerOf(c);
  const rows = await db
    .select({ link: guardianLinks, guardian: clubMembers })
    .from(guardianLinks)
    .leftJoin(clubMembers, eq(clubMembers.memberId, guardianLinks.guardianMemberId))
    .where(eq(guardianLinks.wardClubMemberId, ward.id))
    .orderBy(asc(guardianLinks.createdAt), asc(guardianLinks.id));
  // Names of a child's guardians are personal data: board with members:read_sensitive, or the guardian themself.
  const isGuardianOfWard = rows.some((r) => r.link.guardianMemberId === caller.memberId);
  if (!caller.canReadSensitive && !isGuardianOfWard) throw new ForbiddenError("Missing members:read_sensitive permission");
  return c.json({ data: rows.map((r) => shapeGuardianLink(r.link, ward, r.guardian)) });
});

clubMemberRoutes.post("/:id/guardians", zValidator("json", guardianLinkSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const ward = await resolveClubMember(clubId, c.req.param("id"));
  const guardian = await resolveClubMember(clubId, c.req.valid("json").guardianMemberId).catch(() => {
    throw new NotFoundError("Guardian member not found in this club");
  });
  const guardianAccountId = requireAccount(guardian);
  if (guardian.id === ward.id) throw new ValidationError("A member cannot be their own guardian");

  let created;
  try {
    [created] = await db.insert(guardianLinks).values({ guardianMemberId: guardianAccountId, wardClubMemberId: ward.id }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("Guardian link already exists");
    throw err;
  }

  await db.insert(auditLog).values({
    eventType: "guardian_link.create",
    subjectId: ward.id,
    payload: { clubId, guardianMemberId: guardianAccountId },
  });

  return c.json({ data: shapeGuardianLink(created!, ward, guardian) }, 201);
});

clubMemberRoutes.delete("/:id/guardians/:guardianMemberId", async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const ward = await resolveClubMember(clubId, c.req.param("id"));
  const guardian = await resolveClubMember(clubId, c.req.param("guardianMemberId")).catch(() => null);
  if (!guardian?.memberId) throw new NotFoundError("Guardian link not found");

  const [removed] = await db
    .delete(guardianLinks)
    .where(and(eq(guardianLinks.wardClubMemberId, ward.id), eq(guardianLinks.guardianMemberId, guardian.memberId)))
    .returning();
  if (!removed) throw new NotFoundError("Guardian link not found");

  await db.insert(auditLog).values({
    eventType: "guardian_link.delete",
    subjectId: ward.id,
    payload: { clubId, guardianMemberId: guardian.memberId },
  });

  return c.body(null, 204);
});
