import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, ilike, inArray, isNull, max, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers, LEFT_STATUSES } from "../db/schema/club-members.js";
import { consentPurposes, consentRecords, consentTexts } from "../db/schema/privacy.js";
import { writeAudit } from "../lib/audit.js";
import { askablePurposes, consentAgeLimitOf, currentTexts, isUnderConsentAge, sha256Hex } from "../lib/consent.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { todayBerlin } from "../lib/member-lifecycle.js";
import { cleanText } from "../lib/text-policy.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Consent purposes and their versioned texts (Wave 10 B3). A consent is ALWAYS voluntary: `requested` only feeds the
 * "open" list and reminders. Managing purposes/texts needs `privacy:manage`, reading everything `privacy:read`; every other
 * member only sees the purposes that are active with a published text (what they can be asked about).
 */
export const consentPurposeRoutes = new Hono<ClubEnv>();
/** `GET /consents/overview`: matrix members x purposes for `privacy:read`. */
export const consentOverviewRoutes = new Hono<ClubEnv>();

for (const router of [consentPurposeRoutes, consentOverviewRoutes]) {
  router.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
  router.use("*", sessionGuard);
  router.use("*", clubGuard);
}

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

const canRead = (c: { get(k: "clubRoleTypes"): string[] }) => hasClubPermission(c.get("clubRoleTypes"), "privacy:read") || hasClubPermission(c.get("clubRoleTypes"), "privacy:manage");
function requireManage(c: { get(k: "clubRoleTypes"): string[] }) {
  if (!hasClubPermission(c.get("clubRoleTypes"), "privacy:manage")) throw new ForbiddenError("Missing privacy:manage permission");
}

const TEXT_MIN = 10;
const TEXT_MAX = 5000;

function slugKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

type PurposeRow = typeof consentPurposes.$inferSelect;
type TextRow = typeof consentTexts.$inferSelect;

function shapePurpose(p: PurposeRow, text: TextRow | undefined) {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    system: p.system,
    requested: p.requested,
    active: p.active,
    minAge: p.minAge,
    sortOrder: p.sortOrder,
    archivedAt: p.archivedAt,
    currentText: text ? { id: text.id, version: text.version, body: text.body, sha256: text.sha256, publishedAt: text.publishedAt } : null,
  };
}

async function purposeOf(clubId: string, id: string): Promise<PurposeRow> {
  const [row] = await db.select().from(consentPurposes).where(and(eq(consentPurposes.id, id), eq(consentPurposes.clubId, clubId)));
  if (!row) throw new NotFoundError("Consent purpose not found");
  return row;
}

consentPurposeRoutes.get("/", async (c) => {
  const clubId = c.get("clubId");
  if (!canRead(c)) {
    // Everybody else: what they can be asked about (the text they would see), nothing about drafts or archived purposes.
    const askable = await askablePurposes(clubId);
    return c.json({ data: askable.map(({ purpose, text }) => shapePurpose(purpose, text)) });
  }
  const purposes = await db.select().from(consentPurposes).where(eq(consentPurposes.clubId, clubId)).orderBy(asc(consentPurposes.sortOrder), asc(consentPurposes.name));
  const texts = await currentTexts(purposes.map((p) => p.id));
  return c.json({ data: purposes.map((p) => shapePurpose(p, texts.get(p.id))) });
});

const createSchema = z.object({
  name: cleanText(z.string().trim().min(1).max(100)),
  description: z.union([cleanText(z.string().trim().max(500), true), z.null()]).optional(),
  requested: z.boolean().optional(),
  minAge: z.number().int().min(0).max(18).nullable().optional(),
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/).optional(),
});

consentPurposeRoutes.post("/", zValidator("json", createSchema, validationHook), async (c) => {
  requireManage(c);
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const key = body.key ?? slugKey(body.name);
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) throw new ValidationError("Cannot derive a key from the name; send `key`", { details: { code: "invalid_key" } });

  const row = await db.transaction(async (tx) => {
    const [taken] = await tx.select({ id: consentPurposes.id }).from(consentPurposes).where(and(eq(consentPurposes.clubId, clubId), eq(consentPurposes.key, key)));
    if (taken) throw new ConflictError("A purpose with this key already exists");
    const [top] = await tx.select({ next: max(consentPurposes.sortOrder) }).from(consentPurposes).where(eq(consentPurposes.clubId, clubId));
    const [created] = await tx
      .insert(consentPurposes)
      .values({ clubId, key, name: body.name, description: body.description ?? null, requested: body.requested ?? false, minAge: body.minAge ?? null, system: false, active: false, sortOrder: (top?.next ?? 0) + 10 })
      .returning();
    await writeAudit(tx, { eventType: "consent_purpose.create", subjectId: created!.id, payload: { clubId, key } });
    return created!;
  });
  return c.json({ data: shapePurpose(row, undefined) }, 201);
});

const updateSchema = z
  .object({
    name: cleanText(z.string().trim().min(1).max(100)).optional(),
    description: z.union([cleanText(z.string().trim().max(500), true), z.null()]).optional(),
    requested: z.boolean().optional(),
    active: z.boolean().optional(),
    minAge: z.number().int().min(0).max(18).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

consentPurposeRoutes.patch("/:id", zValidator("json", updateSchema, validationHook), async (c) => {
  requireManage(c);
  const clubId = c.get("clubId");
  const body = c.req.valid("json");
  const current = await purposeOf(clubId, c.req.param("id"));
  if (body.archived === true && current.system) throw new ConflictError("System purposes cannot be archived; deactivate them instead", { details: { code: "system_purpose" } });

  const updated = await db.transaction(async (tx) => {
    const text = (await currentTexts([current.id], tx)).get(current.id);
    if (body.active === true && !text) throw new ConflictError("Publish a text before activating the purpose", { details: { code: "no_published_text" } });
    const set: Partial<typeof consentPurposes.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) set.name = body.name;
    if (body.description !== undefined) set.description = body.description;
    if (body.requested !== undefined) set.requested = body.requested;
    if (body.active !== undefined) set.active = body.active;
    if (body.minAge !== undefined) set.minAge = body.minAge;
    if (body.archived !== undefined) {
      set.archivedAt = body.archived ? new Date() : null;
      if (body.archived) set.active = false;
    }
    const [row] = await tx.update(consentPurposes).set(set).where(and(eq(consentPurposes.id, current.id), eq(consentPurposes.clubId, clubId))).returning();
    await writeAudit(tx, { eventType: "consent_purpose.update", subjectId: current.id, payload: { clubId, changedFields: Object.keys(body) } });
    return { row: row!, text };
  });
  return c.json({ data: shapePurpose(updated.row, updated.text) });
});

consentPurposeRoutes.get("/:id/texts", async (c) => {
  if (!canRead(c)) throw new ForbiddenError("Missing privacy:read permission");
  const purpose = await purposeOf(c.get("clubId"), c.req.param("id"));
  const rows = await db.select().from(consentTexts).where(eq(consentTexts.purposeId, purpose.id)).orderBy(desc(consentTexts.version));
  return c.json({ data: rows.map((t) => ({ id: t.id, version: t.version, body: t.body, sha256: t.sha256, publishedAt: t.publishedAt, publishedBy: t.publishedBy })) });
});

const publishSchema = z.object({ body: cleanText(z.string().trim().min(TEXT_MIN).max(TEXT_MAX), true) });

/** Publishes a new immutable text version (+1). The first text activates the purpose. Re-sending the current text is a no-op (200). */
consentPurposeRoutes.post("/:id/texts", zValidator("json", publishSchema, validationHook), async (c) => {
  requireManage(c);
  const clubId = c.get("clubId");
  const { body } = c.req.valid("json");
  const purpose = await purposeOf(clubId, c.req.param("id"));
  if (purpose.archivedAt !== null) throw new ConflictError("The purpose is archived");
  const sha = sha256Hex(body);

  const result = await db.transaction(async (tx) => {
    // The purpose row serialises parallel publishes, so versions stay gapless.
    await tx.select({ id: consentPurposes.id }).from(consentPurposes).where(eq(consentPurposes.id, purpose.id)).for("update");
    const [latest] = await tx.select().from(consentTexts).where(eq(consentTexts.purposeId, purpose.id)).orderBy(desc(consentTexts.version)).limit(1);
    if (latest && latest.sha256 === sha && latest.publishedAt !== null) return { text: latest, created: false };
    const [text] = await tx
      .insert(consentTexts)
      .values({ purposeId: purpose.id, version: (latest?.version ?? 0) + 1, body, sha256: sha, publishedAt: new Date(), publishedBy: c.get("user").id })
      .returning();
    if (!latest) await tx.update(consentPurposes).set({ active: true, updatedAt: new Date() }).where(eq(consentPurposes.id, purpose.id));
    await writeAudit(tx, { eventType: "consent_text.publish", subjectId: purpose.id, payload: { clubId, purposeId: purpose.id, version: text!.version, sha256: sha } });
    return { text: text!, created: true };
  });
  const t = result.text;
  return c.json({ data: { id: t.id, version: t.version, body: t.body, sha256: t.sha256, publishedAt: t.publishedAt } }, result.created ? 201 : 200);
});

const overviewQuery = z.object({
  q: z.string().trim().max(100).optional(),
  // Only members whose latest event for `purposeId` is in this state ("none" = no decision yet).
  purposeId: z.uuid().optional(),
  state: z.enum(["granted", "revoked", "none"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

consentOverviewRoutes.get("/overview", zValidator("query", overviewQuery, validationHook), async (c) => {
  if (!canRead(c)) throw new ForbiddenError("Missing privacy:read permission");
  const clubId = c.get("clubId");
  const query = c.req.valid("query");
  if (query.state !== undefined && query.purposeId === undefined) throw new ValidationError("`state` needs `purposeId`");

  const purposes = (await askablePurposes(clubId)).map((a) => a.purpose);
  if (query.purposeId !== undefined && !purposes.some((p) => p.id === query.purposeId)) throw new NotFoundError("Consent purpose not found");

  // Latest event per member + purpose, as a derived table (the table is append-only; latest wins).
  const latest = db
    .selectDistinctOn([consentRecords.clubMemberId, consentRecords.purposeId], { clubMemberId: consentRecords.clubMemberId, purposeId: consentRecords.purposeId, action: consentRecords.action })
    .from(consentRecords)
    .where(eq(consentRecords.clubId, clubId))
    .orderBy(consentRecords.clubMemberId, consentRecords.purposeId, desc(consentRecords.createdAt), desc(consentRecords.id))
    .as("latest");

  const active = and(eq(clubMembers.clubId, clubId), notInArray(clubMembers.status, [...LEFT_STATUSES]), isNull(clubMembers.leftAt));
  const search = query.q ? ilike(clubMembers.displayName, `%${query.q.replace(/[%_\\]/g, "\\$&")}%`) : undefined;

  const stateOf = sql<string>`coalesce(${latest.action}, 'none')`;
  const filtered =
    query.purposeId !== undefined && query.state !== undefined
      ? sql`${stateOf} = ${query.state}`
      : undefined;
  const base = db
    .select({ id: clubMembers.id, displayName: clubMembers.displayName, birthDate: clubMembers.birthDate, accountLinked: sql<boolean>`${clubMembers.memberId} is not null` })
    .from(clubMembers)
    .leftJoin(latest, and(eq(latest.clubMemberId, clubMembers.id), query.purposeId !== undefined ? eq(latest.purposeId, query.purposeId) : sql`false`))
    .where(and(active, search, filtered));

  const [totalRow] = await db.select({ total: count() }).from(base.as("filtered_members"));
  const members = await base
    .orderBy(sql`lower(${clubMembers.displayName})`, clubMembers.id)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  // Page of states: one query for the members on this page; counters over all active members of the club.
  const ids = members.map((m) => m.id);
  const pageRecords = ids.length === 0 ? [] : await db.select().from(latest).where(inArray(latest.clubMemberId, ids));
  const stateByMember = new Map<string, Map<string, string>>();
  for (const r of pageRecords) {
    const m = stateByMember.get(r.clubMemberId) ?? new Map<string, string>();
    m.set(r.purposeId, r.action);
    stateByMember.set(r.clubMemberId, m);
  }

  const [activeRow] = await db.select({ activeTotal: count() }).from(clubMembers).where(active);
  const counts = await db
    .select({ purposeId: latest.purposeId, action: latest.action, n: count() })
    .from(latest)
    .innerJoin(clubMembers, and(eq(clubMembers.id, latest.clubMemberId), active))
    .groupBy(latest.purposeId, latest.action);
  const countOf = (purposeId: string, action: string) => counts.find((r) => r.purposeId === purposeId && r.action === action)?.n ?? 0;

  const limits = new Map<string, number>();
  for (const p of purposes) limits.set(p.id, await consentAgeLimitOf(clubId, p));
  const today = todayBerlin();

  return c.json({
    data: {
      purposes: purposes.map((p) => {
        const granted = countOf(p.id, "granted");
        const revoked = countOf(p.id, "revoked");
        return { id: p.id, key: p.key, name: p.name, requested: p.requested, counts: { granted, revoked, none: Math.max((activeRow?.activeTotal ?? 0) - granted - revoked, 0) } };
      }),
      members: members.map((m) => ({
        clubMemberId: m.id,
        displayName: m.displayName,
        accountLinked: m.accountLinked,
        // Per purpose: needs a guardian (or the board with a paper proof) because the person is under the age limit.
        states: Object.fromEntries(
          purposes.map((p) => [p.id, { state: stateByMember.get(m.id)?.get(p.id) ?? "none", needsGuardian: isUnderConsentAge(m.birthDate, limits.get(p.id)!, today) }]),
        ),
      })),
    },
    meta: { total: totalRow?.total ?? 0, page: query.page, pageSize: query.pageSize },
  });
});
