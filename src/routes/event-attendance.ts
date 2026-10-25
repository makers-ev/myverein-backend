import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { eventAttendance, eventAttendanceCorrections, eventAttendanceSheets, eventAttendanceSupervisors, ATTENDANCE_STATUSES, type EventAttendanceSheetRow } from "../db/schema/event-attendance.js";
import { events } from "../db/schema/events.js";
import { writeAudit } from "../lib/audit.js";
import type { DbExecutor } from "../lib/club-members.js";
import { absentMemberIds, buildAttendanceView, eventLocalDays, rosterMemberIds } from "../lib/event-attendance.js";
import { assertEventScope, loadVisibleEvent, mayManageEvent, needsPermission, requirePermission } from "../lib/event-access.js";
import { ConflictError, ValidationError } from "../lib/errors.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "../lib/member-lifecycle.js";
import { cleanText } from "../lib/text-policy.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Attendance of an event (Wave 12 B10/B11). Mounted into `eventRoutes` (session + club guard come from there).
 * Rights: `attendance:read` / `attendance:write`; trainer and abteilungsleitung only for events of their own departments.
 */
export const eventAttendanceRoutes = new Hono<ClubEnv>();

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const MAX_ENTRIES = 500;
const reasonSchema = cleanText(z.string().trim().min(1).max(300));

const entrySchema = z
  .object({
    clubMemberId: z.uuid().optional(),
    attendanceId: z.uuid().optional(),
    guestName: cleanText(z.string().trim().min(1).max(100)).optional(),
    /** `null` takes the person off the list again (open). */
    status: z.enum(ATTENDANCE_STATUSES).nullable(),
  })
  .refine((e) => [e.clubMemberId, e.attendanceId, e.guestName].filter((v) => v !== undefined).length === 1, { message: "Exactly one of clubMemberId, attendanceId, guestName" });

const saveSchema = z.object({
  entries: z.array(entrySchema).min(1).max(MAX_ENTRIES),
  /** Required once the list is closed (a correction); shown in the log of the list. */
  reason: reasonSchema.optional(),
});

/** Sheet of the event, created on demand, locked for the transaction. */
async function lockedSheet(tx: DbExecutor, eventId: string): Promise<EventAttendanceSheetRow> {
  await tx.insert(eventAttendanceSheets).values({ eventId }).onConflictDoNothing();
  const [sheet] = await tx.select().from(eventAttendanceSheets).where(eq(eventAttendanceSheets.eventId, eventId)).for("update");
  return sheet!;
}

function requireReasonIfClosed(sheet: EventAttendanceSheetRow, reason: string | undefined): void {
  if (sheet.closedAt !== null && !reason) throw new ConflictError("The list is closed: a change needs a reason", { details: { code: "reason_required" } });
}

async function assertActiveClubMembers(tx: DbExecutor, clubId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await tx.select({ id: clubMembers.id, status: clubMembers.status, leftAt: clubMembers.leftAt }).from(clubMembers).where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.id, ids)));
  const today = todayBerlin();
  const ok = new Set(rows.filter((r) => !isLeftStatus(effectiveStatus(r, today))).map((r) => r.id));
  const bad = ids.filter((id) => !ok.has(id));
  if (bad.length > 0) throw new ValidationError("Unknown club members or members who have left", { details: { code: "unknown_member", ids: bad } });
}

async function loadManaged(ctx: Context<ClubEnv>, permission: "attendance:read" | "attendance:write", eventId: string) {
  const roles = ctx.get("clubRoleTypes");
  requirePermission(roles, permission);
  const loaded = await loadVisibleEvent(eventId, ctx.get("clubId"), ctx.get("membership").id, roles);
  await assertEventScope(permission, roles, ctx.get("membership").id, loaded.calendar);
  return { ...loaded, clubId: ctx.get("clubId"), roles, accountMemberId: ctx.get("membership").id };
}

eventAttendanceRoutes.get("/:id/attendance", async (c) => {
  const { event, calendar, clubId, roles, accountMemberId } = await loadManaged(c, "attendance:read", c.req.param("id"));
  const view = await buildAttendanceView(clubId, event, calendar);
  return c.json({ data: { ...view, canWrite: await mayManageEvent("attendance:write", roles, accountMemberId, calendar) } });
});

eventAttendanceRoutes.put("/:id/attendance", needsPermission("attendance:write"), zValidator("json", saveSchema, hook), async (c) => {
  const { event, calendar, clubId } = await loadManaged(c, "attendance:write", c.req.param("id"));
  if (event.cancelledAt !== null) throw new ConflictError("The event is cancelled", { details: { code: "event_cancelled" } });
  const body = c.req.valid("json");
  const actor = c.get("user").id;
  const { from, to } = await eventLocalDays(clubId, event);

  await db.transaction(async (tx) => {
    const sheet = await lockedSheet(tx, event.id);
    requireReasonIfClosed(sheet, body.reason);
    await assertActiveClubMembers(tx, clubId, body.entries.flatMap((e) => (e.clubMemberId ? [e.clubMemberId] : [])));

    const existing = await tx.select().from(eventAttendance).where(eq(eventAttendance.sheetId, sheet.id));
    const byMember = new Map(existing.flatMap((r) => (r.clubMemberId ? [[r.clubMemberId, r] as const] : [])));
    const byId = new Map(existing.map((r) => [r.id, r]));
    const absent = await absentMemberIds(clubId, body.entries.flatMap((e) => (e.clubMemberId ? [e.clubMemberId] : [])), from, to, tx);
    let saved = 0;
    let removed = 0;
    const now = new Date();
    const correction = async (clubMemberId: string | null, oldStatus: string | null, newStatus: string | null) => {
      if (sheet.closedAt === null) return;
      await tx.insert(eventAttendanceCorrections).values({ sheetId: sheet.id, clubMemberId, oldStatus, newStatus, reason: body.reason!, changedBy: actor });
    };

    for (const entry of body.entries) {
      const current = entry.clubMemberId ? byMember.get(entry.clubMemberId) : entry.attendanceId ? byId.get(entry.attendanceId) : undefined;
      if (entry.attendanceId && (!current || current.clubMemberId !== null)) throw new ValidationError("Unknown guest entry", { details: { code: "unknown_entry", attendanceId: entry.attendanceId } });
      if (entry.status === null) {
        if (!current) continue;
        await tx.delete(eventAttendance).where(eq(eventAttendance.id, current.id));
        await correction(current.clubMemberId, current.status, null);
        removed += 1;
        continue;
      }
      if (current && current.status === entry.status) continue;
      if (current) {
        await tx.update(eventAttendance).set({ status: entry.status, source: "manuell", recordedBy: actor, updatedAt: now }).where(eq(eventAttendance.id, current.id));
        await correction(current.clubMemberId, current.status, entry.status);
      } else {
        // A new "entschuldigt" for somebody with an absence report keeps its origin (status only, never the report).
        const source = entry.clubMemberId && entry.status === "entschuldigt" && absent.has(entry.clubMemberId) ? "meldung" : "manuell";
        const [created] = await tx
          .insert(eventAttendance)
          .values({ sheetId: sheet.id, clubMemberId: entry.clubMemberId ?? null, guestName: entry.guestName ?? null, status: entry.status, source, recordedBy: actor })
          .returning();
        if (entry.clubMemberId) byMember.set(entry.clubMemberId, created!);
        await correction(entry.clubMemberId ?? null, null, entry.status);
      }
      saved += 1;
    }
    if (!event.attendanceTracking) await tx.update(events).set({ attendanceTracking: true, updatedAt: now }).where(eq(events.id, event.id));
    // One audit entry per batch (pattern of the meeting attendance): counts only, no names.
    await writeAudit(tx, { eventType: sheet.closedAt === null ? "event_attendance.save" : "event_attendance.correct", subjectId: event.id, payload: { clubId, eventId: event.id, saved, removed, entries: body.entries.length } });
  });

  const [fresh] = await db.select().from(events).where(eq(events.id, event.id));
  return c.json({ data: await buildAttendanceView(clubId, fresh ?? event, calendar) });
});

const supervisorsSchema = z.object({ clubMemberIds: z.array(z.uuid()).max(20), reason: reasonSchema.optional() });

eventAttendanceRoutes.put("/:id/attendance/supervisors", needsPermission("attendance:write"), zValidator("json", supervisorsSchema, hook), async (c) => {
  const { event, calendar, clubId } = await loadManaged(c, "attendance:write", c.req.param("id"));
  const body = c.req.valid("json");
  const wanted = [...new Set(body.clubMemberIds)];
  const actor = c.get("user").id;

  await db.transaction(async (tx) => {
    const sheet = await lockedSheet(tx, event.id);
    requireReasonIfClosed(sheet, body.reason);
    await assertActiveClubMembers(tx, clubId, wanted);
    const current = (await tx.select().from(eventAttendanceSupervisors).where(eq(eventAttendanceSupervisors.sheetId, sheet.id))).map((r) => r.clubMemberId);
    const add = wanted.filter((id) => !current.includes(id));
    const drop = current.filter((id) => !wanted.includes(id));
    if (drop.length) await tx.delete(eventAttendanceSupervisors).where(and(eq(eventAttendanceSupervisors.sheetId, sheet.id), inArray(eventAttendanceSupervisors.clubMemberId, drop)));
    if (add.length) await tx.insert(eventAttendanceSupervisors).values(add.map((clubMemberId) => ({ sheetId: sheet.id, clubMemberId })));
    if (sheet.closedAt !== null) {
      const rows = [...add.map((id) => ({ id, oldStatus: null, newStatus: "aufsicht" })), ...drop.map((id) => ({ id, oldStatus: "aufsicht", newStatus: null }))];
      if (rows.length) await tx.insert(eventAttendanceCorrections).values(rows.map((r) => ({ sheetId: sheet.id, clubMemberId: r.id, oldStatus: r.oldStatus, newStatus: r.newStatus, reason: body.reason!, changedBy: actor })));
    }
    await writeAudit(tx, { eventType: "event_attendance.supervisors", subjectId: event.id, payload: { clubId, eventId: event.id, added: add.length, removed: drop.length } });
  });

  return c.json({ data: await buildAttendanceView(clubId, event, calendar) });
});

const closeSchema = z.object({ markOpenAs: z.literal("unentschuldigt").optional() }).default({});

/** Closes the list: later changes need a reason and are logged. `markOpenAs` turns everybody on the roster who was not recorded into "unentschuldigt". */
eventAttendanceRoutes.post("/:id/attendance/close", needsPermission("attendance:write"), zValidator("json", closeSchema, hook), async (c) => {
  const { event, calendar, clubId } = await loadManaged(c, "attendance:write", c.req.param("id"));
  const body = c.req.valid("json");
  const actor = c.get("user").id;
  const { from, to } = await eventLocalDays(clubId, event);

  await db.transaction(async (tx) => {
    const sheet = await lockedSheet(tx, event.id);
    if (sheet.closedAt !== null) throw new ConflictError("The list is already closed", { details: { code: "already_closed" } });
    let marked = 0;
    if (body.markOpenAs) {
      const { ids } = await rosterMemberIds(clubId, event, calendar, from, tx);
      const have = new Set((await tx.select({ id: eventAttendance.clubMemberId }).from(eventAttendance).where(eq(eventAttendance.sheetId, sheet.id))).flatMap((r) => (r.id ? [r.id] : [])));
      const open = [...ids].filter((id) => !have.has(id));
      const active = open.length ? await tx.select({ id: clubMembers.id, status: clubMembers.status, leftAt: clubMembers.leftAt }).from(clubMembers).where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.id, open))) : [];
      const today = todayBerlin();
      const targets = active.filter((m) => !isLeftStatus(effectiveStatus(m, today))).map((m) => m.id);
      const absent = await absentMemberIds(clubId, targets, from, to, tx);
      if (targets.length) {
        await tx.insert(eventAttendance).values(targets.map((id) => (absent.has(id) ? { sheetId: sheet.id, clubMemberId: id, status: "entschuldigt", source: "meldung", recordedBy: actor } : { sheetId: sheet.id, clubMemberId: id, status: "unentschuldigt", source: "manuell", recordedBy: actor })));
      }
      marked = targets.length;
    }
    await tx.update(eventAttendanceSheets).set({ closedAt: new Date(), closedBy: actor }).where(eq(eventAttendanceSheets.id, sheet.id));
    if (!event.attendanceTracking) await tx.update(events).set({ attendanceTracking: true, updatedAt: new Date() }).where(eq(events.id, event.id));
    await writeAudit(tx, { eventType: "event_attendance.close", subjectId: event.id, payload: { clubId, eventId: event.id, markedOpen: marked } });
  });

  const [fresh] = await db.select().from(events).where(eq(events.id, event.id));
  return c.json({ data: await buildAttendanceView(clubId, fresh ?? event, calendar) });
});
