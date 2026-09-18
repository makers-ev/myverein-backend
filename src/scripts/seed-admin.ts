import "dotenv/config";
import { eq } from "drizzle-orm";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";

/**
 * Idempotent admin bootstrap. Safe to re-run: if ADMIN_EMAIL already exists,
 * it's promoted to role "admin" instead of erroring; if not, it's created
 * directly via Better Auth's admin.createUser server API (bypasses the
 * public sign-up endpoint).
 *
 * `admin.createUser` (node_modules/better-auth/dist/db/internal-adapter.mjs)
 * does NOT set `emailVerified` -- it's left at the schema default (`false`).
 * With `requireEmailVerification: true` (src/auth/auth.ts) that would lock
 * the freshly-created admin out with "Email not verified" on their very
 * first sign-in. This script sets `emailVerified: true` directly via
 * Drizzle right after creation so an admin-provisioned account is actually
 * usable immediately, matching the intent "admin-provisioned = verified by
 * definition" instead of just asserting it.
 */
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME ?? "Admin";

  if (!email || !password) {
    throw new Error(
      "ADMIN_EMAIL and ADMIN_PASSWORD must be set in the environment before running seed:admin.",
    );
  }
  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters.");
  }

  const existing = await db.query.user.findFirst({ where: eq(user.email, email) });

  if (existing) {
    if (existing.role === "admin" && existing.emailVerified) {
      console.log(`[seed-admin] ${email} already exists, is admin, and is verified. Nothing to do.`);
      return;
    }
    await db.update(user).set({ role: "admin", emailVerified: true }).where(eq(user.id, existing.id));
    console.log(
      `[seed-admin] ${email} existed (role="${existing.role}", emailVerified=${existing.emailVerified}) -- promoted to verified admin.`,
    );
    return;
  }

  const { user: created } = await auth.api.createUser({
    body: { email, password, name, role: "admin" },
  });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  console.log(`[seed-admin] created admin user ${email} (verified).`);
}

main()
  .then(() => closeDatabase())
  .catch(async (err) => {
    console.error("[seed-admin] failed", err);
    await closeDatabase();
    process.exit(1);
  });
