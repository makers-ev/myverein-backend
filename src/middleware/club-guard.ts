import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditContext } from "../lib/audit.js";
import { resolveClubRoleTypes } from "../lib/club-access.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../lib/errors.js";
import { dpaGate } from "./dpa-gate.js";
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
 * `clubRoleTypes` always starts with the implicit `mitglied` role (see
 * club-permissions.ts). A user who isn't a member of the requested club gets 404, never 403 --
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

  const effective = await resolveClubRoleTypes(membership, clubId);
  if (effective === null) {
    throw new NotFoundError("Club not found");
  }

  c.set("clubId", clubId);
  const auditStore = auditContext.getStore();
  if (auditStore) auditStore.clubId = clubId;
  c.set("membership", membership);
  c.set("clubRoleTypes", effective);

  // Wave 10 B10: no writing while the club has not accepted the processor agreement (DPA_REQUIRED, grace period).
  await dpaGate(c, clubId);

  await next();
});

/**
 * Read routes that hold club-wide data (inventory, departments) are closed to external guests (`member.role = guest`,
 * e.g. guardians): they reach their ward's data through `/guardian/*` only. Call at the top of the handler.
 */
export function denyExternalGuests(c: Context<ClubEnv>): void {
  if (c.get("membership").role === "guest") throw new ForbiddenError("Not available for external guests");
}
