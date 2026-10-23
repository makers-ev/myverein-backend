import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { dpaAcceptances, dpaVersions, type DpaVersionRow } from "../db/schema/privacy.js";
import { writeAudit } from "../lib/audit.js";
import { isUuid } from "../lib/club-members.js";
import { dpaChecksum, dpaGraceDays, dpaRequired, DPA_NOTIFY_JOB_TYPE, dpaStatusOf } from "../lib/dpa.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import { enqueue } from "../lib/jobs/queue.js";
import { cleanText } from "../lib/text-policy.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Platform admin: processor agreement versions (`/admin/dpa-versions`) and which club accepted which version
 * (`/admin/dpa-acceptances`). A version is a draft until published; a published version never changes (publish a new one).
 */
export const adminDpaVersionRoutes = new Hono<SessionEnv>();
export const adminDpaAcceptanceRoutes = new Hono<SessionEnv>();

for (const router of [adminDpaVersionRoutes, adminDpaAcceptanceRoutes]) {
  router.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
  router.use("*", adminGuard);
}

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

const subprocessor = z.object({ name: cleanText(z.string().trim().min(1).max(200)), purpose: cleanText(z.string().trim().min(1).max(300)), location: cleanText(z.string().trim().min(1).max(200)) });
const contentFields = {
  title: cleanText(z.string().trim().min(3).max(200)),
  body: z.string().trim().min(20).max(200_000),
  subprocessors: z.array(subprocessor).max(50),
  tomAnnex: z.string().trim().min(1).max(100_000).nullable().optional(),
  // From this day the version is mandatory (grace period starts here); NULL = the publication day.
  requiredFrom: z.iso.date().nullable().optional(),
};
const createSchema = z.object({ ...contentFields, subprocessors: contentFields.subprocessors.default([]) });
const patchSchema = z.object(contentFields).partial().refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

const shape = (v: DpaVersionRow, extra: Record<string, unknown> = {}) => ({
  id: v.id,
  version: v.version,
  title: v.title,
  body: v.body,
  subprocessors: v.subprocessors,
  tomAnnex: v.tomAnnex,
  sha256: v.sha256,
  requiredFrom: v.requiredFrom,
  publishedAt: v.publishedAt,
  publishedBy: v.publishedBy,
  createdAt: v.createdAt,
  status: v.publishedAt ? "published" : "draft",
  ...extra,
});

adminDpaVersionRoutes.get("/", async (c) => {
  const versions = await db.select().from(dpaVersions).orderBy(desc(dpaVersions.version));
  const accepted = await db.select({ versionId: dpaAcceptances.dpaVersionId, n: count() }).from(dpaAcceptances).groupBy(dpaAcceptances.dpaVersionId);
  const [clubs] = await db.select({ n: count() }).from(organization);
  const acceptedBy = new Map(accepted.map((a) => [a.versionId, Number(a.n)]));
  return c.json({ data: versions.map((v) => shape(v, { acceptedClubs: acceptedBy.get(v.id) ?? 0 })), totalClubs: Number(clubs?.n ?? 0), gate: { required: dpaRequired(), graceDays: dpaGraceDays() } });
});

adminDpaVersionRoutes.post("/", zValidator("json", createSchema, validationHook), async (c) => {
  const body = c.req.valid("json");
  const content = { title: body.title, body: body.body, subprocessors: body.subprocessors, tomAnnex: body.tomAnnex ?? null };
  const row = await db.transaction(async (tx) => {
    // Version numbers are assigned in order; the unique index guards a parallel create.
    const [last] = await tx.select({ v: sql<number>`coalesce(max(${dpaVersions.version}), 0)::int` }).from(dpaVersions);
    const [created] = await tx
      .insert(dpaVersions)
      .values({ version: (last?.v ?? 0) + 1, ...content, requiredFrom: body.requiredFrom ?? null, sha256: dpaChecksum(content) })
      .returning();
    await writeAudit(tx, { eventType: "dpa_version.create", subjectId: created!.id, clubId: null, payload: { version: created!.version } });
    return created!;
  });
  return c.json({ data: shape(row) }, 201);
});

async function draftOf(id: string) {
  if (!isUuid(id)) throw new NotFoundError("Version not found");
  const [row] = await db.select().from(dpaVersions).where(eq(dpaVersions.id, id));
  if (!row) throw new NotFoundError("Version not found");
  if (row.publishedAt) throw new ConflictError("A published version cannot be changed: publish a new version", { details: { code: "version_published" } });
  return row;
}

adminDpaVersionRoutes.patch("/:id", zValidator("json", patchSchema, validationHook), async (c) => {
  const current = await draftOf(c.req.param("id"));
  const body = c.req.valid("json");
  const content = { title: body.title ?? current.title, body: body.body ?? current.body, subprocessors: body.subprocessors ?? current.subprocessors, tomAnnex: body.tomAnnex === undefined ? current.tomAnnex : body.tomAnnex };
  const [row] = await db
    .update(dpaVersions)
    .set({ ...content, requiredFrom: body.requiredFrom === undefined ? current.requiredFrom : body.requiredFrom, sha256: dpaChecksum(content) })
    .where(and(eq(dpaVersions.id, current.id), sql`${dpaVersions.publishedAt} IS NULL`))
    .returning();
  if (!row) throw new ConflictError("A published version cannot be changed: publish a new version", { details: { code: "version_published" } });
  await writeAudit(db, { eventType: "dpa_version.update", subjectId: row.id, clubId: null, payload: { version: row.version, changedFields: Object.keys(body) } });
  return c.json({ data: shape(row) });
});

adminDpaVersionRoutes.delete("/:id", async (c) => {
  const current = await draftOf(c.req.param("id"));
  await db.delete(dpaVersions).where(and(eq(dpaVersions.id, current.id), sql`${dpaVersions.publishedAt} IS NULL`));
  await writeAudit(db, { eventType: "dpa_version.delete", subjectId: current.id, clubId: null, payload: { version: current.version } });
  return c.body(null, 204);
});

/** Publishes a draft: immutable from now on, current for every club; the owners are told by a job. */
adminDpaVersionRoutes.post("/:id/publish", async (c) => {
  const current = await draftOf(c.req.param("id"));
  const row = await db.transaction(async (tx) => {
    const [published] = await tx
      .update(dpaVersions)
      .set({ publishedAt: new Date(), publishedBy: c.get("user").id })
      .where(and(eq(dpaVersions.id, current.id), sql`${dpaVersions.publishedAt} IS NULL`))
      .returning();
    if (!published) throw new ConflictError("Already published", { details: { code: "version_published" } });
    await writeAudit(tx, { eventType: "dpa_version.publish", subjectId: published.id, clubId: null, payload: { version: published.version, sha256: published.sha256, requiredFrom: published.requiredFrom } });
    await enqueue({ type: DPA_NOTIFY_JOB_TYPE, payload: { dpaVersionId: published.id }, dedupeKey: `dpa_notify:${published.id}` }, tx);
    return published;
  });
  return c.json({ data: shape(row) });
});

const acceptanceQuery = z.object({
  versionId: z.uuid().optional(),
  // `missing` = clubs that have not accepted the version yet.
  state: z.enum(["accepted", "missing"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Per club: has it accepted the version (default: the current one), who, when, and the grace deadline. */
adminDpaAcceptanceRoutes.get("/", zValidator("query", acceptanceQuery, validationHook), async (c) => {
  const q = c.req.valid("query");
  const [version] = q.versionId
    ? await db.select().from(dpaVersions).where(and(eq(dpaVersions.id, q.versionId), isNotNull(dpaVersions.publishedAt)))
    : await db.select().from(dpaVersions).where(isNotNull(dpaVersions.publishedAt)).orderBy(desc(dpaVersions.version)).limit(1);
  if (!version) return c.json({ data: [], page: q.page, pageSize: q.pageSize, total: 0, version: null, gate: { required: dpaRequired(), graceDays: dpaGraceDays() } });
  const accepted = sql`EXISTS (SELECT 1 FROM dpa_acceptances a WHERE a.club_id = ${organization.id} AND a.dpa_version_id = ${version.id})`;
  const where = q.state === "accepted" ? accepted : q.state === "missing" ? sql`NOT ${accepted}` : undefined;
  const [total] = await db.select({ n: count() }).from(organization).where(where);
  const clubs = await db.select({ id: organization.id, name: organization.name }).from(organization).where(where).orderBy(asc(organization.name), asc(organization.id)).limit(q.pageSize).offset((q.page - 1) * q.pageSize);
  const data = [];
  for (const club of clubs) {
    const [acceptance] = await db
      .select({ acceptedAt: dpaAcceptances.acceptedAt, signerName: dpaAcceptances.signerName, userName: user.name })
      .from(dpaAcceptances)
      .leftJoin(user, eq(user.id, dpaAcceptances.acceptedByUserId))
      .where(and(eq(dpaAcceptances.clubId, club.id), eq(dpaAcceptances.dpaVersionId, version.id)));
    const { status } = await dpaStatusOf(club.id);
    data.push({ clubId: club.id, clubName: club.name, accepted: acceptance !== undefined, acceptedAt: acceptance?.acceptedAt ?? null, signerName: acceptance?.signerName ?? null, acceptedBy: acceptance?.userName ?? null, deadline: status.deadline, daysLeft: acceptance ? null : status.daysLeft, blocked: status.blocked });
  }
  return c.json({ data, page: q.page, pageSize: q.pageSize, total: total?.n ?? 0, version: { id: version.id, version: version.version, publishedAt: version.publishedAt }, gate: { required: dpaRequired(), graceDays: dpaGraceDays() } });
});
