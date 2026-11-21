import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, max, notInArray, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubPlans, clubPlatformStatus, clubStatusHistory } from "../db/schema/club-platform.js";
import { clubRegistrations } from "../db/schema/club-registrations.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { writeAudit } from "../lib/audit.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import { registerCheckOf } from "../lib/club-platform.js";
import { COUNTED_STATUSES } from "../lib/member-lifecycle.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Club aggregates for the admin panel: total club count + open registration count (dashboard KPI / navbar badge) and
 * the clubs each of a page of users belongs to (user list column).
 */
export const adminClubRoutes = new Hono<SessionEnv>();

adminClubRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
adminClubRoutes.use("*", adminGuard);

const MAX_USER_IDS = 100;

adminClubRoutes.get("/club-stats", async (c) => {
  const [[clubRow], [pendingRow]] = await Promise.all([
    db.select({ total: count() }).from(organization),
    db.select({ pending: count() }).from(clubRegistrations).where(eq(clubRegistrations.status, "pending")),
  ]);
  return c.json({
    clubs: { total: Number(clubRow?.total ?? 0) },
    registrations: { pending: Number(pendingRow?.pending ?? 0) },
  });
});

adminClubRoutes.get("/user-clubs", async (c) => {
  const raw = c.req.query("userIds") ?? "";
  const userIds = [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id.length > 0))];

  if (userIds.length === 0) {
    throw new ValidationError("userIds must contain at least one user id");
  }
  if (userIds.length > MAX_USER_IDS) {
    throw new ValidationError(`userIds may contain at most ${MAX_USER_IDS} ids`);
  }

  const rows = await db
    .select({ userId: member.userId, clubId: organization.id, name: organization.name, slug: organization.slug })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(inArray(member.userId, userIds))
    .orderBy(asc(organization.name), asc(organization.slug));

  const data: Record<string, Array<{ clubId: string; name: string; slug: string }>> = {};
  for (const id of userIds) data[id] = [];
  for (const r of rows) {
    const list = data[r.userId];
    if (list && !list.some((club) => club.clubId === r.clubId)) {
      list.push({ clubId: r.clubId, name: r.name, slug: r.slug });
    }
  }

  return c.json({ data });
});

// --- Wave 15 B7: club list, detail, suspension and plan data ------------------------------------------------------------

const adminHook = (r: { success: boolean; error?: { issues: unknown } }) => {
  if (!r.success) throw new ValidationError("Invalid request", { details: r.error?.issues });
};

const clubListQuery = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

async function clubRows(clubIdsWanted: string[]) {
  if (clubIdsWanted.length === 0) return [];
  const [orgs, members, accounts, activity, statuses, plans, settings] = await Promise.all([
    db.select().from(organization).where(inArray(organization.id, clubIdsWanted)),
    db
      .select({ clubId: clubMembers.clubId, n: count() })
      .from(clubMembers)
      .where(and(inArray(clubMembers.clubId, clubIdsWanted), inArray(clubMembers.status, [...COUNTED_STATUSES]), or(isNull(clubMembers.leftAt), sql`${clubMembers.leftAt} > CURRENT_DATE`)))
      .groupBy(clubMembers.clubId),
    db.select({ clubId: member.organizationId, n: count() }).from(member).where(inArray(member.organizationId, clubIdsWanted)).groupBy(member.organizationId),
    db.select({ clubId: auditLog.clubId, at: max(auditLog.createdAt) }).from(auditLog).where(inArray(auditLog.clubId, clubIdsWanted)).groupBy(auditLog.clubId),
    db.select().from(clubPlatformStatus).where(inArray(clubPlatformStatus.clubId, clubIdsWanted)),
    db.select().from(clubPlans).where(inArray(clubPlans.clubId, clubIdsWanted)),
    db.select({ clubId: clubSettings.clubId, publicProfileEnabled: clubSettings.publicProfileEnabled, discoverable: clubSettings.discoverable }).from(clubSettings).where(inArray(clubSettings.clubId, clubIdsWanted)),
  ]);
  const by = <T extends { clubId: string | null }>(rows: T[]) => new Map(rows.map((r) => [r.clubId as string, r]));
  const memberBy = by(members);
  const accountBy = by(accounts);
  const activityBy = by(activity);
  const statusBy = by(statuses);
  const planBy = by(plans);
  const settingsBy = by(settings);
  const orgBy = new Map(orgs.map((o) => [o.id, o]));
  return clubIdsWanted
    .filter((id) => orgBy.has(id))
    .map((id) => {
      const org = orgBy.get(id)!;
      const plan = planBy.get(id);
      const status = statusBy.get(id);
      const memberCount = Number(memberBy.get(id)?.n ?? 0);
      return {
        clubId: id,
        name: org.name,
        slug: org.slug,
        createdAt: org.createdAt,
        memberCount,
        accountCount: Number(accountBy.get(id)?.n ?? 0),
        status: status?.suspendedAt ? ("suspended" as const) : ("active" as const),
        suspendedAt: status?.suspendedAt ?? null,
        lastActivityAt: activityBy.get(id)?.at ?? null,
        plan: plan ? { tier: plan.tier, validFrom: plan.validFrom, validUntil: plan.validUntil, memberLimit: plan.memberLimit } : null,
        overMemberLimit: plan?.memberLimit != null && memberCount > plan.memberLimit,
        publicProfileEnabled: settingsBy.get(id)?.publicProfileEnabled ?? false,
        discoverable: settingsBy.get(id)?.discoverable ?? false,
      };
    });
}

/** Club list of the platform: member count, founding date, status, last activity, plan. Counts only, no member data. */
adminClubRoutes.get("/clubs", zValidator("query", clubListQuery, adminHook), async (c) => {
  const q = c.req.valid("query");
  const escaped = q.q?.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  const suspendedIds = db.select({ id: clubPlatformStatus.clubId }).from(clubPlatformStatus).where(isNotNull(clubPlatformStatus.suspendedAt));
  const filter = and(
    escaped ? or(ilike(organization.name, `%${escaped}%`), ilike(organization.slug, `%${escaped}%`)) : undefined,
    q.status === "suspended" ? inArray(organization.id, suspendedIds) : q.status === "active" ? notInArray(organization.id, suspendedIds) : undefined,
  );
  const [total] = await db.select({ n: count() }).from(organization).where(filter);
  const page = await db
    .select({ id: organization.id })
    .from(organization)
    .where(filter)
    .orderBy(asc(organization.name), asc(organization.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: await clubRows(page.map((p) => p.id)), page: q.page, pageSize: q.pageSize, total: Number(total?.n ?? 0) });
});

async function clubDetail(clubId: string) {
  const [row] = await clubRows([clubId]);
  if (!row) throw new NotFoundError("Club not found");
  const [reg] = await db.select().from(clubRegistrations).where(eq(clubRegistrations.clubId, clubId)).orderBy(desc(clubRegistrations.createdAt)).limit(1);
  const [status] = await db.select().from(clubPlatformStatus).where(eq(clubPlatformStatus.clubId, clubId));
  const [plan] = await db.select().from(clubPlans).where(eq(clubPlans.clubId, clubId));
  const history = await db.select().from(clubStatusHistory).where(eq(clubStatusHistory.clubId, clubId)).orderBy(desc(clubStatusHistory.createdAt)).limit(50);
  const audit = await db.select({ eventType: auditLog.eventType, createdAt: auditLog.createdAt }).from(auditLog).where(eq(auditLog.clubId, clubId)).orderBy(desc(auditLog.createdAt)).limit(20);
  const userIds = [...new Set([status?.suspendedBy, ...history.map((h) => h.actorUserId)].filter((v): v is string => !!v))];
  const names = new Map((userIds.length ? await db.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds)) : []).map((u) => [u.id, u.name]));
  const actor = (id: string | null | undefined) => (id ? { userId: id, name: names.get(id) ?? "" } : null);
  return {
    ...row,
    registration: reg ? { id: reg.id, status: reg.status, legalForm: reg.legalForm, registerCourt: reg.registerCourt, registerNumber: reg.registerNumber, city: reg.city, submittedAt: reg.submittedAt, reviewedAt: reg.reviewedAt } : null,
    registerCheck: registerCheckOf(reg),
    suspension: status?.suspendedAt ? { suspendedAt: status.suspendedAt, reason: status.suspensionReason, note: status.suspensionNote, suspendedBy: actor(status.suspendedBy) } : null,
    statusHistory: history.map((h) => ({ action: h.action, reason: h.reason, note: h.note, actor: actor(h.actorUserId), createdAt: h.createdAt })),
    plan: plan ? { tier: plan.tier, validFrom: plan.validFrom, validUntil: plan.validUntil, memberLimit: plan.memberLimit, note: plan.note, updatedAt: plan.updatedAt } : null,
    auditExcerpt: audit,
  };
}

adminClubRoutes.get("/clubs/:clubId", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: await clubDetail(c.req.param("clubId")) });
});

const suspendBody = z.object({ reason: z.string().trim().min(10).max(1000), note: z.union([z.string().trim().max(500), z.null()]).optional() });
const unsuspendBody = z.object({ reason: z.string().trim().min(10).max(1000) });

async function assertClubExists(clubId: string): Promise<void> {
  const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.id, clubId));
  if (!org) throw new NotFoundError("Club not found");
}

adminClubRoutes.post("/clubs/:clubId/suspend", zValidator("json", suspendBody, adminHook), async (c) => {
  const clubId = c.req.param("clubId");
  await assertClubExists(clubId);
  const body = c.req.valid("json");
  const actorId = c.get("user").id;
  const note = body.note ? body.note : null;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`club-status:${clubId}`}, 0))`);
    const [current] = await tx.select().from(clubPlatformStatus).where(eq(clubPlatformStatus.clubId, clubId));
    if (current?.suspendedAt) throw new ConflictError("The club is already suspended", { details: { code: "club_already_suspended" } });
    const now = new Date();
    const values = { suspendedAt: now, suspendedBy: actorId, suspensionReason: body.reason, suspensionNote: note, updatedAt: now };
    await tx.insert(clubPlatformStatus).values({ clubId, ...values }).onConflictDoUpdate({ target: clubPlatformStatus.clubId, set: values });
    await tx.insert(clubStatusHistory).values({ clubId, action: "suspend", reason: body.reason, note, actorUserId: actorId });
    await writeAudit(tx, { eventType: "admin.club_suspend", subjectId: clubId, clubId, payload: { clubId, withNote: note !== null } });
  });
  return c.json({ data: await clubDetail(clubId) });
});

adminClubRoutes.post("/clubs/:clubId/unsuspend", zValidator("json", unsuspendBody, adminHook), async (c) => {
  const clubId = c.req.param("clubId");
  await assertClubExists(clubId);
  const body = c.req.valid("json");
  const actorId = c.get("user").id;
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`club-status:${clubId}`}, 0))`);
    const [current] = await tx.select().from(clubPlatformStatus).where(eq(clubPlatformStatus.clubId, clubId));
    if (!current?.suspendedAt) throw new ConflictError("The club is not suspended", { details: { code: "club_not_suspended" } });
    await tx.update(clubPlatformStatus).set({ suspendedAt: null, suspendedBy: null, suspensionReason: null, suspensionNote: null, updatedAt: new Date() }).where(eq(clubPlatformStatus.clubId, clubId));
    await tx.insert(clubStatusHistory).values({ clubId, action: "unsuspend", reason: body.reason, actorUserId: actorId });
    await writeAudit(tx, { eventType: "admin.club_unsuspend", subjectId: clubId, clubId, payload: { clubId } });
  });
  return c.json({ data: await clubDetail(clubId) });
});

const isoDay = z.union([z.iso.date(), z.null()]);
const planBody = z
  .object({
    tier: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/, { message: "tier must be 1-40 lower case letters, digits, '-' or '_'" }),
    validFrom: isoDay.optional(),
    validUntil: isoDay.optional(),
    memberLimit: z.union([z.number().int().min(1).max(1_000_000), z.null()]).optional(),
    note: z.union([z.string().trim().max(500), z.null()]).optional(),
  })
  .refine((v) => !v.validFrom || !v.validUntil || v.validUntil >= v.validFrom, { message: "validUntil must not be before validFrom", path: ["validUntil"] });

/** Plan hook (E3): data only -- nothing is billed or enforced. */
adminClubRoutes.put("/clubs/:clubId/plan", zValidator("json", planBody, adminHook), async (c) => {
  const clubId = c.req.param("clubId");
  await assertClubExists(clubId);
  const body = c.req.valid("json");
  const values = { tier: body.tier, validFrom: body.validFrom ?? null, validUntil: body.validUntil ?? null, memberLimit: body.memberLimit ?? null, note: body.note ? body.note : null, updatedBy: c.get("user").id, updatedAt: new Date() };
  await db.transaction(async (tx) => {
    await tx.insert(clubPlans).values({ clubId, ...values }).onConflictDoUpdate({ target: clubPlans.clubId, set: values });
    await writeAudit(tx, { eventType: "admin.club_plan_set", subjectId: clubId, clubId, payload: { clubId, tier: values.tier, memberLimit: values.memberLimit, validUntil: values.validUntil } });
  });
  return c.json({ data: await clubDetail(clubId) });
});

adminClubRoutes.delete("/clubs/:clubId/plan", async (c) => {
  const clubId = c.req.param("clubId");
  await assertClubExists(clubId);
  await db.transaction(async (tx) => {
    const removed = await tx.delete(clubPlans).where(eq(clubPlans.clubId, clubId)).returning({ clubId: clubPlans.clubId });
    if (removed.length > 0) await writeAudit(tx, { eventType: "admin.club_plan_clear", subjectId: clubId, clubId, payload: { clubId } });
  });
  return c.body(null, 204);
});
