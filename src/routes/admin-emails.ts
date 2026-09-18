import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { NotFoundError, ConflictError, ValidationError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Admin-only e-mail actions that Better Auth's own client endpoints can't
 * do while an admin is signed in: `sendVerificationEmail` requires the
 * *session's* email to match the target (EMAIL_MISMATCH otherwise), so an
 * admin can never use it for a different user. This route re-enters Better
 * Auth server-side with no session (the anonymous path), which works for
 * any email -- see src/api/email-verification.mjs in better-auth for the
 * session-vs-anonymous branch this relies on.
 */
export const adminEmailRoutes = new Hono<SessionEnv>();

adminEmailRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
adminEmailRoutes.use("*", adminGuard);

const sendVerificationSchema = z.object({
  userId: z.string().min(1).max(256),
  callbackURL: z.string().url().max(2048).optional(),
});

adminEmailRoutes.post(
  "/send-verification-email",
  zValidator("json", sendVerificationSchema, (result) => {
    if (!result.success) {
      throw new ValidationError("Invalid request body", { details: result.error.issues });
    }
  }),
  async (c) => {
    const { userId, callbackURL } = c.req.valid("json");

    const target = await db.query.user.findFirst({ where: eq(user.id, userId) });
    if (!target) throw new NotFoundError("User not found");

    // Only meaningful for an unverified account -- refuse the redundant
    // (and email-sending) call rather than silently re-sending to someone
    // who already verified.
    if (target.emailVerified) throw new ConflictError("User is already verified");

    await auth.api.sendVerificationEmail({ body: { email: target.email, callbackURL } });

    return c.json({ status: true });
  },
);