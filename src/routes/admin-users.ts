import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { writeAudit } from "../lib/audit.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { eraseAccountMemberships } from "../lib/privacy/erasure.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Platform admin account deletion. Better Auth's `/admin/remove-user` is disabled (it bypasses `deleteUser.beforeDelete`),
 * so this route is the only admin path: the person is first erased from every club through the same process as the account
 * deletion (blockers answer 409 with the blocker code and nothing changes), then the user row goes.
 */
export const adminUserRoutes = new Hono<SessionEnv>();

adminUserRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
adminUserRoutes.use("*", adminGuard);

adminUserRoutes.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  if (id === c.get("user").id) throw new ValidationError("You cannot delete your own account here");
  const [target] = await db.select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!target) throw new NotFoundError("User not found");
  await eraseAccountMemberships(id);
  await writeAudit(db, { eventType: "admin.user_remove", subjectId: id, clubId: null, actorUserId: c.get("user").id, payload: { userId: id } });
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(id);
  await ctx.internalAdapter.deleteUser(id);
  return c.json({ success: true });
});
