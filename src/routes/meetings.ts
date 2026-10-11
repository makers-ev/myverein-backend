import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import { MEETING_TYPES, meetingAttendance, meetingInvitees, meetingResolutions, meetings } from "../db/schema/meetings.js";
import { computeAvailability, type AvailabilityInput } from "../lib/availability-match.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const meetingRoutes = new Hono<ClubEnv>();

meetingRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
meetingRoutes.use("*", sessionGuard);
meetingRoutes.use("*", clubGuard);

/** Board-level readers: meetings:write or meetings:read_board see every meeting of the club. */
function canReadAllMeetings(roleTypes: readonly string[]) {
  return hasClubPermission(roleTypes, "meetings:write") || hasClubPermission(roleTypes, "meetings:read_board");
}

/**
 * Loads a meeting scoped to the caller's club AND to what the caller may read, 404s (never 403, never leaks
 * existence) otherwise. Read scoping (B8): a `vorstandssitzung` is only visible to invitees and to
 * meetings:write / meetings:read_board; `mitgliederversammlung` and `sonstige` are visible to every member.
 */
async function loadClubMeeting(c: Context<ClubEnv>, id: string) {
  const clubId = c.get("clubId");
  const row = await db.query.meetings.findFirst({ where: and(eq(meetings.id, id), eq(meetings.clubId, clubId)) });
  if (!row) throw new NotFoundError("Meeting not found");
  if (row.type === "vorstandssitzung" && !canReadAllMeetings(c.get("clubRoleTypes"))) {
    const invited = await db.query.meetingInvitees.findFirst({
      where: and(eq(meetingInvitees.meetingId, id), eq(meetingInvitees.memberId, c.get("membership").id)),
    });
    if (!invited) throw new NotFoundError("Meeting not found");
  }
  return row;
}

// --- Meetings CRUD ---------------------------------------------------------

meetingRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");

  // Vorstandssitzungen are filtered out unless the caller is board-level or invited.
  const visible = canReadAllMeetings(c.get("clubRoleTypes"))
    ? undefined
    : or(
        ne(meetings.type, "vorstandssitzung"),
        inArray(
          meetings.id,
          db.select({ id: meetingInvitees.meetingId }).from(meetingInvitees).where(eq(meetingInvitees.memberId, c.get("membership").id)),
        ),
      );

  const rows = await db.query.meetings.findMany({
    where: and(eq(meetings.clubId, clubId), visible),
    // Postgres sorts NULLS LAST on ASC by default, so still-scheduling
    // meetings (scheduledAt = null, i.e. Terminfindung) land at the end.
    orderBy: (m, { asc }) => [asc(m.scheduledAt), asc(m.createdAt)],
  });

  return c.json({ data: rows });
});

meetingRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await loadClubMeeting(c, id);
  return c.json({ data: row });
});

const createMeetingSchema = z.object({
  type: z.enum(MEETING_TYPES),
  title: z.string().min(1).max(300),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  agenda: z.string().optional(),
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

    const [row] = await db
      .insert(meetings)
      .values({
        clubId,
        type: body.type,
        title: body.title,
        scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : undefined,
        agenda: body.agenda,
        status: body.scheduledAt ? "geplant" : "terminfindung",
        createdBy: currentUser.id,
      })
      .returning();

    await db.insert(auditLog).values({ eventType: "meeting.create", subjectId: row.id, payload: { clubId, type: row.type } });

    return c.json({ data: row }, 201);
  },
);

const updateMeetingSchema = z.object({
  type: z.enum(MEETING_TYPES).optional(),
  title: z.string().min(1).max(300).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
  agenda: z.string().nullable().optional(),
  status: z.string().min(1).optional(),
  minutes: z.string().nullable().optional(),
});

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
    const body = c.req.valid("json");
    await loadClubMeeting(c, id);

    const [row] = await db
      .update(meetings)
      .set({
        ...body,
        scheduledAt: body.scheduledAt === undefined ? undefined : body.scheduledAt === null ? null : new Date(body.scheduledAt),
        updatedAt: new Date(),
      })
      .where(eq(meetings.id, id))
      .returning();

    await db.insert(auditLog).values({ eventType: "meeting.update", subjectId: id, payload: { clubId, changes: body } });

    return c.json({ data: row });
  },
);

meetingRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "meetings:write")) {
    throw new ForbiddenError("Missing meetings:write permission");
  }
  const id = c.req.param("id");
  await loadClubMeeting(c, id);

  await db.delete(meetings).where(eq(meetings.id, id));
  await db.insert(auditLog).values({ eventType: "meeting.delete", subjectId: id, payload: { clubId } });

  return c.body(null, 204);
});

// --- Invitees ---------------------------------------------------------------
// Same meeting_invitees table serves both the Terminfindung candidate list
// (before scheduledAt is set) and zu-/absage tracking afterwards.

meetingRoutes.get("/:id/invitees", async (c) => {
  const id = c.req.param("id");
  await loadClubMeeting(c, id);

  const rows = await db.query.meetingInvitees.findMany({ where: eq(meetingInvitees.meetingId, id) });
  return c.json({ data: rows });
});

const addInviteeSchema = z.object({ memberId: z.string().min(1) });

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
    await loadClubMeeting(c, id);
    const { memberId } = c.req.valid("json");

    const memberRow = await db.query.member.findFirst({ where: and(eq(member.id, memberId), eq(member.organizationId, clubId)) });
    if (!memberRow) throw new NotFoundError("Member not found in this club");

    const existing = await db.query.meetingInvitees.findFirst({
      where: and(eq(meetingInvitees.meetingId, id), eq(meetingInvitees.memberId, memberId)),
    });
    if (existing) throw new ConflictError("Member is already invited to this meeting");

    const [row] = await db.insert(meetingInvitees).values({ meetingId: id, memberId, response: "ausstehend" }).returning();

    await db.insert(auditLog).values({ eventType: "meeting_invitee.add", subjectId: id, payload: { clubId, memberId } });

    return c.json({ data: row }, 201);
  },
);

meetingRoutes.delete("/:id/invitees/:memberId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "meetings:write")) {
    throw new ForbiddenError("Missing meetings:write permission");
  }
  const id = c.req.param("id");
  const memberId = c.req.param("memberId");
  await loadClubMeeting(c, id);

  const existing = await db.query.meetingInvitees.findFirst({
    where: and(eq(meetingInvitees.meetingId, id), eq(meetingInvitees.memberId, memberId)),
  });
  if (!existing) throw new NotFoundError("Invitee not found");

  await db.delete(meetingInvitees).where(eq(meetingInvitees.id, existing.id));
  await db.insert(auditLog).values({ eventType: "meeting_invitee.remove", subjectId: id, payload: { clubId, memberId } });

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
    const membership = c.get("membership");
    const id = c.req.param("id");
    await loadClubMeeting(c, id);
    const { response } = c.req.valid("json");

    const existing = await db.query.meetingInvitees.findFirst({
      where: and(eq(meetingInvitees.meetingId, id), eq(meetingInvitees.memberId, membership.id)),
    });
    if (!existing) throw new NotFoundError("Not invited to this meeting");

    const [row] = await db.update(meetingInvitees).set({ response }).where(eq(meetingInvitees.id, existing.id)).returning();

    await db.insert(auditLog).values({ eventType: "meeting_invitee.respond", subjectId: id, payload: { clubId, memberId: membership.id, response } });

    return c.json({ data: row });
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
  const inviteeRows = await db.query.meetingInvitees.findMany({ where: eq(meetingInvitees.meetingId, id) });
  const memberIds = inviteeRows.map((r) => r.memberId);

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

meetingRoutes.get("/:id/attendance", async (c) => {
  const id = c.req.param("id");
  await loadClubMeeting(c, id);

  const rows = await db.query.meetingAttendance.findMany({ where: eq(meetingAttendance.meetingId, id) });
  return c.json({ data: rows });
});

// Partial-update semantics: only the fields an entry actually carries are written, and only the members
// listed in the batch are touched -- re-saving never resets unlisted members or omitted fields (B17).
// `proxyForMemberId: null` clears a proxy (Vollmacht).
const attendanceEntrySchema = z.object({
  memberId: z.string().min(1),
  present: z.boolean().optional(),
  hasVotingRight: z.boolean().optional(),
  proxyForMemberId: z.string().min(1).nullable().optional(),
});
const attendanceBatchSchema = z.array(attendanceEntrySchema).min(1);

meetingRoutes.patch(
  "/:id/attendance",
  zValidator("json", attendanceBatchSchema, (result) => {
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
    const entries = c.req.valid("json");

    for (const entry of entries) {
      if (entry.proxyForMemberId && entry.proxyForMemberId === entry.memberId) {
        throw new ValidationError("A member cannot be their own proxy (proxyForMemberId must differ from memberId)");
      }
    }

    // Verify every referenced member (attendee AND proxy-giver) belongs to
    // the caller's club BEFORE writing anything -- a bad entry in the batch
    // must reject the whole batch, not leave a partial write.
    const referencedIds = [...new Set(entries.flatMap((e) => (e.proxyForMemberId ? [e.memberId, e.proxyForMemberId] : [e.memberId])))];
    const memberRows = await db.query.member.findMany({ where: and(inArray(member.id, referencedIds), eq(member.organizationId, clubId)) });
    if (memberRows.length !== referencedIds.length) {
      throw new NotFoundError("One or more members not found in this club");
    }

    await db.transaction(async (tx) => {
      for (const entry of entries) {
        const patch = {
          ...(entry.present !== undefined ? { present: entry.present } : {}),
          ...(entry.hasVotingRight !== undefined ? { hasVotingRight: entry.hasVotingRight } : {}),
          ...(entry.proxyForMemberId !== undefined ? { proxyForMemberId: entry.proxyForMemberId } : {}),
        };
        await tx
          .insert(meetingAttendance)
          .values({ meetingId: id, memberId: entry.memberId, ...patch })
          .onConflictDoUpdate({
            target: [meetingAttendance.meetingId, meetingAttendance.memberId],
            // An entry without any field is a no-op on an existing row (set it to itself to keep the statement valid).
            set: Object.keys(patch).length > 0 ? patch : { meetingId: id },
          });
      }

      // One audit entry summarizing the batch, not one per row -- this data
      // carries real legal weight (Mitgliederversammlung-Protokolle), but
      // per-row audit entries here would just be noise.
      await tx.insert(auditLog).values({
        eventType: "meeting_attendance.record",
        subjectId: id,
        payload: { clubId, meetingId: id, count: entries.length },
      });
    });

    const rows = await db.query.meetingAttendance.findMany({ where: eq(meetingAttendance.meetingId, id) });
    return c.json({ data: rows });
  },
);

// --- Resolutions (Beschluesse) ------------------------------------------------

meetingRoutes.get("/:id/resolutions", async (c) => {
  const id = c.req.param("id");
  await loadClubMeeting(c, id);

  const rows = await db.query.meetingResolutions.findMany({ where: eq(meetingResolutions.meetingId, id) });
  return c.json({ data: rows });
});

const createResolutionSchema = z.object({
  description: z.string().min(1),
  votesFor: z.number().int().min(0),
  votesAgainst: z.number().int().min(0),
  votesAbstain: z.number().int().min(0),
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
    await db.insert(auditLog).values({
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
    votesFor: z.number().int().min(0).optional(),
    votesAgainst: z.number().int().min(0).optional(),
    votesAbstain: z.number().int().min(0).optional(),
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

    await db.insert(auditLog).values({
      eventType: "meeting_resolution.correct",
      subjectId: rid,
      payload: {
        clubId,
        meetingId: id,
        correctionNote,
        before: {
          description: existing.description,
          votesFor: existing.votesFor,
          votesAgainst: existing.votesAgainst,
          votesAbstain: existing.votesAbstain,
          result: existing.result,
          correctionNote: existing.correctionNote,
        },
        after: changes,
      },
    });

    return c.json({ data: row });
  },
);
