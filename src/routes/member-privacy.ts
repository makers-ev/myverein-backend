import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubPrivacyNotices } from "../db/schema/club-privacy-notices.js";
import { dataSubjectRequests } from "../db/schema/privacy.js";
import { writeAudit } from "../lib/audit.js";
import { ensureClubMember } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, ValidationError } from "../lib/errors.js";
import { executeErasure, planErasure } from "../lib/privacy/erasure.js";
import { latestPublishedNotice } from "../lib/privacy-notice.js";
import { openRequest } from "../lib/privacy/requests.js";
import { respondWithExport } from "../lib/privacy/respond.js";
import { loadSubject } from "../lib/privacy/subject.js";
import { cleanText } from "../lib/text-policy.js";
import { dbRateLimit, envInt, HOUR_MS } from "../lib/rate-limits.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Data subject rights of a club member (Wave 10 B7/B8), mounted into the club-members router (session + club guard from there).
 * Self service: `GET /me/data-export`, `POST /me/erasure-request`, `GET /me/data-requests`. Board (`privacy:manage`):
 * `POST /:id/data-export`, `POST /:id/erasure/plan|execute`, `PUT /:id/legal-hold`.
 */
export const memberPrivacyRoutes = new Hono<ClubEnv>();

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const userSubject = (c: { get(k: "user"): { id: string } }) => c.get("user").id;
const exportLimit = dbRateLimit({ bucket: "data-export.user", windowMs: HOUR_MS, max: () => envInt("DATA_EXPORT_PER_HOUR", 5), subject: userSubject, message: "Too many exports, try again later" });
const boardExportLimit = dbRateLimit({ bucket: "data-export.board", windowMs: HOUR_MS, max: () => envInt("DATA_EXPORT_BOARD_PER_HOUR", 30), subject: userSubject, message: "Too many exports, try again later" });

const formatQuery = z.object({ format: z.enum(["json", "html"]).default("json") });

function requireManage(c: { get(k: "clubRoleTypes"): string[] }) {
  if (!hasClubPermission(c.get("clubRoleTypes"), "privacy:manage")) throw new ForbiddenError("Missing privacy:manage permission");
}

memberPrivacyRoutes.get("/me/data-export", exportLimit, zValidator("query", formatQuery, validationHook), async (c) => {
  const row = await ensureClubMember(db, c.get("membership"));
  return respondWithExport(c, { clubId: c.get("clubId"), clubMemberId: row.id, format: c.req.valid("query").format, via: "self", userId: c.get("user").id, closeAccessRequests: true });
});

/** The member asks for their data to be erased: a request with a deadline for the board (who runs plan + execute). */
memberPrivacyRoutes.post("/me/erasure-request", async (c) => {
  const row = await ensureClubMember(db, c.get("membership"));
  const { row: request, created } = await db.transaction((tx) => openRequest(tx, { clubId: c.get("clubId"), clubMemberId: row.id, kind: "erasure", requestedByUserId: c.get("user").id }));
  return c.json({ data: { id: request.id, kind: request.kind, status: request.status, receivedAt: request.receivedAt, dueAt: request.dueAt } }, created ? 201 : 200);
});

memberPrivacyRoutes.get("/me/data-requests", async (c) => {
  const row = await ensureClubMember(db, c.get("membership"));
  const rows = await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.clubMemberId, row.id));
  return c.json({ data: rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, receivedAt: r.receivedAt, dueAt: r.dueAt, completedAt: r.completedAt })) });
});

const boardExportSchema = z.object({
  // The board confirms that it checked the identity of the requester (offline, e.g. by ID or a call back).
  identityChecked: z.literal(true),
  format: z.enum(["json", "html"]).default("json"),
});

memberPrivacyRoutes.post("/:id/data-export", boardExportLimit, zValidator("json", boardExportSchema, validationHook), async (c) => {
  requireManage(c);
  const { row } = await loadSubject(c.get("clubId"), c.req.param("id"));
  return respondWithExport(c, { clubId: c.get("clubId"), clubMemberId: row.id, format: c.req.valid("json").format, via: "board", userId: c.get("user").id, closeAccessRequests: true });
});

memberPrivacyRoutes.post("/:id/erasure/plan", async (c) => {
  requireManage(c);
  const { row } = await loadSubject(c.get("clubId"), c.req.param("id"));
  const plan = await planErasure(c.get("clubId"), row.id);
  await writeAudit(db, { eventType: "member_erasure.plan", subjectId: row.id, payload: { clubId: c.get("clubId"), requestedBy: c.get("user").id, blockers: plan.blockers.length } });
  return c.json({ data: { ...plan, displayName: row.displayName } });
});

const executeSchema = z.object({ planDigest: z.string().length(64), confirm: z.literal(true) });

memberPrivacyRoutes.post("/:id/erasure/execute", zValidator("json", executeSchema, validationHook), async (c) => {
  requireManage(c);
  const { row } = await loadSubject(c.get("clubId"), c.req.param("id"));
  const result = await executeErasure({ clubId: c.get("clubId"), clubMemberId: row.id, actorUserId: c.get("user").id, via: "board", planDigest: c.req.valid("json").planDigest });
  return c.json({ data: { clubMemberId: row.id, erased: true, steps: result.steps } });
});

const legalHoldSchema = z.object({ active: z.boolean(), reason: cleanText(z.string().trim().min(1).max(200)).optional() });

memberPrivacyRoutes.put("/:id/legal-hold", zValidator("json", legalHoldSchema, validationHook), async (c) => {
  requireManage(c);
  const { row } = await loadSubject(c.get("clubId"), c.req.param("id"));
  const body = c.req.valid("json");
  if (body.active && !body.reason) throw new ValidationError("A legal hold needs a reason", { details: { code: "reason_required" } });
  await db.transaction(async (tx) => {
    await tx
      .update(clubMembers)
      .set(body.active ? { legalHoldAt: row.legalHoldAt ?? new Date(), legalHoldReason: body.reason ?? null, updatedAt: new Date() } : { legalHoldAt: null, legalHoldReason: null, updatedAt: new Date() })
      .where(eq(clubMembers.id, row.id));
    await writeAudit(tx, { eventType: "member_legal_hold.update", subjectId: row.id, payload: { clubId: c.get("clubId"), active: body.active, changedBy: c.get("user").id } });
  });
  return c.json({ data: { clubMemberId: row.id, legalHold: body.active, reason: body.active ? (body.reason ?? null) : null } });
});

/**
 * Art. 14 GDPR for members without an account (children, people the board entered): the board notes that the privacy notice was
 * handed over, with the version. Information only: nothing depends on it, it is not a consent.
 */
memberPrivacyRoutes.get("/:id/privacy-notice", async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "privacy:manage") && !hasClubPermission(c.get("clubRoleTypes"), "members:write") && !hasClubPermission(c.get("clubRoleTypes"), "privacy:read")) throw new ForbiddenError("Missing privacy:read permission");
  const { row } = await loadSubject(c.get("clubId"), c.req.param("id"));
  const current = await latestPublishedNotice(c.get("clubId"));
  const sent = row.privacyNoticeVersionId ? (await db.select({ version: clubPrivacyNotices.version }).from(clubPrivacyNotices).where(eq(clubPrivacyNotices.id, row.privacyNoticeVersionId)))[0] : undefined;
  return c.json({ data: { sentAt: row.privacyNoticeSentAt, sentVersion: sent?.version ?? null, currentVersion: current?.version ?? null, upToDate: current !== null && row.privacyNoticeVersionId === current.id } });
});

memberPrivacyRoutes.post("/:id/privacy-notice-sent", async (c) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "privacy:manage") && !hasClubPermission(c.get("clubRoleTypes"), "members:write")) throw new ForbiddenError("Missing members:write permission");
  const { row } = await loadSubject(c.get("clubId"), c.req.param("id"));
  const current = await latestPublishedNotice(c.get("clubId"));
  if (!current) throw new ConflictError("The club has not published a privacy notice yet", { details: { code: "no_published_notice" } });
  const changed = row.privacyNoticeVersionId !== current.id;
  const sentAt = changed || !row.privacyNoticeSentAt ? new Date() : row.privacyNoticeSentAt;
  if (changed || !row.privacyNoticeSentAt) {
    await db.transaction(async (tx) => {
      await tx.update(clubMembers).set({ privacyNoticeSentAt: sentAt, privacyNoticeVersionId: current.id, updatedAt: new Date() }).where(eq(clubMembers.id, row.id));
      await writeAudit(tx, { eventType: "club_member.privacy_notice_sent", subjectId: row.id, payload: { clubId: c.get("clubId"), version: current.version } });
    });
  }
  return c.json({ data: { sentAt, sentVersion: current.version, currentVersion: current.version, upToDate: true } });
});
