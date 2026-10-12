import { eq } from "drizzle-orm";
import { Hono } from "hono";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { NotFoundError } from "../lib/errors.js";
import { applicantCategories, applicantDefinition, ensureFormBasics, findCurrentForm, SLUG_RE } from "../lib/forms.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Applicant side, read part (Wave 8 B5): the form a person fills in to join a club. Session only -- the applicant has
 * no club yet, so there is no `clubGuard` and no permission; the response carries the field definitions and the privacy
 * notice of the currently published version and nothing else (no club data, no mapping targets).
 */
export const clubFormRoutes = new Hono<SessionEnv>();

clubFormRoutes.use("*", sessionGuard);
clubFormRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60, key: (c) => `club-forms:${c.get("user").id}` }));

clubFormRoutes.get("/:clubSlug/aufnahme", async (c) => {
  const slug = c.req.param("clubSlug");
  const org = SLUG_RE.test(slug) ? await db.query.organization.findFirst({ where: eq(organization.slug, slug), columns: { id: true } }) : undefined;
  if (!org) throw new NotFoundError("Club not found");
  // Reading does not write: a club that is missing its standard form / categories is seeded once (first access).
  await ensureFormBasics(org.id);

  const current = await findCurrentForm(org.id, "aufnahme");
  if (!current) throw new NotFoundError("This club has no application form");
  c.header("Cache-Control", "private, no-cache");
  return c.json({ data: applicantDefinition(current.form, current.version, await applicantCategories(org.id)) });
});
