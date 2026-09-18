import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubInfoPages } from "../db/schema/club-info-pages.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { BOARD_ROLE_TYPES, hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

export const clubInfoRoutes = new Hono<ClubEnv>();

clubInfoRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubInfoRoutes.use("*", sessionGuard);
clubInfoRoutes.use("*", clubGuard);

/**
 * Aggregate Vereinsinfo view: current board (who holds a BOARD_ROLE_TYPES
 * role, with name/role/term end), department overview, and the club's info
 * pages (Satzung/Leitbild/...). One request instead of three round trips --
 * see Concept - MyVerein §2 "Vereinsinfo".
 */
clubInfoRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");

  const [allMembers, allDepartments, pages] = await Promise.all([
    db.query.member.findMany({ where: eq(member.organizationId, clubId) }),
    db.query.departments.findMany({ where: eq(departments.clubId, clubId), orderBy: (d, { asc }) => [asc(d.name)] }),
    db.query.clubInfoPages.findMany({ where: eq(clubInfoPages.clubId, clubId), orderBy: (p, { asc }) => [asc(p.slug)] }),
  ]);

  const memberIds = allMembers.map((m) => m.id);
  const boardRoleRows = memberIds.length
    ? await db.query.clubRoles.findMany({
        where: and(inArray(clubRoles.memberId, memberIds), inArray(clubRoles.roleType, BOARD_ROLE_TYPES)),
      })
    : [];

  const membersById = new Map(allMembers.map((m) => [m.id, m]));
  const userIds = [...new Set(boardRoleRows.map((r) => membersById.get(r.memberId)?.userId).filter((id): id is string => !!id))];
  const users = userIds.length ? await db.query.user.findMany({ where: inArray(user.id, userIds) }) : [];
  const usersById = new Map(users.map((u) => [u.id, u]));

  const board = boardRoleRows.map((roleRow) => {
    const memberRow = membersById.get(roleRow.memberId);
    const userRow = memberRow ? usersById.get(memberRow.userId) : undefined;
    return {
      memberId: roleRow.memberId,
      name: userRow?.name ?? null,
      roleType: roleRow.roleType,
      termEndsAt: roleRow.termEndsAt,
    };
  });

  return c.json({ data: { board, departments: allDepartments, pages } });
});

clubInfoRoutes.get("/:slug", async (c) => {
  const clubId = c.get("clubId");
  const slug = c.req.param("slug");

  const row = await db.query.clubInfoPages.findFirst({ where: and(eq(clubInfoPages.clubId, clubId), eq(clubInfoPages.slug, slug)) });
  if (!row) throw new NotFoundError("Info page not found");

  return c.json({ data: row });
});

const upsertPageSchema = z.object({
  title: z.string().min(1).max(200),
  contentMarkdown: z.string().optional(),
  externalUrl: z.string().url().optional(),
});

/** Create-or-update semantics (slug is the natural key) -- board-only. */
clubInfoRoutes.put(
  "/:slug",
  zValidator("json", upsertPageSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    const clubId = c.get("clubId");
    const roleTypes = c.get("clubRoleTypes");
    if (!hasClubPermission(roleTypes, "club_info:write")) {
      throw new ForbiddenError("Missing club_info:write permission");
    }
    const slug = c.req.param("slug");
    const body = c.req.valid("json");

    const existing = await db.query.clubInfoPages.findFirst({ where: and(eq(clubInfoPages.clubId, clubId), eq(clubInfoPages.slug, slug)) });

    const row = existing
      ? (
          await db
            .update(clubInfoPages)
            .set({ ...body, updatedAt: new Date() })
            .where(eq(clubInfoPages.id, existing.id))
            .returning()
        )[0]
      : (await db.insert(clubInfoPages).values({ clubId, slug, ...body }).returning())[0];

    await db.insert(auditLog).values({
      eventType: existing ? "club_info_page.update" : "club_info_page.create",
      subjectId: row.id,
      payload: { clubId, slug },
    });

    return c.json({ data: row }, existing ? 200 : 201);
  },
);

clubInfoRoutes.delete("/:slug", async (c) => {
  const clubId = c.get("clubId");
  const roleTypes = c.get("clubRoleTypes");
  if (!hasClubPermission(roleTypes, "club_info:write")) {
    throw new ForbiddenError("Missing club_info:write permission");
  }
  const slug = c.req.param("slug");

  const existing = await db.query.clubInfoPages.findFirst({ where: and(eq(clubInfoPages.clubId, clubId), eq(clubInfoPages.slug, slug)) });
  if (!existing) throw new NotFoundError("Info page not found");

  await db.delete(clubInfoPages).where(eq(clubInfoPages.id, existing.id));
  await db.insert(auditLog).values({ eventType: "club_info_page.delete", subjectId: existing.id, payload: { clubId, slug } });

  return c.body(null, 204);
});
