import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { formSubmissions } from "../db/schema/forms.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { isUuid } from "../lib/club-members.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import { assertEventScope, loadClubEvent, loadVisibleEvent, needsPermission, requirePermission } from "../lib/event-access.js";
import { answerCell, loadParticipants, type Participant } from "../lib/event-participants.js";
import { notifyPromoted, notifyRegistrationRemoved } from "../lib/event-notify.js";
import { lockEvent } from "../lib/event-registration.js";
import { fits, promoteWaitlist, takenSeats } from "../lib/event-seats.js";
import { buildCsv } from "../lib/member-csv.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Participant list of an event (Wave 12 B15): `registrations:read` (trainer / abteilungsleitung only for their own
 * departments), CSV export with a choice of columns, and status changes by the organiser (`calendars:write`). Answers marked
 * `sensitive` in the form need `members:read_sensitive` on top, and reading them is audited. Mounted into `eventRoutes`.
 */
export const eventParticipantRoutes = new Hono<ClubEnv>();

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

async function loadForRead(c: Context<ClubEnv>) {
  const roles = c.get("clubRoleTypes");
  requirePermission(roles, "registrations:read");
  const loaded = await loadVisibleEvent(c.req.param("id") ?? "", c.get("clubId"), c.get("membership").id, roles);
  await assertEventScope("registrations:read", roles, c.get("membership").id, loaded.calendar);
  return loaded;
}

async function list(c: Context<ClubEnv>, eventId: string, clubId: string) {
  const includeSensitive = hasClubPermission(c.get("clubRoleTypes"), "members:read_sensitive");
  const result = await loadParticipants(eventId, includeSensitive);
  if (includeSensitive && result.hasSensitive) await writeAudit(db, { eventType: "event_registration.read_sensitive", subjectId: eventId, payload: { clubId, eventId } });
  return { ...result, sensitiveVisible: includeSensitive };
}

eventParticipantRoutes.get("/:id/registrations", async (c) => {
  const { event } = await loadForRead(c);
  const { participants, fields, sensitiveVisible } = await list(c, event.id, c.get("clubId"));
  const seats = (status: string) => participants.filter((p) => p.status === status).reduce((n, p) => n + p.partySize, 0);
  return c.json({
    data: {
      eventId: event.id,
      capacity: event.capacity,
      seatsTaken: seats("angemeldet"),
      seatsWaiting: seats("warteliste"),
      pendingConfirmation: participants.filter((p) => p.status === "unbestaetigt").length,
      sensitiveVisible,
      fields,
      registrations: participants,
    },
  });
});

const BASE_COLUMNS: Record<string, { header: string; value: (p: Participant) => string | number }> = {
  name: { header: "Name", value: (p) => p.displayName },
  status: { header: "Status", value: (p) => p.status },
  partySize: { header: "Personen", value: (p) => p.partySize },
  email: { header: "E-Mail (Gäste)", value: (p) => p.email ?? "" },
  kind: { header: "Art", value: (p) => (p.kind === "guest" ? "Gast" : p.kind === "member" ? "Mitglied (ohne Konto)" : "Mitglied") },
  respondedAt: { header: "Angemeldet am", value: (p) => p.respondedAt.toISOString() },
  registeredBy: { header: "Angemeldet durch", value: (p) => p.registeredBy ?? "" },
};

/** CSV export (Excel-DE friendly, formula-escaped). `columns` = comma separated base columns and form field keys; default: all. */
eventParticipantRoutes.get("/:id/registrations.csv", async (c) => {
  const { event } = await loadForRead(c);
  const clubId = c.get("clubId");
  const { participants, fields } = await list(c, event.id, clubId);
  const requested = (c.req.query("columns") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const allKeys = [...Object.keys(BASE_COLUMNS), ...fields.map((f) => f.key)];
  const chosen = requested.length > 0 ? requested : allKeys;
  const unknown = chosen.filter((k) => !allKeys.includes(k));
  if (unknown.length > 0) throw new ValidationError("Unknown columns", { details: { code: "unknown_column", columns: unknown } });
  const header = chosen.map((k) => BASE_COLUMNS[k]?.header ?? fields.find((f) => f.key === k)!.label);
  const rows = participants.map((p) => chosen.map((k) => (BASE_COLUMNS[k] ? BASE_COLUMNS[k]!.value(p) : answerCell(p.answers[k]))));
  await writeAudit(db, { eventType: "event_registration.export", subjectId: event.id, payload: { clubId, eventId: event.id, rows: rows.length, columns: chosen.length } });
  return c.body(buildCsv(header, rows), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="anmeldungen.csv"', "Cache-Control": "private, no-store" });
});

const statusSchema = z.object({
  status: z.enum(["angemeldet", "warteliste", "abgesagt"]),
  /** Seat a person although the event is full (the organiser knows better). */
  force: z.boolean().optional(),
});

/** The organiser moves somebody up, back to the waitlist or removes the registration (the person is told). */
eventParticipantRoutes.patch("/:id/registrations/:attendeeId", needsPermission("calendars:write"), zValidator("json", statusSchema, hook), async (c) => {
  const clubId = c.get("clubId");
  const { event } = await loadClubEvent(c.req.param("id"), clubId);
  const attendeeId = c.req.param("attendeeId");
  if (!isUuid(attendeeId)) throw new NotFoundError("Registration not found");
  const body = c.req.valid("json");

  const outcome = await db.transaction(async (tx) => {
    const locked = await lockEvent(tx, event.id);
    const [row] = await tx.select().from(eventAttendees).where(and(eq(eventAttendees.id, attendeeId), eq(eventAttendees.eventId, event.id))).for("update");
    if (!row) throw new NotFoundError("Registration not found");
    if (row.status === "unbestaetigt") throw new ConflictError("The guest has not confirmed the e-mail address yet", { details: { code: "not_confirmed" } });
    let promoted: Awaited<ReturnType<typeof promoteWaitlist>> = [];
    if (body.status === "abgesagt") {
      await tx.delete(eventAttendees).where(eq(eventAttendees.id, row.id));
      if (row.formSubmissionId) await tx.delete(formSubmissions).where(eq(formSubmissions.id, row.formSubmissionId));
      if (row.status === "angemeldet") promoted = await promoteWaitlist(tx, locked, clubId);
    } else if (body.status === "angemeldet") {
      if (row.status !== "angemeldet") {
        const taken = await takenSeats(tx, event.id, { attendeeId: row.id });
        if (!fits(locked.capacity, taken, row.partySize) && !body.force) throw new ConflictError("Not enough free seats", { details: { code: "capacity_exceeded", free: Math.max(0, (locked.capacity ?? 0) - taken) } });
        await tx.update(eventAttendees).set({ status: "angemeldet" }).where(eq(eventAttendees.id, row.id));
        promoted = [{ kind: "attendee", id: row.id, respondedAt: row.respondedAt }];
      }
    } else if (row.status === "angemeldet") {
      await tx.update(eventAttendees).set({ status: "warteliste" }).where(eq(eventAttendees.id, row.id));
    }
    await writeAudit(tx, { eventType: "event_registration.status", subjectId: event.id, payload: { clubId, eventId: event.id, attendeeId: row.id, status: body.status, forced: body.force === true } });
    return { row, promoted };
  });

  if (body.status === "abgesagt") await notifyRegistrationRemoved({ clubId, event, row: outcome.row });
  await notifyPromoted({ clubId, event, promoted: outcome.promoted });
  return c.json({ data: { id: outcome.row.id, status: body.status === "abgesagt" ? null : body.status } });
});
