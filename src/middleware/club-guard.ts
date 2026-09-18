import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { BadRequestError, NotFoundError } from "../lib/errors.js";
import type { SessionEnv } from "./session-guard.js";

type MemberRow = typeof member.$inferSelect;

/** Typed context variables attached by `clubGuard`, on top of `SessionEnv`. */
export type ClubEnv = SessionEnv & {
  Variables: SessionEnv["Variables"] & {
    clubId: string;
    membership: MemberRow;
    clubRoleTypes: string[];
  };
};

/**
 * MyVerein's equivalent of MyHome's `householdGuard` / MyCouple's
 * `coupleSpaceGuard`: resolves which club (`organization`) the request is
 * for, verifies the session user is actually a member, and attaches the
 * membership + fine-grained club_roles to the context.
 *
 * `clubId` is read from (in order) a `:clubId` route param, an
 * `X-Club-Id` header, or a `clubId` query param -- routes mounted under a
 * club-scoped path use the param, one-off lookups can use the header/query.
 * A user who isn't a member of the requested club gets 404, never 403 --
 * same "don't leak existence" convention as the rest of this backend (see
 * accounts.ts's ownership-scoping precedent).
 */
export const clubGuard = createMiddleware<ClubEnv>(async (c: Context, next: Next) => {
  const user = c.get("user");
  const clubId = c.req.param("clubId") ?? c.req.header("x-club-id") ?? c.req.query("clubId");

  if (!clubId) {
    throw new BadRequestError("clubId is required (route param, X-Club-Id header, or query param)");
  }

  const membership = await db.query.member.findFirst({
    where: and(eq(member.organizationId, clubId), eq(member.userId, user.id)),
  });

  if (!membership) {
    throw new NotFoundError("Club not found");
  }

  const roleRows = await db.query.clubRoles.findMany({
    where: eq(clubRoles.memberId, membership.id),
  });

  c.set("clubId", clubId);
  c.set("membership", membership);
  c.set("clubRoleTypes", roleRows.map((row) => row.roleType));

  await next();
});
