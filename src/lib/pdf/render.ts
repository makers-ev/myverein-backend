import { createHash, randomUUID } from "node:crypto";

import { and, count, eq, inArray, lt, or, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { documentFolders, documents, documentVersions, renderJobs, type RenderJobRow } from "../../db/schema/documents.js";
import { writeAudit } from "../audit.js";
import { loadBranding } from "../branding.js";
import type { DocumentPrincipal } from "../document-access.js";
import { hasClubPermission } from "../club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, TooManyRequestsError, ValidationError } from "../errors.js";
import { enqueue } from "../jobs/queue.js";
import type { JobContext } from "../jobs/registry.js";
import { logger } from "../logger.js";
import { discardStoredFile, DOCUMENT_OWNER_TYPES, storeGeneratedPdf } from "../media.js";
import { checkStorageThresholds } from "../media-quota.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { todayBerlin } from "../member-lifecycle.js";
import { retentionUntilFor } from "../retention/document-classes.js";
import { getPdfEngine, looksLikePdf, PdfRenderError, DEFAULT_PDF_LIMITS, type PdfBranding } from "./engine.js";
import { getTemplate, RENDER_ENGINE_VERSION, type AnyTemplate } from "./registry.js";
import { pdfText } from "./text.js";

/**
 * Render pipeline (Wave 13 B8): request -> `render_jobs` row -> (inline for short documents, else the worker) -> PDF via the
 * engine -> registered through the media layer -> `documents` / `document_versions` as a SNAPSHOT (never re-rendered on read;
 * "regenerate" adds a new version). Rules:
 *  - a template id outside the registry and params outside its schema are refused before anything is stored;
 *  - the caller's rights are checked at request time by the template (`authorize`), the data is read at execution time;
 *  - a failed render never blocks a business action: `requestRenderSafely` only logs, the queue retries with backoff, a final
 *    failure leaves a visible `fehlgeschlagen` job with a fixed error code (no personal data) and a manual retry;
 *  - at most `MAX_ACTIVE_JOBS_PER_CLUB` jobs run or wait per club at the same time (`429`).
 */

export const RENDER_JOB_TYPE = "render_pdf";
export const MAX_ACTIVE_JOBS_PER_CLUB = 10;
/** A job claimed longer ago than this is treated as abandoned (crashed worker) and may be claimed again. */
const STALE_CLAIM_MS = 5 * 60 * 1000;
/** How long an interactive request waits for a short document. */
const SYNC_WAIT_MS = 15_000;

export const RENDER_ERROR_CODES = ["render_timeout", "render_limit", "render_failed", "quota_exceeded", "source_unavailable", "internal_error"] as const;
export type RenderErrorCode = (typeof RENDER_ERROR_CODES)[number];

/** Canonical JSON (sorted keys): equal input data always hashes equal. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export const inputHashOf = (data: unknown): string => createHash("sha256").update(stableStringify(data)).digest("hex");

export interface RenderRequest {
  clubId: string;
  templateId: string;
  params: unknown;
  /** Caller; `null` for system requests (business actions), which skip `authorize`. */
  actor: DocumentPrincipal | null;
  /** Adds a new version to this generated document instead of creating a new one. */
  replaceDocumentId?: string | null;
  /** The same key never creates a second job (the finished or running one is returned). */
  idempotencyKey?: string | null;
  /** `false` forces the worker even for a short document. */
  wait?: boolean;
}

function errorCodeOf(err: unknown): RenderErrorCode {
  if (err instanceof PdfRenderError) return err.code === "timeout" ? "render_timeout" : err.code === "engine_error" ? "render_failed" : "render_limit";
  if (err instanceof ValidationError && err.code === "QUOTA_EXCEEDED") return "quota_exceeded";
  if (err instanceof NotFoundError || err instanceof ForbiddenError) return "source_unavailable";
  return "internal_error";
}

/** Creates the job (and runs it inline when the template is short and `wait` allows). Throws for refusals the caller must see. */
export async function requestRender(req: RenderRequest): Promise<RenderJobRow> {
  const template = getTemplate(req.templateId);
  if (!template) throw new NotFoundError("Unknown template");
  const parsed = template.paramsSchema.safeParse(req.params ?? {});
  if (!parsed.success) throw new ValidationError("Invalid template parameters", { details: parsed.error.issues });
  if (req.actor) {
    if (req.actor.clubId !== req.clubId) throw new NotFoundError("Unknown template");
    if (template.permission !== null && !hasClubPermission(req.actor.roleTypes, template.permission)) throw new ForbiddenError(`Missing ${template.permission} permission`);
    await template.authorize(req.actor, parsed.data);
  }
  // Ephemeral templates (branding test page, membership cards) are rendered by their own routes and never stored.
  if (template.destination === "ephemeral") throw new ValidationError("This template is rendered directly and cannot be requested as a job", { details: { code: "ephemeral_template" } });

  if (req.replaceDocumentId) {
    const [doc] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, req.replaceDocumentId), eq(documents.clubId, req.clubId), eq(documents.kind, "erzeugt"), eq(documents.status, "aktiv"))).limit(1);
    if (!doc) throw new NotFoundError("Document to regenerate not found");
  }

  const job = await db.transaction(async (tx) => {
    if (req.idempotencyKey) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`render-key:${req.clubId}:${template.id}:${req.idempotencyKey}`}, 0))`);
      const [existing] = await tx
        .select()
        .from(renderJobs)
        .where(and(eq(renderJobs.clubId, req.clubId), eq(renderJobs.templateId, template.id), sql`${renderJobs.params}->>'idempotencyKey' = ${req.idempotencyKey}`))
        .limit(1);
      if (existing) return existing;
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`render-active:${req.clubId}`}, 0))`);
    const [{ n }] = await tx.select({ n: count() }).from(renderJobs).where(and(eq(renderJobs.clubId, req.clubId), inArray(renderJobs.status, ["wartet", "rendert"])));
    if (n >= MAX_ACTIVE_JOBS_PER_CLUB) throw new TooManyRequestsError("Too many documents are being generated right now, try again in a moment");
    const stored: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>), ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}), ...(req.replaceDocumentId ? { replaceDocumentId: req.replaceDocumentId } : {}) };
    const [row] = await tx
      .insert(renderJobs)
      .values({ clubId: req.clubId, templateId: template.id, templateVersion: template.version, params: stored, requestedBy: req.actor?.userId ?? null, documentId: null })
      .returning();
    return row!;
  });
  if (job.status !== "wartet") return job;

  const inline = template.sync && req.wait !== false;
  if (inline) {
    const finished = await Promise.race([executeRenderJob(job.id, { final: true }), new Promise<null>((resolve) => setTimeout(() => resolve(null), SYNC_WAIT_MS).unref())]);
    if (finished) return finished;
  }
  await enqueue({ type: RENDER_JOB_TYPE, payload: { jobId: job.id }, dedupeKey: `render:${job.id}:${job.attempts}` });
  return job;
}

/** For business actions (receipt on acceptance, confirmation on exit): never throws, a failure is logged by id and code only. */
export async function requestRenderSafely(req: RenderRequest): Promise<RenderJobRow | null> {
  try {
    return await requestRender({ ...req, wait: false });
  } catch (err) {
    logger.error({ clubId: req.clubId, templateId: req.templateId, errCode: err instanceof Error ? err.name : "unknown" }, "[render] could not schedule a document");
    return null;
  }
}

async function systemFolder(clubId: string, folder: { systemKey: string; name: string }): Promise<string> {
  await db.insert(documentFolders).values({ clubId, name: folder.name, systemKey: folder.systemKey }).onConflictDoNothing();
  const [row] = await db.select({ id: documentFolders.id }).from(documentFolders).where(and(eq(documentFolders.clubId, clubId), eq(documentFolders.systemKey, folder.systemKey))).limit(1);
  return row!.id;
}

/** Atomically takes a waiting (or abandoned) job; `null` if somebody else has it or it is finished. */
async function claim(jobId: string): Promise<RenderJobRow | null> {
  const [row] = await db
    .update(renderJobs)
    .set({ status: "rendert", startedAt: new Date(), attempts: sql`${renderJobs.attempts} + 1`, errorCode: null })
    .where(and(eq(renderJobs.id, jobId), or(eq(renderJobs.status, "wartet"), and(eq(renderJobs.status, "rendert"), lt(renderJobs.startedAt, new Date(Date.now() - STALE_CLAIM_MS))))))
    .returning();
  return row ?? null;
}

async function loadJob(jobId: string): Promise<RenderJobRow | null> {
  const [row] = await db.select().from(renderJobs).where(eq(renderJobs.id, jobId)).limit(1);
  return row ?? null;
}

/**
 * Renders one job. `final: true` marks the failure as final (no retry left); otherwise a failure puts the job back to
 * `wartet` and rethrows so the queue retries with backoff. Returns the job as it ends.
 */
export async function executeRenderJob(jobId: string, opts: { final: boolean }): Promise<RenderJobRow | null> {
  const job = await claim(jobId);
  if (!job) return loadJob(jobId);
  const template = getTemplate(job.templateId);
  try {
    if (!template) throw new NotFoundError("Unknown template");
    const params = template.paramsSchema.parse(stripInternal(job.params));
    const built = await template.build(job.clubId, params);
    const branding = await loadBranding(job.clubId);
    const bytes = await renderBuffer(template, built, branding, params);
    const inputHash = inputHashOf(built.data);
    const stored = await persist(job, template, built, bytes, inputHash);
    const [done] = await db
      .update(renderJobs)
      .set({ status: "fertig", documentId: stored.documentId, versionId: stored.versionId, inputHash, subjectClubMemberId: built.subjectClubMemberId ?? null, finishedAt: new Date(), errorCode: null })
      .where(eq(renderJobs.id, job.id))
      .returning();
    await checkStorageThresholds(job.clubId);
    return done!;
  } catch (err) {
    const code = errorCodeOf(err);
    // The log carries ids and the fixed code only: error messages of the engine or the data layer may echo personal data.
    logger.warn({ jobId: job.id, clubId: job.clubId, templateId: job.templateId, code, attempt: job.attempts }, "[render] job failed");
    // Retrying cannot help against a full quota or a source that is gone.
    const hopeless = code === "quota_exceeded" || code === "source_unavailable" || code === "render_limit";
    if (!opts.final && !hopeless) {
      await db.update(renderJobs).set({ status: "wartet", errorCode: code }).where(eq(renderJobs.id, job.id));
      throw new Error(`render job failed: ${code}`, { cause: err });
    }
    const [failed] = await db.update(renderJobs).set({ status: "fehlgeschlagen", errorCode: code, finishedAt: new Date() }).where(eq(renderJobs.id, job.id)).returning();
    return failed!;
  }
}

/** Params as stored carry bookkeeping keys that are not part of the template's schema. */
export function stripInternal(params: Record<string, unknown>): Record<string, unknown> {
  const { idempotencyKey: _k, replaceDocumentId: _r, ...rest } = params;
  void _k;
  void _r;
  return rest;
}

async function renderBuffer(template: AnyTemplate, built: Awaited<ReturnType<AnyTemplate["build"]>>, branding: PdfBranding, params: unknown): Promise<Buffer> {
  const layout = template.layout(built, branding, params);
  const bytes = await getPdfEngine().render({ title: layout.title, generatedAt: new Date(), format: layout.format, landscape: layout.landscape, branding, blocks: layout.blocks }, DEFAULT_PDF_LIMITS);
  if (!looksLikePdf(bytes)) throw new PdfRenderError("engine_error", "Engine did not produce a PDF");
  return bytes;
}

/** Renders a template to bytes without storing anything (`ephemeral` templates such as the branding test page). */
export async function renderEphemeral(templateId: string, clubId: string, params: unknown): Promise<{ bytes: Buffer; filename: string }> {
  const template = getTemplate(templateId);
  if (!template || template.destination !== "ephemeral") throw new NotFoundError("Unknown template");
  const parsed = template.paramsSchema.parse(params ?? {});
  const built = await template.build(clubId, parsed);
  const bytes = await renderBuffer(template, built, await loadBranding(clubId), parsed);
  return { bytes, filename: built.filename };
}

async function persist(job: RenderJobRow, template: AnyTemplate, built: Awaited<ReturnType<AnyTemplate["build"]>>, bytes: Buffer, inputHash: string): Promise<{ documentId: string; versionId: string }> {
  if (template.destination === "ephemeral") throw new ConflictError("This template cannot be stored");
  const replaceId = typeof job.params.replaceDocumentId === "string" ? job.params.replaceDocumentId : null;
  const person = template.destination === "person";
  if (person && !built.subjectClubMemberId) throw new NotFoundError("No person to store the document for");
  const folderId = !person && template.folder ? await systemFolder(job.clubId, template.folder) : null;
  const title = pdfText(built.title, { maxLength: 200 }) || template.label;

  let storedKey: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
      const documentId = replaceId ?? randomUUID();
      const media = await storeGeneratedPdf({
        buffer: bytes,
        clubId: job.clubId,
        directory: person ? "personal" : "documents",
        filename: built.filename,
        owner: { type: person ? DOCUMENT_OWNER_TYPES.personal : DOCUMENT_OWNER_TYPES.generated, id: documentId },
        sensitive: template.sensitive || person,
        uploadedBy: job.requestedBy,
        executor: tx,
      });
      storedKey = media.storageKey;
      let versionNo = 1;
      if (replaceId) {
        const [doc] = await tx.select().from(documents).where(and(eq(documents.id, replaceId), eq(documents.clubId, job.clubId), eq(documents.kind, "erzeugt"))).for("update");
        if (!doc || doc.status !== "aktiv") throw new NotFoundError("Document to regenerate not found");
        const [{ n }] = await tx.select({ n: sql<number>`coalesce(max(${documentVersions.versionNo}), 0)::int` }).from(documentVersions).where(eq(documentVersions.documentId, doc.id));
        versionNo = n + 1;
      } else {
        // Retention (B14): classes counted from the creation get their date now; exit-based ones follow the exit of the person.
        const [owner] = person ? await tx.select({ leftAt: clubMembers.leftAt }).from(clubMembers).where(eq(clubMembers.id, built.subjectClubMemberId!)) : [];
        await tx.insert(documents).values({
          retentionUntil: retentionUntilFor(template.docType, todayBerlin(), owner?.leftAt ?? null),
          id: documentId,
          clubId: job.clubId,
          scope: person ? "person" : "verein",
          folderId,
          ownerClubMemberId: person ? built.subjectClubMemberId! : null,
          kind: "erzeugt",
          docType: template.docType,
          title,
          createdBy: job.requestedBy,
        });
      }
      const [version] = await tx
        .insert(documentVersions)
        .values({
          documentId,
          clubId: job.clubId,
          versionNo,
          storageKey: media.storageKey,
          mimeType: media.mimeType,
          sizeBytes: media.sizeBytes,
          sha256: media.sha256,
          originalFilename: media.originalFilename,
          templateId: template.id,
          templateVersion: template.version,
          inputHash,
          engineVersion: RENDER_ENGINE_VERSION,
          createdBy: job.requestedBy,
        })
        .returning();
      await tx.update(documents).set({ currentVersionId: version!.id, updatedAt: new Date() }).where(eq(documents.id, documentId));
      await writeAudit(tx, { eventType: "document.generate", subjectId: documentId, actorUserId: job.requestedBy, clubId: job.clubId, payload: { clubId: job.clubId, documentId, templateId: template.id, versionNo } });
      return { documentId, versionId: version!.id };
    });
    return result;
  } catch (err) {
    // The registry row rolled back with the transaction: do not leave the file behind.
    if (storedKey) await discardStoredFile(storedKey);
    throw err;
  }
}

/** Worker handler of `render_pdf`: the last attempt marks the job failed for good instead of throwing. */
export async function handleRenderJob(job: JobContext): Promise<void> {
  const jobId = typeof job.payload.jobId === "string" ? job.payload.jobId : null;
  if (!jobId) return;
  await executeRenderJob(jobId, { final: job.attempt >= job.maxAttempts });
}

/** Resets a failed job and schedules it again (manual retry); `409` unless it failed. */
export async function retryRenderJob(jobId: string): Promise<RenderJobRow> {
  const [row] = await db
    .update(renderJobs)
    .set({ status: "wartet", errorCode: null, finishedAt: null, startedAt: null })
    .where(and(eq(renderJobs.id, jobId), eq(renderJobs.status, "fehlgeschlagen")))
    .returning();
  if (!row) throw new ConflictError("Only a failed job can be retried");
  await enqueue({ type: RENDER_JOB_TYPE, payload: { jobId: row.id }, dedupeKey: `render:${row.id}:retry:${Date.now()}` });
  return row;
}

