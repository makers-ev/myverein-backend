import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { ANNOUNCEMENT_STATUSES, clubAnnouncements, messageDeliveries, type ClubAnnouncementRow } from "../db/schema/communication.js";
import { assertWithinSendLimits } from "../lib/announcement-limits.js";
import { AudienceLimitError, resolveClubAudience, summarizeAudience } from "../lib/audience.js";
import {
  assertMayAddress,
  assertPublishAt,
  audienceSchema,
  bodySchema,
  canAuthor,
  channelsSchema,
  loadAuthorScope,
  schedulePublish,
  sendAnnouncement,
  titleSchema,
  type AuthorScope,
} from "../lib/announcements.js";
import { ensureClubMember, isUuid } from "../lib/club-members.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { enqueue } from "../lib/jobs/queue.js";
import { optedOutDeliveryIds } from "../lib/notify/guards.js";
import { EMAIL_JOB_TYPE, type DeliveryContent } from "../lib/notify/types.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";
import { writeAudit } from "../lib/audit.js";

/**
 * Club announcements (Wave 9 B7, ADR-006). Authoring side `/club-announcements` (needs `announcements:write` or
 * `announcements:write_department`, the latter only for the own departments) and member side `/club-inbox`
 * (the caller's own in-app deliveries). Sending always goes through `sendAnnouncement` -> `notify`.
 */

type AnnouncementEnv = ClubEnv & { Variables: ClubEnv["Variables"] & { scope: AuthorScope } };

export const clubAnnouncementRoutes = new Hono<AnnouncementEnv>();

clubAnnouncementRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
clubAnnouncementRoutes.use("*", sessionGuard);
clubAnnouncementRoutes.use("*", clubGuard);
// Deny-by-default for the whole router, BEFORE any body validation or lookup: only authors get past this line.
clubAnnouncementRoutes.use("*", async (c, next) => {
  const scope = await loadAuthorScope(c.get("clubId"), c.get("membership").id, c.get("clubRoleTypes"));
  if (!canAuthor(scope)) throw new ForbiddenError("Missing announcements:write permission");
  c.set("scope", scope);
  await next();
});

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

const sendLimit = rateLimit({ windowMs: 60_000, max: 20, key: (c) => `send:${c.get("user")?.id ?? "anon"}` });
const previewLimit = rateLimit({ windowMs: 60_000, max: 30, key: (c) => `preview:${c.get("user")?.id ?? "anon"}` });

const LOCKED = "Only pinning and withdrawing are possible after sending";

function shape(row: ClubAnnouncementRow, authorName: string | null) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    audience: row.audience,
    channels: row.channels,
    urgent: row.urgent,
    pinned: row.pinned,
    publishAt: row.publishAt,
    expiresAt: row.expiresAt,
    status: row.status,
    sentAt: row.sentAt,
    authorMemberId: row.authorMemberId,
    authorName,
    withdrawn: row.status === "sent" && row.expiresAt !== null && row.expiresAt.getTime() <= Date.now(),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Announcement visible to the caller: `announcements:write` sees the whole club, the department variant only own ones. */
async function loadVisible(c: Context<AnnouncementEnv>, idParam: string, lock = false) {
  if (!isUuid(idParam)) throw new NotFoundError("Announcement not found");
  const clubId = c.get("clubId");
  const scope = c.get("scope");
  const own = scope.write ? null : await ensureClubMember(db, c.get("membership"));
  const query = db
    .select({ row: clubAnnouncements, authorName: clubMembers.displayName })
    .from(clubAnnouncements)
    .leftJoin(clubMembers, eq(clubMembers.id, clubAnnouncements.authorMemberId))
    .where(and(eq(clubAnnouncements.id, idParam), eq(clubAnnouncements.clubId, clubId), own ? eq(clubAnnouncements.authorMemberId, own.id) : undefined));
  const [found] = await (lock ? query.for("update", { of: clubAnnouncements }) : query);
  if (!found) throw new NotFoundError("Announcement not found");
  return found;
}

const isEditable = (row: ClubAnnouncementRow) => row.status === "draft" || row.status === "scheduled";

/** Order-insensitive JSON for comparing audience objects. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).sort().join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Withdraw / cancel: mails and pushes that have not gone out yet must not go out any more. */
async function skipUnsentDeliveries(tx: Pick<typeof db, "update">, announcementId: string): Promise<void> {
  await tx
    .update(messageDeliveries)
    .set({ status: "skipped", errorCode: "withdrawn" })
    .where(and(eq(messageDeliveries.announcementId, announcementId), inArray(messageDeliveries.channel, ["email", "push"]), eq(messageDeliveries.status, "queued")));
}

// --- Create / list ---------------------------------------------------------------------------------

const createSchema = z.object({
  title: titleSchema,
  body: bodySchema,
  audience: audienceSchema,
  channels: channelsSchema.default(["in_app"]),
  urgent: z.boolean().default(false),
  pinned: z.boolean().default(false),
  publishAt: z.coerce.date().nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});

clubAnnouncementRoutes.post("/", zValidator("json", createSchema, validationHook), async (c) => {
  const body = c.req.valid("json");
  assertMayAddress(c.get("scope"), body.audience, body.urgent);
  assertPublishAt(body.publishAt);
  if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) throw new ValidationError("expiresAt must be in the future");
  const author = await ensureClubMember(db, c.get("membership"));
  const [row] = await db
    .insert(clubAnnouncements)
    .values({
      clubId: c.get("clubId"),
      authorMemberId: author.id,
      title: body.title,
      body: body.body,
      audience: body.audience,
      channels: body.channels,
      urgent: body.urgent,
      pinned: body.pinned,
      publishAt: body.publishAt ?? null,
      expiresAt: body.expiresAt ?? null,
    })
    .returning();
  return c.json({ data: shape(row!, author.displayName) }, 201);
});

const listSchema = z.object({
  status: z.enum(ANNOUNCEMENT_STATUSES).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

clubAnnouncementRoutes.get("/", zValidator("query", listSchema, validationHook), async (c) => {
  const query = c.req.valid("query");
  const own = c.get("scope").write ? null : await ensureClubMember(db, c.get("membership"));
  const where = and(eq(clubAnnouncements.clubId, c.get("clubId")), query.status ? eq(clubAnnouncements.status, query.status) : undefined, own ? eq(clubAnnouncements.authorMemberId, own.id) : undefined);
  const [total] = await db.select({ n: count() }).from(clubAnnouncements).where(where);
  const rows = await db
    .select({ row: clubAnnouncements, authorName: clubMembers.displayName })
    .from(clubAnnouncements)
    .leftJoin(clubMembers, eq(clubMembers.id, clubAnnouncements.authorMemberId))
    .where(where)
    .orderBy(desc(clubAnnouncements.createdAt), desc(clubAnnouncements.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return c.json({ data: rows.map((r) => shape(r.row, r.authorName)), pagination: { page: query.page, pageSize: query.pageSize, total: total?.n ?? 0 } });
});

// --- Preview (counts only) ---------------------------------------------------------------------------

const previewSchema = z.object({ audience: audienceSchema, channels: channelsSchema.default(["in_app"]) });

clubAnnouncementRoutes.post("/preview", previewLimit, zValidator("json", previewSchema, validationHook), async (c) => {
  const body = c.req.valid("json");
  assertMayAddress(c.get("scope"), body.audience, false);
  try {
    const { recipients } = await resolveClubAudience(c.get("clubId"), body.audience);
    c.header("Cache-Control", "private, no-store");
    return c.json({ data: summarizeAudience(recipients, body.channels) });
  } catch (err) {
    if (err instanceof AudienceLimitError) throw new ValidationError("The audience is too large", { code: "UNPROCESSABLE_ENTITY", details: { size: err.size, limit: err.limit } });
    throw err;
  }
});

// --- Read / edit / delete -------------------------------------------------------------------------------

clubAnnouncementRoutes.get("/:id", async (c) => {
  const { row, authorName } = await loadVisible(c, c.req.param("id"));
  return c.json({ data: shape(row, authorName) });
});

const patchSchema = z
  .object({
    title: titleSchema,
    body: bodySchema,
    audience: audienceSchema,
    channels: channelsSchema,
    urgent: z.boolean(),
    pinned: z.boolean(),
    publishAt: z.coerce.date().nullable(),
    expiresAt: z.coerce.date().nullable(),
    withdraw: z.literal(true),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

clubAnnouncementRoutes.patch("/:id", zValidator("json", patchSchema, validationHook), async (c) => {
  const body = c.req.valid("json");
  const clubId = c.get("clubId");
  const id = c.req.param("id");
  await loadVisible(c, id); // 404 for foreign / not-own ids before anything is locked
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(clubAnnouncements).where(and(eq(clubAnnouncements.id, id), eq(clubAnnouncements.clubId, clubId))).for("update");
    if (!row) throw new NotFoundError("Announcement not found");
    const set: Partial<typeof clubAnnouncements.$inferInsert> = { updatedAt: new Date() };
    let reschedule = false;
    if (isEditable(row)) {
      if (body.withdraw) throw new ConflictError("Only a sent announcement can be withdrawn", { code: "CONFLICT" });
      const audience = body.audience ?? row.audience;
      const urgent = body.urgent ?? row.urgent;
      assertMayAddress(c.get("scope"), audience, urgent);
      if (body.publishAt !== undefined) {
        assertPublishAt(body.publishAt);
        if (row.status === "scheduled") {
          if (body.publishAt === null) throw new ValidationError("Use /cancel to unschedule an announcement");
          reschedule = body.publishAt.getTime() !== row.publishAt?.getTime();
        }
        set.publishAt = body.publishAt;
      }
      if (body.expiresAt !== undefined) {
        if (body.expiresAt && body.expiresAt.getTime() <= Date.now()) throw new ValidationError("expiresAt must be in the future");
        set.expiresAt = body.expiresAt;
      }
      // A scheduled announcement was confirmed (limits, recipient count) for its audience/channels/urgency: changing any of
      // them sends it back to draft, so it needs a new /send with confirmation instead of going out unchecked.
      if (
        row.status === "scheduled" &&
        ((body.audience !== undefined && canon(body.audience) !== canon(row.audience)) ||
          (body.channels !== undefined && canon([...body.channels].sort()) !== canon([...row.channels].sort())) ||
          (body.urgent !== undefined && body.urgent !== row.urgent))
      ) {
        set.status = "draft";
        reschedule = false;
      }
      if (body.title !== undefined) set.title = body.title;
      if (body.body !== undefined) set.body = body.body;
      if (body.audience !== undefined) set.audience = body.audience;
      if (body.channels !== undefined) set.channels = body.channels;
      if (body.urgent !== undefined) set.urgent = body.urgent;
      if (body.pinned !== undefined) set.pinned = body.pinned;
    } else {
      // sent / sending / cancelled: only pin and withdraw.
      const allowed = new Set(["pinned", "withdraw"]);
      if (Object.keys(body).some((k) => !allowed.has(k))) throw new ConflictError(LOCKED, { code: "CONFLICT" });
      if (row.status !== "sent") throw new ConflictError(LOCKED, { code: "CONFLICT" });
      if (body.pinned !== undefined) set.pinned = body.pinned;
      if (body.withdraw) {
        set.expiresAt = new Date();
        set.pinned = false;
        await skipUnsentDeliveries(tx, id);
        await writeAudit(tx, { eventType: "club_announcement.withdraw", subjectId: id, payload: { clubId, actor: c.get("user").id } });
      }
    }
    const [done] = await tx.update(clubAnnouncements).set(set).where(eq(clubAnnouncements.id, id)).returning();
    if (reschedule) await schedulePublish(done!);
    return done!;
  });
  const { authorName } = await loadVisible(c, id);
  return c.json({ data: shape(updated, authorName) });
});

clubAnnouncementRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  await loadVisible(c, id);
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(clubAnnouncements).where(and(eq(clubAnnouncements.id, id), eq(clubAnnouncements.clubId, c.get("clubId")))).for("update");
    if (!row) throw new NotFoundError("Announcement not found");
    // The deliveries of a sent announcement are the proof of delivery: withdraw instead of delete.
    if (row.status === "sending" || row.status === "sent") throw new ConflictError("A sent announcement cannot be deleted, withdraw it instead", { code: "CONFLICT" });
    await tx.delete(clubAnnouncements).where(eq(clubAnnouncements.id, id));
    await writeAudit(tx, { eventType: "club_announcement.delete", subjectId: id, payload: { clubId: c.get("clubId"), actor: c.get("user").id, status: row.status } });
  });
  return c.body(null, 204);
});

// --- Send / cancel ----------------------------------------------------------------------------------------

// `confirmRecipients`: the recipient count the author saw in the preview; required above ANNOUNCEMENT_CONFIRM_THRESHOLD (B14).
const sendSchema = z.object({ publishAt: z.coerce.date().nullable().optional(), confirmRecipients: z.number().int().min(0).max(1_000_000).nullable().optional() }).default({});

clubAnnouncementRoutes.post("/:id/send", sendLimit, zValidator("json", sendSchema, validationHook), async (c) => {
  const body = c.req.valid("json");
  const clubId = c.get("clubId");
  const id = c.req.param("id");
  const { row: current } = await loadVisible(c, id);
  assertMayAddress(c.get("scope"), current.audience, current.urgent);

  // `publishAt` omitted: use the stored one if it lies in the future; `null`: send immediately.
  const requested = body.publishAt === undefined ? current.publishAt : body.publishAt;
  if (body.publishAt) assertPublishAt(body.publishAt);
  if (requested && requested.getTime() > Date.now() + 5_000) {
    await assertWithinSendLimits(current, { actorUserId: c.get("user").id, confirmRecipients: body.confirmRecipients ?? null, mode: "schedule" });
    const scheduled = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(clubAnnouncements).where(and(eq(clubAnnouncements.id, id), eq(clubAnnouncements.clubId, clubId))).for("update");
      if (!row || !isEditable(row)) throw new ConflictError("Only a draft or scheduled announcement can be sent", { code: "CONFLICT" });
      const [done] = await tx.update(clubAnnouncements).set({ status: "scheduled", publishAt: requested, updatedAt: new Date() }).where(eq(clubAnnouncements.id, id)).returning();
      await schedulePublish(done!);
      await writeAudit(tx, { eventType: "club_announcement.schedule", subjectId: id, payload: { clubId, actor: c.get("user").id, publishAt: requested.toISOString() } });
      return done!;
    });
    return c.json({ data: { status: scheduled.status, publishAt: scheduled.publishAt, delivery: null } });
  }

  const result = await sendAnnouncement(clubId, id, { actorUserId: c.get("user").id, confirmRecipients: body.confirmRecipients ?? null });
  if (!result.sent) {
    if (result.reason === "audience_too_large") throw new ValidationError("The audience is too large", { details: { limit: "AUDIENCE_MAX_RECIPIENTS" } });
    throw new ConflictError("Only a draft or scheduled announcement can be sent", { code: "CONFLICT" });
  }
  return c.json({ data: { status: result.row.status, sentAt: result.row.sentAt, delivery: result.outcome } });
});

clubAnnouncementRoutes.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  await loadVisible(c, id);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(clubAnnouncements).where(and(eq(clubAnnouncements.id, id), eq(clubAnnouncements.clubId, c.get("clubId")))).for("update");
    if (!row) throw new NotFoundError("Announcement not found");
    if (row.status !== "scheduled") throw new ConflictError("Only a scheduled announcement can be cancelled", { code: "CONFLICT" });
    const [done] = await tx.update(clubAnnouncements).set({ status: "cancelled", updatedAt: new Date() }).where(eq(clubAnnouncements.id, id)).returning();
    await skipUnsentDeliveries(tx, id);
    await writeAudit(tx, { eventType: "club_announcement.cancel", subjectId: id, payload: { clubId: c.get("clubId"), actor: c.get("user").id } });
    return done!;
  });
  const { authorName } = await loadVisible(c, id);
  return c.json({ data: shape(updated, authorName) });
});

// --- Deliveries ------------------------------------------------------------------------------------------------

const deliveriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().max(30).optional(),
});

/** Aggregate for every author; the per-recipient list (names, status, read state; never addresses) needs `announcements:write`. */
clubAnnouncementRoutes.get("/:id/deliveries", zValidator("query", deliveriesQuerySchema, validationHook), async (c) => {
  const id = c.req.param("id");
  const clubId = c.get("clubId");
  const query = c.req.valid("query");
  await loadVisible(c, id);
  const scope = and(eq(messageDeliveries.announcementId, id), eq(messageDeliveries.clubId, clubId));

  const groups = await db
    .select({ channel: messageDeliveries.channel, status: messageDeliveries.status, n: count(), read: sql<number>`count(${messageDeliveries.readAt})::int` })
    .from(messageDeliveries)
    .where(scope)
    .groupBy(messageDeliveries.channel, messageDeliveries.status);
  const byChannel: Record<string, { total: number; read: number; statuses: Record<string, number> }> = {};
  for (const g of groups) {
    const entry = (byChannel[g.channel] ??= { total: 0, read: 0, statuses: {} });
    entry.total += g.n;
    entry.read += g.read;
    entry.statuses[g.status] = g.n;
  }
  const inApp = byChannel.in_app;
  const summary = { recipients: inApp?.total ?? 0, read: inApp?.read ?? 0, byChannel };

  if (!c.get("scope").write) {
    c.header("Cache-Control", "private, no-store");
    return c.json({ data: { summary } });
  }
  const where = and(scope, query.status ? eq(messageDeliveries.status, query.status) : undefined);
  const [total] = await db.select({ n: count() }).from(messageDeliveries).where(where);
  const rows = await db
    .select({
      id: messageDeliveries.id,
      clubMemberId: messageDeliveries.clubMemberId,
      name: clubMembers.displayName,
      channel: messageDeliveries.channel,
      status: messageDeliveries.status,
      errorCode: messageDeliveries.errorCode,
      attempts: messageDeliveries.attempts,
      sentAt: messageDeliveries.sentAt,
      readAt: messageDeliveries.readAt,
    })
    .from(messageDeliveries)
    .leftJoin(clubMembers, eq(clubMembers.id, messageDeliveries.clubMemberId))
    .where(where)
    .orderBy(clubMembers.displayName, messageDeliveries.channel, messageDeliveries.id)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  // Read state is behavioural data (ADR-006): looking at the individual list leaves a trace.
  await writeAudit(db, { eventType: "club_announcement.deliveries_read", subjectId: id, payload: { clubId, actor: c.get("user").id, page: query.page } });
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: { summary, recipients: rows }, pagination: { page: query.page, pageSize: query.pageSize, total: total?.n ?? 0 } });
});

clubAnnouncementRoutes.post("/:id/resend-failed", sendLimit, async (c) => {
  const id = c.req.param("id");
  const clubId = c.get("clubId");
  const { row } = await loadVisible(c, id);
  if (row.status !== "sent") throw new ConflictError("Only a sent announcement has deliveries to retry", { code: "CONFLICT" });
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) throw new ConflictError("A withdrawn or expired announcement cannot be resent", { code: "CONFLICT" });
  const requeued = await db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(messageDeliveries)
      .where(and(eq(messageDeliveries.announcementId, id), eq(messageDeliveries.clubId, clubId), eq(messageDeliveries.channel, "email"), eq(messageDeliveries.status, "failed"), sql`${messageDeliveries.address} IS NOT NULL`))
      .for("update");
    // Preferences are re-checked: whoever opted out since the first attempt is not mailed again.
    const optedOut = await optedOutDeliveryIds(candidates);
    if (optedOut.size > 0) await tx.update(messageDeliveries).set({ status: "skipped_optout" }).where(inArray(messageDeliveries.id, [...optedOut]));
    const failed = candidates.filter((r) => !optedOut.has(r.id));
    if (failed.length > 0) await tx.update(messageDeliveries).set({ status: "queued", attempts: 0, errorCode: null }).where(inArray(messageDeliveries.id, failed.map((r) => r.id)));
    const stamp = Date.now();
    for (const f of failed) await enqueue({ type: EMAIL_JOB_TYPE, payload: { deliveryId: f.id }, dedupeKey: `${EMAIL_JOB_TYPE}:${f.id}:retry:${stamp}` }, tx);
    await writeAudit(tx, { eventType: "club_announcement.resend_failed", subjectId: id, payload: { clubId, actor: c.get("user").id, requeued: failed.length } });
    return failed.length;
  });
  return c.json({ data: { requeued } });
});

// ======================================================================================================
// Member side: GET /club-inbox
// ======================================================================================================

export const clubInboxRoutes = new Hono<ClubEnv>();

clubInboxRoutes.use("*", rateLimit({ windowMs: 60_000, max: 240 }));
clubInboxRoutes.use("*", sessionGuard);
clubInboxRoutes.use("*", clubGuard);

/**
 * The caller's own in-app deliveries in this club. Subscriber scoping is structural: a row exists only for a recipient
 * the audience snapshot contained, and every query is bound to `user_id = caller AND club_id = club`. Withdrawn, expired
 * and unsent announcements are hidden.
 */
function inboxWhere(clubId: string, userId: string, unreadOnly: boolean) {
  return and(
    eq(messageDeliveries.userId, userId),
    eq(messageDeliveries.clubId, clubId),
    eq(messageDeliveries.channel, "in_app"),
    unreadOnly ? isNull(messageDeliveries.readAt) : undefined,
    or(isNull(messageDeliveries.announcementId), and(eq(clubAnnouncements.status, "sent"), or(isNull(clubAnnouncements.expiresAt), gt(clubAnnouncements.expiresAt, sql`now()`)))),
  );
}

const inboxQuerySchema = z.object({
  unread: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

clubInboxRoutes.get("/", zValidator("query", inboxQuerySchema, validationHook), async (c) => {
  const query = c.req.valid("query");
  const where = inboxWhere(c.get("clubId"), c.get("user").id, query.unread === "true");
  const base = db.select({ n: count() }).from(messageDeliveries).leftJoin(clubAnnouncements, eq(clubAnnouncements.id, messageDeliveries.announcementId)).where(where);
  const [total] = await base;
  const rows = await db
    .select({
      id: messageDeliveries.id,
      announcementId: messageDeliveries.announcementId,
      eventKey: messageDeliveries.eventKey,
      content: messageDeliveries.content,
      sentAt: messageDeliveries.sentAt,
      createdAt: messageDeliveries.createdAt,
      readAt: messageDeliveries.readAt,
      pinned: clubAnnouncements.pinned,
      authorName: clubMembers.displayName,
    })
    .from(messageDeliveries)
    .leftJoin(clubAnnouncements, eq(clubAnnouncements.id, messageDeliveries.announcementId))
    .leftJoin(clubMembers, eq(clubMembers.id, clubAnnouncements.authorMemberId))
    .where(where)
    .orderBy(desc(sql`coalesce(${clubAnnouncements.pinned}, false)`), desc(messageDeliveries.createdAt), desc(messageDeliveries.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  c.header("Cache-Control", "private, no-store");
  return c.json({
    data: rows.map((r) => {
      const content = (r.content ?? {}) as Partial<DeliveryContent>;
      return {
        id: r.id,
        kind: r.announcementId ? "announcement" : "system",
        announcementId: r.announcementId,
        title: content.title ?? "",
        body: content.body ?? "",
        urgent: content.urgent === true,
        category: content.category ?? null,
        ctaLabel: content.ctaLabel ?? null,
        ctaUrl: content.ctaUrl ?? null,
        pinned: r.pinned === true,
        authorName: r.announcementId ? r.authorName : null,
        sentAt: r.sentAt ?? r.createdAt,
        readAt: r.readAt,
      };
    }),
    pagination: { page: query.page, pageSize: query.pageSize, total: total?.n ?? 0 },
  });
});

clubInboxRoutes.get("/unread-count", async (c) => {
  const [row] = await db
    .select({ n: count() })
    .from(messageDeliveries)
    .leftJoin(clubAnnouncements, eq(clubAnnouncements.id, messageDeliveries.announcementId))
    .where(inboxWhere(c.get("clubId"), c.get("user").id, true));
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: { count: row?.n ?? 0 } });
});

/** Own in-app delivery only; any other id (foreign user, foreign club, unknown, non-uuid) is the same 404. Idempotent. */
clubInboxRoutes.post("/:id/read", async (c) => {
  const id = c.req.param("id");
  if (!isUuid(id)) throw new NotFoundError("Message not found");
  const [row] = await db
    .update(messageDeliveries)
    .set({ readAt: sql`coalesce(${messageDeliveries.readAt}, now())` })
    .where(and(eq(messageDeliveries.id, id), eq(messageDeliveries.userId, c.get("user").id), eq(messageDeliveries.clubId, c.get("clubId")), eq(messageDeliveries.channel, "in_app")))
    .returning({ id: messageDeliveries.id, readAt: messageDeliveries.readAt });
  if (!row) throw new NotFoundError("Message not found");
  return c.json({ data: row });
});
