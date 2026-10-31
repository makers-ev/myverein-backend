import { zValidator } from "@hono/zod-validator";
import { and, asc, count, eq, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { DSR_KINDS, DSR_STATUSES, dataSubjectRequests } from "../db/schema/privacy.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { isUuid } from "../lib/club-members.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { openRequest } from "../lib/privacy/requests.js";
import { loadSubject } from "../lib/privacy/subject.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Access / erasure / rectification requests of a club with their deadline (Art. 12(3) GDPR: one month). Reading needs
 * `privacy:read`, creating and closing `privacy:manage`. A request closes by itself when the export is delivered or the
 * erasure is executed; rectification and rejections are closed here by hand.
 */
export const dataSubjectRequestRoutes = new Hono<ClubEnv>();

dataSubjectRequestRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
dataSubjectRequestRoutes.use("*", sessionGuard);
dataSubjectRequestRoutes.use("*", clubGuard);

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

const listQuery = z.object({
  status: z.enum(DSR_STATUSES).optional(),
  kind: z.enum(DSR_KINDS).optional(),
  // Only requests that are open and past their deadline.
  overdue: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const DAY_MS = 86_400_000;

function shape(r: typeof dataSubjectRequests.$inferSelect, displayName: string | null, now = Date.now()) {
  const openStatus = r.status === "open" || r.status === "in_progress";
  const daysLeft = openStatus ? Math.ceil((r.dueAt.getTime() - now) / DAY_MS) : null;
  return {
    id: r.id,
    clubMemberId: r.clubMemberId,
    memberName: displayName,
    kind: r.kind,
    status: r.status,
    receivedAt: r.receivedAt,
    dueAt: r.dueAt,
    completedAt: r.completedAt,
    result: r.result,
    daysLeft,
    overdue: daysLeft !== null && daysLeft < 0,
  };
}

dataSubjectRequestRoutes.get("/", zValidator("query", listQuery, validationHook), async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "privacy:read")) throw new ForbiddenError("Missing privacy:read permission");
  const q = c.req.valid("query");
  const conditions: SQL[] = [eq(dataSubjectRequests.clubId, c.get("clubId"))];
  if (q.status) conditions.push(eq(dataSubjectRequests.status, q.status));
  if (q.kind) conditions.push(eq(dataSubjectRequests.kind, q.kind));
  if (q.overdue === "true") conditions.push(sql`${dataSubjectRequests.status} IN ('open', 'in_progress') AND ${dataSubjectRequests.dueAt} < now()`);
  const where = and(...conditions);
  const [total] = await db.select({ n: count() }).from(dataSubjectRequests).where(where);
  const rows = await db
    .select({ r: dataSubjectRequests, name: clubMembers.displayName })
    .from(dataSubjectRequests)
    .leftJoin(clubMembers, eq(clubMembers.id, dataSubjectRequests.clubMemberId))
    .where(where)
    .orderBy(asc(dataSubjectRequests.dueAt), asc(dataSubjectRequests.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  return c.json({ data: rows.map((x) => shape(x.r, x.name)), page: q.page, pageSize: q.pageSize, total: total?.n ?? 0 });
});

const createSchema = z.object({ clubMemberId: z.uuid(), kind: z.enum(DSR_KINDS) });

/** Records a request that came in by letter, mail or phone, so its deadline is tracked. */
dataSubjectRequestRoutes.post("/", zValidator("json", createSchema, validationHook), async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "privacy:manage")) throw new ForbiddenError("Missing privacy:manage permission");
  const body = c.req.valid("json");
  const { row } = await loadSubject(c.get("clubId"), body.clubMemberId);
  const { row: request, created } = await db.transaction((tx) => openRequest(tx, { clubId: c.get("clubId"), clubMemberId: row.id, kind: body.kind, requestedByUserId: c.get("user").id }));
  return c.json({ data: shape(request, row.displayName) }, created ? 201 : 200);
});

const patchSchema = z.object({
  status: z.enum(["in_progress", "done", "rejected"]),
  // Short outcome for the file (reason of a rejection, "corrected"); no personal data.
  result: cleanText(z.string().trim().min(1).max(500)).optional(),
});

dataSubjectRequestRoutes.patch("/:id", zValidator("json", patchSchema, validationHook), async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "privacy:manage")) throw new ForbiddenError("Missing privacy:manage permission");
  const id = c.req.param("id");
  if (!isUuid(id)) throw new NotFoundError("Request not found");
  const body = c.req.valid("json");
  if (body.status === "rejected" && !body.result) throw new ValidationError("A rejection needs a reason", { details: { code: "reason_required" } });
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(dataSubjectRequests).where(and(eq(dataSubjectRequests.id, id), eq(dataSubjectRequests.clubId, c.get("clubId")))).for("update");
    if (!current) throw new NotFoundError("Request not found");
    if (current.status === "done" || current.status === "rejected") throw new ValidationError("The request is already closed", { details: { code: "already_closed" } });
    const closing = body.status !== "in_progress";
    const [row] = await tx
      .update(dataSubjectRequests)
      .set({ status: body.status, handledByUserId: c.get("user").id, result: body.result ?? current.result, completedAt: closing ? new Date() : null, updatedAt: new Date() })
      .where(eq(dataSubjectRequests.id, id))
      .returning();
    await writeAudit(tx, { eventType: "data_subject_request.update", subjectId: id, payload: { clubId: c.get("clubId"), clubMemberId: current.clubMemberId, kind: current.kind, status: body.status } });
    return row!;
  });
  const [m] = updated.clubMemberId ? await db.select({ name: clubMembers.displayName }).from(clubMembers).where(eq(clubMembers.id, updated.clubMemberId)) : [];
  return c.json({ data: shape(updated, m?.name ?? null) });
});
