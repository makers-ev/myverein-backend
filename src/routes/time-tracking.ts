import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { clubMembers } from "../db/schema/club-members.js";
import { eventAttendance, eventAttendanceSheets, eventAttendanceSupervisors } from "../db/schema/event-attendance.js";
import { rateCards, timeEntries, type TimeEntryRow } from "../db/schema/event-extras.js";
import { events } from "../db/schema/events.js";
import { writeAudit } from "../lib/audit.js";
import { addDays } from "../lib/absences.js";
import { isUuid } from "../lib/club-members.js";
import { CLUB_ROLE_TYPES, hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { needsPermission, ownClubMemberRow } from "../lib/event-access.js";
import { isCalendarVisible } from "../lib/calendar-visibility.js";
import { buildCsv } from "../lib/member-csv.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { assertEntryWindow, assertNoOverlap, buildReport, inScope, minutesOf, requireTracking, timeScopeOf, TIME_STATUSES } from "../lib/time-tracking.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Time tracking of trainers (Wave 12 B20, P2): stamping in/out per assignment or event, entries from attended events (proposed,
 * never created automatically), confirmation by `time:write` (department leads: their own departments), hourly rates
 * (`time:read_rates`) and a report hours x rate. **Report only** -- no payout, no booking, no payment status.
 */

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

async function ownMember(c: Context<ClubEnv>) {
  const own = await ownClubMemberRow(c.get("clubId"), c.get("membership").id);
  if (!own) throw new ForbiddenError("Only club members can track time");
  return own;
}

function shapeEntry(row: TimeEntryRow, extra: { displayName?: string | null; eventTitle?: string | null } = {}) {
  return {
    id: row.id,
    clubMemberId: row.clubMemberId,
    displayName: extra.displayName ?? null,
    eventId: row.eventId,
    eventTitle: extra.eventTitle ?? null,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    minutes: minutesOf(row),
    running: row.endedAt === null,
    source: row.source,
    status: row.status,
    confirmedAt: row.confirmedAt,
  };
}

// --- Entries -------------------------------------------------------------------------------------------------------------------------

export const timeEntryRoutes = new Hono<ClubEnv>();
timeEntryRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
timeEntryRoutes.use("*", sessionGuard);
timeEntryRoutes.use("*", clubGuard);

const listQuery = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  status: z.enum(TIME_STATUSES).optional(),
  scope: z.enum(["mine", "team"]).optional(),
  clubMemberId: z.uuid().optional(),
});

/** Own entries, or - `scope=team` / `clubMemberId` - those of the members the caller may confirm (`time:write`). */
timeEntryRoutes.get("/", zValidator("query", listQuery, hook), async (c) => {
  const roles = c.get("clubRoleTypes");
  requireTracking(roles);
  const clubId = c.get("clubId");
  const q = c.req.valid("query");
  const to = q.to ?? todayBerlin();
  const from = q.from ?? addDays(to, -30);
  if (to < from) throw new ValidationError("`to` must not be before `from`");
  const own = await ownMember(c);
  const team = q.scope === "team" || (q.clubMemberId !== undefined && q.clubMemberId !== own.id);
  let memberFilter;
  if (team) {
    if (!hasClubPermission(roles, "time:write")) throw new ForbiddenError("Missing time:write permission");
    const scope = await timeScopeOf(clubId, roles, c.get("membership").id);
    if (q.clubMemberId) {
      if (!inScope(scope, q.clubMemberId)) throw new ForbiddenError("Not a member of your departments");
      memberFilter = eq(timeEntries.clubMemberId, q.clubMemberId);
    } else if (scope.clubMemberIds !== null) {
      memberFilter = scope.clubMemberIds.size === 0 ? sql`false` : inArray(timeEntries.clubMemberId, [...scope.clubMemberIds]);
    }
  } else memberFilter = eq(timeEntries.clubMemberId, own.id);

  const rows = await db
    .select({ entry: timeEntries, name: clubMembers.displayName, eventTitle: events.title })
    .from(timeEntries)
    .innerJoin(clubMembers, eq(clubMembers.id, timeEntries.clubMemberId))
    .leftJoin(events, eq(events.id, timeEntries.eventId))
    .where(and(eq(timeEntries.clubId, clubId), gte(timeEntries.startedAt, new Date(`${from}T00:00:00Z`)), lte(timeEntries.startedAt, new Date(`${to}T23:59:59Z`)), q.status ? eq(timeEntries.status, q.status) : undefined, memberFilter))
    .orderBy(desc(timeEntries.startedAt))
    .limit(500);
  return c.json({ data: rows.map((r) => shapeEntry(r.entry, { displayName: r.name, eventTitle: r.eventTitle })) });
});

/** The running entry of the caller, if any (for the stamp button). */
timeEntryRoutes.get("/current", async (c) => {
  requireTracking(c.get("clubRoleTypes"));
  const own = await ownMember(c);
  const [row] = await db.select({ entry: timeEntries, eventTitle: events.title }).from(timeEntries).leftJoin(events, eq(events.id, timeEntries.eventId)).where(and(eq(timeEntries.clubMemberId, own.id), isNull(timeEntries.endedAt)));
  return c.json({ data: row ? shapeEntry(row.entry, { eventTitle: row.eventTitle }) : null });
});

async function visibleEventOrNull(c: Context<ClubEnv>, eventId: string | undefined): Promise<void> {
  if (!eventId) return;
  const [row] = await db.select({ calendarId: events.calendarId }).from(events).innerJoin(calendars, eq(calendars.id, events.calendarId)).where(and(eq(events.id, eventId), eq(calendars.clubId, c.get("clubId"))));
  if (!row || !(await isCalendarVisible(row.calendarId, c.get("membership").id, c.get("clubRoleTypes")))) throw new NotFoundError("Event not found");
}

const clockInSchema = z.object({ eventId: z.uuid().optional() }).default({});

timeEntryRoutes.post("/clock-in", needsTracking(), zValidator("json", clockInSchema, hook), async (c) => {
  const own = await ownMember(c);
  const body = c.req.valid("json");
  await visibleEventOrNull(c, body.eventId);
  const clubId = c.get("clubId");
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`time:${own.id}`}, 0))`);
    const [running] = await tx.select({ id: timeEntries.id }).from(timeEntries).where(and(eq(timeEntries.clubMemberId, own.id), isNull(timeEntries.endedAt)));
    if (running) throw new ConflictError("A time entry is already running", { details: { code: "already_running", entryId: running.id } });
    const [created] = await tx.insert(timeEntries).values({ clubId, clubMemberId: own.id, eventId: body.eventId ?? null, startedAt: new Date(), source: "stempeln", status: "offen" }).returning();
    await writeAudit(tx, { eventType: "time_entry.clock_in", subjectId: own.id, payload: { clubId, entryId: created!.id, clubMemberId: own.id } });
    return created!;
  });
  return c.json({ data: shapeEntry(row) }, 201);
});

timeEntryRoutes.post("/clock-out", needsTracking(), async (c) => {
  const own = await ownMember(c);
  const clubId = c.get("clubId");
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`time:${own.id}`}, 0))`);
    const [running] = await tx.select().from(timeEntries).where(and(eq(timeEntries.clubMemberId, own.id), isNull(timeEntries.endedAt))).for("update");
    if (!running) throw new ConflictError("No time entry is running", { details: { code: "none_running" } });
    const [done] = await tx.update(timeEntries).set({ endedAt: new Date() }).where(eq(timeEntries.id, running.id)).returning();
    await writeAudit(tx, { eventType: "time_entry.clock_out", subjectId: own.id, payload: { clubId, entryId: running.id, clubMemberId: own.id } });
    return done!;
  });
  return c.json({ data: shapeEntry(row) });
});

const manualSchema = z.object({ startedAt: z.string().datetime({ offset: true }), endedAt: z.string().datetime({ offset: true }), eventId: z.uuid().optional() });

/** A forgotten stamp: the person enters it themselves. Stays `offen` until it is confirmed. */
timeEntryRoutes.post("/", needsTracking(), zValidator("json", manualSchema, hook), async (c) => {
  const own = await ownMember(c);
  const body = c.req.valid("json");
  await visibleEventOrNull(c, body.eventId);
  const startedAt = new Date(body.startedAt);
  const endedAt = new Date(body.endedAt);
  assertEntryWindow(startedAt, endedAt);
  const clubId = c.get("clubId");
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`time:${own.id}`}, 0))`);
    await assertNoOverlap(tx, own.id, startedAt, endedAt);
    const [created] = await tx.insert(timeEntries).values({ clubId, clubMemberId: own.id, eventId: body.eventId ?? null, startedAt, endedAt, source: "manuell", status: "offen" }).returning();
    await writeAudit(tx, { eventType: "time_entry.create", subjectId: own.id, payload: { clubId, entryId: created!.id, clubMemberId: own.id, source: "manuell" } });
    return created!;
  });
  return c.json({ data: shapeEntry(row) }, 201);
});

/** Events the caller supervised or attended as trainer, with a list, that ended and have no time entry yet: PROPOSALS only. */
async function proposals(c: Context<ClubEnv>, ownId: string, from: Date, to: Date) {
  const clubId = c.get("clubId");
  const supervised = await db
    .select({ eventId: eventAttendanceSheets.eventId })
    .from(eventAttendanceSupervisors)
    .innerJoin(eventAttendanceSheets, eq(eventAttendanceSheets.id, eventAttendanceSupervisors.sheetId))
    .where(eq(eventAttendanceSupervisors.clubMemberId, ownId));
  const present = await db
    .select({ eventId: eventAttendanceSheets.eventId })
    .from(eventAttendance)
    .innerJoin(eventAttendanceSheets, eq(eventAttendanceSheets.id, eventAttendance.sheetId))
    .where(and(eq(eventAttendance.clubMemberId, ownId), eq(eventAttendance.status, "anwesend")));
  const ids = [...new Set([...supervised, ...present].map((r) => r.eventId))];
  if (ids.length === 0) return [];
  const taken = await db.select({ eventId: timeEntries.eventId }).from(timeEntries).where(and(eq(timeEntries.clubMemberId, ownId), inArray(timeEntries.eventId, ids), sql`${timeEntries.status} <> 'abgelehnt'`));
  const free = ids.filter((id) => !taken.some((t) => t.eventId === id));
  if (free.length === 0) return [];
  const rows = await db
    .select({ id: events.id, title: events.title, startsAt: events.startsAt, endsAt: events.endsAt })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(and(eq(calendars.clubId, clubId), inArray(events.id, free), isNull(events.cancelledAt), gte(events.startsAt, from), lte(events.startsAt, to), lte(events.startsAt, new Date())))
    .orderBy(desc(events.startsAt))
    .limit(100);
  return rows.map((e) => ({ eventId: e.id, title: e.title, startsAt: e.startsAt, endsAt: e.endsAt ?? new Date(e.startsAt.getTime() + 3_600_000), supervisor: supervised.some((s) => s.eventId === e.id) }));
}

timeEntryRoutes.get("/suggestions", needsTracking(), zValidator("query", z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }), hook), async (c) => {
  const own = await ownMember(c);
  const q = c.req.valid("query");
  const to = q.to ?? todayBerlin();
  const from = q.from ?? addDays(to, -30);
  return c.json({ data: await proposals(c, own.id, new Date(`${from}T00:00:00Z`), new Date(`${to}T23:59:59Z`)) });
});

/** The person takes over a proposal (explicit action; the times are those of the event). */
timeEntryRoutes.post("/from-event", needsTracking(), zValidator("json", z.object({ eventId: z.uuid() }), hook), async (c) => {
  const own = await ownMember(c);
  const { eventId } = c.req.valid("json");
  const clubId = c.get("clubId");
  const list = await proposals(c, own.id, new Date(0), new Date());
  const proposal = list.find((p) => p.eventId === eventId);
  if (!proposal) {
    const [existing] = await db.select({ id: timeEntries.id }).from(timeEntries).where(and(eq(timeEntries.clubMemberId, own.id), eq(timeEntries.eventId, eventId)));
    if (existing) throw new ConflictError("There is already a time entry for this event", { details: { code: "entry_exists" } });
    throw new NotFoundError("No proposal for this event");
  }
  assertEntryWindow(proposal.startsAt, proposal.endsAt);
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`time:${own.id}`}, 0))`);
    await assertNoOverlap(tx, own.id, proposal.startsAt, proposal.endsAt);
    const [created] = await tx.insert(timeEntries).values({ clubId, clubMemberId: own.id, eventId, startedAt: proposal.startsAt, endedAt: proposal.endsAt, source: "aus_termin", status: "offen" }).returning();
    await writeAudit(tx, { eventType: "time_entry.create", subjectId: own.id, payload: { clubId, entryId: created!.id, clubMemberId: own.id, source: "aus_termin" } });
    return created!;
  });
  return c.json({ data: shapeEntry(row, { eventTitle: proposal.title }) }, 201);
});

async function ownOpenEntry(c: Context<ClubEnv>, tx: Pick<typeof db, "select">, lock = false) {
  const id = c.req.param("id") ?? "";
  if (!isUuid(id)) throw new NotFoundError("Time entry not found");
  const own = await ownMember(c);
  const q = tx.select().from(timeEntries).where(and(eq(timeEntries.id, id), eq(timeEntries.clubMemberId, own.id), eq(timeEntries.clubId, c.get("clubId"))));
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new NotFoundError("Time entry not found");
  if (row.status !== "offen") throw new ConflictError("Only open entries can be changed", { details: { code: "entry_decided" } });
  return row;
}

timeEntryRoutes.patch("/:id", needsTracking(), zValidator("json", manualSchema.partial().omit({ eventId: true }).refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }), hook), async (c) => {
  const body = c.req.valid("json");
  const clubId = c.get("clubId");
  const row = await db.transaction(async (tx) => {
    const entry = await ownOpenEntry(c, tx, true);
    if (entry.endedAt === null) throw new ConflictError("Stop the running entry first", { details: { code: "running" } });
    const startedAt = body.startedAt ? new Date(body.startedAt) : entry.startedAt;
    const endedAt = body.endedAt ? new Date(body.endedAt) : entry.endedAt;
    assertEntryWindow(startedAt, endedAt);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`time:${entry.clubMemberId}`}, 0))`);
    await assertNoOverlap(tx, entry.clubMemberId, startedAt, endedAt, entry.id);
    const [updated] = await tx.update(timeEntries).set({ startedAt, endedAt }).where(eq(timeEntries.id, entry.id)).returning();
    await writeAudit(tx, { eventType: "time_entry.update", subjectId: entry.clubMemberId, payload: { clubId, entryId: entry.id, clubMemberId: entry.clubMemberId } });
    return updated!;
  });
  return c.json({ data: shapeEntry(row) });
});

timeEntryRoutes.delete("/:id", needsTracking(), async (c) => {
  const clubId = c.get("clubId");
  await db.transaction(async (tx) => {
    const entry = await ownOpenEntry(c, tx, true);
    await tx.delete(timeEntries).where(eq(timeEntries.id, entry.id));
    await writeAudit(tx, { eventType: "time_entry.delete", subjectId: entry.clubMemberId, payload: { clubId, entryId: entry.id, clubMemberId: entry.clubMemberId } });
  });
  return c.body(null, 204);
});

/** Confirm or reject (never one's own entry). */
function decide(status: "bestaetigt" | "abgelehnt") {
  return async (c: Context<ClubEnv>) => {
    const clubId = c.get("clubId");
    const id = c.req.param("id") ?? "";
    if (!isUuid(id)) throw new NotFoundError("Time entry not found");
    const roles = c.get("clubRoleTypes");
    const scope = await timeScopeOf(clubId, roles, c.get("membership").id);
    const own = await ownClubMemberRow(clubId, c.get("membership").id);
    const row = await db.transaction(async (tx) => {
      const [entry] = await tx.select().from(timeEntries).where(and(eq(timeEntries.id, id), eq(timeEntries.clubId, clubId))).for("update");
      if (!entry || !inScope(scope, entry.clubMemberId)) throw new NotFoundError("Time entry not found");
      if (own && entry.clubMemberId === own.id) throw new ForbiddenError("Nobody decides about their own entry", { details: { code: "no_self_decision" } });
      if (entry.endedAt === null) throw new ConflictError("The entry is still running", { details: { code: "running" } });
      if (entry.status !== "offen") throw new ConflictError("The entry was already decided", { details: { code: "entry_decided" } });
      const [updated] = await tx.update(timeEntries).set({ status, confirmedBy: c.get("user").id, confirmedAt: new Date() }).where(eq(timeEntries.id, entry.id)).returning();
      await writeAudit(tx, { eventType: status === "bestaetigt" ? "time_entry.confirm" : "time_entry.reject", subjectId: entry.clubMemberId, payload: { clubId, entryId: entry.id, clubMemberId: entry.clubMemberId } });
      return updated!;
    });
    return c.json({ data: shapeEntry(row) });
  };
}
timeEntryRoutes.post("/:id/confirm", needsPermission("time:write"), decide("bestaetigt"));
timeEntryRoutes.post("/:id/reject", needsPermission("time:write"), decide("abgelehnt"));

function needsTracking() {
  return async (c: Context<ClubEnv>, next: () => Promise<void>) => {
    requireTracking(c.get("clubRoleTypes"));
    await next();
  };
}

// --- Rate cards ----------------------------------------------------------------------------------------------------------------------

export const rateCardRoutes = new Hono<ClubEnv>();
rateCardRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
rateCardRoutes.use("*", sessionGuard);
rateCardRoutes.use("*", clubGuard);
rateCardRoutes.use("*", needsPermission("time:read_rates"));

const cardSchema = z
  .object({
    clubMemberId: z.uuid().optional(),
    roleType: z.enum(CLUB_ROLE_TYPES).optional(),
    hourlyRateCents: z.number().int().min(0).max(1_000_000),
    validFrom: z.iso.date(),
    validUntil: z.iso.date().nullable().optional(),
  })
  .refine((c) => (c.clubMemberId !== undefined) !== (c.roleType !== undefined), { message: "Exactly one of clubMemberId and roleType", path: ["clubMemberId"] })
  .refine((c) => !c.validUntil || c.validUntil >= c.validFrom, { message: "validUntil must not be before validFrom", path: ["validUntil"] });

function shapeCard(r: typeof rateCards.$inferSelect, name?: string | null) {
  return { id: r.id, clubMemberId: r.clubMemberId, displayName: name ?? null, roleType: r.roleType, hourlyRateCents: r.hourlyRateCents, validFrom: r.validFrom, validUntil: r.validUntil, createdAt: r.createdAt };
}

rateCardRoutes.get("/", async (c) => {
  const rows = await db.select({ card: rateCards, name: clubMembers.displayName }).from(rateCards).leftJoin(clubMembers, eq(clubMembers.id, rateCards.clubMemberId)).where(eq(rateCards.clubId, c.get("clubId"))).orderBy(asc(rateCards.validFrom));
  return c.json({ data: rows.map((r) => shapeCard(r.card, r.name)) });
});

rateCardRoutes.post("/", zValidator("json", cardSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  if (body.clubMemberId) {
    const [m] = await db.select({ id: clubMembers.id }).from(clubMembers).where(and(eq(clubMembers.id, body.clubMemberId), eq(clubMembers.clubId, clubId)));
    if (!m) throw new NotFoundError("Member not found");
  }
  const [row] = await db.insert(rateCards).values({ clubId, clubMemberId: body.clubMemberId ?? null, roleType: body.roleType ?? null, hourlyRateCents: body.hourlyRateCents, validFrom: body.validFrom, validUntil: body.validUntil ?? null, createdBy: c.get("membership").id }).returning();
  await writeAudit(db, { eventType: "rate_card.create", subjectId: body.clubMemberId ?? null, payload: { clubId, cardId: row!.id } });
  return c.json({ data: shapeCard(row!) }, 201);
});

async function loadCard(c: Context<ClubEnv>) {
  const id = c.req.param("id") ?? "";
  if (!isUuid(id)) throw new NotFoundError("Rate card not found");
  const [row] = await db.select().from(rateCards).where(and(eq(rateCards.id, id), eq(rateCards.clubId, c.get("clubId"))));
  if (!row) throw new NotFoundError("Rate card not found");
  return row;
}

rateCardRoutes.patch("/:id", zValidator("json", z.object({ hourlyRateCents: z.number().int().min(0).max(1_000_000).optional(), validFrom: z.iso.date().optional(), validUntil: z.iso.date().nullable().optional() }).refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }), hook), async (c) => {
  const existing = await loadCard(c);
  const body = c.req.valid("json");
  const validFrom = body.validFrom ?? existing.validFrom;
  const validUntil = body.validUntil === undefined ? existing.validUntil : body.validUntil;
  if (validUntil && validUntil < validFrom) throw new ValidationError("validUntil must not be before validFrom");
  const [row] = await db.update(rateCards).set({ ...(body.hourlyRateCents !== undefined ? { hourlyRateCents: body.hourlyRateCents } : {}), validFrom, validUntil }).where(eq(rateCards.id, existing.id)).returning();
  await writeAudit(db, { eventType: "rate_card.update", subjectId: existing.clubMemberId, payload: { clubId: c.get("clubId"), cardId: existing.id } });
  return c.json({ data: shapeCard(row!) });
});

rateCardRoutes.delete("/:id", async (c) => {
  const existing = await loadCard(c);
  await db.delete(rateCards).where(eq(rateCards.id, existing.id));
  await writeAudit(db, { eventType: "rate_card.delete", subjectId: existing.clubMemberId, payload: { clubId: c.get("clubId"), cardId: existing.id } });
  return c.body(null, 204);
});

// --- Report --------------------------------------------------------------------------------------------------------------------------------

export const timeReportRoutes = new Hono<ClubEnv>();
timeReportRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
timeReportRoutes.use("*", sessionGuard);
timeReportRoutes.use("*", clubGuard);

const reportQuery = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), departmentId: z.uuid().optional(), format: z.enum(["json", "csv"]).optional() });

/**
 * Hours (and, with `time:read_rates`, hours x rate) of CONFIRMED entries. `time:write` sees the hours of its scope without
 * any amount; `time:read_rates` additionally sees amounts. A report is a calculation basis, not a payment: nothing is booked.
 */
timeReportRoutes.get("/", zValidator("query", reportQuery, hook), async (c) => {
  const roles = c.get("clubRoleTypes");
  const withRates = hasClubPermission(roles, "time:read_rates");
  if (!withRates && !hasClubPermission(roles, "time:write")) throw new ForbiddenError("Missing time:write or time:read_rates permission");
  const clubId = c.get("clubId");
  const q = c.req.valid("query");
  const to = q.to ?? todayBerlin();
  const from = q.from ?? addDays(to, -30);
  if (to < from) throw new ValidationError("`to` must not be before `from`");
  if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86_400_000) throw new ValidationError("The range covers at most 366 days");
  // Amounts need time:read_rates (board-wide); a department lead with time:write only reads hours of their own departments.
  const scope = withRates ? { clubMemberIds: null } : await timeScopeOf(clubId, roles, c.get("membership").id);
  const report = await buildReport(clubId, { from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T23:59:59Z`), scope, withRates, departmentId: q.departmentId });
  if (q.format === "csv") {
    const header = withRates ? ["Name", "Einträge", "Stunden", "Satz (EUR/h)", "Betrag (EUR)", "Satz fehlt"] : ["Name", "Einträge", "Stunden"];
    const eur = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(".", ","));
    const rows = report.people.map((p) => (withRates ? [p.displayName, p.entries, String(p.hours).replace(".", ","), eur(p.rateCents), eur(p.amountCents), p.rateMissing ? "ja" : ""] : [p.displayName, p.entries, String(p.hours).replace(".", ",")]));
    await writeAudit(db, { eventType: "time_report.export", subjectId: null, payload: { clubId, rows: rows.length, withRates } });
    return c.body(buildCsv(header, rows), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="stundenreport.csv"', "Cache-Control": "private, no-store" });
  }
  return c.json({ data: { range: { from, to }, includesRates: withRates, note: "Calculation basis only: no payout, no booking, no payment status.", ...report } });
});

