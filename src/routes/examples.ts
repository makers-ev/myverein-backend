import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { ValidationError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Deliberately trivial. This is a copy-paste starting point for a real
 * project's first route -- one public endpoint, one session-guarded
 * endpoint -- and doubles as the connectivity check the website/mobile
 * templates call to confirm they can reach this backend. Delete it once a
 * project has its own routes to model instead.
 */
export const examplesRoutes = new Hono<SessionEnv>();

examplesRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));

examplesRoutes.get("/ping", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

const echoSchema = z.object({
  message: z.string().min(1).max(500),
});

examplesRoutes.post(
  "/echo",
  sessionGuard,
  zValidator("json", echoSchema, (result) => {
    if (!result.success) {
      throw new ValidationError("Invalid request body", { details: result.error.issues });
    }
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    return c.json({
      data: { message: body.message, userId: user.id, receivedAt: new Date().toISOString() },
    });
  },
);
