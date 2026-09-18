import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";

import { auth } from "../auth/auth.js";
import { UnauthorizedError } from "../lib/errors.js";

type Session = typeof auth.$Infer.Session;

/** Typed context variables attached by `sessionGuard`. */
export type SessionEnv = {
  Variables: {
    user: Session["user"];
    session: Session["session"];
  };
};

/**
 * Reads the Better Auth session for the incoming request (cookie or
 * `Authorization: Bearer` header, both handled internally by Better Auth --
 * see `bearer()` plugin in src/auth/auth.ts) and attaches a typed
 * `ctx.get("user")` / `ctx.get("session")`.
 *
 * There is no hand-rolled token verification here -- Better Auth owns that
 * centrally via `auth.api.getSession`, which is the fix for the JWT
 * audience-validation gap in the old backend template.
 */
/**
 * Fetches the Better Auth session for the incoming request and attaches it
 * to the context, throwing `UnauthorizedError` if there is none. Shared by
 * `sessionGuard` and `adminGuard` so the two can't drift.
 */
async function requireSession(c: Context): Promise<Session> {
  const result = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!result) {
    throw new UnauthorizedError("Authentication required");
  }

  c.set("user", result.user);
  c.set("session", result.session);

  return result;
}

export const sessionGuard = createMiddleware<SessionEnv>(async (c: Context, next: Next) => {
  await requireSession(c);
  await next();
});

/** Same as sessionGuard, but only accepts users with an admin role. */
export const adminGuard = createMiddleware<SessionEnv>(async (c: Context, next: Next) => {
  const result = await requireSession(c);

  if (result.user.role !== "admin") {
    throw new UnauthorizedError("Admin privileges required");
  }

  await next();
});
