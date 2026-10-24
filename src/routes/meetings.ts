import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { meetingMinutes, meetingProxies } from "../db/schema/assembly.js";
import { clubMailLanguage } from "../lib/club-settings.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import { MEETING_TYPES, meetingAttendance, meetingInvitees, meetingResolutions, meetings } from "../db/schema/meetings.js";
import { computeAvailability, type AvailabilityInput } from "../lib/availability-match.js";
import { announceMeetingInvitation, clubTimezone, composeEventMessage, isOpenMeeting, locationName, meetingAudience, scheduleEventChanged } from "../lib/event-notify.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { grantProxy, isEligible, loadEligibility } from "../lib/assembly-attendance.js";
import { callerClubMemberId, clubMembersByIds, resolveClubMember } from "../lib/meeting-members.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { loadClubMeeting, canReadAllMeetings, denyGuests } from "../lib/meeting-access.js";
import { meetingAssemblyRoutes } from "./meeting-assembly.js";
import { meetingMinutesRoutes } from "./meeting-minutes.js";
import { attachMinutes, saveMinutesDraft } from "../lib/minutes.js";
import { rescheduleCheck } from "../lib/assembly-invitation.js";
import { assertParticipation, PARTICIPATION_MODES, withVisibleOnlineUrl } from "../lib/meeting-online.js";
import { meetingOnlineRoutes } from "./meeting-online.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";
import { writeAudit } from "../lib/audit.js";

export const meetingRoutes = new Hono<ClubEnv>();

meetingRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
meetingRoutes.use("*", sessionGuard);
meetingRoutes.use("*", clubGuard);

// Agenda items and invitations of the general assembly (Wave 11) live in their own file, behind the same guards.
meetingRoutes.route("/", meetingAssemblyRoutes);
meetingRoutes.route("/", meetingMinutesRoutes);
meetingRoutes.route("/", meetingOnlineRoutes);

// --- Meetings CRUD ---------------------------------------------------------

meetingRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  denyGuests(c);

  // Vorstandssitzungen are filtered out unless the caller is board-level or invited.
  const me = await callerClubMemberId(db, clubId, c.get("membership").id);
  const visible = canReadAllMeetings(c.get("clubRoleTypes"))
    ? undefined
    : or(
        ne(meetings.type, "vorstandssitzung"),
        inArray(
          meetings.id,
          me ? db.select({ id: meetingInvitees.meetingId }).from(meetingInvitees).where(eq(meetingInvitees.clubMemberId, me)) : sql`(select null::uuid where false)`,
        ),
      );

  const rows = await db.query.meetings.findMany({
    where: and(eq(meetings.clubId, clubId), visible),
    // Postgres sorts NULLS LAST on ASC by default, so still-scheduling
    // meetings (scheduledAt = null, i.e. Terminfindung) land at the end.
    orderBy: (m, { asc }) => [asc(m.scheduledAt), asc(m.createdAt)],
  });

  return c.json({ data: await withVisibleOnlineUrl(c, await attachMinutes(rows, hasClubPermission(c.get("clubRoleTypes"), "meetings:write") || hasClubPermission(c.get("clubRoleTypes"), "assembly:manage"))) });
});

meetingRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await loadClubMeeting(c, id);
  return c.json({ data: (await withVisibleOnlineUrl(c, await attachMinutes([row], hasClubPermission(c.get("clubRoleTypes"), "meetings:write") || hasClubPermission(c.get("clubRoleTypes"), "assembly:manage"))))[0] });
});

const joinUrlSchema = cleanText(z.string().trim().max(500), false).refine((v) => /^https:\/\/[^\s]+$/.test(v), { message: "must be an https URL" });

const createMeetingSchema = z.object({
  type: z.enum(MEETING_TYPES),
  title: z.string().min(1).max(300),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  agenda: z.string().optional(),
  /** Hybrid / virtual only when the statute parameters allow it (`onlineAllowed`); the link is shown to the invited only. */
  participationMode: z.enum(PARTICIPATION_MODES).optional(),
  onlineUrl: joinUrlSchema.nullable().optional(),
});

meetingRoutes.post(
  "/",
  zValidator("json", createMeetingSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    const currentUser = c.get("user");
    if (!hasClubPermission(roleTypes, "meetings:write")) {
      throw new ForbiddenError("Missing meetings:write permission");
    }
    const body = c.req.valid("json");
    await assertParticipation(clubId, body.participationMode ?? "praesenz", body.onlineUrl ?? null);

    const [row] = await db
      .insert(meetings)
      .values({
        clubId,
        type: body.type,
        title: body.title,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        agenda: body.agenda,
        participationMode: body.participationMode,
        onlineUrl: body.onlineUrl,
        status: body.scheduledAt ? "geplant" : "terminfindung",
        createdBy: currentUser.id,
      })
      .returning();

    await writeAudit(db, { eventType: "meeting.create", subjectId: row.id, payload: { clubId, type: row.type } });

    return c.json({ data: row }, 201);
  },
);

const updateMeetingSchema = z.object({
  type: z.enum(MEETING_TYPES).optional(),
  title: z.string().min(1).max(300).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  agenda: z.string().nullable().optional(),
  status: z.string().min(1).optional(),
  /** Redirected to the working draft of the minutes (409 once the version is locked); `null` clears the draft. */
  minutes: cleanText(z.string().max(200_000), true).nullable().optional(),
  participationMode: z.enum(PARTICIPATION_MODES).optional(),
  onlineUrl: joinUrlSchema.nullable().optional(),
  /** Needed (with `assembly:manage`) to move the date of an invited assembly although the invitation period is no longer met; recorded and shown in the minutes. */
  exceptionReason: cleanText(z.string().trim().min(1).max(1000), true).optional(),
  /** `false` saves a reschedule / cancellation without telling the invitees (audited). */
  notify: z.boolean().optional(),
});

/** `status` value that marks a cancelled meeting (free-text column; the invitees are told when it is set). */
const CANCELLED_MEETING_STATUS = "abgesagt";

meetingRoutes.patch(
  "/:id",
  zValidator("json", updateMeetingSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "meetings:write")) {
      throw new ForbiddenError("Missing meetings:write permission");
    }
    const id = c.req.param("id");
    const { notify: notifyFlag, minutes, exceptionReason, ...body } = c.req.valid("json");
    const existing = await loadClubMeeting(c, id);

    // The free-text field is the working draft of the minutes now (versions, approval and lock: lib/minutes.ts).
    // After the formal invitation the new date must still meet the statute period (counted from the day the invitation went out).
    let scheduleException: Record<string, unknown> | null = null;
    if (body.scheduledAt !== undefined && existing.type === "mitgliederversammlung" && body.scheduledAt !== existing.scheduledAt?.toISOString()) {
      if (body.scheduledAt === null) {
        if (await rescheduleCheck(id, new Date(), await clubTimezone(clubId))) throw new ValidationError("An invited assembly keeps its date", { details: { code: "meeting_without_date" } });
      } else {
        const failed = await rescheduleCheck(id, new Date(body.scheduledAt), await clubTimezone(clubId));
        if (failed) {
          if (!exceptionReason) throw new ValidationError("The invitation period is no longer met for the new date", { details: { code: "invitation_period_violated", ...failed.period } });
          if (!hasClubPermission(roleTypes, "assembly:manage")) throw new ForbiddenError("Missing assembly:manage permission for an exception");
          scheduleException = { at: new Date().toISOString(), from: existing.scheduledAt?.toISOString() ?? null, to: body.scheduledAt, reason: exceptionReason, requiredDays: failed.period.requiredDays, daysAvailable: failed.period.daysAvailable, by: c.get("user").id };
        }
      }
    }
    if (body.participationMode !== undefined || body.onlineUrl !== undefined) {
      const mode = (body.participationMode ?? existing.participationMode) as (typeof PARTICIPATION_MODES)[number];
      // Switching back to the room clears the link; a link on a room meeting is refused.
      if (mode === "praesenz" && body.onlineUrl === undefined) body.onlineUrl = null;
      // An unchanged mode stays valid even if the statute parameters changed since; only a change is checked.
      if (body.participationMode !== undefined && body.participationMode !== existing.participationMode) await assertParticipation(clubId, mode, body.onlineUrl ?? null);
      else if (mode === "praesenz" && body.onlineUrl) throw new ValidationError("A join link needs the mode hybrid or virtual", { details: { code: "online_url_requires_mode" } });
    }
    if (minutes !== undefined) await saveMinutesDraft({ clubId, meetingId: id, content: minutes ?? "", userId: c.get("user").id });

    const [row] = await db
      .update(meetings)
      .set({
        ...body,
        scheduledAt: body.scheduledAt === undefined ? undefined : body.scheduledAt === null ? null : new Date(body.scheduledAt),
        ...(scheduleException ? { scheduleExceptions: [...existing.scheduleExceptions, scheduleException] } : {}),
        updatedAt: new Date(),
      })
      .where(eq(meetings.id, id))
      .returning();

    await writeAudit(db, { eventType: "meeting.update", subjectId: id, payload: { clubId, changedFields: [...Object.keys(body), ...(minutes !== undefined ? ["minutes"] : [])], ...(notifyFlag === false ? { notify: false } : {}) } });

    // A moved or cancelled meeting is announced to the invitees (B10).
    const cancelled = row!.status === CANCELLED_MEETING_STATUS && existing.status !== CANCELLED_MEETING_STATUS;
    const moved = existing.status !== CANCELLED_MEETING_STATUS && row!.scheduledAt !== null && row!.scheduledAt.getTime() !== existing.scheduledAt?.getTime();
    if (cancelled || moved) {
      try {
        const audience = await meetingAudience(clubId, id);
        const timezone = await clubTimezone(clubId);
        const place = await locationName(clubId, row!.locationId);
        const message = composeEventMessage({
          lang: await clubMailLanguage(db, clubId),
          noun: "Treffen",
          title: row!.title,
          timezone,
          before: { startsAt: existing.scheduledAt, endsAt: null, place },
          after: { startsAt: row!.scheduledAt, endsAt: null, place },
          cancelled,
        });
        const payload = { clubId, kind: "meeting" as const, refId: id, version: row!.updatedAt.getTime(), cancelled, ...message, audience: audience ?? { memberIds: [], includeGuardians: false } };
        if (notifyFlag === false || audience !== null) await scheduleEventChanged(payload, { suppressed: notifyFlag === false, actor: c.get("user").id });
      } catch {
        // Best effort: the meeting itself is already saved.
      }
    }

    return c.json({ data: (await attachMinutes([row!], true))[0] });
  },
);

meetingRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "meetings:write")) {
    throw new ForbiddenError("Missing meetings:write permission");
  }
  const id = c.req.param("id");
  const existing = await loadClubMeeting(c, id);
  // Approved minutes (and the record of a decision) belong to the club's documents: the meeting stays.
  const approved = await db.query.meetingMinutes.findFirst({ where: and(eq(meetingMinutes.meetingId, id), inArray(meetingMinutes.status, ["genehmigt", "archiviert"])), columns: { id: true } });
  if (approved) throw new ConflictError("A meeting with approved minutes cannot be deleted", { details: { code: "minutes_approved" } });

  // Deleting a meeting that is still open (Terminfindung or planned) is a cancellation for the invitees: capture them before they vanish.
  const notifyFlag = c.req.query("notify");
  const audience = isOpenMeeting(existing) ? await meetingAudience(clubId, id) : null;

  await db.delete(meetings).where(eq(meetings.id, id));
  await writeAudit(db, { eventType: "meeting.delete", subjectId: id, payload: { clubId, ...(notifyFlag === "false" ? { notify: false } : {}) } });

  if (audience !== null) {
    try {
      const timezone = await clubTimezone(clubId);
      const message = composeEventMessage({
        lang: await clubMailLanguage(db, clubId),
        noun: "Treffen",
        title: existing.title,
        timezone,
        before: { startsAt: existing.scheduledAt, endsAt: null, place: await locationName(clubId, existing.locationId) },
        after: { startsAt: null, endsAt: null, place: null },
        cancelled: true,
      });
      await scheduleEventChanged({ clubId, kind: "meeting", refId: id, version: Date.now(), cancelled: true, ...message, audience }, { suppressed: notifyFlag === "false", actor: c.get("user").id });
    } catch {
      // Best effort: the meeting itself is already deleted.
    }
  }

  return c.body(null, 204);
});

// --- Invitees ---------------------------------------------------------------
// Same meeting_invitees table serves both the Terminfindung candidate list
// (before scheduledAt is set) and zu-/absage tracking afterwards. Rows point at club_members, so members without an
// account can be invited; `memberId` (the account membership id) stays as a read/write alias for the transition.

/** Names only for the roles that manage meetings; everybody else who may read the meeting gets ids (as before). */
function showNames(c: Context<ClubEnv>) {
  return canReadAllMeetings(c.get("clubRoleTypes"));
}

async function shapeInvitees(c: Context<ClubEnv>, rows: Array<typeof meetingInvitees.$inferSelect>) {
  const people = await clubMembersByIds(db, c.get("clubId"), rows.map((r) => r.clubMemberId));
  const names = showNames(c);
  return rows.map((r) => ({
    id: r.id,
    meetingId: r.meetingId,
    clubMemberId: r.clubMemberId,
    memberId: people.get(r.clubMemberId)?.memberId ?? null,
    ...(names ? { displayName: people.get(r.clubMemberId)?.displayName ?? null } : {}),
    response: r.response,
  }));
}

meetingRoutes.get("/:id/invitees", async (c) => {
  const id = c.req.param("id");
  await loadClubMeeting(c, id);

  const rows = await db.query.meetingInvitees.findMany({ where: eq(meetingInvitees.meetingId, id) });
  return c.json({ data: await shapeInvitees(c, rows) });
});

const addInviteeSchema = z
  .object({
    clubMemberId: z.string().uuid().optional(),
    /** Alias for the transition: the account membership id. */
    memberId: z.string().min(1).optional(),
    /** `false` adds the person without telling them (audited). Default: the invitation is announced (club switch `notify_meeting_invites`). */
    notify: z.boolean().optional(),
  })
  .refine((v) => v.clubMemberId || v.memberId, { message: "clubMemberId is required" });

meetingRoutes.post(
  "/:id/invitees",
  zValidator("json", addInviteeSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "meetings:write")) {
      throw new ForbiddenError("Missing meetings:write permission");
    }
    const id = c.req.param("id");
    const meeting = await loadClubMeeting(c, id);
    const { notify: notifyFlag, ...ref } = c.req.valid("json");

    const person = await resolveClubMember(db, clubId, ref);
    if (!person) throw new NotFoundError("Member not found in this club");

    const existing = await db.query.meetingInvitees.findFirst({
      where: and(eq(meetingInvitees.meetingId, id), eq(meetingInvitees.clubMemberId, person.id)),
    });
    if (existing) throw new ConflictError("Member is already invited to this meeting");

    const [row] = await db.insert(meetingInvitees).values({ meetingId: id, clubMemberId: person.id, response: "ausstehend" }).returning();

    await writeAudit(db, { eventType: "meeting_invitee.add", subjectId: id, payload: { clubId, memberId: person.id, ...(notifyFlag === false ? { notify: false } : {}) } });
    await announceMeetingInvitation({ clubId, actor: c.get("user").id, meeting, invitee: row, suppress: notifyFlag === false });

    return c.json({ data: (await shapeInvitees(c, [row!]))[0] }, 201);
  },
);

meetingRoutes.delete("/:id/invitees/:memberId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "meetings:write")) {
    throw new ForbiddenError("Missing meetings:write permission");
  }
  const id = c.req.param("id");
  const ref = c.req.param("memberId");
  await loadClubMeeting(c, id);

  // The path carries the club member id; an account membership id (legacy) is accepted as well.
  const isUuid = z.string().uuid().safeParse(ref).success;
  const person = await resolveClubMember(db, clubId, isUuid ? { clubMemberId: ref } : { memberId: ref });
  const existing = person ? await db.query.meetingInvitees.findFirst({ where: and(eq(meetingInvitees.meetingId, id), eq(meetingInvitees.clubMemberId, person.id)) }) : undefined;
  if (!existing) throw new NotFoundError("Invitee not found");

  await db.delete(meetingInvitees).where(eq(meetingInvitees.id, existing.id));
  await writeAudit(db, { eventType: "meeting_invitee.remove", subjectId: id, payload: { clubId, memberId: existing.clubMemberId } });

  return c.body(null, 204);
});

// Self-service RSVP for the caller's own invitee row -- not in the vault's
// Technical Reference table (which only lists board-managed POST/DELETE on
// this sub-resource), same class of gap Wave 1 found with /my-clubs and
// guardian_links: a necessary small addition, not a silent deviation.
const inviteeResponseSchema = z.object({ response: z.enum(["zugesagt", "abgesagt"]) });

meetingRoutes.patch(
  "/:id/invitees/me",
  zValidator("json", inviteeResponseSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const id = c.req.param("id");
    await loadClubMeeting(c, id);
    const { response } = c.req.valid("json");

    const me = await callerClubMemberId(db, clubId, c.get("membership").id);
    const existing = me ? await db.query.meetingInvitees.findFirst({ where: and(eq(meetingInvitees.meetingId, id), eq(meetingInvitees.clubMemberId, me)) }) : undefined;
    if (!existing) throw new NotFoundError("Not invited to this meeting");

    const [row] = await db.update(meetingInvitees).set({ response }).where(eq(meetingInvitees.id, existing.id)).returning();

    await writeAudit(db, { eventType: "meeting_invitee.respond", subjectId: id, payload: { clubId, memberId: existing.clubMemberId, response } });

    return c.json({ data: (await shapeInvitees(c, [row!]))[0] });
  },
);

// --- Terminfindung overlap: meeting-scoped convenience over /availability/overlap ---

meetingRoutes.get("/:id/overlap", async (c) => {
  const id = c.req.param("id");
  await loadClubMeeting(c, id);

  const candidatesParam = c.req.query("candidates");
  if (!candidatesParam) throw new ValidationError("candidates query param is required");

  const candidateStrs = candidatesParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (candidateStrs.length === 0) throw new ValidationError("candidates must contain at least one value");

  const candidates = candidateStrs.map((s) => {
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) throw new ValidationError(`Invalid candidate timestamp: ${s}`);
    return parsed;
  });

  // Auto-loads the meeting's own invitees -- the whole point of this being
  // meeting-scoped instead of just telling clients to call
  // /availability/overlap directly with a members= list they'd have to
  // assemble themselves.
  // Availability belongs to the account; invitees without an account have none to compare.
  const inviteeRows = await db
    .select({ memberId: clubMembers.memberId })
    .from(meetingInvitees)
    .innerJoin(clubMembers, eq(clubMembers.id, meetingInvitees.clubMemberId))
    .where(eq(meetingInvitees.meetingId, id));
  const memberIds = inviteeRows.flatMap((r) => (r.memberId ? [r.memberId] : []));

  const [slotRows, exceptionRows] = memberIds.length
    ? await Promise.all([
        db.query.availabilitySlots.findMany({ where: inArray(availabilitySlots.memberId, memberIds) }),
        db.query.availabilityExceptions.findMany({ where: inArray(availabilityExceptions.memberId, memberIds) }),
      ])
    : [[], []];

  const inputs: AvailabilityInput[] = memberIds.map((mid) => ({
    memberId: mid,
    slots: slotRows.filter((s) => s.memberId === mid).map((s) => ({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime })),
    exceptions: exceptionRows.filter((e) => e.memberId === mid).map((e) => ({ date: e.date, isAvailable: e.isAvailable })),
  }));

  const data = candidates.map((candidate) => ({
    candidate: candidate.toISOString(),
    availability: computeAvailability(candidate, inputs),
  }));

  return c.json({ data });
});

// --- Attendance --------------------------------------------------------------

/** Attendance rows with the proxies the person holds (`proxyFor` = grantors' club member ids). `memberId` / `proxyForMemberId` are the legacy account aliases. */
async function shapeAttendance(c: Context<ClubEnv>, meetingId: string, rows: Array<typeof meetingAttendance.$inferSelect>) {
  const proxies = await db.query.meetingProxies.findMany({ where: eq(meetingProxies.meetingId, meetingId) });
  const ids = [...rows.map((r) => r.clubMemberId), ...proxies.map((p) => p.grantorClubMemberId)].filter((v): v is string => v !== null);
  const people = await clubMembersByIds(db, c.get("clubId"), [...new Set(ids)]);
  const names = showNames(c);
  return rows.map((r) => {
    const held = proxies.flatMap((p) => (p.holderClubMemberId !== null && p.holderClubMemberId === r.clubMemberId && p.grantorClubMemberId ? [p.grantorClubMemberId] : []));
    return {
      id: r.id,
      meetingId: r.meetingId,
      clubMemberId: r.clubMemberId,
      memberId: r.clubMemberId ? (people.get(r.clubMemberId)?.memberId ?? null) : null,
      ...(names ? { displayName: r.clubMemberId ? (people.get(r.clubMemberId)?.displayName ?? null) : null } : {}),
      present: r.present,
      hasVotingRight: r.hasVotingRight,
      checkedInAt: r.checkedInAt,
      leftAt: r.leftAt,
      checkInMethod: r.checkInMethod,
      proxyFor: held,
      proxyForMemberId: held[0] ? (people.get(held[0])?.memberId ?? null) : null,
    };
  });
}

meetingRoutes.get("/:id/attendance", async (c) => {
  const id = c.req.param("id");
  await loadClubMeeting(c, id);

  const rows = await db.query.meetingAttendance.findMany({ where: eq(meetingAttendance.meetingId, id) });
  return c.json({ data: await shapeAttendance(c, id, rows) });
});

// Partial-update semantics: only the fields an entry actually carries are written, and only the members
// listed in the batch are touched -- re-saving never resets unlisted members or omitted fields (B17).
// `present: true` is the check-in (time + method recorded, a member without account is checked in by the clerk), `present: false`
// after a check-in is leaving (time recorded). `proxyForClubMemberId: null` clears the proxies the person holds; setting one
// applies the statute rules (`grantProxy`). `memberId` / `proxyForMemberId` (account ids) are aliases.
const attendanceEntrySchema = z
  .object({
    clubMemberId: z.string().uuid().optional(),
    memberId: z.string().min(1).optional(),
    present: z.boolean().optional(),
    /** Only while the voting roll is not frozen; afterwards the roll decides (`PATCH /voting-roll/:clubMemberId`). */
    hasVotingRight: z.boolean().optional(),
    /** How the check-in happened (default `schriftfuehrer`). */
    method: z.enum(["schriftfuehrer", "vollmacht"]).optional(),
    proxyForClubMemberId: z.string().uuid().nullable().optional(),
    proxyForMemberId: z.string().min(1).nullable().optional(),
  })
  .refine((v) => v.clubMemberId || v.memberId, { message: "clubMemberId is required" });
const attendanceBatchSchema = z.array(attendanceEntrySchema).min(1).max(500);

meetingRoutes.patch(
  "/:id/attendance",
  zValidator("json", attendanceBatchSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "meetings:write") && !hasClubPermission(roleTypes, "assembly:manage")) {
      throw new ForbiddenError("Missing meetings:write permission");
    }
    const id = c.req.param("id");
    await loadClubMeeting(c, id);
    const entries = c.req.valid("json");

    // Resolve every referenced member (attendee AND proxy-giver) inside the caller's club BEFORE writing anything --
    // a bad entry in the batch must reject the whole batch, not leave a partial write.
    const resolved: Array<{ entry: (typeof entries)[number]; person: ClubMemberRow; grantor: ClubMemberRow | null; clearProxies: boolean }> = [];
    for (const entry of entries) {
      const person = await resolveClubMember(db, clubId, { clubMemberId: entry.clubMemberId, memberId: entry.memberId });
      if (!person) throw new NotFoundError("One or more members not found in this club");
      const proxyRef = entry.proxyForClubMemberId ? { clubMemberId: entry.proxyForClubMemberId } : entry.proxyForMemberId ? { memberId: entry.proxyForMemberId } : null;
      const grantor = proxyRef ? await resolveClubMember(db, clubId, proxyRef) : null;
      if (proxyRef && !grantor) throw new NotFoundError("One or more members not found in this club");
      if (grantor && grantor.id === person.id) {
        throw new ValidationError("A member cannot be their own proxy (proxyForClubMemberId must differ from clubMemberId)");
      }
      resolved.push({ entry, person, grantor, clearProxies: entry.proxyForClubMemberId === null || entry.proxyForMemberId === null });
    }

    await db.transaction(async (tx) => {
      // Serialise with the roll freeze and other batches of this meeting.
      const [locked] = await tx.select().from(meetings).where(eq(meetings.id, id)).for("update");
      const eligibility = await loadEligibility(tx, clubId, locked!);
      const now = new Date();
      for (const { entry, person, grantor, clearProxies } of resolved) {
        if (entry.hasVotingRight !== undefined && eligibility.frozen) {
          throw new ValidationError("The voting roll is frozen: change the voting right with PATCH /voting-roll/:clubMemberId", { details: { code: "use_voting_roll_override" } });
        }
        const [existing] = await tx.select().from(meetingAttendance).where(and(eq(meetingAttendance.meetingId, id), eq(meetingAttendance.clubMemberId, person.id)));
        const patch: Partial<typeof meetingAttendance.$inferInsert> = {};
        if (entry.hasVotingRight !== undefined) patch.hasVotingRight = entry.hasVotingRight;
        if (entry.present === true && !existing?.present) {
          // Whoever gave a proxy cannot also take part: the proxy has to be withdrawn first.
          const [given] = await tx.select({ id: meetingProxies.id }).from(meetingProxies).where(and(eq(meetingProxies.meetingId, id), eq(meetingProxies.grantorClubMemberId, person.id)));
          if (given) throw new ConflictError("This member gave a proxy: withdraw it before checking the member in", { details: { code: "proxy_granted", clubMemberId: person.id } });
          Object.assign(patch, { present: true, checkedInAt: now, leftAt: null, checkInMethod: entry.method ?? "schriftfuehrer" });
        } else if (entry.present === false) {
          Object.assign(patch, { present: false, ...(existing?.present ? { leftAt: now } : {}) });
        }
        // A new row carries the decision of the roll (frozen) or of the live derivation, not a blanket default.
        const insertVoting = entry.hasVotingRight ?? isEligible(eligibility, person.id);
        await tx
          .insert(meetingAttendance)
          .values({ meetingId: id, clubMemberId: person.id, hasVotingRight: insertVoting, ...patch })
          .onConflictDoUpdate({
            target: [meetingAttendance.meetingId, meetingAttendance.clubMemberId],
            // An entry without any field is a no-op on an existing row (set it to itself to keep the statement valid).
            set: Object.keys(patch).length > 0 ? patch : { meetingId: id },
          });
        if (clearProxies) await tx.delete(meetingProxies).where(and(eq(meetingProxies.meetingId, id), eq(meetingProxies.holderClubMemberId, person.id)));
        if (grantor) await grantProxy(tx, { clubId, meeting: locked!, grantorClubMemberId: grantor.id, holderClubMemberId: person.id, grantedBy: c.get("user").id, byBoard: true });
      }

      // One audit entry summarizing the batch, not one per row -- this data
      // carries real legal weight (Mitgliederversammlung-Protokolle), but
      // per-row audit entries here would just be noise.
      await writeAudit(tx, {
        eventType: "meeting_attendance.record",
        subjectId: id,
        payload: { clubId, meetingId: id, count: entries.length },
      });
    });

    const rows = await db.query.meetingAttendance.findMany({ where: eq(meetingAttendance.meetingId, id) });
    return c.json({ data: await shapeAttendance(c, id, rows) });
  },
);

// --- Resolutions (Beschluesse) ------------------------------------------------

meetingRoutes.get("/:id/resolutions", async (c) => {
  const id = c.req.param("id");
  await loadClubMeeting(c, id);

  const rows = await db.query.meetingResolutions.findMany({ where: eq(meetingResolutions.meetingId, id) });
  return c.json({ data: rows });
});

// Upper bound for vote counts (no club has more members; guards against absurd values).
const MAX_VOTES = 100000;

const createResolutionSchema = z.object({
  description: z.string().min(1),
  votesFor: z.number().int().min(0).max(MAX_VOTES),
  votesAgainst: z.number().int().min(0).max(MAX_VOTES),
  votesAbstain: z.number().int().min(0).max(MAX_VOTES),
  result: z.string().min(1),
});

meetingRoutes.post(
  "/:id/resolutions",
  zValidator("json", createResolutionSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "meetings:write")) {
      throw new ForbiddenError("Missing meetings:write permission");
    }
    const id = c.req.param("id");
    await loadClubMeeting(c, id);
    const body = c.req.valid("json");

    const [row] = await db
      .insert(meetingResolutions)
      .values({ meetingId: id, ...body })
      .returning();

    // Same legal-weight reasoning as attendance -- Beschluesse are the
    // record a Mitgliederversammlung is legally judged by.
    await writeAudit(db, {
      eventType: "meeting_resolution.create",
      subjectId: row.id,
      payload: { clubId, meetingId: id },
    });

    return c.json({ data: row }, 201);
  },
);

// Correction instead of silent overwrite: a Berichtigungsvermerk is mandatory, the previous values go to the audit log.
const correctResolutionSchema = z
  .object({
    description: z.string().min(1).optional(),
    votesFor: z.number().int().min(0).max(MAX_VOTES).optional(),
    votesAgainst: z.number().int().min(0).max(MAX_VOTES).optional(),
    votesAbstain: z.number().int().min(0).max(MAX_VOTES).optional(),
    result: z.string().min(1).optional(),
    correctionNote: z.string().trim().min(1).max(2000),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "correctionNote"), { message: "At least one resolution field must be changed" });

meetingRoutes.patch(
  "/:id/resolutions/:rid",
  zValidator("json", correctResolutionSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "meetings:write")) {
      throw new ForbiddenError("Missing meetings:write permission");
    }
    const id = c.req.param("id");
    const rid = c.req.param("rid");
    await loadClubMeeting(c, id);
    const { correctionNote, ...changes } = c.req.valid("json");

    const uuidOk = z.string().uuid().safeParse(rid).success;
    const existing = uuidOk
      ? await db.query.meetingResolutions.findFirst({ where: and(eq(meetingResolutions.id, rid), eq(meetingResolutions.meetingId, id)) })
      : undefined;
    if (!existing) throw new NotFoundError("Resolution not found");

    const [row] = await db
      .update(meetingResolutions)
      .set({ ...changes, correctionNote, correctedAt: new Date(), correctedBy: c.get("user").id })
      .where(eq(meetingResolutions.id, rid))
      .returning();

    await writeAudit(db, {
      eventType: "meeting_resolution.correct",
      subjectId: rid,
      payload: {
        clubId,
        meetingId: id,
        // Field names only: the values and the note are club content (resolution text, counts), not audit data.
        changedFields: Object.keys(changes),
      },
    });

    return c.json({ data: row });
  },
);
