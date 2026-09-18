import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { availabilityExceptions, availabilitySlots } from "../db/schema/availability.js";
import { computeAvailability, type AvailabilityInput } from "../lib/availability-match.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * The vault's Technical Reference lists `/availability` as `Session`-only,
 * but `availability_slots`/`availability_exceptions.member_id` is a FK to
 * `member.id` -- a club MEMBERSHIP row, not a bare user (see Data Model -
 * MyVerein Backend §7: "member-scoped, not club-scoped" means the table
 * itself skips a redundant club_id column, not that the route skips club
 * resolution). A user can belong to several clubs, each with its own
 * membership and its own availability, so every route here still needs
 * `sessionGuard` + `clubGuard` (same as club-members.ts's `/me`) to resolve
 * which membership's availability is in play via `c.get("membership")`.
 * This is a documented deviation from the vault doc's shorthand.
 */
export const availabilityRoutes = new Hono<ClubEnv>();

availabilityRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
availabilityRoutes.use("*", sessionGuard);
availabilityRoutes.use("*", clubGuard);

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":");
  return Number(h) * 60 + Number(m);
}

// --- Slots ---------------------------------------------------------------

const createSlotSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startTime: z.string().regex(timeRegex, "Expected HH:MM or HH:MM:SS"),
    endTime: z.string().regex(timeRegex, "Expected HH:MM or HH:MM:SS"),
    note: z.string().max(500).optional(),
  })
  .strict()
  .refine((body) => timeToMinutes(body.startTime) < timeToMinutes(body.endTime), {
    message: "startTime must be before endTime",
    path: ["startTime"],
  });

const updateSlotSchema = z
  .object({
    weekday: z.number().int().min(0).max(6).optional(),
    startTime: z.string().regex(timeRegex, "Expected HH:MM or HH:MM:SS").optional(),
    endTime: z.string().regex(timeRegex, "Expected HH:MM or HH:MM:SS").optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();

availabilityRoutes.get("/slots", async (c) => {
  const membership = c.get("membership");
  const rows = await db.query.availabilitySlots.findMany({
    where: eq(availabilitySlots.memberId, membership.id),
    orderBy: (row, { asc }) => [asc(row.weekday), asc(row.startTime)],
  });
  return c.json({ data: rows });
});

availabilityRoutes.post(
  "/slots",
  zValidator("json", createSlotSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const membership = c.get("membership");
    const body = c.req.valid("json");

    const [created] = await db
      .insert(availabilitySlots)
      .values({ memberId: membership.id, ...body })
      .returning();

    return c.json({ data: created }, 201);
  },
);

availabilityRoutes.patch(
  "/slots/:id",
  zValidator("json", updateSlotSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const membership = c.get("membership");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query.availabilitySlots.findFirst({
      where: and(eq(availabilitySlots.id, id), eq(availabilitySlots.memberId, membership.id)),
    });
    if (!existing) throw new NotFoundError("Slot not found");

    const mergedStart = body.startTime ?? existing.startTime;
    const mergedEnd = body.endTime ?? existing.endTime;
    if (timeToMinutes(mergedStart) >= timeToMinutes(mergedEnd)) {
      throw new ValidationError("startTime must be before endTime");
    }

    const [updated] = await db.update(availabilitySlots).set(body).where(eq(availabilitySlots.id, id)).returning();

    return c.json({ data: updated });
  },
);

availabilityRoutes.delete("/slots/:id", async (c) => {
  const membership = c.get("membership");
  const id = c.req.param("id");

  const existing = await db.query.availabilitySlots.findFirst({
    where: and(eq(availabilitySlots.id, id), eq(availabilitySlots.memberId, membership.id)),
  });
  if (!existing) throw new NotFoundError("Slot not found");

  await db.delete(availabilitySlots).where(eq(availabilitySlots.id, id));

  return c.body(null, 204);
});

// --- Exceptions ------------------------------------------------------------

const createExceptionSchema = z
  .object({
    date: z.string().date(),
    isAvailable: z.boolean(),
    note: z.string().max(500).optional(),
  })
  .strict();

const updateExceptionSchema = z
  .object({
    date: z.string().date().optional(),
    isAvailable: z.boolean().optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict();

availabilityRoutes.get("/exceptions", async (c) => {
  const membership = c.get("membership");
  const rows = await db.query.availabilityExceptions.findMany({
    where: eq(availabilityExceptions.memberId, membership.id),
    orderBy: (row, { asc }) => [asc(row.date)],
  });
  return c.json({ data: rows });
});

availabilityRoutes.post(
  "/exceptions",
  zValidator("json", createExceptionSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const membership = c.get("membership");
    const body = c.req.valid("json");

    const [created] = await db
      .insert(availabilityExceptions)
      .values({ memberId: membership.id, ...body })
      .returning();

    return c.json({ data: created }, 201);
  },
);

availabilityRoutes.patch(
  "/exceptions/:id",
  zValidator("json", updateExceptionSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const membership = c.get("membership");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query.availabilityExceptions.findFirst({
      where: and(eq(availabilityExceptions.id, id), eq(availabilityExceptions.memberId, membership.id)),
    });
    if (!existing) throw new NotFoundError("Exception not found");

    const [updated] = await db.update(availabilityExceptions).set(body).where(eq(availabilityExceptions.id, id)).returning();

    return c.json({ data: updated });
  },
);

availabilityRoutes.delete("/exceptions/:id", async (c) => {
  const membership = c.get("membership");
  const id = c.req.param("id");

  const existing = await db.query.availabilityExceptions.findFirst({
    where: and(eq(availabilityExceptions.id, id), eq(availabilityExceptions.memberId, membership.id)),
  });
  if (!existing) throw new NotFoundError("Exception not found");

  await db.delete(availabilityExceptions).where(eq(availabilityExceptions.id, id));

  return c.body(null, 204);
});

// --- Terminfindung: GET /overlap --------------------------------------------
// Returns raw per-candidate availability data for the board to eyeball --
// deliberately NOT an auto-ranked "best slot" suggestion (Wave 2
// Implementation Plan §7 "Open Points": "show overlap data only, board picks
// manually"). Manual comma-list parsing rather than zValidator("query", ...)
// -- reads cleaner than coercing a Zod query schema through comma-split
// strings for two list params.

availabilityRoutes.get("/overlap", async (c) => {
  const clubId = c.get("clubId");
  const membersParam = c.req.query("members");
  const candidatesParam = c.req.query("candidates");

  if (!membersParam || !candidatesParam) {
    throw new ValidationError("members and candidates query params are required");
  }

  const memberIds = [...new Set(membersParam.split(",").map((s) => s.trim()).filter(Boolean))];
  const candidateStrs = candidatesParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (memberIds.length === 0 || candidateStrs.length === 0) {
    throw new ValidationError("members and candidates must each contain at least one value");
  }

  const candidates = candidateStrs.map((s) => {
    const parsed = new Date(s);
    if (Number.isNaN(parsed.getTime())) throw new ValidationError(`Invalid candidate timestamp: ${s}`);
    return parsed;
  });

  // IDOR-safety: every requested member must belong to the caller's own
  // club -- same "404, not partial data" convention as the rest of this repo.
  const memberRows = await db.query.member.findMany({
    where: and(inArray(member.id, memberIds), eq(member.organizationId, clubId)),
  });
  if (memberRows.length !== memberIds.length) {
    throw new NotFoundError("One or more members not found in this club");
  }

  const [slotRows, exceptionRows] = await Promise.all([
    db.query.availabilitySlots.findMany({ where: inArray(availabilitySlots.memberId, memberIds) }),
    db.query.availabilityExceptions.findMany({ where: inArray(availabilityExceptions.memberId, memberIds) }),
  ]);

  const inputs: AvailabilityInput[] = memberIds.map((id) => ({
    memberId: id,
    slots: slotRows
      .filter((s) => s.memberId === id)
      .map((s) => ({ weekday: s.weekday, startTime: s.startTime, endTime: s.endTime })),
    exceptions: exceptionRows.filter((e) => e.memberId === id).map((e) => ({ date: e.date, isAvailable: e.isAvailable })),
  }));

  const data = candidates.map((candidate) => ({
    candidate: candidate.toISOString(),
    availability: computeAvailability(candidate, inputs),
  }));

  return c.json({ data });
});
