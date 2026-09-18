import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { accounts } from "../db/schema/accounts.js";
import { auditLog } from "../db/schema/audit-log.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Generic example CRUD resource, scoped to the authenticated user via
 * `session-guard`. This is boilerplate a real project deletes and replaces
 * with actual domain logic -- see NEW-ARCHITECTURE-README §7 ("domain logic
 * baked into a template" was a documented pain point of the old suite).
 */
export const accountsRoutes = new Hono<SessionEnv>();

accountsRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
accountsRoutes.use("*", sessionGuard);

const createAccountSchema = z.object({
  name: z.string().min(1).max(200),
});

const updateAccountSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  archived: z.boolean().optional(),
});

accountsRoutes.get("/", async (c) => {
  const user = c.get("user");
  const rows = await db.query.accounts.findMany({
    where: eq(accounts.ownerId, user.id),
    orderBy: (a, { desc }) => [desc(a.createdAt)],
  });
  return c.json({ data: rows });
});

accountsRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const row = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, id), eq(accounts.ownerId, user.id)),
  });

  if (!row) throw new NotFoundError("Account not found");

  return c.json({ data: row });
});

accountsRoutes.post(
  "/",
  zValidator("json", createAccountSchema, (result) => {
    if (!result.success) {
      throw new ValidationError("Invalid request body", { details: result.error.issues });
    }
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    const row = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(accounts)
        .values({ ownerId: user.id, name: body.name })
        .returning();

      await tx.insert(auditLog).values({
        eventType: "account.create",
        subjectId: row.id,
        payload: { ownerId: user.id, name: row.name },
      });

      return row;
    });

    return c.json({ data: row }, 201);
  },
);

accountsRoutes.patch(
  "/:id",
  zValidator("json", updateAccountSchema, (result) => {
    if (!result.success) {
      throw new ValidationError("Invalid request body", { details: result.error.issues });
    }
  }),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query.accounts.findFirst({
      where: and(eq(accounts.id, id), eq(accounts.ownerId, user.id)),
    });
    if (!existing) throw new NotFoundError("Account not found");

    const row = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(accounts)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(accounts.id, id), eq(accounts.ownerId, user.id)))
        .returning();

      await tx.insert(auditLog).values({
        eventType: "account.update",
        subjectId: row.id,
        payload: { ownerId: user.id, changes: body },
      });

      return row;
    });

    return c.json({ data: row });
  },
);

accountsRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const existing = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, id), eq(accounts.ownerId, user.id)),
  });
  if (!existing) throw new NotFoundError("Account not found");

  await db.transaction(async (tx) => {
    await tx.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.ownerId, user.id)));

    await tx.insert(auditLog).values({
      eventType: "account.delete",
      subjectId: id,
      payload: { ownerId: user.id },
    });
  });

  return c.body(null, 204);
});
