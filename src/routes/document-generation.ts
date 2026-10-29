import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { documents, renderJobs, RENDER_JOB_STATUSES, type RenderJobRow } from "../db/schema/documents.js";
import { buildPrincipal, canAccessDocument, loadFolderIndex } from "../lib/document-access.js";
import { isUuid } from "../lib/club-members.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { getTemplate, listTemplates } from "../lib/pdf/registry.js";
import { registerBuiltinTemplates } from "../lib/pdf/templates/index.js";
import { requestRender, retryRenderJob, stripInternal } from "../lib/pdf/render.js";
import { clubGuard, denyExternalGuests, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Generating PDFs from club data (Wave 13 B8). Only templates of the fixed registry can be requested; the template checks the
 * caller's right on its source data before a job is created; the result is a snapshot document (archive or personal storage).
 * Job status: `wartet`, `rendert`, `fertig`, `fehlgeschlagen` (fixed `errorCode`, no personal data).
 */
export const documentGenerationRoutes = new Hono<ClubEnv>();

registerBuiltinTemplates();

documentGenerationRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
documentGenerationRoutes.use("*", sessionGuard);
documentGenerationRoutes.use("*", clubGuard);
documentGenerationRoutes.use("*", async (c, next) => {
  denyExternalGuests(c);
  await next();
});

const generateLimiter = rateLimit({ windowMs: 60_000, max: 20, key: (c) => `document-generate:${c.get("user").id}` });
const invalid = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

function shapeJob(job: RenderJobRow) {
  return {
    id: job.id,
    templateId: job.templateId,
    templateVersion: job.templateVersion,
    status: job.status,
    errorCode: job.errorCode,
    documentId: job.documentId,
    attempts: job.attempts,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

/** The templates the caller may request (by permission; a template without a fixed permission is listed for everybody and decides per request). */
documentGenerationRoutes.get("/templates", (c) => {
  const roles = c.get("clubRoleTypes");
  return c.json({
    data: listTemplates()
      .filter((t) => t.permission === null || hasClubPermission(roles, t.permission))
      .map((t) => ({ id: t.id, version: t.version, label: t.label, description: t.description, destination: t.destination, sync: t.sync, docType: t.docType })),
  });
});

const generateSchema = z.object({
  templateId: z.string().trim().min(1).max(60),
  params: z.record(z.string(), z.unknown()).default({}),
  replaceDocumentId: z.uuid().nullish(),
  idempotencyKey: z.string().trim().min(1).max(100).nullish(),
});

/** `201` with the finished job (and `documentId`), `202` while it waits / renders / when it failed (read `status` and `errorCode`). */
documentGenerationRoutes.post("/", generateLimiter, zValidator("json", generateSchema, invalid), async (c) => {
  const p = await buildPrincipal(c);
  const body = c.req.valid("json");
  if (body.replaceDocumentId) {
    // Regenerating adds a version to an existing document: the caller needs write access to it (archive) -- personal documents are decided by the template.
    const [doc] = await db.select().from(documents).where(and(eq(documents.id, body.replaceDocumentId), eq(documents.clubId, p.clubId))).limit(1);
    if (!doc || (doc.scope === "verein" && !canAccessDocument(p, await loadFolderIndex(p.clubId), doc, "schreiben"))) throw new NotFoundError("Document to regenerate not found");
  }
  const job = await requestRender({ clubId: p.clubId, templateId: body.templateId, params: body.params, actor: p, replaceDocumentId: body.replaceDocumentId ?? null, idempotencyKey: body.idempotencyKey ?? null });
  return c.json({ data: shapeJob(job) }, job.status === "fertig" ? 201 : 202);
});

const listQuery = z.object({
  status: z.enum(RENDER_JOB_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const canSeeAll = (roles: string[]) => hasClubPermission(roles, "documents:manage");

/** Own jobs; `documents:manage` sees the jobs of the whole club. */
documentGenerationRoutes.get("/jobs", zValidator("query", listQuery, invalid), async (c) => {
  const q = c.req.valid("query");
  const clubId = c.get("clubId");
  const where = and(eq(renderJobs.clubId, clubId), q.status ? eq(renderJobs.status, q.status) : undefined, canSeeAll(c.get("clubRoleTypes")) ? undefined : eq(renderJobs.requestedBy, c.get("user").id));
  const [total] = await db.select({ n: count() }).from(renderJobs).where(where);
  const rows = await db.select().from(renderJobs).where(where).orderBy(desc(renderJobs.createdAt), desc(renderJobs.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  return c.json({ data: rows.map(shapeJob), page: q.page, pageSize: q.pageSize, total: total?.n ?? 0 });
});

async function visibleJob(c: { get(key: "clubId"): string; get(key: "clubRoleTypes"): string[]; get(key: "user"): { id: string } }, rawId: string): Promise<RenderJobRow> {
  if (!isUuid(rawId)) throw new NotFoundError("Job not found");
  const [job] = await db.select().from(renderJobs).where(and(eq(renderJobs.id, rawId), eq(renderJobs.clubId, c.get("clubId")))).limit(1);
  if (!job || (!canSeeAll(c.get("clubRoleTypes")) && job.requestedBy !== c.get("user").id)) throw new NotFoundError("Job not found");
  return job;
}

documentGenerationRoutes.get("/jobs/:id", async (c) => c.json({ data: shapeJob(await visibleJob(c, c.req.param("id"))) }));

/** Runs a failed job again (the requester or `documents:manage`); the caller's right on the template is checked again. */
documentGenerationRoutes.post("/jobs/:id/retry", generateLimiter, async (c) => {
  const job = await visibleJob(c, c.req.param("id"));
  const p = await buildPrincipal(c);
  const template = getTemplate(job.templateId);
  if (!template) throw new NotFoundError("Job not found");
  if (template.permission !== null && !hasClubPermission(p.roleTypes, template.permission)) throw new ForbiddenError(`Missing ${template.permission} permission`);
  await template.authorize(p, template.paramsSchema.parse(stripInternal(job.params)));
  return c.json({ data: shapeJob(await retryRenderJob(job.id)) }, 202);
});
