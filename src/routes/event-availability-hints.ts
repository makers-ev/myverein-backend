import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { calendars } from "../db/schema/calendars.js";
import { writeAudit } from "../lib/audit.js";
import { availabilityHints, MAX_WINDOW_DAYS } from "../lib/availability-hints.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { loadClubEvent, ownDepartmentIds } from "../lib/event-access.js";
import type { ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";

/**
 * `GET /events/availability-hints` (Wave 16 T6): "Wer hat Zeit?" while creating or editing a calendar event. Mounted inside
 * `eventRoutes` (session + club guard already ran) BEFORE `GET /events/:id`. Deny by default:
 * - `calendars:write` (who manages events): counters and the names of the people who are NOT available (D2);
 * - trainer / department lead with `attendance:write` for a department calendar of their own department: counters only;
 * - everybody else 403 (checked before anything is looked up).
 * Only a hint (D4); a read with names is audited as `availability.sensitive_read` (ids and counts only).
 */

const hook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid query", { details: result.error?.issues });
};

const instant = z.string().datetime({ offset: true });
const query = z.object({ startsAt: instant, endsAt: instant.optional(), calendarId: z.uuid(), eventId: z.uuid().optional() });

export const eventAvailabilityHintRoutes = new Hono<ClubEnv>();

eventAvailabilityHintRoutes.get(
  "/",
  async (c, next) => {
    const roles = c.get("clubRoleTypes");
    if (!hasClubPermission(roles, "calendars:write") && !hasClubPermission(roles, "attendance:write")) throw new ForbiddenError("Missing calendars:write permission");
    await next();
  },
  // The client refetches while date/time/calendar change; 30 per minute and person is plenty and bounds the reading of availability.
  rateLimit({ windowMs: 60_000, max: 30, key: (c) => `availability-hints:${c.get("user")?.id ?? "anonymous"}` }),
  zValidator("query", query, hook),
  async (c) => {
    const clubId = c.get("clubId");
    const roles = c.get("clubRoleTypes");
    const q = c.req.valid("query");
    const startsAt = new Date(q.startsAt);
    const endsAt = q.endsAt ? new Date(q.endsAt) : null;
    if (endsAt && endsAt <= startsAt) throw new ValidationError("endsAt must be after startsAt", { details: { code: "invalid_time" } });
    if (endsAt && endsAt.getTime() - startsAt.getTime() > MAX_WINDOW_DAYS * 86_400_000) throw new ValidationError(`The window covers at most ${MAX_WINDOW_DAYS} days`, { details: { code: "range_too_long" } });

    const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, q.calendarId), eq(calendars.clubId, clubId)) });
    if (!calendar) throw new NotFoundError("Calendar not found");
    const withNames = hasClubPermission(roles, "calendars:write");
    if (!withNames) {
      const own = calendar.departmentId !== null && (await ownDepartmentIds(c.get("membership").id, roles)).includes(calendar.departmentId);
      if (!own) throw new ForbiddenError("Availability hints are only shown for calendars of your own departments");
    }
    if (q.eventId) {
      const { event } = await loadClubEvent(q.eventId, clubId);
      // Counters-only callers stay inside their calendar; managers may move an event to another calendar.
      if (!withNames && event.calendarId !== calendar.id) throw new NotFoundError("Event not found");
    }

    const hints = await availabilityHints(clubId, calendar, { startsAt, endsAt, eventId: q.eventId ?? null }, withNames);
    if (withNames && hints.unavailablePeople.length > 0) {
      await writeAudit(db, { eventType: "availability.sensitive_read", subjectId: null, payload: { clubId, calendarId: calendar.id, eventId: q.eventId ?? null, count: hints.unavailablePeople.length } });
    }
    c.header("Cache-Control", "private, no-store");
    return c.json({
      data: {
        calendarId: calendar.id,
        eventId: q.eventId ?? null,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt ? endsAt.toISOString() : null,
        timezone: hints.timezone,
        pool: hints.pool,
        counts: hints.counts,
        includesNames: withNames,
        unavailablePeople: withNames ? hints.unavailablePeople : null,
        truncated: hints.truncated,
      },
    });
  },
);
