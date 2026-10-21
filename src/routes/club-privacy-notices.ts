import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubPrivacyNotices } from "../db/schema/club-privacy-notices.js";
import { isUuid } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { generateNoticeDraft, latestPublishedNotice, NOTICE_MAX, publishNotice } from "../lib/privacy-notice.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Privacy notice of a club (Wave 10 B11). `/club-privacy-notices`: every member reads the current notice, the board (`privacy:read`
 * / `privacy:manage`) sees the versions, the generated draft and publishes. `/clubs/:slug/privacy-notice` serves the applicant who
 * is not a member yet (session only). A notice informs; it is NOT a consent and conditions nothing.
 */
export const clubPrivacyNoticeRoutes = new Hono<ClubEnv>();

clubPrivacyNoticeRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubPrivacyNoticeRoutes.use("*", sessionGuard);
clubPrivacyNoticeRoutes.use("*", clubGuard);

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const need = (c: { get(k: "clubRoleTypes"): string[] }, permission: "privacy:read" | "privacy:manage") => {
  if (!hasClubPermission(c.get("clubRoleTypes"), permission)) throw new ForbiddenError(`Missing ${permission} permission`);
};

const shape = (n: { id: string; version: number; body: string; sha256: string; publishedAt: Date | null }) => ({ id: n.id, version: n.version, body: n.body, sha256: n.sha256, publishedAt: n.publishedAt });

/** The notice every member of the club may read; `null` while the board has not published one. */
clubPrivacyNoticeRoutes.get("/current", async (c) => {
  const notice = await latestPublishedNotice(c.get("clubId"));
  return c.json({ data: notice ? shape(notice) : null });
});

/** All versions without the text (newest first). */
clubPrivacyNoticeRoutes.get("/", async (c) => {
  need(c, "privacy:read");
  const rows = await db.select().from(clubPrivacyNotices).where(eq(clubPrivacyNotices.clubId, c.get("clubId"))).orderBy(desc(clubPrivacyNotices.version));
  return c.json({ data: rows.map((r) => ({ id: r.id, version: r.version, sha256: r.sha256, publishedAt: r.publishedAt, publishedBy: r.publishedBy })) });
});

/** The template filled with the club's data, next to the current text (for the editor and its diff). Not stored. */
clubPrivacyNoticeRoutes.get("/draft", async (c) => {
  need(c, "privacy:read");
  const clubId = c.get("clubId");
  const [draft, current] = await Promise.all([generateNoticeDraft(clubId), latestPublishedNotice(clubId)]);
  return c.json({ data: { body: draft, current: current ? shape(current) : null } });
});

const publishSchema = z.object({ body: z.string().max(NOTICE_MAX * 2).optional() });

/** Publishes the text (default: the generated draft) as the next version: `201`, or `200` when it equals the current text. */
clubPrivacyNoticeRoutes.post("/", zValidator("json", publishSchema, validationHook), async (c) => {
  need(c, "privacy:manage");
  const clubId = c.get("clubId");
  const body = c.req.valid("json").body ?? (await generateNoticeDraft(clubId));
  const { notice, created } = await publishNotice(clubId, body, c.get("user").id);
  return c.json({ data: shape(notice) }, created ? 201 : 200);
});

clubPrivacyNoticeRoutes.get("/:id", async (c) => {
  need(c, "privacy:read");
  const id = c.req.param("id");
  // A foreign club's notice is "not found" like an unknown or malformed id.
  const [row] = isUuid(id) ? await db.select().from(clubPrivacyNotices).where(eq(clubPrivacyNotices.id, id)) : [];
  if (!row || row.clubId !== c.get("clubId")) throw new NotFoundError("Privacy notice not found");
  return c.json({ data: shape(row) });
});

/** `/clubs/:slug/privacy-notice`: for the applicant's join page (session only, no membership needed). */
export const clubNoticeBySlugRoutes = new Hono<SessionEnv>();
clubNoticeBySlugRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
clubNoticeBySlugRoutes.use("*", sessionGuard);

clubNoticeBySlugRoutes.get("/:slug/privacy-notice", async (c) => {
  const [club] = await db.select({ id: organization.id, name: organization.name }).from(organization).where(eq(organization.slug, c.req.param("slug")));
  if (!club) throw new NotFoundError("Club not found");
  const notice = await latestPublishedNotice(club.id);
  return c.json({ data: notice ? { ...shape(notice), clubName: club.name } : null });
});
