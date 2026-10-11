import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, gt, ilike, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubExitRequests } from "../db/schema/club-exit-requests.js";
import { clubApplications } from "../db/schema/club-applications.js";
import {
  clubMemberDepartments,
  clubMembers,
  clubMemberStatusHistory,
  LEFT_STATUSES,
  MEMBER_STATUSES,
  memberCategories,
  type ClubMemberRow,
  type MemberCategoryRow,
} from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { ASSIGNABLE_ROLE_TYPES, IMPLICIT_ROLE_TYPE, clubPermissionsFor, hasClubPermission } from "../lib/club-permissions.js";
import { DEFAULT_CATEGORY_KEY, type DbExecutor, ensureClubMember, ensureDefaultCategories, isUuid, markDetachedMembersLeft, memberNumberTaken, resolveClubMember } from "../lib/club-members.js";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { createInvite, previewInvite, acceptInvite, unlinkAccount } from "../lib/member-invites.js";
import { sendEmail } from "../lib/email.js";
import { APP_NAME, buildMemberInviteEmail, LOGO_CID, LOGO_PATH, SITE_URL } from "../lib/emailTemplate.js";
import { clubMemberInvites, type ClubMemberInviteRow } from "../db/schema/club-member-invites.js";
import { COUNTED_STATUSES, effectiveStatus, isLeftStatus, subtractYears, suggestCategory, todayBerlin, transitionMember, wouldCreateCycle } from "../lib/member-lifecycle.js";
import { nextMemberNumber } from "../lib/member-number.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const clubMemberRoutes = new Hono<ClubEnv>();

clubMemberRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));


const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

/**
 * Shapes club_members rows into the API response (stable contract, see README "Club members API").
 *
 * Always present: id (= club_members.id), memberId (Better Auth member.id | null), userId, hasAccount, name,
 * status, category (KEY string -- kept for older clients), categoryId, categoryName, categoryObject, joinedAt,
 * leftAt, effectiveStatus (status derived at read time: left_at <= today => ausgetreten), orgRole, roles, departments.
 * `suggestedCategory` ({id,key,name} | null, age transition proposal) only for the own row or `members:read_sensitive`,
 * because it is derived from the birth date.
 * Only for the member's own row or callers with `members:read_sensitive`: email (account e-mail), contactEmail,
 * memberNumber, birthDate, street, postalCode, city, phone, emergencyContactName/Phone.
 *
 * Batch-loads everything it needs, so the list endpoint does not run N+1 queries.
 */
async function shapeClubMembers(rows: ClubMemberRow[], caller: { memberId: string; canReadSensitive: boolean }, forceSensitive = false, today = todayBerlin()) {
  if (rows.length === 0) return [];

  const memberIds = rows.map((r) => r.memberId).filter((v): v is string => v !== null);
  const hasCategories = rows.some((r) => r.categoryId !== null);

  const [accountRows, roleRows, categoryRows, departmentRows] = await Promise.all([
    memberIds.length > 0
      ? db.select({ member, email: user.email, userName: user.name }).from(member).innerJoin(user, eq(user.id, member.userId)).where(inArray(member.id, memberIds))
      : Promise.resolve([]),
    memberIds.length > 0 ? db.select().from(clubRoles).where(inArray(clubRoles.memberId, memberIds)) : Promise.resolve([]),
    // The club's categories (a handful of rows): needed for the shape and for the age transition target.
    hasCategories ? db.select().from(memberCategories).where(eq(memberCategories.clubId, rows[0]!.clubId)) : Promise.resolve([]),
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
  const categoryByKey = new Map<string, MemberCategoryRow>(categoryRows.map((c) => [c.key, c]));
  const departmentsByMember = new Map<string, Array<{ id: string; name: string; since: string; until: string | null }>>();
  for (const d of departmentRows) {
    departmentsByMember.set(d.clubMemberId, [...(departmentsByMember.get(d.clubMemberId) ?? []), { id: d.id, name: d.name, since: d.since, until: d.until }]);
  }

  return rows.map((row) => {
    const account = row.memberId ? accountById.get(row.memberId) : undefined;
    const category = row.categoryId ? categoryById.get(row.categoryId) : undefined;
    const sensitive = forceSensitive || caller.canReadSensitive || (row.memberId !== null && row.memberId === caller.memberId);
    const suggestion = sensitive ? suggestCategory(row, categoryById, categoryByKey, today) : null;

    return {
      id: row.id,
      memberId: row.memberId,
      userId: account?.member.userId ?? null,
      hasAccount: account !== undefined,
      name: row.displayName,
      status: row.status,
      // Derived at read time (no job): a stored non-left status with left_at <= today reads as "ausgetreten".
      effectiveStatus: effectiveStatus(row, today),
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
            suggestedCategory: suggestion ? { id: suggestion.to.id, key: suggestion.to.key, name: suggestion.to.name } : null,
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

/**
 * Resolves a category reference (id or key) within the club INSIDE the caller's transaction and share-locks the row, so
 * a concurrent archive (which locks all categories of the club first) cannot slip in between check and use.
 * Unknown/archived categories are a 422. Lock order everywhere: categories -> member rows -> organization row.
 */
async function resolveCategory(tx: DbExecutor, clubId: string, ref: { categoryId?: string; categoryKey?: string }): Promise<MemberCategoryRow | undefined> {
  let row: MemberCategoryRow | undefined;
  if (ref.categoryId !== undefined) {
    [row] = await tx.select().from(memberCategories).where(and(eq(memberCategories.id, ref.categoryId), eq(memberCategories.clubId, clubId))).for("share");
  } else if (ref.categoryKey !== undefined) {
    await ensureDefaultCategories(clubId, tx);
    [row] = await tx
      .select()
      .from(memberCategories)
      .where(and(eq(memberCategories.clubId, clubId), eq(memberCategories.key, ref.categoryKey.trim().toLowerCase())))
      .for("share");
  } else {
    return undefined;
  }
  if (!row || row.archivedAt) throw new ValidationError("Unknown or archived category");
  return row;
}

/**
 * Locks ALL categories of the club in id order (category writes serialize per club; also guards cycle checks).
 * "update" is `FOR NO KEY UPDATE`, not `FOR UPDATE`: the foreign keys of club_members / club_member_status_history
 * take `FOR KEY SHARE` locks on OTHER category rows later in a member transaction (the "from" category), and a full
 * `FOR UPDATE` held here would deadlock with them. Category keys are never changed, so nothing is lost.
 */
async function lockClubCategories(tx: DbExecutor, clubId: string, mode: "update" | "share" = "update"): Promise<MemberCategoryRow[]> {
  const query = tx.select().from(memberCategories).where(eq(memberCategories.clubId, clubId)).orderBy(asc(memberCategories.id));
  return mode === "update" ? query.for("no key update") : query.for("share");
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
    if (existing) {
      // A former member (cancelled: ausgetreten) keeps the account membership row but lost access (clubGuard); they may
      // re-apply and the board decides. Excluded / deceased persons need a reopen by the board first.
      const own = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, existing.id) });
      const state = own ? effectiveStatus(own, todayBerlin()) : null;
      if (state === "ausgeschlossen" || state === "verstorben") {
        throw new ConflictError("This person was excluded from the club or is marked deceased; the member must be reopened by the board before re-joining", {
          details: { code: "member_rejoin_blocked", clubMemberId: own!.id, status: state },
        });
      }
      if (state !== "ausgetreten") throw new ConflictError("Already a member of this club");
    }

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

// --- Account linking by invitation (B4) ----------------------------------------------------
// Session-only like /apply: the invitee is not a member of the club yet. Registered before the clubGuard below. Token
// lifecycle and the checks of `accept`: README "Account linking" and lib/member-invites.ts.

const inviteSessionLimit = rateLimit({ windowMs: 60_000, max: 20, key: (c) => `invite-token:${c.get("user")?.id ?? "anonymous"}` });

clubMemberRoutes.get("/invites/preview", sessionGuard, inviteSessionLimit, zValidator("query", z.object({ token: z.string().min(16).max(200) }), validationHook), async (c) => {
  const preview = await previewInvite(c.req.valid("query").token, c.get("user").email);
  return c.json({ data: preview });
});

clubMemberRoutes.post("/invites/accept", sessionGuard, inviteSessionLimit, zValidator("json", z.object({ token: z.string().min(16).max(200) }), validationHook), async (c) => {
  const accepted = await acceptInvite(c.req.valid("json").token, { id: c.get("user").id, email: c.get("user").email, emailVerified: c.get("user").emailVerified });
  return c.json({ data: accepted });
});

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

const csv = (v: string) => {
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
};

const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().transform(csv).pipe(z.array(z.enum(MEMBER_STATUSES)).max(MEMBER_STATUSES.length).optional()).optional(),
  category: z.string().transform(csv).pipe(z.array(z.string().max(50)).max(20).optional()).optional(),
  departmentId: z.string().uuid().optional(),
  ageMin: z.coerce.number().int().min(0).max(150).optional(),
  ageMax: z.coerce.number().int().min(0).max(150).optional(),
  hasAccount: z.enum(["true", "false"]).optional(),
  sort: z.enum(["name", "joinedAt", "memberNumber"]).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Members whose effective status is probe, aktiv or ruhend (what a plain member may see of the others). */
const VISIBLE_STATUSES: readonly string[] = COUNTED_STATUSES;

function visibleStatusCondition(today: string): SQL {
  return and(inArray(clubMembers.status, [...VISIBLE_STATUSES]), or(isNull(clubMembers.leftAt), gt(clubMembers.leftAt, today)))!;
}

/** Callers who manage members (members:write) or may read sensitive data also see former members and interessenten. */
function canSeeAllMembers(c: { get(k: "clubRoleTypes"): string[] }): boolean {
  return hasClubPermission(c.get("clubRoleTypes"), "members:write") || hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive");
}

/**
 * Read gate for ONE member row (detail and its sub-resources). 404 -- never 403 -- so existence is not leaked:
 * external guests only reach their own row; callers without members:write / members:read_sensitive only reach members
 * with an effective status probe|aktiv|ruhend and their own row.
 */
function assertMemberReadable(c: { get(k: "membership"): { id: string; role: string }; get(k: "clubRoleTypes"): string[] }, row: ClubMemberRow, today = todayBerlin()): void {
  const own = row.memberId !== null && row.memberId === c.get("membership").id;
  if (own) return;
  if (c.get("membership").role === "guest") throw new NotFoundError("Member not found");
  if (!canSeeAllMembers(c) && !VISIBLE_STATUSES.includes(effectiveStatus(row, today))) throw new NotFoundError("Member not found");
}

/**
 * Natural ordering of member numbers ("DEMO-2" before "DEMO-10", zero padding ignored): text prefix, then the numeric
 * suffix (digit count without leading zeros, then digits), then the raw text. Rows without a number come last.
 */
function memberNumberOrder(order: "asc" | "desc") {
  const number = clubMembers.memberNumber;
  const dir = sql.raw(order === "desc" ? "DESC" : "ASC");
  return [
    sql`(${number} IS NULL) ASC`,
    sql`regexp_replace(${number}, '[0-9]+$', '') ${dir}`,
    sql`length(ltrim(coalesce(substring(${number} from '[0-9]+$'), ''), '0')) ${dir}`,
    sql`ltrim(coalesce(substring(${number} from '[0-9]+$'), ''), '0') ${dir}`,
    sql`${number} ${dir}`,
    asc(clubMembers.id),
  ];
}

/** Filter on the EFFECTIVE status (see member-lifecycle.ts): left_at <= today turns a live status into ausgetreten. */
function effectiveStatusCondition(status: (typeof MEMBER_STATUSES)[number], today: string): SQL {
  const left = [...LEFT_STATUSES];
  if (status === "ausgetreten") return or(eq(clubMembers.status, "ausgetreten"), and(notInArray(clubMembers.status, left), lte(clubMembers.leftAt, today)))!;
  if (isLeftStatus(status)) return eq(clubMembers.status, status);
  return and(eq(clubMembers.status, status), or(isNull(clubMembers.leftAt), gt(clubMembers.leftAt, today)))!;
}

/**
 * Member list with search, filters, sorting and paging (B9). Response `{ data, page, pageSize, total }`; without any
 * query parameter the first 50 members by name come back (clients must read `total`/page for larger clubs).
 * Free-text search covers the name; member number and e-mail (contact + account) only count for callers with
 * `members:read_sensitive` (otherwise they are ignored -- no oracle). Age filter and sorting by member number need
 * `members:read_sensitive` too (403 otherwise). Sorting is stable (secondary key `id`). Departments/roles/categories are
 * batch-loaded for the page only (no N+1).
 */
clubMemberRoutes.get("/", zValidator("query", listQuerySchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const query = c.req.valid("query");
  const caller = callerOf(c);
  const today = todayBerlin();

  // External guests (guardians etc.) never read the member list; Wave 10 brings dedicated guardian routes.
  if (c.get("membership").role === "guest") throw new ForbiddenError("External guests cannot read the member list");
  if ((query.ageMin !== undefined || query.ageMax !== undefined) && !caller.canReadSensitive) throw new ForbiddenError("Missing members:read_sensitive permission for the age filter");
  if (query.sort === "memberNumber" && !caller.canReadSensitive) throw new ForbiddenError("Missing members:read_sensitive permission to sort by member number");
  if (query.ageMin !== undefined && query.ageMax !== undefined && query.ageMin > query.ageMax) throw new ValidationError("ageMin must not exceed ageMax");

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

  const conditions: Array<SQL | undefined> = [eq(clubMembers.clubId, clubId)];
  // Former members (and interessenten) are only visible to callers who manage members; everyone else sees members with
  // an effective status probe|aktiv|ruhend plus their own row. Status filters narrow this set, they cannot widen it.
  if (!canSeeAllMembers(c)) conditions.push(or(visibleStatusCondition(today), eq(clubMembers.memberId, caller.memberId)));
  if (query.q) {
    const pattern = `%${query.q.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push(
      caller.canReadSensitive
        ? or(ilike(clubMembers.displayName, pattern), ilike(clubMembers.memberNumber, pattern), ilike(clubMembers.contactEmail, pattern), ilike(user.email, pattern))
        : ilike(clubMembers.displayName, pattern),
    );
  }
  if (query.status && query.status.length > 0) conditions.push(or(...query.status.map((st) => effectiveStatusCondition(st, today))));
  if (query.category && query.category.length > 0) {
    conditions.push(
      inArray(
        clubMembers.categoryId,
        db
          .select({ id: memberCategories.id })
          .from(memberCategories)
          .where(and(eq(memberCategories.clubId, clubId), inArray(memberCategories.key, query.category.map((k) => k.toLowerCase())))),
      ),
    );
  }
  if (query.departmentId) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM club_member_departments d WHERE d.club_member_id = ${clubMembers.id} AND d.department_id = ${query.departmentId} AND (d.until IS NULL OR d.until > ${today}))`,
    );
  }
  if (query.hasAccount) conditions.push(query.hasAccount === "true" ? isNotNull(clubMembers.memberId) : isNull(clubMembers.memberId));
  // age >= ageMin  <=>  born on or before today - ageMin years;  age <= ageMax  <=>  born after today - (ageMax + 1) years
  if (query.ageMin !== undefined) conditions.push(lte(clubMembers.birthDate, subtractYears(today, query.ageMin)));
  if (query.ageMax !== undefined) conditions.push(gt(clubMembers.birthDate, subtractYears(today, query.ageMax + 1)));

  const where = and(...conditions);
  const dir = query.order === "desc" ? desc : asc;
  const nameKey = sql`lower(${clubMembers.displayName})`;
  const orderBy =
    query.sort === "joinedAt"
      ? [dir(clubMembers.joinedAt), asc(nameKey), asc(clubMembers.id)]
      : query.sort === "memberNumber"
        ? memberNumberOrder(query.order)
        : [dir(nameKey), asc(clubMembers.id)];

  const base = () => db.select({ row: clubMembers }).from(clubMembers).leftJoin(member, eq(member.id, clubMembers.memberId)).leftJoin(user, eq(user.id, member.userId));
  const [totalRow] = await db
    .select({ n: count() })
    .from(clubMembers)
    .leftJoin(member, eq(member.id, clubMembers.memberId))
    .leftJoin(user, eq(user.id, member.userId))
    .where(where);
  const pageRows = await base()
    .where(where)
    .orderBy(...orderBy)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  const data = await shapeClubMembers(pageRows.map((r) => r.row), caller, false, today);
  return c.json({ data, page: query.page, pageSize: query.pageSize, total: totalRow?.n ?? 0 });
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

  const created = await db.transaction(async (tx) => {
    const category = await resolveCategory(tx, clubId, { categoryId, categoryKey });
    let number: string;
    if (memberNumber !== undefined) {
      if (await memberNumberTaken(tx, clubId, memberNumber)) throw new ConflictError("Member number is already in use");
      number = memberNumber;
    } else {
      number = await nextMemberNumber(tx, clubId);
    }

    const [row] = await tx
      .insert(clubMembers)
      .values({ ...definedOnly(rest), clubId, displayName, memberNumber: number, categoryId: category!.id, status: status ?? "aktiv", joinedAt: joinedAt ?? todayBerlin() })
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

// --- Member categories (B5) -------------------------------------------------------
// Registered BEFORE `/:id` so the static segments are not swallowed by the member-id routes.

type CategoryRow = MemberCategoryRow;

function shapeCategory(row: CategoryRow, memberCount?: number) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    votingRight: row.votingRight,
    minAge: row.minAge,
    maxAge: row.maxAge,
    autoTransitionToKey: row.autoTransitionToKey,
    sortOrder: row.sortOrder,
    archived: row.archivedAt !== null,
    archivedAt: row.archivedAt,
    ...(memberCount !== undefined ? { memberCount } : {}),
  };
}

/** Members that still belong to the club (effective status not left), per category id. */
async function activeMemberCounts(clubId: string, today: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ categoryId: clubMembers.categoryId, n: count() })
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, clubId), notInArray(clubMembers.status, [...LEFT_STATUSES]), or(isNull(clubMembers.leftAt), gt(clubMembers.leftAt, today))))
    .groupBy(clubMembers.categoryId);
  return new Map(rows.filter((r) => r.categoryId !== null).map((r) => [r.categoryId!, r.n]));
}

const ageField = z.number().int().min(0).max(120).nullable().optional();
const categoryKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,49}$/, { message: "key must be 1-50 characters of a-z, 0-9, _ or - and start with a letter or digit" });

/** Category keys are lower case: "Aktiv" and " aktiv " name the same target as "aktiv". */
const autoTransitionKeySchema = z.string().trim().toLowerCase().min(1).max(50);

const createCategorySchema = z.object({
  key: categoryKeySchema.optional(),
  name: z.string().trim().min(1).max(100),
  votingRight: z.boolean().optional(),
  minAge: ageField,
  maxAge: ageField,
  autoTransitionToKey: autoTransitionKeySchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const updateCategorySchema = z.object({
  // The key is the stable identifier (older clients, imports, auto transitions refer to it): immutable after creation.
  key: z.never({ error: "key cannot be changed after creation" }).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  votingRight: z.boolean().optional(),
  minAge: ageField,
  maxAge: ageField,
  autoTransitionToKey: autoTransitionKeySchema.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

/** Derives a category key from a name: lower case ASCII, umlauts transliterated, other characters become "-". */
function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

/**
 * Age range + auto transition rules of a category (the resulting state, so a PATCH is validated as a whole).
 * `all` = the club's categories, already locked by the caller (so two parallel PATCHes cannot jointly create a cycle).
 */
function validateCategoryRules(
  all: readonly MemberCategoryRow[],
  state: { key: string; minAge: number | null; maxAge: number | null; autoTransitionToKey: string | null },
): void {
  if (state.minAge !== null && state.maxAge !== null && state.minAge > state.maxAge) throw new ValidationError("minAge must not exceed maxAge");
  if (state.autoTransitionToKey === null) return;
  if (state.maxAge === null) throw new ValidationError("autoTransitionToKey requires maxAge");
  const target = state.autoTransitionToKey.trim().toLowerCase();
  if (target === state.key) throw new ValidationError("autoTransitionToKey must point to another category");
  const targetRow = all.find((c) => c.key === target);
  if (!targetRow || targetRow.archivedAt) throw new ValidationError("autoTransitionToKey must name an existing, non-archived category of this club");
  if (wouldCreateCycle(all, state.key, target)) throw new ValidationError("autoTransitionToKey would create a cycle between categories");
}

clubMemberRoutes.get("/categories", async (c) => {
  const clubId = c.get("clubId");
  const canWrite = hasClubPermission(c.get("clubRoleTypes"), "members:write");
  const includeArchived = c.req.query("includeArchived") === "true";
  if (includeArchived && !canWrite) throw new ForbiddenError("Missing members:write permission");
  await ensureDefaultCategories(clubId);
  const rows = await db
    .select()
    .from(memberCategories)
    .where(and(eq(memberCategories.clubId, clubId), includeArchived ? undefined : isNull(memberCategories.archivedAt)))
    .orderBy(asc(memberCategories.sortOrder), asc(memberCategories.name), asc(memberCategories.id));
  const counts = await activeMemberCounts(clubId, todayBerlin());
  return c.json({ data: rows.map((r) => shapeCategory(r, counts.get(r.id) ?? 0)) });
});

clubMemberRoutes.post("/categories", zValidator("json", createCategorySchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  const body = c.req.valid("json");

  const key = body.key ?? keyFromName(body.name);
  if (!categoryKeySchema.safeParse(key).success) throw new ValidationError("Could not derive a valid key from the name; send an explicit key");
  const rules = { key, minAge: body.minAge ?? null, maxAge: body.maxAge ?? null, autoTransitionToKey: body.autoTransitionToKey ?? null };

  let created: CategoryRow;
  try {
    created = await db.transaction(async (tx) => {
      await ensureDefaultCategories(clubId, tx);
      validateCategoryRules(await lockClubCategories(tx, clubId), rules);
      const [last] = await tx.select({ n: sql<number>`coalesce(max(${memberCategories.sortOrder}), -1)` }).from(memberCategories).where(eq(memberCategories.clubId, clubId));
      const [row] = await tx
        .insert(memberCategories)
        .values({ clubId, name: body.name, votingRight: body.votingRight ?? true, ...rules, sortOrder: body.sortOrder ?? Number(last?.n ?? -1) + 1 })
        .returning();
      await tx.insert(auditLog).values({ eventType: "member_category.create", subjectId: row!.id, payload: { clubId, key, createdBy: actor.id } });
      return row!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("A category with this key already exists (archived categories keep their key)");
    throw err;
  }
  return c.json({ data: shapeCategory(created, 0) }, 201);
});

clubMemberRoutes.patch("/categories/:id", zValidator("json", updateCategorySchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const idParam = c.req.param("id");
  const { key: _ignored, ...body } = c.req.valid("json");
  void _ignored;
  const changes = definedOnly(body);

  const updated = await db.transaction(async (tx) => {
    const all = await lockClubCategories(tx, clubId);
    const current = isUuid(idParam) ? all.find((cat) => cat.id === idParam) : undefined;
    if (!current) throw new NotFoundError("Category not found");
    const next = {
      key: current.key,
      minAge: changes.minAge === undefined ? current.minAge : changes.minAge,
      maxAge: changes.maxAge === undefined ? current.maxAge : changes.maxAge,
      autoTransitionToKey: changes.autoTransitionToKey === undefined ? current.autoTransitionToKey : changes.autoTransitionToKey,
    };
    if (current.archivedAt && changes.autoTransitionToKey) throw new ConflictError("Category is archived");
    if (!current.archivedAt) validateCategoryRules(all, next);

    const [row] = await tx.update(memberCategories).set(changes).where(and(eq(memberCategories.id, current.id), eq(memberCategories.clubId, clubId))).returning();
    await tx.insert(auditLog).values({ eventType: "member_category.update", subjectId: current.id, payload: { clubId, changedFields: Object.keys(changes), changedBy: actor.id } });
    return row!;
  });
  const counts = await activeMemberCounts(clubId, todayBerlin());
  return c.json({ data: shapeCategory(updated, counts.get(updated.id) ?? 0) });
});

/**
 * "Delete" = archive (history and references keep working). Members that still belong to the club must be moved:
 * `?moveTo=<categoryId>` is mandatory when there are any (409 with the count otherwise). The default category `aktiv`
 * (fallback for every new member) cannot be archived.
 */
clubMemberRoutes.delete("/categories/:id", async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const idParam = c.req.param("id");
  const moveToParam = c.req.query("moveTo");
  const today = todayBerlin();

  const result = await db.transaction(async (tx) => {
    // Lock order: all categories of the club (id order) -> affected member rows (id order).
    const all = await lockClubCategories(tx, clubId);
    const locked = isUuid(idParam) ? all.find((cat) => cat.id === idParam) : undefined;
    if (!locked) throw new NotFoundError("Category not found");
    if (locked.archivedAt) throw new ConflictError("Category is already archived");
    if (locked.key === DEFAULT_CATEGORY_KEY) throw new ConflictError(`The default category "${DEFAULT_CATEGORY_KEY}" cannot be archived`);

    const active = await tx
      .select()
      .from(clubMembers)
      .where(and(eq(clubMembers.clubId, clubId), eq(clubMembers.categoryId, locked.id), notInArray(clubMembers.status, [...LEFT_STATUSES]), or(isNull(clubMembers.leftAt), gt(clubMembers.leftAt, today))))
      .orderBy(asc(clubMembers.id))
      .for("update");

    if (active.length > 0) {
      if (!moveToParam) throw new ConflictError("Category still has members; pass moveTo=<categoryId> to move them", { details: { memberCount: active.length } });
      const target = isUuid(moveToParam) ? all.find((cat) => cat.id === moveToParam) : undefined;
      if (!target || target.archivedAt || target.id === locked.id) throw new ValidationError("moveTo must be another, non-archived category of this club");
      await tx.update(clubMembers).set({ categoryId: target.id, updatedAt: new Date() }).where(inArray(clubMembers.id, active.map((m) => m.id)));
      await tx.insert(clubMemberStatusHistory).values(
        active.map((m) => ({ clubMemberId: m.id, fromStatus: m.status, toStatus: m.status, fromCategoryId: locked.id, toCategoryId: target.id, effectiveOn: today, reason: "Kategorie archiviert", changedBy: actor.id })),
      );
    }

    // Other categories must not keep pointing at an archived one.
    const cleared = await tx
      .update(memberCategories)
      .set({ autoTransitionToKey: null })
      .where(and(eq(memberCategories.clubId, clubId), eq(memberCategories.autoTransitionToKey, locked.key)))
      .returning({ id: memberCategories.id });
    const [archived] = await tx.update(memberCategories).set({ archivedAt: new Date() }).where(eq(memberCategories.id, locked.id)).returning();
    await tx.insert(auditLog).values({
      eventType: "member_category.archive",
      subjectId: locked.id,
      payload: { clubId, key: locked.key, movedMembers: active.length, movedTo: active.length > 0 ? moveToParam : null, clearedAutoTransitions: cleared.length, changedBy: actor.id },
    });
    return { archived: archived!, moved: active.length, cleared: cleared.length };
  });

  return c.json({ data: { ...shapeCategory(result.archived), movedMembers: result.moved, clearedAutoTransitions: result.cleared } });
});

// --- Age transition suggestions (B5) -------------------------------------------------
// Derived at read time; nothing is changed until the board applies them (scheduler: Wave 9).

/**
 * Suggestions for the club. With `onlyIds` (apply) the rows are locked: categories first (share, id order), then the
 * member rows (update, id order) -- the same order as archiving, so the two cannot deadlock.
 */
async function loadSuggestions(tx: DbExecutor, clubId: string, today: string, onlyIds?: string[]) {
  const categories = onlyIds ? await lockClubCategories(tx, clubId, "share") : await tx.select().from(memberCategories).where(eq(memberCategories.clubId, clubId));
  const byId = new Map(categories.map((cat) => [cat.id, cat]));
  const byKey = new Map(categories.map((cat) => [cat.key, cat]));
  const sourceIds = categories.filter((cat) => cat.autoTransitionToKey && cat.maxAge !== null && !cat.archivedAt).map((cat) => cat.id);
  if (sourceIds.length === 0) return { rows: [] as ClubMemberRow[], suggestions: new Map<string, ReturnType<typeof suggestCategory>>() };
  const base = tx
    .select()
    .from(clubMembers)
    .where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.categoryId, sourceIds), isNotNull(clubMembers.birthDate), onlyIds ? inArray(clubMembers.id, onlyIds) : undefined));
  const rows = await (onlyIds ? base.orderBy(asc(clubMembers.id)).for("update") : base);
  const suggestions = new Map(rows.map((row) => [row.id, suggestCategory(row, byId, byKey, today)]));
  return { rows, suggestions };
}

// Suggestions are derived from birth dates: reading them needs members:read_sensitive on top of members:write.
// (Applying only needs members:write -- the suggestions are recomputed on the locked rows there.)
clubMemberRoutes.get("/transition-suggestions", async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive")) throw new ForbiddenError("Missing members:read_sensitive permission");
  const { rows, suggestions } = await loadSuggestions(db, clubId, todayBerlin());
  const data = rows
    .flatMap((row) => {
      const s = suggestions.get(row.id);
      return s ? [{ id: row.id, name: row.displayName, category: { id: s.from.id, key: s.from.key, name: s.from.name }, suggestedCategory: { id: s.to.id, key: s.to.key, name: s.to.name } }] : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return c.json({ data });
});

const applySuggestionsSchema = z.object({ memberIds: z.array(z.string().uuid()).min(1).max(500) });

clubMemberRoutes.post("/transition-suggestions/apply", zValidator("json", applySuggestionsSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  const ids = [...new Set(c.req.valid("json").memberIds)];
  const today = todayBerlin();

  const result = await db.transaction(async (tx) => {
    // Suggestions are recomputed on the locked rows: a stale client list can't move someone who no longer qualifies.
    const { rows, suggestions } = await loadSuggestions(tx, clubId, today, ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const applied: Array<{ id: string; fromCategoryId: string; toCategoryId: string }> = [];
    const skipped: Array<{ id: string; reason: "no_suggestion" }> = [];
    for (const id of ids) {
      const row = byId.get(id);
      const s = row ? suggestions.get(id) : null;
      if (!row || !s) {
        skipped.push({ id, reason: "no_suggestion" });
        continue;
      }
      await tx.update(clubMembers).set({ categoryId: s.to.id, updatedAt: new Date() }).where(eq(clubMembers.id, row.id));
      await tx.insert(clubMemberStatusHistory).values({
        clubMemberId: row.id,
        fromStatus: row.status,
        toStatus: row.status,
        fromCategoryId: s.from.id,
        toCategoryId: s.to.id,
        effectiveOn: today,
        reason: "Altersübergang",
        changedBy: actor.id,
      });
      applied.push({ id: row.id, fromCategoryId: s.from.id, toCategoryId: s.to.id });
    }
    if (applied.length > 0) {
      await tx.insert(auditLog).values({ eventType: "club_member.age_transition", subjectId: clubId, payload: { clubId, count: applied.length, memberIds: applied.map((a) => a.id), changedBy: actor.id } });
    }
    return { applied, skipped };
  });
  return c.json({ data: result });
});

// --- Status / category transition (B5) ----------------------------------------------------

const transitionSchema = z
  .object({
    toStatus: z.enum(MEMBER_STATUSES).optional(),
    categoryId: z.string().uuid().optional(),
    categoryKey: z.string().trim().min(1).max(50).optional(),
    effectiveOn: z.string().date().optional(),
    reason: z.string().trim().max(1000).nullable().optional(),
    reopen: z.boolean().optional(),
  })
  .refine((b) => b.toStatus !== undefined || b.categoryId !== undefined || b.categoryKey !== undefined, { message: "toStatus or categoryId/categoryKey is required", path: ["toStatus"] });

clubMemberRoutes.post("/:id/transition", zValidator("json", transitionSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const target = await resolveClubMember(clubId, c.req.param("id"));
  const body = c.req.valid("json");
  const today = todayBerlin();

  const result = await db.transaction(async (tx) => {
    // Category first (share lock), then the member row inside transitionMember: same order as archiving.
    const category = await resolveCategory(tx, clubId, { categoryId: body.categoryId, categoryKey: body.categoryKey });
    const done = await transitionMember(tx, clubId, target.id, { toStatus: body.toStatus, category, effectiveOn: body.effectiveOn, reason: body.reason, reopen: body.reopen }, actor.id, today);
    // A direct exit makes open exit requests of the member obsolete: close them instead of leaving them dangling.
    if (body.toStatus !== undefined && isLeftStatus(body.toStatus) && done.kind !== "cancel_exit") {
      await tx
        .update(clubExitRequests)
        .set({ status: "rejected", decidedBy: actor.id, decidedAt: new Date(), decisionNote: "Ersetzt durch direkte Statusänderung" })
        .where(and(eq(clubExitRequests.clubMemberId, target.id), eq(clubExitRequests.status, "pending")));
    }
    await tx.insert(auditLog).values({
      eventType: "club_member.transition",
      subjectId: target.id,
      // Status/category ids and dates only; the free-text reason stays in club_member_status_history.
      payload: { clubId, kind: done.kind, fromStatus: done.fromStatus, toStatus: done.toStatus, fromCategoryId: done.fromCategoryId, toCategoryId: done.toCategoryId, effectiveOn: done.effectiveOn, changedBy: actor.id },
    });
    return done;
  });

  return c.json({
    data: await shapeOne(result.row, callerOf(c)),
    transition: { kind: result.kind, fromStatus: result.fromStatus, toStatus: result.toStatus, fromCategoryId: result.fromCategoryId, toCategoryId: result.toCategoryId, effectiveOn: result.effectiveOn },
  });
});

// Status/category history of one member (exit reasons are personal data: board with members:read_sensitive only).
clubMemberRoutes.get("/:id/history", async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive")) throw new ForbiddenError("Missing members:read_sensitive permission");
  const row = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  const rows = await db
    .select()
    .from(clubMemberStatusHistory)
    .where(eq(clubMemberStatusHistory.clubMemberId, row.id))
    .orderBy(desc(clubMemberStatusHistory.createdAt), desc(clubMemberStatusHistory.id));
  return c.json({
    data: rows.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      fromCategoryId: h.fromCategoryId,
      toCategoryId: h.toCategoryId,
      effectiveOn: h.effectiveOn,
      reason: h.reason,
      changedBy: h.changedBy,
      createdAt: h.createdAt,
    })),
  });
});

clubMemberRoutes.get("/:id", async (c) => {
  const row = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  assertMemberReadable(c, row);
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
  // Exits are dated and logged by the status workflow: POST /club-members/:id/transition (or the exit-request routes).
  leftAt: z.never({ error: "leftAt cannot be changed via PATCH /club-members/:id; use POST /club-members/:id/transition" }).optional(),
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

  const resolved = await resolveClubMember(clubId, c.req.param("id"));
  const { categoryId, category: categoryKeyLegacy, categoryKey, ...fields } = c.req.valid("json");
  const changes = definedOnly(fields);

  const updated = await db.transaction(async (tx) => {
    // Lock order: category (share) -> member row (update) -> organization row (member number check).
    const category = await resolveCategory(tx, clubId, { categoryId, categoryKey: categoryKey ?? categoryKeyLegacy });
    // History "from" must come from the LOCKED row, not from a read taken before a concurrent change.
    const [target] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, resolved.id), eq(clubMembers.clubId, clubId))).for("update");
    if (!target) throw new NotFoundError("Member not found");
    if (typeof changes.memberNumber === "string" && changes.memberNumber !== target.memberNumber && (await memberNumberTaken(tx, clubId, changes.memberNumber, target.id))) {
      throw new ConflictError("Member number is already in use");
    }
    const [row] = await tx
      .update(clubMembers)
      .set({ ...changes, ...(category ? { categoryId: category.id } : {}), updatedAt: new Date() })
      .where(and(eq(clubMembers.id, target.id), eq(clubMembers.clubId, clubId)))
      .returning();

    if (category && category.id !== target.categoryId) {
      await tx.insert(clubMemberStatusHistory).values({
        clubMemberId: target.id,
        fromStatus: target.status,
        toStatus: target.status,
        fromCategoryId: target.categoryId,
        toCategoryId: category.id,
        effectiveOn: todayBerlin(),
        changedBy: actor.id,
      });
    }
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
  assertMemberReadable(c, row);
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
      .values({ clubMemberId: target.id, departmentId: department.id, since: body.since ?? todayBerlin() })
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
  const until = untilParam === undefined ? todayBerlin() : z.string().date().safeParse(untilParam).data;
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
  assertMemberReadable(c, row);
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

// --- Invite / unlink an account (B4, board: members:write) --------------------------------

const inviteLimitPerUser = rateLimit({ windowMs: 3_600_000, max: 20, key: (c) => `invite-create:${c.get("user")?.id ?? "anonymous"}` });
const inviteSchema = z.object({ email: z.string().trim().toLowerCase().max(320).email() });

function shapeInvite(invite: ClubMemberInviteRow) {
  const status = invite.acceptedAt ? "accepted" : invite.expiresAt.getTime() <= Date.now() ? "expired" : "pending";
  return { id: invite.id, clubMemberId: invite.clubMemberId, email: invite.email, status, expiresAt: invite.expiresAt, acceptedAt: invite.acceptedAt, createdAt: invite.createdAt };
}

clubMemberRoutes.post("/:id/invite", inviteLimitPerUser, zValidator("json", inviteSchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const actor = c.get("membership");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");

  const target = await resolveClubMember(clubId, c.req.param("id"));
  const { email } = c.req.valid("json");
  if (target.memberId) throw new ConflictError("Member already has an account");

  const { invite, token } = await createInvite(clubId, target.id, email, actor.id);

  // Mail problems never block the invite (the board sees emailSent=false and can resend); the address is not logged.
  let emailSent = false;
  try {
    const club = await db.query.organization.findFirst({ where: eq(organization.id, clubId) });
    const clubName = club?.name ?? "deinem Verein";
    await sendEmail({
      to: email,
      subject: `Einladung von ${clubName.replace(/[\r\n]+/g, " ")} zu ${APP_NAME}`,
      html: buildMemberInviteEmail({
        name: target.displayName,
        clubName,
        url: `${SITE_URL}/einladung?token=${encodeURIComponent(token)}`,
        expiresOn: invite.expiresAt.toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }),
      }),
      attachments: [{ filename: "logo.png", path: LOGO_PATH, cid: LOGO_CID }],
    });
    emailSent = true;
  } catch (err) {
    logger.error({ errorName: err instanceof Error ? err.name : "unknown", clubMemberId: target.id, inviteId: invite.id }, "[club-members] invite e-mail could not be sent");
  }

  return c.json({ data: { ...shapeInvite(invite), emailSent } }, 201);
});

// Current open invite of a member (null = none). Status: pending | expired.
clubMemberRoutes.get("/:id/invite", async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  const target = await resolveClubMember(c.get("clubId"), c.req.param("id"));
  const invite = await db.query.clubMemberInvites.findFirst({
    where: and(eq(clubMemberInvites.clubMemberId, target.id), isNull(clubMemberInvites.acceptedAt)),
    orderBy: (t, { desc: latest }) => [latest(t.createdAt)],
  });
  return c.json({ data: invite && !target.memberId ? shapeInvite(invite) : null });
});

clubMemberRoutes.delete("/:id/invite", async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  const target = await resolveClubMember(clubId, c.req.param("id"));
  const removed = await db.delete(clubMemberInvites).where(and(eq(clubMemberInvites.clubMemberId, target.id), isNull(clubMemberInvites.acceptedAt))).returning({ id: clubMemberInvites.id });
  if (removed.length === 0) throw new NotFoundError("No open invitation");
  await db.insert(auditLog).values({ eventType: "club_member.invite_revoke", subjectId: target.id, payload: { clubId, revokedBy: c.get("membership").id } });
  return c.body(null, 204);
});

clubMemberRoutes.post("/:id/unlink", zValidator("json", z.object({ force: z.boolean().optional() }), validationHook), async (c) => {
  const clubId = c.get("clubId");
  if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  const target = await resolveClubMember(clubId, c.req.param("id"));
  const row = await unlinkAccount(clubId, target.id, c.get("membership").id, c.req.valid("json").force === true, c.get("clubRoleTypes"));
  return c.json({ data: await shapeOne(row, callerOf(c)) });
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
  assertMemberReadable(c, ward);
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
