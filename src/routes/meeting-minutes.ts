import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { MINUTES_CONFIRM_ROLES } from "../db/schema/assembly.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { loadClubMeeting } from "../lib/meeting-access.js";
import { addMinutesAmendment, approveMinutes, archiveMinutes, confirmMinutes, exportMinutes, readMinutes, reopenMinutes, saveMinutesDraft, shapeMinutes, submitMinutes, visibleMinutes } from "../lib/minutes.js";
import { cleanText } from "../lib/text-policy.js";
import type { ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";

/**
 * Minutes of a meeting (Wave 11 B9) on top of `/meetings`, mounted into `meetingRoutes` behind the same guards. Read scoping is
 * `loadClubMeeting` (404, never 403): a board meeting's minutes are only visible to the invited and to board readers. Everybody
 * who may read the meeting sees the latest APPROVED version; drafts, versions and confirmations only the managers.
 */
export const meetingMinutesRoutes = new Hono<ClubEnv>();

const validate = <T extends z.ZodType>(schema: T) =>
  zValidator("json", schema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  });

const canManage = (c: Context<ClubEnv>) => hasClubPermission(c.get("clubRoleTypes"), "assembly:manage") || hasClubPermission(c.get("clubRoleTypes"), "meetings:write");

function requireManage(c: Context<ClubEnv>) {
  if (!canManage(c)) throw new ForbiddenError("Missing assembly:manage permission");
}

function requireAssemblyManage(c: Context<ClubEnv>) {
  if (!hasClubPermission(c.get("clubRoleTypes"), "assembly:manage")) throw new ForbiddenError("Missing assembly:manage permission");
}

const idOf = (c: Context<ClubEnv>) => {
  const raw = c.req.param("id") ?? "";
  if (!z.string().uuid().safeParse(raw).success) throw new NotFoundError("Meeting not found");
  return raw;
};

export const MAX_MINUTES_LENGTH = 200_000;
export const minutesContentSchema = cleanText(z.string().max(MAX_MINUTES_LENGTH), true);

meetingMinutesRoutes.get("/:id/minutes", async (c) => {
  const meeting = await loadClubMeeting(c, idOf(c));
  return c.json({ data: await readMinutes(meeting, canManage(c)) });
});

meetingMinutesRoutes.put("/:id/minutes", validate(z.object({ content: minutesContentSchema })), async (c) => {
  requireManage(c);
  const meeting = await loadClubMeeting(c, idOf(c));
  const row = await saveMinutesDraft({ clubId: c.get("clubId"), meetingId: meeting.id, content: c.req.valid("json").content, userId: c.get("user").id });
  return c.json({ data: shapeMinutes(row, []) });
});

meetingMinutesRoutes.post("/:id/minutes/confirm", validate(z.object({ role: z.enum(MINUTES_CONFIRM_ROLES) })), async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, idOf(c));
  await confirmMinutes({ clubId: c.get("clubId"), meetingId: meeting.id, role: c.req.valid("json").role, userId: c.get("user").id });
  return c.json({ data: await readMinutes(meeting, true) });
});

meetingMinutesRoutes.post("/:id/minutes/submit", async (c) => {
  requireManage(c);
  const meeting = await loadClubMeeting(c, idOf(c));
  await submitMinutes({ clubId: c.get("clubId"), meetingId: meeting.id, userId: c.get("user").id });
  return c.json({ data: await readMinutes(meeting, true) });
});

meetingMinutesRoutes.post("/:id/minutes/reopen", async (c) => {
  requireManage(c);
  const meeting = await loadClubMeeting(c, idOf(c));
  await reopenMinutes({ clubId: c.get("clubId"), meetingId: meeting.id, userId: c.get("user").id });
  return c.json({ data: await readMinutes(meeting, true) });
});

meetingMinutesRoutes.post("/:id/minutes/approve", validate(z.object({ resolutionId: z.string().uuid() })), async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, idOf(c));
  await approveMinutes({ clubId: c.get("clubId"), meetingId: meeting.id, resolutionId: c.req.valid("json").resolutionId, userId: c.get("user").id });
  return c.json({ data: await readMinutes(meeting, true) });
});

meetingMinutesRoutes.post("/:id/minutes/archive", async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, idOf(c));
  await archiveMinutes({ clubId: c.get("clubId"), meetingId: meeting.id, userId: c.get("user").id });
  return c.json({ data: await readMinutes(meeting, true) });
});

meetingMinutesRoutes.post("/:id/minutes/amendments", validate(z.object({ note: cleanText(z.string().trim().min(1).max(2000), true) })), async (c) => {
  requireAssemblyManage(c);
  const meeting = await loadClubMeeting(c, idOf(c));
  const row = await addMinutesAmendment({ clubId: c.get("clubId"), meetingId: meeting.id, note: c.req.valid("json").note, userId: c.get("user").id });
  return c.json({ data: { id: row.id, version: row.version, note: row.note, createdAt: row.createdAt } }, 201);
});

// Export of the minutes the caller may see; the body is a document, never a stored file (nothing to sign or cache).
meetingMinutesRoutes.get("/:id/minutes/export", rateLimit({ windowMs: 60_000, max: 20 }), async (c) => {
  const meeting = await loadClubMeeting(c, idOf(c));
  const parsed = z.enum(["html", "md"]).safeParse(c.req.query("format") ?? "html");
  if (!parsed.success) throw new ValidationError("format must be html or md");
  const manage = canManage(c);
  const { body, contentType } = await exportMinutes({ meeting, includeDrafts: manage, includeNames: manage, format: parsed.data });
  const shown = await visibleMinutes(meeting.id, manage);
  await writeAudit(db, { eventType: "meeting_minutes.export", subjectId: meeting.id, payload: { clubId: c.get("clubId"), meetingId: meeting.id, format: parsed.data, version: shown?.version } });
  return c.body(body, 200, {
    "content-type": contentType,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
  });
});
