import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { departments } from "../db/schema/departments.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const departmentRoutes = new Hono<ClubEnv>();

departmentRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
departmentRoutes.use("*", sessionGuard);
departmentRoutes.use("*", clubGuard);

departmentRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  const rows = await db.query.departments.findMany({
    where: eq(departments.clubId, clubId),
    orderBy: (d, { asc }) => [asc(d.name)],
  });
  return c.json({ data: rows });
});

departmentRoutes.get("/:id", async (c) => {
  const clubId = c.get("clubId");
  const id = c.req.param("id");

  const row = await db.query.departments.findFirst({ where: and(eq(departments.id, id), eq(departments.clubId, clubId)) });
  if (!row) throw new NotFoundError("Department not found");

  return c.json({ data: row });
});

const createDepartmentSchema = z.object({
  name: z.string().min(1).max(200),
  leadMemberId: z.string().optional(),
});

departmentRoutes.post(
  "/",
  zValidator("json", createDepartmentSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "departments:write")) {
      throw new ForbiddenError("Missing departments:write permission");
    }
    const body = c.req.valid("json");

    if (body.leadMemberId) {
      const lead = await db.query.member.findFirst({ where: and(eq(member.id, body.leadMemberId), eq(member.organizationId, clubId)) });
      if (!lead) throw new ValidationError("leadMemberId is not a member of this club");
    }

    const row = await db.transaction(async (tx) => {
      const [row] = await tx.insert(departments).values({ clubId, ...body }).returning();
      await tx.insert(auditLog).values({ eventType: "department.create", subjectId: row.id, payload: { clubId, name: row.name } });
      return row;
    });

    return c.json({ data: row }, 201);
  },
);

const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  leadMemberId: z.string().nullable().optional(),
});

departmentRoutes.patch(
  "/:id",
  zValidator("json", updateDepartmentSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "departments:write")) {
      throw new ForbiddenError("Missing departments:write permission");
    }
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query.departments.findFirst({ where: and(eq(departments.id, id), eq(departments.clubId, clubId)) });
    if (!existing) throw new NotFoundError("Department not found");

    if (body.leadMemberId) {
      const lead = await db.query.member.findFirst({ where: and(eq(member.id, body.leadMemberId), eq(member.organizationId, clubId)) });
      if (!lead) throw new ValidationError("leadMemberId is not a member of this club");
    }

    const [row] = await db
      .update(departments)
      .set(body)
      .where(and(eq(departments.id, id), eq(departments.clubId, clubId)))
      .returning();

    await db.insert(auditLog).values({ eventType: "department.update", subjectId: id, payload: { clubId, changes: body } });

    return c.json({ data: row });
  },
);

departmentRoutes.delete("/:id", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "departments:write")) {
    throw new ForbiddenError("Missing departments:write permission");
  }
  const id = c.req.param("id");

  const existing = await db.query.departments.findFirst({ where: and(eq(departments.id, id), eq(departments.clubId, clubId)) });
  if (!existing) throw new NotFoundError("Department not found");

  await db.delete(departments).where(and(eq(departments.id, id), eq(departments.clubId, clubId)));
  await db.insert(auditLog).values({ eventType: "department.delete", subjectId: id, payload: { clubId } });

  return c.body(null, 204);
});
