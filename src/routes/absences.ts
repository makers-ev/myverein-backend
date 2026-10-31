import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { events } from "../db/schema/events.js";
import { ABSENCE_KINDS, ABSENCE_NOTE_MAX } from "../db/schema/absences.js";
import { absenceScopeOf, addDays, createAbsence, listAbsencesInScope, listAbsencesOf, shapeAbsence, updateAbsence, withdrawAbsence } from "../lib/absences.js";
import { isCalendarVisible } from "../lib/calendar-visibility.js";
import { isUuid } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubTimezone } from "../lib/event-notify.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Absence / sick notes (Wave 10 B5). Members report for THEMSELVES here (guardians report for their ward under
 * `/guardian/wards/:wardId/absences`); `absences:read` holders read the club's reports: the board all of them,
 * trainers / department leads only the members of their own departments. No diagnosis field, only kind + period + a short note.
 */
export const absenceRoutes = new Hono<ClubEnv>();

absenceRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
absenceRoutes.use("*", sessionGuard);
absenceRoutes.use("*", clubGuard);

export const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const day = z.iso.date();
export const absenceCreateSchema = z.object({
  kind: z.enum(ABSENCE_KINDS),
  startsOn: day,
  endsOn: day,
  // Short text only; clients warn "no diagnoses" next to the field.
  note: z.union([cleanText(z.string().trim().max(ABSENCE_NOTE_MAX)), z.null()]).optional().transform((v) => (v === "" ? null : v)),
});
export const absenceUpdateSchema = z
  .object({ kind: z.enum(ABSENCE_KINDS), startsOn: day, endsOn: day, note: z.union([cleanText(z.string().trim().max(ABSENCE_NOTE_MAX)), z.null()]).transform((v) => (v === "" ? null : v)) })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

/** The caller's own club member row; external guests (guardians) have no absences of their own. */
async function ownClubMember(c: { get(k: "membership"): { id: string; role: string }; get(k: "clubId"): string }): Promise<ClubMemberRow> {
  const membership = c.get("membership");
  if (membership.role === "guest") throw new ForbiddenError("External guests do not report absences for themselves");
  const [row] = await db.select().from(clubMembers).where(and(eq(clubMembers.memberId, membership.id), eq(clubMembers.clubId, c.get("clubId"))));
  if (!row) throw new NotFoundError("Member not found");
  return row;
}

absenceRoutes.get("/", async (c) => {
  const own = await ownClubMember(c);
  const includeWithdrawn = c.req.query("includeWithdrawn") === "true";
  const rows = await listAbsencesOf(c.get("clubId"), own.id, { includeWithdrawn, from: includeWithdrawn ? undefined : todayBerlin() });
  return c.json({ data: rows.map(shapeAbsence) });
});

absenceRoutes.post("/", zValidator("json", absenceCreateSchema, validationHook), async (c) => {
  const own = await ownClubMember(c);
  const row = await createAbsence(c.get("clubId"), own, c.req.valid("json"), { userId: c.get("user").id, kind: "self" });
  return c.json({ data: shapeAbsence(row) }, 201);
});

const clubQuery = z.object({ from: day.optional(), to: day.optional(), departmentId: z.uuid().optional() });

/** Reports overlapping a period (default: today and the next 14 days) for `absences:read`, scoped to the caller's departments. */
absenceRoutes.get("/club", zValidator("query", clubQuery, validationHook), async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "absences:read")) throw new ForbiddenError("Missing absences:read permission");
  const q = c.req.valid("query");
  const from = q.from ?? todayBerlin();
  const to = q.to ?? addDays(from, 14);
  if (to < from) throw new ValidationError("`to` must not be before `from`");
  const scope = await absenceScopeOf(c.get("clubRoleTypes"), c.get("membership").id);
  const rows = await listAbsencesInScope(c.get("clubId"), scope, { from, to, departmentId: q.departmentId });
  return c.json({ data: rows.map((r) => ({ ...shapeAbsence(r.absence), displayName: r.displayName })), meta: { from, to } });
});

/** Overlay for the participant list of an event: members (in the caller's scope) with a report on the day of the event. */
absenceRoutes.get("/event/:eventId", async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "absences:read")) throw new ForbiddenError("Missing absences:read permission");
  const clubId = c.get("clubId");
  if (!isUuid(c.req.param("eventId"))) throw new NotFoundError("Event not found");
  const [row] = await db
    .select({ event: events, calendar: calendars })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(eq(events.id, c.req.param("eventId")), eq(calendars.clubId, clubId)));
  if (!row || !(await isCalendarVisible(row.calendar.id, c.get("membership").id, c.get("clubRoleTypes")))) throw new NotFoundError("Event not found");
  const timezone = await clubTimezone(clubId);
  const eventDay = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(row.event.startsAt);
  const scope = await absenceScopeOf(c.get("clubRoleTypes"), c.get("membership").id);
  const rows = await listAbsencesInScope(clubId, scope, { from: eventDay, to: eventDay });
  // Only who is absent and for how long -- the note stays in the overview.
  return c.json({ data: rows.map((r) => ({ clubMemberId: r.absence.clubMemberId, displayName: r.displayName, startsOn: r.absence.startsOn, endsOn: r.absence.endsOn })), meta: { day: eventDay } });
});

absenceRoutes.patch("/:id", zValidator("json", absenceUpdateSchema, validationHook), async (c) => {
  const own = await ownClubMember(c);
  const row = await updateAbsence(c.get("clubId"), own, c.req.param("id"), c.req.valid("json"), c.get("user").id);
  return c.json({ data: shapeAbsence(row) });
});

absenceRoutes.delete("/:id", async (c) => {
  const own = await ownClubMember(c);
  await withdrawAbsence(c.get("clubId"), own, c.req.param("id"), c.get("user").id);
  return c.body(null, 204);
});
