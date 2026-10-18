import { zValidator } from "@hono/zod-validator";
import { and, count, eq, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { pushTokens } from "../db/schema/communication.js";
import { TooManyRequestsError, ValidationError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Expo push tokens (Wave 9 B8). A token belongs to the CALLER's account: registering a token that is stored for another
 * account re-assigns it (shared device, re-login) and the response never reveals the previous owner; no route reads
 * tokens back. Sending happens in `src/lib/notify/push.ts`.
 */
export const pushTokenRoutes = new Hono<SessionEnv>();

pushTokenRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
pushTokenRoutes.use("*", sessionGuard);

const EXPO_TOKEN = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

const registerSchema = z.object({
  token: z.string().trim().max(300).regex(EXPO_TOKEN, "token must be an Expo push token"),
  platform: z.enum(["ios", "android"]),
  appVersion: z.string().trim().min(1).max(40).optional(),
});

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

/** Maximum devices per account (`PUSH_TOKENS_MAX_PER_USER`, default 10). */
export function maxTokensPerUser(): number {
  const n = Number(process.env.PUSH_TOKENS_MAX_PER_USER ?? 10);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : 10;
}

const STALE_TOKEN_MS = 90 * 24 * 60 * 60 * 1000;

pushTokenRoutes.post("/", zValidator("json", registerSchema, validationHook), async (c) => {
  const userId = c.get("user").id;
  const body = c.req.valid("json");
  const now = new Date();
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ userId: pushTokens.userId }).from(pushTokens).where(eq(pushTokens.token, body.token));
    if (!existing || existing.userId !== userId) {
      // Make room first: disabled and long-unseen tokens of this account are dead weight.
      await tx.delete(pushTokens).where(and(eq(pushTokens.userId, userId), or(lt(pushTokens.lastSeenAt, new Date(now.getTime() - STALE_TOKEN_MS)), lt(pushTokens.disabledAt, now))));
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(pushTokens).where(eq(pushTokens.userId, userId));
      if (n >= maxTokensPerUser()) throw new TooManyRequestsError("Too many devices are registered for push notifications on this account", { details: { limit: maxTokensPerUser() } });
    }
    await tx
      .insert(pushTokens)
      .values({ userId, token: body.token, platform: body.platform, appVersion: body.appVersion ?? null, lastSeenAt: now })
      .onConflictDoUpdate({ target: pushTokens.token, set: { userId, platform: body.platform, appVersion: body.appVersion ?? null, lastSeenAt: now, disabledAt: null } });
  });
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: { registered: true } });
});

/** Logout of a device. Only the caller's own token is removed; any other token is a silent no-op (no existence oracle). */
pushTokenRoutes.delete("/:token", async (c) => {
  await db.delete(pushTokens).where(and(eq(pushTokens.token, c.req.param("token")), eq(pushTokens.userId, c.get("user").id)));
  return c.body(null, 204);
});
