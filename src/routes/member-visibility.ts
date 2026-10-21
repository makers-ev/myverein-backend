import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { memberFieldVisibility } from "../db/schema/privacy.js";
import { writeAudit } from "../lib/audit.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { clubMemberOf } from "../lib/consent.js";
import { ForbiddenError, ValidationError } from "../lib/errors.js";
import { levelsFor, VISIBILITY_FIELDS, VISIBILITY_LEVELS } from "../lib/field-visibility.js";
import { liveLinkOf } from "../lib/guardian-scope.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * `/club-members/:id/visibility` (Wave 10 B12), mounted into the club-members router. Who decides which of phone, e-mail,
 * address and photo trainers / other members may see: the person themself, a guardian with a live link and custody for a
 * child, or the board (`members:write`). Default: `nur_vorstand` (nothing is shared).
 */
export const memberVisibilityRoutes = new Hono<ClubEnv>();

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const updateSchema = z
  .object(Object.fromEntries(VISIBILITY_FIELDS.map((f) => [f, z.enum(VISIBILITY_LEVELS).optional()])) as Record<(typeof VISIBILITY_FIELDS)[number], z.ZodOptional<z.ZodEnum<{ nur_vorstand: "nur_vorstand"; trainer: "trainer"; mitglieder: "mitglieder" }>>>)
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

async function authorize(c: { get(k: "membership"): { id: string }; get(k: "clubRoleTypes"): string[]; get(k: "clubId"): string; req: { param(k: string): string | undefined } }, mayEdit: boolean) {
  const ward = await clubMemberOf(c.get("clubId"), c.req.param("id")!);
  const isSelf = ward.memberId !== null && ward.memberId === c.get("membership").id;
  const board = hasClubPermission(c.get("clubRoleTypes"), "members:write");
  const link = isSelf || board ? null : await liveLinkOf(c.get("membership").id, ward.id);
  const allowed = isSelf || board || (link !== null && (!mayEdit || link.link.hasCustody));
  if (!allowed) throw new ForbiddenError("Not allowed for this member");
  return ward;
}

memberVisibilityRoutes.get("/", async (c) => {
  const ward = await authorize(c, false);
  return c.json({ data: { clubMemberId: ward.id, levels: await levelsFor(ward.id) } });
});

memberVisibilityRoutes.put("/", zValidator("json", updateSchema, validationHook), async (c) => {
  const ward = await authorize(c, true);
  const body = c.req.valid("json");
  const entries = Object.entries(body) as Array<[(typeof VISIBILITY_FIELDS)[number], (typeof VISIBILITY_LEVELS)[number]]>;
  await db.transaction(async (tx) => {
    await tx
      .insert(memberFieldVisibility)
      .values(entries.map(([field, level]) => ({ clubMemberId: ward.id, field, level, updatedBy: c.get("user").id })))
      .onConflictDoUpdate({ target: [memberFieldVisibility.clubMemberId, memberFieldVisibility.field], set: { level: sql`excluded.level`, updatedBy: sql`excluded.updated_by`, updatedAt: new Date() } });
    await writeAudit(tx, { eventType: "member_field_visibility.update", subjectId: ward.id, payload: { clubId: c.get("clubId"), changedBy: c.get("membership").id, fields: entries.map(([f]) => f) } });
  });
  return c.json({ data: { clubMemberId: ward.id, levels: await levelsFor(ward.id) } });
});
