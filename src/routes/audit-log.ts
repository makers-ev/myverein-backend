import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gte, like, lte, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers } from "../db/schema/club-members.js";
import { auditKindOf, READ_EVENT_PATTERN, writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { buildCsv } from "../lib/member-csv.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Access and change log of ONE club (Wave 10 B2), for `privacy:read`. Always scoped to the caller's club (`audit_log.club_id`):
 * platform events without a club (sessions, admin) are never listed here. The payloads were whitelisted when written
 * (lib/audit.ts), so ids, field names and counts only.
 */
export const auditLogRoutes = new Hono<ClubEnv>();

auditLogRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
auditLogRoutes.use("*", sessionGuard);
auditLogRoutes.use("*", clubGuard);
auditLogRoutes.use("*", async (c, next) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "privacy:read")) throw new ForbiddenError("Missing privacy:read permission");
  await next();
});

const EXPORT_MAX_ROWS = 10_000;

const dateTime = z
  .string()
  .trim()
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "must be an ISO date or date-time" });

const filterSchema = z.object({
  subjectId: z.string().trim().min(1).max(100).optional(),
  actorId: z.string().trim().min(1).max(100).optional(),
  // Exact event type, or a prefix with a trailing `*` ("club_member.*").
  type: z.string().trim().min(1).max(80).optional(),
  // Seen (read access, exports, downloads) or changed (everything else).
  kind: z.enum(["read", "change"]).optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
});

const listQuerySchema = filterSchema.extend({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

type Filters = z.infer<typeof filterSchema>;

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

/** `to` given as a plain date means "up to the end of that day". */
function upperBound(to: string): Date {
  const date = new Date(to);
  return /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(date.getTime() + 86_400_000 - 1) : date;
}

function conditionsOf(clubId: string, f: Filters, clubMemberId?: string): SQL[] {
  const conditions: SQL[] = [eq(auditLog.clubId, clubId)];
  if (clubMemberId) conditions.push(eq(auditLog.subjectMemberId, clubMemberId));
  if (f.subjectId) conditions.push(eq(auditLog.subjectId, f.subjectId));
  if (f.actorId) conditions.push(eq(auditLog.actorUserId, f.actorId));
  if (f.type) {
    if (f.type.endsWith("*")) conditions.push(like(auditLog.eventType, `${f.type.slice(0, -1).replace(/[\\%_]/g, "\\$&")}%`));
    else conditions.push(eq(auditLog.eventType, f.type));
  }
  if (f.kind) conditions.push(f.kind === "read" ? sql`${auditLog.eventType} ~ ${READ_EVENT_PATTERN}` : sql`${auditLog.eventType} !~ ${READ_EVENT_PATTERN}`);
  if (f.from) conditions.push(gte(auditLog.createdAt, new Date(f.from)));
  if (f.to) conditions.push(lte(auditLog.createdAt, upperBound(f.to)));
  return conditions;
}

const baseSelect = () =>
  db
    .select({
      id: auditLog.id,
      eventType: auditLog.eventType,
      subjectId: auditLog.subjectId,
      subjectMemberId: auditLog.subjectMemberId,
      actorUserId: auditLog.actorUserId,
      actorName: user.name,
      subjectMemberName: clubMembers.displayName,
      payload: auditLog.payload,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.actorUserId))
    .leftJoin(clubMembers, and(eq(sql`${clubMembers.id}::text`, auditLog.subjectMemberId), eq(clubMembers.clubId, auditLog.clubId)));

type Row = Awaited<ReturnType<ReturnType<typeof baseSelect>["limit"]>>[number];

const shape = (r: Row) => ({
  id: r.id,
  eventType: r.eventType,
  kind: auditKindOf(r.eventType),
  subjectId: r.subjectId,
  subjectMember: r.subjectMemberId ? { id: r.subjectMemberId, name: r.subjectMemberName } : null,
  actor: r.actorUserId ? { userId: r.actorUserId, name: r.actorName } : null,
  payload: r.payload ?? {},
  createdAt: r.createdAt.toISOString(),
});

async function page(clubId: string, f: Filters & { page: number; pageSize: number }, clubMemberId?: string) {
  const where = and(...conditionsOf(clubId, f, clubMemberId));
  const [total] = await db.select({ n: count() }).from(auditLog).where(where);
  const rows = await baseSelect()
    .where(where)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { data: rows.map(shape), page: f.page, pageSize: f.pageSize, total: total?.n ?? 0 };
}

/** `GET /audit-log?subjectId=&actorId=&type=&kind=&from=&to=&page=&pageSize=` -- newest first. */
auditLogRoutes.get("/", zValidator("query", listQuerySchema, validationHook), async (c) => c.json(await page(c.get("clubId"), c.req.valid("query"))));

const exportLimiter = rateLimit({ windowMs: 60_000, max: 10, key: (c) => `audit-export:${c.get("user")?.id ?? "anonymous"}` });

async function exportCsv(c: import("hono").Context<ClubEnv>, f: Filters) {
  const clubId = c.get("clubId");
  const rows = await baseSelect()
    .where(and(...conditionsOf(clubId, f)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(EXPORT_MAX_ROWS + 1);
  const truncated = rows.length > EXPORT_MAX_ROWS;
  const exported = truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows;
  const body = buildCsv(
    ["Zeitpunkt", "Ereignis", "Art", "Akteur", "Person", "Objekt-ID", "Details"],
    exported.map((r) => [r.createdAt.toISOString(), r.eventType, auditKindOf(r.eventType) === "read" ? "gesehen" : "geändert", r.actorName ?? r.actorUserId, r.subjectMemberName ?? r.subjectMemberId, r.subjectId, JSON.stringify(r.payload ?? {})]),
  );
  await writeAudit(db, { eventType: "audit_log.export", subjectId: clubId, payload: { clubId, rows: exported.length, filters: Object.keys(f).filter((k) => f[k as keyof Filters] !== undefined) } });
  return c.body(body, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="protokoll-${new Date().toISOString().slice(0, 10)}.csv"`,
    "Cache-Control": "private, no-store",
    ...(truncated ? { "X-Export-Truncated": "true" } : {}),
  });
}

auditLogRoutes.get("/export", exportLimiter, zValidator("query", filterSchema, validationHook), (c) => exportCsv(c, c.req.valid("query")));
auditLogRoutes.get("/export.csv", exportLimiter, zValidator("query", filterSchema, validationHook), (c) => exportCsv(c, c.req.valid("query")));

/** Member-centric view: who saw or changed the data of ONE club member (`kind=read` = seen, `kind=change` = changed). 404 for a member of another club. */
auditLogRoutes.get("/members/:clubMemberId", zValidator("query", listQuerySchema, validationHook), async (c) => {
  const clubId = c.get("clubId");
  const clubMemberId = c.req.param("clubMemberId");
  const found = z.string().uuid().safeParse(clubMemberId).success
    ? await db.query.clubMembers.findFirst({ where: and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId)), columns: { id: true, displayName: true } })
    : undefined;
  if (!found) throw new NotFoundError("Member not found");
  return c.json({ member: { id: found.id, name: found.displayName }, ...(await page(clubId, c.req.valid("query"), found.id)) });
});
