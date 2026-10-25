import { zValidator } from "@hono/zod-validator";
import { and, count, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { helperShifts, helperSignups, helperStations, helperSwapRequests } from "../db/schema/event-helpers.js";
import { writeAudit } from "../lib/audit.js";
import { isUuid } from "../lib/club-members.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import { assertEventScope, loadVisibleEvent, mayManageEvent, needsPermission } from "../lib/event-access.js";
import { resolveActingMember } from "../lib/event-actor.js";
import { assertNoOverlap, loadPlan, lockMemberShifts, MAX_SHIFT_CAPACITY, MAX_SHIFTS_PER_EVENT, MAX_STATIONS_PER_EVENT, notifyHelpers, notifyLateCancel, lateCancelHours, overlappingShift } from "../lib/event-helpers.js";
import { suggestHelpers } from "../lib/helper-suggestions.js";
import { clubTimezone, formatWhen } from "../lib/event-notify.js";
import { clubMailLanguage } from "../lib/club-settings.js";
import { activeWardLinks } from "../lib/guardian-scope.js";
import { tr } from "../lib/notify/i18n.js";
import { effectiveStatus, isLeftStatus, todayBerlin } from "../lib/member-lifecycle.js";
import { ownClubMemberRow } from "../lib/event-access.js";
import { cleanText } from "../lib/text-policy.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Helper plan of an event (Wave 12 B16). Reading: everybody who sees the event. Managing (stations, shifts): `helpers:write`
 * within the event scope (department roles only for their own departments). Self-service: sign up / withdraw / swap for
 * oneself, for a ward (live guardian link) or - as organiser - for any member; minors are never entered by themselves.
 * Mounted into `eventRoutes`.
 */
export const eventHelperRoutes = new Hono<ClubEnv>();

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};
const isUniqueViolation = (err: unknown): boolean => (err as { code?: string; cause?: { code?: string } })?.code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505";

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError("Invalid JSON body");
  }
}

// --- Plan ---------------------------------------------------------------------------------------------------------------

eventHelperRoutes.get("/:id/helpers", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roles = c.get("clubRoleTypes");
  const { event, calendar } = await loadVisibleEvent(c.req.param("id"), clubId, membership.id, roles);
  const own = await ownClubMemberRow(clubId, membership.id);
  const wards = await activeWardLinks(c.get("user").id, { clubId });
  const myIds = new Set<string>([...(own ? [own.id] : []), ...wards.map((w) => w.ward.id)]);
  const stations = await loadPlan(event.id, myIds, membership.role !== "guest");
  const mine = stations.flatMap((s) => s.shifts.filter((sh) => sh.mine).map((sh) => ({ shiftId: sh.id, stationId: s.id, stationName: s.name, startsAt: sh.startsAt, endsAt: sh.endsAt, signupId: sh.mySignupId })));
  return c.json({ data: { eventId: event.id, cancelled: event.cancelledAt !== null, canManage: await mayManageEvent("helpers:write", roles, membership.id, calendar), stations, mine } });
});

// --- Management -----------------------------------------------------------------------------------------------------------

async function manage(c: Context<ClubEnv>) {
  const roles = c.get("clubRoleTypes");
  const { event, calendar } = await loadVisibleEvent(c.req.param("id") ?? "", c.get("clubId"), c.get("membership").id, roles);
  await assertEventScope("helpers:write", roles, c.get("membership").id, calendar);
  return { event, calendar, clubId: c.get("clubId") };
}

const stationSchema = z.object({
  name: cleanText(z.string().trim().min(1).max(100)),
  description: z.union([cleanText(z.string().trim().max(500)), z.null()]).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

eventHelperRoutes.post("/:id/helpers/stations", needsPermission("helpers:write"), zValidator("json", stationSchema, hook), async (c) => {
  const { event, clubId } = await manage(c);
  const body = c.req.valid("json");
  const [n] = await db.select({ n: count() }).from(helperStations).where(eq(helperStations.eventId, event.id));
  if ((n?.n ?? 0) >= MAX_STATIONS_PER_EVENT) throw new ConflictError(`At most ${MAX_STATIONS_PER_EVENT} stations per event`, { details: { code: "too_many_stations" } });
  const [row] = await db.insert(helperStations).values({ eventId: event.id, name: body.name, description: body.description ?? null, sortOrder: body.sortOrder ?? n?.n ?? 0 }).returning();
  await writeAudit(db, { eventType: "helper.station_create", subjectId: event.id, payload: { clubId, eventId: event.id, stationId: row!.id } });
  return c.json({ data: row }, 201);
});

async function loadStation(eventId: string, stationId: string) {
  if (!isUuid(stationId)) throw new NotFoundError("Station not found");
  const [row] = await db.select().from(helperStations).where(and(eq(helperStations.id, stationId), eq(helperStations.eventId, eventId)));
  if (!row) throw new NotFoundError("Station not found");
  return row;
}

eventHelperRoutes.patch("/:id/helpers/stations/:stationId", needsPermission("helpers:write"), zValidator("json", stationSchema.partial().refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" }), hook), async (c) => {
  const { event, clubId } = await manage(c);
  const station = await loadStation(event.id, c.req.param("stationId"));
  const body = c.req.valid("json");
  const [row] = await db.update(helperStations).set({ ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}), ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}) }).where(eq(helperStations.id, station.id)).returning();
  await writeAudit(db, { eventType: "helper.station_update", subjectId: event.id, payload: { clubId, eventId: event.id, stationId: station.id } });
  return c.json({ data: row });
});

/** Everybody signed up for the shifts of a station / a shift, for the notice before they vanish. */
async function signedPeople(shiftIds: string[]): Promise<string[]> {
  if (shiftIds.length === 0) return [];
  const rows = await db.select({ id: helperSignups.clubMemberId }).from(helperSignups).where(inArray(helperSignups.shiftId, shiftIds));
  return rows.map((r) => r.id);
}

eventHelperRoutes.delete("/:id/helpers/stations/:stationId", needsPermission("helpers:write"), async (c) => {
  const { event, clubId } = await manage(c);
  const station = await loadStation(event.id, c.req.param("stationId"));
  const shifts = await db.select({ id: helperShifts.id }).from(helperShifts).where(eq(helperShifts.stationId, station.id));
  const people = await signedPeople(shifts.map((s) => s.id));
  await db.delete(helperStations).where(eq(helperStations.id, station.id));
  await writeAudit(db, { eventType: "helper.station_delete", subjectId: event.id, payload: { clubId, eventId: event.id, stationId: station.id } });
  const lang = await clubMailLanguage(db, clubId);
  await notifyHelpers({ clubId, clubMemberIds: people, eventKey: "helper.shift_removed", refId: `${station.id}#removed`, title: `${tr(lang, "Helferschicht entfällt", "Helper shift removed")}: ${event.title}`, body: tr(lang, `Die Station „${station.name}“ bei „${event.title}“ wurde aus dem Helferplan genommen. Deine Eintragung dort ist damit gelöscht.`, `The station “${station.name}” of “${event.title}” was removed from the helper plan. Your sign-up there is gone.`) });
  return c.body(null, 204);
});

const isoDate = z.string().datetime({ offset: true });
const shiftBase = z.object({ startsAt: isoDate, endsAt: isoDate, capacity: z.number().int().min(1).max(MAX_SHIFT_CAPACITY), minStaff: z.number().int().min(0).max(MAX_SHIFT_CAPACITY).optional() });
const shiftCreateSchema = shiftBase.refine((s) => new Date(s.endsAt) > new Date(s.startsAt), { message: "endsAt must be after startsAt", path: ["endsAt"] }).refine((s) => (s.minStaff ?? 0) <= s.capacity, { message: "minStaff must not exceed capacity", path: ["minStaff"] });

eventHelperRoutes.post("/:id/helpers/stations/:stationId/shifts", needsPermission("helpers:write"), zValidator("json", shiftCreateSchema, hook), async (c) => {
  const { event, clubId } = await manage(c);
  const station = await loadStation(event.id, c.req.param("stationId"));
  const body = c.req.valid("json");
  const [n] = await db.select({ n: count() }).from(helperShifts).innerJoin(helperStations, eq(helperStations.id, helperShifts.stationId)).where(eq(helperStations.eventId, event.id));
  if ((n?.n ?? 0) >= MAX_SHIFTS_PER_EVENT) throw new ConflictError(`At most ${MAX_SHIFTS_PER_EVENT} shifts per event`, { details: { code: "too_many_shifts" } });
  const [row] = await db.insert(helperShifts).values({ stationId: station.id, startsAt: new Date(body.startsAt), endsAt: new Date(body.endsAt), capacity: body.capacity, minStaff: body.minStaff ?? 0 }).returning();
  await writeAudit(db, { eventType: "helper.shift_create", subjectId: event.id, payload: { clubId, eventId: event.id, stationId: station.id, shiftId: row!.id } });
  return c.json({ data: row }, 201);
});

const shiftPatchSchema = shiftBase.partial().refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

/** Shift of this event; with `lock` the row is locked FOR UPDATE for the transaction. */
async function loadShift(tx: Pick<typeof db, "select">, eventId: string, shiftId: string, lock = false) {
  if (!isUuid(shiftId)) throw new NotFoundError("Shift not found");
  const query = tx
    .select({ shift: helperShifts, stationName: helperStations.name, stationId: helperStations.id })
    .from(helperShifts)
    .innerJoin(helperStations, eq(helperStations.id, helperShifts.stationId))
    .where(and(eq(helperShifts.id, shiftId), eq(helperStations.eventId, eventId)));
  const [row] = lock ? await query.for("update", { of: helperShifts }) : await query;
  if (!row) throw new NotFoundError("Shift not found");
  return row;
}

eventHelperRoutes.patch("/:id/helpers/shifts/:shiftId", needsPermission("helpers:write"), zValidator("json", shiftPatchSchema, hook), async (c) => {
  const { event, clubId } = await manage(c);
  const body = c.req.valid("json");
  const result = await db.transaction(async (tx) => {
    const { shift, stationId } = await loadShift(tx, event.id, c.req.param("shiftId"), true);
    const startsAt = body.startsAt ? new Date(body.startsAt) : shift.startsAt;
    const endsAt = body.endsAt ? new Date(body.endsAt) : shift.endsAt;
    const capacity = body.capacity ?? shift.capacity;
    const minStaff = body.minStaff ?? shift.minStaff;
    if (endsAt <= startsAt) throw new ValidationError("endsAt must be after startsAt", { details: { code: "invalid_time" } });
    if (minStaff > capacity) throw new ValidationError("minStaff must not exceed capacity", { details: { code: "invalid_min_staff" } });
    const signups = await tx.select({ clubMemberId: helperSignups.clubMemberId }).from(helperSignups).where(eq(helperSignups.shiftId, shift.id));
    if (capacity < signups.length) throw new ConflictError("More people are signed up than the new capacity", { details: { code: "capacity_below_filled", filled: signups.length } });
    const timeChanged = startsAt.getTime() !== shift.startsAt.getTime() || endsAt.getTime() !== shift.endsAt.getTime();
    if (timeChanged) {
      for (const s of signups) {
        await lockMemberShifts(tx, s.clubMemberId);
        assertNoOverlap(await overlappingShift(tx, s.clubMemberId, startsAt, endsAt, shift.id));
      }
    }
    const [row] = await tx.update(helperShifts).set({ startsAt, endsAt, capacity, minStaff }).where(eq(helperShifts.id, shift.id)).returning();
    await writeAudit(tx, { eventType: "helper.shift_update", subjectId: event.id, payload: { clubId, eventId: event.id, stationId, shiftId: shift.id } });
    return { row: row!, timeChanged, people: signups.map((s) => s.clubMemberId) };
  });
  if (result.timeChanged) {
    const lang = await clubMailLanguage(db, clubId);
    const when = formatWhen(result.row.startsAt, await clubTimezone(clubId), result.row.endsAt, lang);
    await notifyHelpers({ clubId, clubMemberIds: result.people, eventKey: "helper.shift_changed", refId: `${result.row.id}#${result.row.startsAt.getTime()}`, title: `${tr(lang, "Helferschicht verschoben", "Helper shift moved")}: ${event.title}`, body: tr(lang, `Deine Schicht bei „${event.title}“ liegt jetzt: ${when}.`, `Your shift at “${event.title}” is now: ${when}.`) });
  }
  return c.json({ data: result.row });
});

eventHelperRoutes.delete("/:id/helpers/shifts/:shiftId", needsPermission("helpers:write"), async (c) => {
  const { event, clubId } = await manage(c);
  const { shift, stationName } = await loadShift(db, event.id, c.req.param("shiftId"));
  const people = await signedPeople([shift.id]);
  await db.delete(helperShifts).where(eq(helperShifts.id, shift.id));
  await writeAudit(db, { eventType: "helper.shift_delete", subjectId: event.id, payload: { clubId, eventId: event.id, shiftId: shift.id } });
  const lang = await clubMailLanguage(db, clubId);
  const when = formatWhen(shift.startsAt, await clubTimezone(clubId), shift.endsAt, lang);
  await notifyHelpers({ clubId, clubMemberIds: people, eventKey: "helper.shift_removed", refId: `${shift.id}#removed`, title: `${tr(lang, "Helferschicht entfällt", "Helper shift removed")}: ${event.title}`, body: tr(lang, `Die Schicht „${stationName}“ (${when}) bei „${event.title}“ wurde gestrichen. Deine Eintragung ist damit gelöscht.`, `The shift “${stationName}” (${when}) at “${event.title}” was cancelled. Your sign-up is gone.`) });
  return c.body(null, 204);
});

/**
 * Who could be asked for which shift: raw availability hints per person ("verfuegbar" / "nicht_verfuegbar" / "unbekannt"),
 * sorted by name, no ranking. Needs the permission to run the plan.
 */
eventHelperRoutes.get("/:id/helpers/suggestions", needsPermission("helpers:write"), async (c) => {
  const { event, calendar, clubId } = await manage(c);
  return c.json({ data: { eventId: event.id, shifts: await suggestHelpers(clubId, event, calendar) } });
});

// --- Sign-up (self-service) ---------------------------------------------------------------------------------------------------

const memberBody = z.object({ clubMemberId: z.uuid().optional() });

async function targetOf(c: Context<ClubEnv>, queryToo = false): Promise<string | undefined> {
  const body = memberBody.safeParse(await readJson(c));
  if (!body.success) throw new ValidationError("Invalid request body", { details: body.error.issues });
  if (body.data.clubMemberId) return body.data.clubMemberId;
  if (!queryToo) return undefined;
  const q = z.uuid().optional().safeParse(c.req.query("clubMemberId"));
  if (!q.success) throw new ValidationError("clubMemberId must be a uuid");
  return q.data;
}

eventHelperRoutes.post("/:id/helpers/shifts/:shiftId/signup", async (c) => {
  const forId = await targetOf(c, true);
  const acting = await resolveActingMember(c, c.req.param("id"), forId, "helpers:write");
  if (acting.event.cancelledAt !== null) throw new ConflictError("Event is cancelled");
  const clubId = c.get("clubId");

  const outcome = await db.transaction(async (tx) => {
    // Order of locks everywhere: the person first, then the shift row. Two sign-ups of one person run one after the other, two people for one shift too.
    await lockMemberShifts(tx, acting.target.id);
    const { shift, stationId } = await loadShift(tx, acting.event.id, c.req.param("shiftId"), true);
    if (shift.endsAt.getTime() <= Date.now()) throw new ConflictError("The shift is over", { details: { code: "shift_over" } });
    const signups = await tx.select({ id: helperSignups.id, clubMemberId: helperSignups.clubMemberId }).from(helperSignups).where(eq(helperSignups.shiftId, shift.id));
    const existing = signups.find((s) => s.clubMemberId === acting.target.id);
    if (existing) return { created: false, signupId: existing.id, shiftId: shift.id, stationId };
    if (signups.length >= shift.capacity) throw new ConflictError("The shift is full", { details: { code: "shift_full" } });
    assertNoOverlap(await overlappingShift(tx, acting.target.id, shift.startsAt, shift.endsAt, shift.id));
    const [created] = await tx.insert(helperSignups).values({ shiftId: shift.id, clubMemberId: acting.target.id, createdBy: c.get("user").id }).returning();
    await writeAudit(tx, { eventType: "helper.signup", subjectId: acting.target.id, payload: { clubId, eventId: acting.event.id, shiftId: shift.id, clubMemberId: acting.target.id, byOther: acting.via !== "self" } });
    return { created: true, signupId: created!.id, shiftId: shift.id, stationId, startsAt: shift.startsAt, endsAt: shift.endsAt };
  });

  if (outcome.created && acting.via === "manager" && outcome.startsAt) {
    const lang = await clubMailLanguage(db, clubId);
    const when = formatWhen(outcome.startsAt, await clubTimezone(clubId), outcome.endsAt, lang);
    await notifyHelpers({ clubId, clubMemberIds: [acting.target.id], eventKey: "helper.signed_up_by_organiser", email: true, refId: `${outcome.signupId}#added`, title: `${tr(lang, "Du bist als Helfer:in eingetragen", "You were signed up as a helper")}: ${acting.event.title}`, body: tr(lang, `Du wurdest für eine Schicht bei „${acting.event.title}“ eingetragen: ${when}. Wenn du nicht kannst, melde dich bitte ab.`, `You were signed up for a shift at “${acting.event.title}”: ${when}. If you cannot make it, please withdraw.`) });
  }
  return c.json({ data: { signupId: outcome.signupId, shiftId: outcome.shiftId, clubMemberId: acting.target.id, created: outcome.created } }, outcome.created ? 201 : 200);
});

eventHelperRoutes.delete("/:id/helpers/shifts/:shiftId/signup", async (c) => {
  const forId = await targetOf(c, true);
  const acting = await resolveActingMember(c, c.req.param("id"), forId, "helpers:write");
  const clubId = c.get("clubId");

  const removed = await db.transaction(async (tx) => {
    await lockMemberShifts(tx, acting.target.id);
    const { shift, stationName } = await loadShift(tx, acting.event.id, c.req.param("shiftId"), true);
    const [deleted] = await tx.delete(helperSignups).where(and(eq(helperSignups.shiftId, shift.id), eq(helperSignups.clubMemberId, acting.target.id))).returning();
    if (!deleted) throw new NotFoundError("Sign-up not found");
    await writeAudit(tx, { eventType: "helper.signup_cancel", subjectId: acting.target.id, payload: { clubId, eventId: acting.event.id, shiftId: shift.id, clubMemberId: acting.target.id, byOther: acting.via !== "self" } });
    return { shift, stationName };
  });

  const { shift, stationName } = removed;
  const upcoming = shift.startsAt.getTime() > Date.now();
  if (acting.via !== "manager" && upcoming && shift.startsAt.getTime() - Date.now() < lateCancelHours() * 3_600_000) {
    await notifyLateCancel({ clubId, event: acting.event, calendar: acting.calendar, shiftId: shift.id, stationName, startsAt: shift.startsAt, endsAt: shift.endsAt, clubMemberId: acting.target.id, actorUserId: c.get("user").id });
  }
  if (acting.via === "manager") {
    const lang = await clubMailLanguage(db, clubId);
    const when = formatWhen(shift.startsAt, await clubTimezone(clubId), shift.endsAt, lang);
    await notifyHelpers({ clubId, clubMemberIds: [acting.target.id], eventKey: "helper.removed_by_organiser", email: true, refId: `${shift.id}#${acting.target.id}:${Date.now()}`, title: `${tr(lang, "Du wurdest aus einer Schicht ausgetragen", "You were removed from a shift")}: ${acting.event.title}`, body: tr(lang, `Die Organisation hat dich aus der Schicht „${stationName}“ (${when}) bei „${acting.event.title}“ ausgetragen.`, `The organisers removed you from the shift “${stationName}” (${when}) at “${acting.event.title}”.`) });
  }
  return c.body(null, 204);
});

// --- Swaps ----------------------------------------------------------------------------------------------------------------------

const swapCreateSchema = z.object({ clubMemberId: z.uuid().optional(), toClubMemberId: z.uuid().nullable().optional() });

/** Hand a shift over: to a named person or open ("who can take over?"). */
eventHelperRoutes.post("/:id/helpers/shifts/:shiftId/swaps", async (c) => {
  const parsed = swapCreateSchema.safeParse(await readJson(c));
  if (!parsed.success) throw new ValidationError("Invalid request body", { details: parsed.error.issues });
  const acting = await resolveActingMember(c, c.req.param("id"), parsed.data.clubMemberId, "helpers:write");
  const clubId = c.get("clubId");
  const toId = parsed.data.toClubMemberId ?? null;
  if (toId === acting.target.id) throw new ValidationError("Cannot hand a shift over to oneself");

  const created = await db.transaction(async (tx) => {
    const { shift, stationName } = await loadShift(tx, acting.event.id, c.req.param("shiftId"), true);
    if (shift.endsAt.getTime() <= Date.now()) throw new ConflictError("The shift is over", { details: { code: "shift_over" } });
    const [signup] = await tx.select().from(helperSignups).where(and(eq(helperSignups.shiftId, shift.id), eq(helperSignups.clubMemberId, acting.target.id)));
    if (!signup) throw new NotFoundError("Sign-up not found");
    if (toId) {
      const [target] = await tx.select().from(clubMembers).where(and(eq(clubMembers.id, toId), eq(clubMembers.clubId, clubId)));
      if (!target || isLeftStatus(effectiveStatus(target, todayBerlin()))) throw new NotFoundError("Member not found");
      const [already] = await tx.select({ id: helperSignups.id }).from(helperSignups).where(and(eq(helperSignups.shiftId, shift.id), eq(helperSignups.clubMemberId, toId)));
      if (already) throw new ConflictError("That person is already on this shift", { details: { code: "already_signed_up" } });
    }
    try {
      const [swap] = await tx.insert(helperSwapRequests).values({ signupId: signup.id, toClubMemberId: toId }).returning();
      await writeAudit(tx, { eventType: "helper.swap_request", subjectId: acting.target.id, payload: { clubId, eventId: acting.event.id, shiftId: shift.id, swapId: swap!.id, clubMemberId: acting.target.id } });
      return { swap: swap!, shift, stationName };
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("There is already an open swap request for this shift", { details: { code: "swap_open" } });
      throw err;
    }
  });

  if (toId) {
    const lang = await clubMailLanguage(db, clubId);
    const when = formatWhen(created.shift.startsAt, await clubTimezone(clubId), created.shift.endsAt, lang);
    await notifyHelpers({ clubId, clubMemberIds: [toId], eventKey: "helper.swap_requested", refId: `${created.swap.id}#requested`, title: `${tr(lang, "Schicht übernehmen?", "Take over a shift?")} ${acting.event.title}`, body: tr(lang, `${acting.target.displayName} bittet dich, die Schicht „${created.stationName}“ (${when}) bei „${acting.event.title}“ zu übernehmen. Du kannst im Helferplan zusagen oder ablehnen.`, `${acting.target.displayName} asks you to take over the shift “${created.stationName}” (${when}) at “${acting.event.title}”. You can accept or decline in the helper plan.`) });
  }
  return c.json({ data: { id: created.swap.id, signupId: created.swap.signupId, shiftId: created.shift.id, toClubMemberId: toId, status: "offen" } }, 201);
});

/** Swap with its shift, the signup and the person who gives the shift away; 404 unless it belongs to this event. */
async function loadSwap(tx: Pick<typeof db, "select">, eventId: string, swapId: string) {
  if (!isUuid(swapId)) throw new NotFoundError("Swap request not found");
  const [row] = await tx
    .select({ swap: helperSwapRequests, signup: helperSignups, shift: helperShifts, stationName: helperStations.name })
    .from(helperSwapRequests)
    .innerJoin(helperSignups, eq(helperSignups.id, helperSwapRequests.signupId))
    .innerJoin(helperShifts, eq(helperShifts.id, helperSignups.shiftId))
    .innerJoin(helperStations, eq(helperStations.id, helperShifts.stationId))
    .where(and(eq(helperSwapRequests.id, swapId), eq(helperStations.eventId, eventId)));
  if (!row) throw new NotFoundError("Swap request not found");
  return row;
}

/** Somebody takes the shift over (the named person, or anybody for an open request). The signup moves; capacity and the booking stay. */
eventHelperRoutes.post("/:id/helpers/swaps/:swapId/accept", async (c) => {
  const forId = await targetOf(c, true);
  const acting = await resolveActingMember(c, c.req.param("id"), forId, "helpers:write");
  const clubId = c.get("clubId");
  if (acting.event.cancelledAt !== null) throw new ConflictError("Event is cancelled");

  const done = await db.transaction(async (tx) => {
    await lockMemberShifts(tx, acting.target.id);
    const first = await loadSwap(tx, acting.event.id, c.req.param("swapId"));
    // Lock order: person, shift, swap row -- two parallel accepts of the same open request end with exactly one winner.
    const { shift, stationName } = await loadShift(tx, acting.event.id, first.shift.id, true);
    const [swap] = await tx.select().from(helperSwapRequests).where(eq(helperSwapRequests.id, first.swap.id)).for("update");
    if (!swap || swap.status !== "offen") throw new ConflictError("The swap request is no longer open", { details: { code: "swap_closed" } });
    if (swap.toClubMemberId !== null && swap.toClubMemberId !== acting.target.id) throw new ConflictError("This swap request is meant for somebody else", { details: { code: "swap_not_for_you" } });
    const [signup] = await tx.select().from(helperSignups).where(eq(helperSignups.id, first.signup.id)).for("update");
    if (!signup) throw new ConflictError("The sign-up is gone", { details: { code: "swap_closed" } });
    if (signup.clubMemberId === acting.target.id) throw new ValidationError("Cannot take over one's own shift");
    if (shift.endsAt.getTime() <= Date.now()) throw new ConflictError("The shift is over", { details: { code: "shift_over" } });
    const [already] = await tx.select({ id: helperSignups.id }).from(helperSignups).where(and(eq(helperSignups.shiftId, shift.id), eq(helperSignups.clubMemberId, acting.target.id)));
    if (already) throw new ConflictError("Already signed up for this shift", { details: { code: "already_signed_up" } });
    assertNoOverlap(await overlappingShift(tx, acting.target.id, shift.startsAt, shift.endsAt, shift.id));
    await tx.update(helperSignups).set({ clubMemberId: acting.target.id, createdBy: c.get("user").id }).where(eq(helperSignups.id, signup.id));
    await tx.update(helperSwapRequests).set({ status: "angenommen", resolvedByClubMemberId: acting.target.id, resolvedAt: new Date() }).where(eq(helperSwapRequests.id, swap.id));
    await writeAudit(tx, { eventType: "helper.swap_accept", subjectId: acting.target.id, payload: { clubId, eventId: acting.event.id, shiftId: shift.id, swapId: swap.id, clubMemberId: acting.target.id } });
    return { shift, stationName, giverId: signup.clubMemberId, swapId: swap.id };
  });

  const lang = await clubMailLanguage(db, clubId);
  const when = formatWhen(done.shift.startsAt, await clubTimezone(clubId), done.shift.endsAt, lang);
  await notifyHelpers({ clubId, clubMemberIds: [done.giverId], eventKey: "helper.swap_accepted", refId: `${done.swapId}#accepted`, title: `${tr(lang, "Schicht übernommen", "Shift taken over")}: ${acting.event.title}`, body: tr(lang, `${acting.target.displayName} hat deine Schicht „${done.stationName}“ (${when}) übernommen. Du bist dort nicht mehr eingetragen.`, `${acting.target.displayName} took over your shift “${done.stationName}” (${when}). You are no longer signed up there.`) });
  return c.json({ data: { swapId: done.swapId, shiftId: done.shift.id, clubMemberId: acting.target.id, status: "angenommen" } });
});

/** The named person declines. */
eventHelperRoutes.post("/:id/helpers/swaps/:swapId/decline", async (c) => {
  const forId = await targetOf(c, true);
  const acting = await resolveActingMember(c, c.req.param("id"), forId, "helpers:write");
  const clubId = c.get("clubId");
  const done = await db.transaction(async (tx) => {
    const first = await loadSwap(tx, acting.event.id, c.req.param("swapId"));
    const [swap] = await tx.select().from(helperSwapRequests).where(eq(helperSwapRequests.id, first.swap.id)).for("update");
    if (!swap || swap.status !== "offen") throw new ConflictError("The swap request is no longer open", { details: { code: "swap_closed" } });
    if (swap.toClubMemberId !== acting.target.id) throw new ConflictError("This swap request is not addressed to you", { details: { code: "swap_not_for_you" } });
    await tx.update(helperSwapRequests).set({ status: "abgelehnt", resolvedByClubMemberId: acting.target.id, resolvedAt: new Date() }).where(eq(helperSwapRequests.id, swap.id));
    await writeAudit(tx, { eventType: "helper.swap_decline", subjectId: acting.target.id, payload: { clubId, eventId: acting.event.id, shiftId: first.shift.id, swapId: swap.id, clubMemberId: acting.target.id } });
    return { giverId: first.signup.clubMemberId, stationName: first.stationName, swapId: swap.id };
  });
  const lang = await clubMailLanguage(db, clubId);
  await notifyHelpers({ clubId, clubMemberIds: [done.giverId], eventKey: "helper.swap_declined", refId: `${done.swapId}#declined`, title: `${tr(lang, "Tausch abgelehnt", "Swap declined")}: ${acting.event.title}`, body: tr(lang, `${acting.target.displayName} kann deine Schicht „${done.stationName}“ nicht übernehmen. Du bleibst eingetragen.`, `${acting.target.displayName} cannot take over your shift “${done.stationName}”. You stay signed up.`) });
  return c.json({ data: { swapId: done.swapId, status: "abgelehnt" } });
});

/** The owner (or a guardian / organiser) withdraws the request. */
eventHelperRoutes.delete("/:id/helpers/swaps/:swapId", async (c) => {
  // The event id of the URL must own the swap; who may withdraw it is decided by the acting-member resolution.
  if (!isUuid(c.req.param("id"))) throw new NotFoundError("Event not found");
  const first = await loadSwap(db, c.req.param("id"), c.req.param("swapId"));
  const acting = await resolveActingMember(c, c.req.param("id"), first.signup.clubMemberId, "helpers:write");
  const clubId = c.get("clubId");
  await db.transaction(async (tx) => {
    const [swap] = await tx.select().from(helperSwapRequests).where(eq(helperSwapRequests.id, first.swap.id)).for("update");
    if (!swap || swap.status !== "offen") throw new ConflictError("The swap request is no longer open", { details: { code: "swap_closed" } });
    await tx.update(helperSwapRequests).set({ status: "zurueckgezogen", resolvedAt: new Date() }).where(eq(helperSwapRequests.id, swap.id));
    await writeAudit(tx, { eventType: "helper.swap_withdraw", subjectId: acting.target.id, payload: { clubId, eventId: acting.event.id, shiftId: first.shift.id, swapId: swap.id, clubMemberId: acting.target.id } });
  });
  return c.body(null, 204);
});
