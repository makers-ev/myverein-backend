import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { departments } from "../db/schema/departments.js";
import { writeAudit } from "../lib/audit.js";
import { entriesOfMember, reportByEvent, reportByMember, withRate, type ReportScope } from "../lib/attendance-report.js";
import { addDays } from "../lib/absences.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { hasClubWidePermission, ownDepartmentIds } from "../lib/event-access.js";
import { liveLinkOf } from "../lib/guardian-scope.js";
import { buildCsv } from "../lib/member-csv.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Attendance report (Wave 12 B12). `attendance:read` for groups (board: whole club; trainer / abteilungsleitung: only events of
 * their own departments), a member always reads their OWN quota, a guardian the quota of a ward. CSV export audited.
 */
export const attendanceReportRoutes = new Hono<ClubEnv>();

attendanceReportRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
attendanceReportRoutes.use("*", sessionGuard);
attendanceReportRoutes.use("*", clubGuard);

const MAX_RANGE_DAYS = 366;
const day = z.iso.date();
const querySchema = z.object({ memberId: z.uuid().optional(), departmentId: z.uuid().optional(), from: day.optional(), to: day.optional() });
const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid query", { details: result.error?.issues });
};

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

interface Resolved {
  scope: ReportScope;
  mode: "member" | "group";
  member?: { id: string; displayName: string };
  rosterDepartmentIds: string[];
}

async function resolve(c: Context<ClubEnv>, q: z.infer<typeof querySchema>): Promise<Resolved> {
  const clubId = c.get("clubId");
  const roles = c.get("clubRoleTypes");
  const membership = c.get("membership");
  const to = q.to ?? todayBerlin();
  const from = q.from ?? addDays(to, -89);
  if (to < from) throw new ValidationError("`to` must not be before `from`");
  if (daysBetween(from, to) >= MAX_RANGE_DAYS) throw new ValidationError(`The range covers at most ${MAX_RANGE_DAYS} days`);

  const mayReadGroups = hasClubPermission(roles, "attendance:read");
  const wide = hasClubWidePermission(roles, "attendance:read");
  const [own] = await db.select({ id: clubMembers.id }).from(clubMembers).where(and(eq(clubMembers.memberId, membership.id), eq(clubMembers.clubId, clubId)));

  if (q.memberId) {
    const [target] = await db.select({ id: clubMembers.id, displayName: clubMembers.displayName }).from(clubMembers).where(and(eq(clubMembers.id, q.memberId), eq(clubMembers.clubId, clubId)));
    if (!target) throw new NotFoundError("Member not found");
    // Own quota, or the quota of a ward with a live guardian link: all events of the person.
    if (own?.id === target.id || (await liveLinkOf(membership.id, target.id))) return { scope: { departmentIds: null, from, to }, mode: "member", member: target, rosterDepartmentIds: [] };
    if (!mayReadGroups) throw new ForbiddenError("Missing attendance:read permission");
    if (wide) return { scope: { departmentIds: q.departmentId ? [q.departmentId] : null, from, to }, mode: "member", member: target, rosterDepartmentIds: [] };
    const mine = await ownDepartmentIds(membership.id, roles);
    if (q.departmentId && !mine.includes(q.departmentId)) throw new ForbiddenError("Not your department");
    return { scope: { departmentIds: q.departmentId ? [q.departmentId] : mine, from, to }, mode: "member", member: target, rosterDepartmentIds: [] };
  }

  if (!mayReadGroups) throw new ForbiddenError("Missing attendance:read permission");
  if (wide) {
    if (q.departmentId) {
      const [dept] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, q.departmentId), eq(departments.clubId, clubId)));
      if (!dept) throw new NotFoundError("Department not found");
    }
    return { scope: { departmentIds: q.departmentId ? [q.departmentId] : null, from, to }, mode: "group", rosterDepartmentIds: q.departmentId ? [q.departmentId] : [] };
  }
  const mine = await ownDepartmentIds(membership.id, roles);
  if (q.departmentId && !mine.includes(q.departmentId)) throw new ForbiddenError("Not your department");
  const departmentIds = q.departmentId ? [q.departmentId] : mine;
  return { scope: { departmentIds, from, to }, mode: "group", rosterDepartmentIds: departmentIds };
}

async function build(c: Context<ClubEnv>, r: Resolved) {
  const clubId = c.get("clubId");
  if (r.mode === "member") {
    const entries = await entriesOfMember(clubId, r.member!.id, r.scope);
    const counts = { present: 0, excused: 0, unexcused: 0 };
    for (const e of entries) {
      if (e.status === "anwesend") counts.present += 1;
      else if (e.status === "entschuldigt") counts.excused += 1;
      else if (e.status === "unentschuldigt") counts.unexcused += 1;
    }
    return { member: { clubMemberId: r.member!.id, displayName: r.member!.displayName, ...withRate(counts) }, entries, members: [], events: [] };
  }
  const [members, byEvent] = await Promise.all([reportByMember(clubId, r.scope, r.rosterDepartmentIds), reportByEvent(clubId, r.scope)]);
  return { member: null, entries: [], members, events: byEvent };
}

attendanceReportRoutes.get("/report", zValidator("query", querySchema, hook), async (c) => {
  const resolved = await resolve(c, c.req.valid("query"));
  const body = await build(c, resolved);
  return c.json({ data: { range: { from: resolved.scope.from, to: resolved.scope.to }, scope: resolved.mode, departmentIds: resolved.scope.departmentIds, ...body } });
});

attendanceReportRoutes.get("/report.csv", zValidator("query", querySchema, hook), async (c) => {
  const resolved = await resolve(c, c.req.valid("query"));
  const body = await build(c, resolved);
  const pct = (rate: number | null) => (rate === null ? "" : `${Math.round(rate * 100)} %`);
  const header = resolved.mode === "member" ? ["Datum", "Termin", "Status"] : ["Name", "Anwesend", "Entschuldigt", "Unentschuldigt", "Erfasst", "Quote"];
  const rows =
    resolved.mode === "member"
      ? body.entries.map((e) => [e.startsAt.toISOString().slice(0, 10), e.title, e.status])
      : body.members.map((m) => [m.displayName, m.present, m.excused, m.unexcused, m.recorded, pct(m.rate)]);
  await writeAudit(db, { eventType: "attendance.export", subjectId: resolved.member?.id ?? null, payload: { clubId: c.get("clubId"), rows: rows.length, scope: resolved.mode } });
  return c.body(buildCsv(header, rows), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="anwesenheit.csv"', "Cache-Control": "private, no-store" });
});
