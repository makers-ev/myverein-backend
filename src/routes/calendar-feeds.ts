import { createHash, randomBytes } from "node:crypto";

import { zValidator } from "@hono/zod-validator";
import { and, count, eq, isNull, or, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { calendarFeedTokens, type CalendarFeedTokenRow } from "../db/schema/calendar-feed-tokens.js";
import { calendars } from "../db/schema/calendars.js";
import { writeAudit } from "../lib/audit.js";
import { getVisibleCalendarIds, isCalendarVisible } from "../lib/calendar-visibility.js";
import { resolveClubRoleTypes } from "../lib/club-access.js";
import { renderCalendarIcs } from "../lib/event-feed.js";
import { ConflictError, NotFoundError, ValidationError } from "../lib/errors.js";
import { enforceLimit, envInt, HOUR_MS, ipSubject } from "../lib/rate-limits.js";
import { clubGuard, denyExternalGuests, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard } from "../middleware/session-guard.js";

/**
 * Subscribable iCal links (Wave 12 B8). `/calendar-feeds` (session) manages the caller's OWN links: a link is a 256 bit random
 * token, only its SHA-256 is stored, the plain token (inside the URL) is shown once at creation / rotation. `GET /feeds/:token.ics`
 * is the public fetch: no session, the token is the credential, and the caller's rights are resolved at FETCH time (a revoked
 * role, a left member or a removed calendar grant takes effect on the next poll). The feed carries event data only, never member data.
 */

export const MAX_ACTIVE_FEEDS = 10;

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const newToken = (): string => randomBytes(32).toString("base64url");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function feedUrls(token: string): { url: string; webcalUrl: string } {
  const base = (process.env.BACKEND_URL ?? "").replace(/\/+$/, "");
  const url = `${base}/feeds/${token}.ics`;
  return { url, webcalUrl: url.replace(/^https?:\/\//, "webcal://") };
}

/** Listing / response shape of a link: never the token or its hash. */
function shapeFeed(row: CalendarFeedTokenRow, calendarName: string | null) {
  return { id: row.id, label: row.label, calendarId: row.calendarId, calendarName, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt };
}

// --- Management (own links, session) -----------------------------------------------------------------------------

export const calendarFeedRoutes = new Hono<ClubEnv>();

calendarFeedRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
calendarFeedRoutes.use("*", sessionGuard);
calendarFeedRoutes.use("*", clubGuard);

const createSchema = z.object({
  /** Limit the link to one calendar; omitted = everything the member may see. */
  calendarId: z.string().uuid().nullable().optional(),
  label: z.string().trim().max(60).nullable().optional(),
});

async function createFeed(memberRow: typeof member.$inferSelect, clubId: string, input: { calendarId: string | null; label: string | null }, rotatedFrom?: string) {
  const token = newToken();
  const row = await db.transaction(async (tx) => {
    const [active] = await tx.select({ n: count() }).from(calendarFeedTokens).where(and(eq(calendarFeedTokens.memberId, memberRow.id), isNull(calendarFeedTokens.revokedAt)));
    if ((active?.n ?? 0) >= MAX_ACTIVE_FEEDS) throw new ConflictError(`At most ${MAX_ACTIVE_FEEDS} active calendar links per member`);
    const [created] = await tx.insert(calendarFeedTokens).values({ clubId, memberId: memberRow.id, calendarId: input.calendarId, tokenHash: hashToken(token), label: input.label }).returning();
    await writeAudit(tx, { eventType: "calendar_feed.create", subjectId: created!.id, payload: { clubId, feedId: created!.id, calendarId: input.calendarId ?? undefined, rotated: rotatedFrom !== undefined } });
    return created!;
  });
  return { row, token };
}

calendarFeedRoutes.post(
  "/",
  zValidator("json", createSchema, (result) => {
    if (!result.success) throw new ValidationError("Invalid request body", { details: result.error.issues });
  }),
  async (c) => {
    denyExternalGuests(c);
    const clubId = c.get("clubId");
    const membership = c.get("membership");
    const body = c.req.valid("json");
    let calendarName: string | null = null;
    if (body.calendarId) {
      const calendar = await db.query.calendars.findFirst({ where: and(eq(calendars.id, body.calendarId), eq(calendars.clubId, clubId)) });
      if (!calendar || !(await isCalendarVisible(calendar.id, membership.id, c.get("clubRoleTypes")))) throw new NotFoundError("Calendar not found");
      calendarName = calendar.name;
    }
    const { row, token } = await createFeed(membership, clubId, { calendarId: body.calendarId ?? null, label: body.label?.trim() || null });
    return c.json({ data: { ...shapeFeed(row, calendarName), token, ...feedUrls(token) } }, 201);
  },
);

calendarFeedRoutes.get("/", async (c) => {
  denyExternalGuests(c);
  const rows = await db
    .select({ feed: calendarFeedTokens, calendarName: calendars.name })
    .from(calendarFeedTokens)
    .leftJoin(calendars, eq(calendars.id, calendarFeedTokens.calendarId))
    .where(and(eq(calendarFeedTokens.memberId, c.get("membership").id), eq(calendarFeedTokens.clubId, c.get("clubId")), isNull(calendarFeedTokens.revokedAt)))
    .orderBy(calendarFeedTokens.createdAt);
  return c.json({ data: rows.map((r) => shapeFeed(r.feed, r.calendarName)) });
});

/** Own active link or 404 (a foreign id is indistinguishable from an unknown one). */
async function ownActiveFeed(c: { get: (k: "membership" | "clubId") => unknown }, id: string): Promise<CalendarFeedTokenRow> {
  const membership = c.get("membership") as typeof member.$inferSelect;
  const clubId = c.get("clubId") as string;
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw new NotFoundError("Calendar link not found");
  const [row] = await db
    .select()
    .from(calendarFeedTokens)
    .where(and(eq(calendarFeedTokens.id, id), eq(calendarFeedTokens.memberId, membership.id), eq(calendarFeedTokens.clubId, clubId), isNull(calendarFeedTokens.revokedAt)));
  if (!row) throw new NotFoundError("Calendar link not found");
  return row;
}

/** Revokes the link; the URL stops working immediately. */
calendarFeedRoutes.delete("/:id", async (c) => {
  denyExternalGuests(c);
  const row = await ownActiveFeed(c, c.req.param("id"));
  const revoked = await db.update(calendarFeedTokens).set({ revokedAt: new Date() }).where(and(eq(calendarFeedTokens.id, row.id), isNull(calendarFeedTokens.revokedAt))).returning({ id: calendarFeedTokens.id });
  if (revoked.length === 0) throw new NotFoundError("Calendar link not found");
  await writeAudit(db, { eventType: "calendar_feed.revoke", subjectId: row.id, payload: { clubId: c.get("clubId"), feedId: row.id } });
  return c.body(null, 204);
});

/** Rotation: the old URL stops working, a new one with the same scope and label is returned (shown once). */
calendarFeedRoutes.post("/:id/rotate", async (c) => {
  denyExternalGuests(c);
  const old = await ownActiveFeed(c, c.req.param("id"));
  const calendarName = old.calendarId ? ((await db.query.calendars.findFirst({ where: eq(calendars.id, old.calendarId) }))?.name ?? null) : null;
  const revoked = await db.update(calendarFeedTokens).set({ revokedAt: new Date() }).where(and(eq(calendarFeedTokens.id, old.id), isNull(calendarFeedTokens.revokedAt))).returning({ id: calendarFeedTokens.id });
  if (revoked.length === 0) throw new NotFoundError("Calendar link not found");
  await writeAudit(db, { eventType: "calendar_feed.revoke", subjectId: old.id, payload: { clubId: c.get("clubId"), feedId: old.id, rotated: true } });
  const { row, token } = await createFeed(c.get("membership"), c.get("clubId"), { calendarId: old.calendarId, label: old.label }, old.id);
  return c.json({ data: { ...shapeFeed(row, calendarName), token, ...feedUrls(token) } }, 201);
});

// --- Public fetch (token is the credential; NO session, NO clubGuard) --------------------------------------------

export const feedRoutes = new Hono();

/** Calendar apps poll every few hours; this allows generous polling but stops scraping. */
const feedIpLimit = () => envInt("FEED_IP_LIMIT_PER_HOUR", 600);
const feedTokenLimit = () => envInt("FEED_TOKEN_LIMIT_PER_HOUR", 60);
const feedInvalidLimit = () => envInt("FEED_INVALID_LIMIT_PER_HOUR", 20);

feedRoutes.get("/:file", async (c) => {
  const ip = ipSubject(c);
  await enforceLimit({ bucket: "feed.ip", subject: ip, windowMs: HOUR_MS, max: feedIpLimit() });
  const file = c.req.param("file");
  const token = file.endsWith(".ics") ? file.slice(0, -4) : "";
  const notFound = async (): Promise<never> => {
    // Only wrong or revoked links count here, so a guesser is stopped long before enumeration could matter.
    await enforceLimit({ bucket: "feed.invalid", subject: ip, windowMs: HOUR_MS, max: feedInvalidLimit() });
    throw new NotFoundError("Calendar link not found");
  };
  if (!TOKEN_RE.test(token)) return notFound();

  const tokenHash = hashToken(token);
  const [row] = await db.select().from(calendarFeedTokens).where(and(eq(calendarFeedTokens.tokenHash, tokenHash), isNull(calendarFeedTokens.revokedAt)));
  if (!row) return notFound();
  await enforceLimit({ bucket: "feed.token", subject: tokenHash, windowMs: HOUR_MS, max: feedTokenLimit() });

  // Rights at fetch time: the account must still be a member of the club, must not have left, and sees what its roles see now.
  const membership = await db.query.member.findFirst({ where: and(eq(member.id, row.memberId), eq(member.organizationId, row.clubId)) });
  const roleTypes = membership && membership.role !== "guest" ? await resolveClubRoleTypes(membership, row.clubId) : null;
  if (!membership || roleTypes === null) return notFound();

  let calendarIds = await getVisibleCalendarIds(row.clubId, membership.id, roleTypes);
  if (row.calendarId) calendarIds = calendarIds.filter((id) => id === row.calendarId);
  const { ics, etag } = await renderCalendarIcs(row.clubId, calendarIds);

  // Bookkeeping at most every 5 minutes (a poll per minute must not become a write per minute).
  await db
    .update(calendarFeedTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(calendarFeedTokens.id, row.id), or(isNull(calendarFeedTokens.lastUsedAt), lt(calendarFeedTokens.lastUsedAt, new Date(Date.now() - 5 * 60_000)))));

  c.header("Content-Type", "text/calendar; charset=utf-8");
  c.header("Cache-Control", "private, no-cache");
  c.header("ETag", etag);
  c.header("X-Content-Type-Options", "nosniff");
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.body(ics);
});
