import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { calendarVisibility } from "../db/schema/calendar-visibility.js";
import { calendars } from "../db/schema/calendars.js";
import { departments } from "../db/schema/departments.js";
import { ensureClubHasCalendar, lockClubCalendars } from "../lib/calendar-defaults.js";
import { getVisibleCalendarIds, isCalendarVisible } from "../lib/calendar-visibility.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";
import { writeAudit } from "../lib/audit.js";

export const calendarRoutes = new Hono<ClubEnv>();

calendarRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
calendarRoutes.use("*", sessionGuard);
calendarRoutes.use("*", clubGuard);

/**
 * A caller with calendars:write sees every club calendar (board oversight --
 * they need to manage visibility grants for calendars they aren't
 * themselves granted to see); everyone else only sees what the visibility
 * algorithm (src/lib/calendar-visibility.ts) grants them.
 */
calendarRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");

  if (hasClubPermission(roleTypes, "calendars:write")) {
    await ensureClubHasCalendar(clubId, { createdBy: c.get("user").id });
    const rows = await db.query.calendars.findMany({ where: eq(calendars.clubId, clubId), orderBy: (cal, { asc }) => [asc(cal.name)] });
    return c.json({ data: rows });
  }

  const visibleIds = await getVisibleCalendarIds(clubId, membership.id, roleTypes);
  const rows = visibleIds.length
    ? await db.query.calendars.findMany({ where: inArray(calendars.id, visibleIds), orderBy: (cal, { asc }) => [asc(cal.name)] })
    : [];
  return c.json({ data: rows });
});

calendarRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const membership = c.get("membership");
  const roleTypes = c.get("clubRoleTypes");
  const id = c.req.param("id");

  const row = await db.query.calendars.findFirst({ where: and(eq(calendars.id, id), eq(calendars.clubId, clubId)) });
  if (!row) throw new NotFoundError("Calendar not found");

  if (!hasClubPermission(roleTypes, "calendars:write") && !(await isCalendarVisible(id, membership.id, roleTypes))) {
    throw new NotFoundError("Calendar not found");
  }

  return c.json({ data: row });
});

function defaultRequired(): ConflictError {
  return new ConflictError("The default club calendar cannot be deleted, unset or moved to a department; make another calendar the default first", {
    details: { code: "default_calendar_required" },
  });
}

const createCalendarSchema = z.object({
  name: z.string().min(1).max(200),
  departmentId: z.string().uuid().optional(),
  isDefault: z.boolean().optional(),
  icalImportUrl: z.string().url().optional(),
});

calendarRoutes.post(
  "/",
  zValidator("json", createCalendarSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    const currentUser = c.get("user");
    if (!hasClubPermission(roleTypes, "calendars:write")) {
      throw new ForbiddenError("Missing calendars:write permission");
    }
    const body = c.req.valid("json");

    if (body.departmentId) {
      const dept = await db.query.departments.findFirst({
        where: and(eq(departments.id, body.departmentId), eq(departments.clubId, clubId)),
      });
      if (!dept) throw new NotFoundError("Department not found");
    }

    const row = await db.transaction(async (tx) => {
      await lockClubCalendars(tx, clubId);
      // A club's first calendar is the standard calendar: make sure it exists before adding a custom one.
      await ensureClubHasCalendar(clubId, { createdBy: currentUser.id, executor: tx });
      // Exactly one default per club -- unset every other calendar's flag first.
      if (body.isDefault) {
        await tx.update(calendars).set({ isDefault: false }).where(eq(calendars.clubId, clubId));
      }
      const [created] = await tx.insert(calendars).values({ clubId, createdBy: currentUser.id, ...body }).returning();
      await writeAudit(tx, { eventType: "calendar.create", subjectId: created.id, payload: { clubId, calendarId: created.id } });
      return created;
    });

    return c.json({ data: row }, 201);
  },
);

const updateCalendarSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  isDefault: z.boolean().optional(),
  icalImportUrl: z.string().url().nullable().optional(),
});

calendarRoutes.patch(
  "/:id",
  zValidator("json", updateCalendarSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "calendars:write")) {
      throw new ForbiddenError("Missing calendars:write permission");
    }
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query.calendars.findFirst({ where: and(eq(calendars.id, id), eq(calendars.clubId, clubId)) });
    if (!existing) throw new NotFoundError("Calendar not found");

    if (body.departmentId) {
      const dept = await db.query.departments.findFirst({
        where: and(eq(departments.id, body.departmentId), eq(departments.clubId, clubId)),
      });
      if (!dept) throw new NotFoundError("Department not found");
    }

    const row = await db.transaction(async (tx) => {
      await lockClubCalendars(tx, clubId);
      const [current] = await tx.select().from(calendars).where(and(eq(calendars.id, id), eq(calendars.clubId, clubId)));
      if (!current) throw new NotFoundError("Calendar not found");
      // Every club has exactly one default: the default calendar stays the default (and club-wide) -- the board makes
      // ANOTHER calendar the default instead, which then takes the status away from this one.
      if (current.isDefault && (body.isDefault === false || body.departmentId)) {
        throw defaultRequired();
      }
      if (body.isDefault) {
        await tx.update(calendars).set({ isDefault: false }).where(and(eq(calendars.clubId, clubId), ne(calendars.id, id)));
      }
      const [updated] = await tx
        .update(calendars)
        .set(body)
        .where(and(eq(calendars.id, id), eq(calendars.clubId, clubId)))
        .returning();
      return updated;
    });

    await writeAudit(db, { eventType: "calendar.update", subjectId: id, payload: { clubId, changedFields: Object.keys(body) } });

    return c.json({ data: row });
  },
);

calendarRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "calendars:write")) {
    throw new ForbiddenError("Missing calendars:write permission");
  }
  const id = c.req.param("id");

  const existing = await db.query.calendars.findFirst({ where: and(eq(calendars.id, id), eq(calendars.clubId, clubId)) });
  if (!existing) throw new NotFoundError("Calendar not found");

  await db.transaction(async (tx) => {
    await lockClubCalendars(tx, clubId);
    const [current] = await tx.select().from(calendars).where(and(eq(calendars.id, id), eq(calendars.clubId, clubId)));
    if (!current) throw new NotFoundError("Calendar not found");
    if (current.isDefault) throw defaultRequired();
    await tx.delete(calendars).where(and(eq(calendars.id, id), eq(calendars.clubId, clubId)));
    await writeAudit(tx, { eventType: "calendar.delete", subjectId: id, payload: { clubId } });
  });

  return c.body(null, 204);
});

// --- Visibility grants (board-facing config, not a public list) --------

calendarRoutes.get("/:id/visibility", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "calendars:write")) {
    throw new ForbiddenError("Missing calendars:write permission");
  }
  const id = c.req.param("id");

  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, id), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Calendar not found");

  const rows = await db.query.calendarVisibility.findMany({ where: eq(calendarVisibility.calendarId, id) });
  return c.json({ data: rows });
});

const visibilitySchema = z
  .object({
    memberId: z.string().min(1).optional(),
    roleType: z.string().min(1).optional(),
    departmentId: z.string().uuid().optional(),
  })
  .refine((body) => [body.memberId, body.roleType, body.departmentId].filter((v) => v !== undefined).length === 1, {
    message: "Exactly one of memberId, roleType, departmentId is required",
  });

calendarRoutes.post(
  "/:id/visibility",
  zValidator("json", visibilitySchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "calendars:write")) {
      throw new ForbiddenError("Missing calendars:write permission");
    }
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, id), eq(calendars.clubId, clubId)) });
    if (!calendar) throw new NotFoundError("Calendar not found");

    if (body.memberId) {
      const target = await db.query.member.findFirst({ where: and(eq(member.id, body.memberId), eq(member.organizationId, clubId)) });
      if (!target) throw new NotFoundError("Member not found");
    }
    if (body.departmentId) {
      const dept = await db.query.departments.findFirst({
        where: and(eq(departments.id, body.departmentId), eq(departments.clubId, clubId)),
      });
      if (!dept) throw new NotFoundError("Department not found");
    }

    const [created] = await db.insert(calendarVisibility).values({ calendarId: id, ...body }).returning();

    await writeAudit(db, {
      eventType: "calendar_visibility.create",
      subjectId: id,
      payload: { clubId, memberId: body.memberId, roleType: body.roleType, departmentId: body.departmentId },
    });

    return c.json({ data: created }, 201);
  },
);

calendarRoutes.delete("/:id/visibility/:visibilityId", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "calendars:write")) {
    throw new ForbiddenError("Missing calendars:write permission");
  }
  const id = c.req.param("id");
  const visibilityId = c.req.param("visibilityId");

  const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, id), eq(calendars.clubId, clubId)) });
  if (!calendar) throw new NotFoundError("Calendar not found");

  const existing = await db.query.calendarVisibility.findFirst({
    where: and(eq(calendarVisibility.id, visibilityId), eq(calendarVisibility.calendarId, id)),
  });
  if (!existing) throw new NotFoundError("Visibility grant not found");

  await db.delete(calendarVisibility).where(eq(calendarVisibility.id, visibilityId));
  await writeAudit(db, { eventType: "calendar_visibility.delete", subjectId: id, payload: { clubId, visibilityId } });

  return c.body(null, 204);
});
