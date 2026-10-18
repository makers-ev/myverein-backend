import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubSettings, NOTICE_MODES } from "../db/schema/club-settings.js";
import { isValidTimezone } from "../lib/club-time.js";
import { loadClubSettings } from "../lib/club-settings.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Club-wide parameters (Wave 7 B6). Every member reads the values that concern them (notice period/mode for the
 * cancellation hint, member number prefix, self loans for the inventory UI); only `members:write` changes anything.
 */
export const clubSettingsRoutes = new Hono<ClubEnv>();

clubSettingsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubSettingsRoutes.use("*", sessionGuard);
clubSettingsRoutes.use("*", clubGuard);

clubSettingsRoutes.get("/", async (c) => {
  const settings = await loadClubSettings(db, c.get("clubId"));
  return c.json({ data: settings });
});

const updateSettingsSchema = z.object({
  noticePeriodDays: z.number().int().min(0).max(365).nullable().optional(),
  noticeMode: z.enum(NOTICE_MODES).nullable().optional(),
  // Becomes the part before the running number ("TSV-0001"): letters and digits only, stored upper case.
  memberNumberPrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,10}$/, { message: "memberNumberPrefix must be 1-10 letters or digits" })
    .nullable()
    .optional(),
  allowSelfLoans: z.boolean().optional(),
  // Time zone of the club's reminders and sweeps (IANA name, e.g. "Europe/Berlin").
  timezone: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .refine(isValidTimezone, { message: "timezone must be a valid IANA time zone" })
    .optional(),
  reminderEventEnabled: z.boolean().optional(),
  reminderEventLeadHours: z.number().int().min(1).max(168).optional(),
  reminderLoanEnabled: z.boolean().optional(),
  reminderLoanLeadDays: z.number().int().min(0).max(30).optional(),
  reminderMaintenanceEnabled: z.boolean().optional(),
  reminderMaintenanceLeadDays: z.number().int().min(0).max(90).optional(),
  reminderRsvpEnabled: z.boolean().optional(),
  reminderRsvpLeadDays: z.number().int().min(1).max(30).optional(),
  ageTransitionAuto: z.boolean().optional(),
});

clubSettingsRoutes.patch(
  "/",
  zValidator("json", updateSettingsSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    if (!hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
    const changes = Object.fromEntries(Object.entries(c.req.valid("json")).filter(([, v]) => v !== undefined));

    await db.transaction(async (tx) => {
      await tx
        .insert(clubSettings)
        .values({ clubId, ...changes })
        .onConflictDoUpdate({ target: clubSettings.clubId, set: { ...changes, updatedAt: new Date() } });
      await tx.insert(auditLog).values({ eventType: "club_settings.update", subjectId: clubId, payload: { clubId, changedFields: Object.keys(changes), changedBy: c.get("membership").id } });
    });

    return c.json({ data: await loadClubSettings(db, clubId) });
  },
);
