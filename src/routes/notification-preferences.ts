import { zValidator } from "@hono/zod-validator";
import { and, count, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { member, organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { notificationPreferences } from "../db/schema/communication.js";
import { EXCLUDED_RECIPIENT_STATUSES } from "../lib/audience.js";
import { hasClubPermission, roleTypesWithPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { BOARD_CATEGORY, NOTIFICATION_CATEGORIES, type NotificationCategory } from "../lib/notify/types.js";
import { verifyUnsubscribeToken, type UnsubscribePayload } from "../lib/notify/unsubscribe-token.js";
import { dbRateLimit, envInt, HOUR_MS } from "../lib/rate-limits.js";
import { clubGuard, type ClubEnv } from "../middleware/club-guard.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { sessionGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Notification preferences (Wave 9 B9, ADR-006). Own preferences per category x channel, the leadership view
 * ("unsubscribed yes/no" only) and the public unsubscribe links of e-mails (`/unsubscribe/:token`).
 */

/** Channels a person can switch: `in_app` is the source of truth and always on; e-mail and push are opt-out. */
const SWITCHABLE_CHANNELS = ["email", "push"] as const;
type SwitchableChannel = (typeof SWITCHABLE_CHANNELS)[number];

/** Mandatory classes (never switchable, shown read-only to the client). */
export const MANDATORY_CLASSES = ["account_security", "own_decisions", "invitation_deadlines"] as const;
/** Category names a client might send for a mandatory class; rejected with a specific code instead of a generic 422. */
const MANDATORY_CATEGORY_NAMES: readonly string[] = ["decisions", ...MANDATORY_CLASSES];

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request", { details: result.error?.issues });
};

// ======================================================================================================
// Own preferences
// ======================================================================================================

export const notificationPreferenceRoutes = new Hono<SessionEnv>();
notificationPreferenceRoutes.use("*", rateLimit({ windowMs: 60_000, max: 120 }));
notificationPreferenceRoutes.use("*", sessionGuard);

type Prefs = Record<NotificationCategory, Record<SwitchableChannel, boolean>>;

/** The ids of the club_members rows linked to this account (any club, or only `clubId`). Preferences stored for them (via a link) count too. */
async function ownClubMemberIds(userId: string, clubId: string | null): Promise<string[]> {
  const rows = await db
    .select({ id: clubMembers.id })
    .from(clubMembers)
    .innerJoin(member, eq(member.id, clubMembers.memberId))
    .where(and(eq(member.userId, userId), clubId ? eq(clubMembers.clubId, clubId) : undefined));
  return rows.map((r) => r.id);
}

/** The account must belong to the club (account membership); anything else answers 404 so the route is no club-existence oracle. */
async function assertAccountInClub(userId: string, clubId: string): Promise<void> {
  const [row] = await db.select({ id: member.id }).from(member).where(and(eq(member.userId, userId), eq(member.organizationId, clubId))).limit(1);
  if (!row) throw new NotFoundError("Club not found");
}

interface LoadedPrefs {
  prefs: Prefs;
  /**
   * Club view only: the switches that have a club-specific row (they win over the global default) -- of the account AND of its
   * linked account-less member records in that club (e.g. an unsubscribe link of a club mail from before the account was linked).
   * When several such rows exist for one switch, `enabled` is their AND (one off is enough, the same rule as the effective value).
   */
  overrides: Array<{ category: NotificationCategory; channel: SwitchableChannel; enabled: boolean }>;
}

/**
 * Effective switches of the account. Global view (`clubId` null): only the global rows. Club view: per switch the club-specific row
 * wins over the global row, no row = on. Same rule as the dispatcher: the account row AND the rows of the linked account-less
 * member records all have to be on (one disabled row is enough).
 */
async function loadPrefs(userId: string, clubId: string | null): Promise<LoadedPrefs> {
  const memberIds = await ownClubMemberIds(userId, clubId);
  const subject = memberIds.length ? sql`(${notificationPreferences.userId} = ${userId} OR ${inArray(notificationPreferences.clubMemberId, memberIds)})` : eq(notificationPreferences.userId, userId);
  const rows = await db
    .select({ userId: notificationPreferences.userId, clubMemberId: notificationPreferences.clubMemberId, clubId: notificationPreferences.clubId, category: notificationPreferences.category, channel: notificationPreferences.channel, enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(and(subject, clubId ? or(isNull(notificationPreferences.clubId), eq(notificationPreferences.clubId, clubId)) : isNull(notificationPreferences.clubId)));
  const prefs = Object.fromEntries(NOTIFICATION_CATEGORIES.map((cat) => [cat, { email: true, push: true }])) as Prefs;
  const overrides: LoadedPrefs["overrides"] = [];
  const known = (r: { category: string; channel: string }) => (NOTIFICATION_CATEGORIES as readonly string[]).includes(r.category) && (SWITCHABLE_CHANNELS as readonly string[]).includes(r.channel);
  const valueOf = (subjectKey: "userId" | "clubMemberId", id: string, category: string, channel: string): boolean => {
    const mine = rows.filter((r) => r[subjectKey] === id && r.category === category && r.channel === channel);
    return (clubId ? mine.find((r) => r.clubId === clubId)?.enabled : undefined) ?? mine.find((r) => r.clubId === null)?.enabled ?? true;
  };
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of SWITCHABLE_CHANNELS) {
      prefs[category][channel] = valueOf("userId", userId, category, channel) && memberIds.every((id) => valueOf("clubMemberId", id, category, channel));
    }
  }
  if (clubId) {
    const byKey = new Map<string, LoadedPrefs["overrides"][number]>();
    for (const r of rows) {
      const own = r.userId === userId || (r.clubMemberId !== null && memberIds.includes(r.clubMemberId));
      if (!own || r.clubId !== clubId || !known(r)) continue;
      const key = `${r.category}:${r.channel}`;
      const seen = byKey.get(key);
      if (seen) seen.enabled = seen.enabled && r.enabled;
      else byKey.set(key, { category: r.category as NotificationCategory, channel: r.channel as SwitchableChannel, enabled: r.enabled });
    }
    overrides.push(...byKey.values());
  }
  return { prefs, overrides };
}

/** Whether the account holds a role with `members:write` (the audience of the `board` digests), in any club or in `clubId`. */
async function holdsBoardRole(userId: string, clubId: string | null): Promise<boolean> {
  const rows = await db
    .select({ id: clubRoles.id })
    .from(clubRoles)
    .innerJoin(member, eq(member.id, clubRoles.memberId))
    .where(and(eq(member.userId, userId), inArray(clubRoles.roleType, roleTypesWithPermission("members:write")), clubId ? eq(member.organizationId, clubId) : undefined))
    .limit(1);
  return rows.length > 0;
}

/** `board` is only listed for accounts that can receive it; everybody else keeps the three categories every client knows. */
function shapePrefs(loaded: LoadedPrefs, includeBoard: boolean, clubId: string | null) {
  const { prefs, overrides } = loaded;
  return {
    clubId,
    categories: NOTIFICATION_CATEGORIES.filter((category) => includeBoard || category !== BOARD_CATEGORY).map((category) => ({
      category,
      channels: [
        { channel: "in_app", enabled: true, switchable: false },
        { channel: "email", enabled: prefs[category].email, switchable: true },
        { channel: "push", enabled: prefs[category].push, switchable: true },
      ],
    })),
    mandatory: MANDATORY_CLASSES.map((key) => ({ key, switchable: false })),
    ...(clubId ? { overrides: overrides.filter((o) => includeBoard || o.category !== BOARD_CATEGORY) } : {}),
  };
}

const getQuerySchema = z.object({ clubId: z.string().min(1).max(100).optional() });

/**
 * `GET /notification-preferences` = the global defaults. `?clubId=` = the effective switches for that club (club-specific
 * overrides win over the global default; `overrides` lists the club-specific ones). The account must belong to the club (404).
 */
notificationPreferenceRoutes.get("/", zValidator("query", getQuerySchema, validationHook), async (c) => {
  c.header("Cache-Control", "private, no-store");
  const userId = c.get("user").id;
  const clubId = c.req.valid("query").clubId ?? null;
  if (clubId) await assertAccountInClub(userId, clubId);
  return c.json({ data: shapePrefs(await loadPrefs(userId, clubId), await holdsBoardRole(userId, clubId), clubId) });
});

const putSchema = z.object({
  /** Omitted/null: the global default. Set: the override for that club only. */
  clubId: z.string().min(1).max(100).nullable().optional(),
  preferences: z
    .array(z.object({ category: z.string().max(40), channel: z.string().max(20), enabled: z.boolean().nullable() }))
    .min(1)
    .max(20),
});

notificationPreferenceRoutes.put("/", zValidator("json", putSchema, validationHook), async (c) => {
  const userId = c.get("user").id;
  const body = c.req.valid("json");
  const clubId = body.clubId ?? null;
  const changes = new Map<string, { category: NotificationCategory; channel: SwitchableChannel; enabled: boolean | null }>();
  for (const p of body.preferences) {
    if (MANDATORY_CATEGORY_NAMES.includes(p.category)) throw new ValidationError("Mandatory messages cannot be switched off", { details: { code: "mandatory_not_switchable", category: p.category } });
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(p.category)) throw new ValidationError("Unknown category", { details: { category: p.category } });
    if (p.channel === "in_app") throw new ValidationError("The in-app channel cannot be switched off", { details: { code: "channel_not_switchable", channel: p.channel } });
    if (!(SWITCHABLE_CHANNELS as readonly string[]).includes(p.channel)) throw new ValidationError("Unknown channel", { details: { channel: p.channel } });
    // `enabled: null` removes the club-specific override again (back to the global default); the global default itself has nothing to reset.
    if (p.enabled === null && clubId === null) throw new ValidationError("Only a club-specific setting can be reset", { details: { code: "reset_needs_club", category: p.category, channel: p.channel } });
    changes.set(`${p.category}:${p.channel}`, { category: p.category as NotificationCategory, channel: p.channel as SwitchableChannel, enabled: p.enabled });
  }
  if (clubId) await assertAccountInClub(userId, clubId);
  const memberIds = await ownClubMemberIds(userId, clubId);
  await db.transaction(async (tx) => {
    for (const ch of changes.values()) {
      if (ch.enabled === null) {
        await tx.delete(notificationPreferences).where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.clubId, clubId!), eq(notificationPreferences.category, ch.category), eq(notificationPreferences.channel, ch.channel)));
        // The club-specific rows of the linked account-less member record(s) in this club are listed as overrides too, so a reset removes them as well.
        if (memberIds.length) {
          await tx.delete(notificationPreferences).where(and(inArray(notificationPreferences.clubMemberId, memberIds), eq(notificationPreferences.clubId, clubId!), eq(notificationPreferences.category, ch.category), eq(notificationPreferences.channel, ch.channel)));
        }
        continue;
      }
      await tx
        .insert(notificationPreferences)
        .values({ userId, clubId, category: ch.category, channel: ch.channel, enabled: ch.enabled })
        .onConflictDoUpdate(
          clubId
            ? { target: [notificationPreferences.userId, notificationPreferences.clubId, notificationPreferences.category, notificationPreferences.channel], targetWhere: sql`${notificationPreferences.userId} IS NOT NULL AND ${notificationPreferences.clubId} IS NOT NULL`, set: { enabled: ch.enabled, updatedAt: new Date() } }
            : { target: [notificationPreferences.userId, notificationPreferences.category, notificationPreferences.channel], targetWhere: sql`${notificationPreferences.userId} IS NOT NULL AND ${notificationPreferences.clubId} IS NULL`, set: { enabled: ch.enabled, updatedAt: new Date() } },
        );
      // A switch made earlier through an unsubscribe link of the account-less period must not outlive the explicit choice
      // (global choice: the global rows of all own member records; club choice: the club-specific rows of the member record in
      // that club AND its global row -- on purpose: that row exists only for this very member record, and the effective value is the
      // AND of the account and member rows, so a stale "off" there would otherwise veto the explicit club-specific "on". The account's
      // own global row and the member records of OTHER clubs are never touched by a club choice.)
      if (memberIds.length) {
        await tx
          .update(notificationPreferences)
          .set({ enabled: ch.enabled, updatedAt: new Date() })
          .where(
            and(
              inArray(notificationPreferences.clubMemberId, memberIds),
              clubId ? or(isNull(notificationPreferences.clubId), eq(notificationPreferences.clubId, clubId)) : isNull(notificationPreferences.clubId),
              eq(notificationPreferences.category, ch.category),
              eq(notificationPreferences.channel, ch.channel),
            ),
          );
      }
    }
  });
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: shapePrefs(await loadPrefs(userId, clubId), await holdsBoardRole(userId, clubId), clubId) });
});

// --- Leadership view: yes/no only ----------------------------------------------------------------------------------------------

const membersQuerySchema = z.object({
  unsubscribed: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * Who cannot be reached by announcement e-mails: one boolean per member, never the categories or channels they chose
 * (ADR-006: the board must not see the details). Needs `announcements:write` (the people who send announcements).
 */
notificationPreferenceRoutes.get("/members", clubGuard, zValidator("query", membersQuerySchema, validationHook), async (c: Context<ClubEnv>) => {
  if (!hasClubPermission(c.get("clubRoleTypes"), "announcements:write")) throw new ForbiddenError("Missing announcements:write permission");
  const query = c.req.valid("query" as never) as z.infer<typeof membersQuerySchema>;
  // Raw qualified names: drizzle renders columns of a single-table select unqualified, which would bind to the subquery's own table.
  // Effective for THIS club: club-specific row > global row > on; the account row or the account-less member row switching it off is enough.
  const clubId = c.get("clubId");
  const effective = (subjectColumn: string, subjectExpr: ReturnType<typeof sql>) => sql`coalesce(
    (select np.enabled from notification_preferences np where ${sql.raw(subjectColumn)} = ${subjectExpr} and np.club_id = ${clubId} and np.category = 'announcements' and np.channel = 'email'),
    (select np.enabled from notification_preferences np where ${sql.raw(subjectColumn)} = ${subjectExpr} and np.club_id is null and np.category = 'announcements' and np.channel = 'email'),
    true)`;
  const unsubscribed = sql<boolean>`(not ${effective("np.club_member_id", sql`club_members.id`)}
    or not ${effective("np.user_id", sql`(select m.user_id from member m where m.id = club_members.member_id)`)})`;
  const base = and(
    eq(clubMembers.clubId, clubId),
    notInArray(clubMembers.status, [...EXCLUDED_RECIPIENT_STATUSES]),
    query.unsubscribed === undefined ? undefined : query.unsubscribed === "true" ? unsubscribed : sql`not ${unsubscribed}`,
  );
  const [total] = await db.select({ n: count() }).from(clubMembers).where(base);
  const rows = await db
    .select({ clubMemberId: clubMembers.id, displayName: clubMembers.displayName, unsubscribed })
    .from(clubMembers)
    .where(base)
    .orderBy(clubMembers.displayName, clubMembers.id)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: rows.map((r) => ({ clubMemberId: r.clubMemberId, displayName: r.displayName, unsubscribed: r.unsubscribed === true })), pagination: { page: query.page, pageSize: query.pageSize, total: total?.n ?? 0 } });
});

// ======================================================================================================
// Public unsubscribe links (no session)
// ======================================================================================================

export const unsubscribeRoutes = new Hono();
// Per client IP; the links are signed, so the limit only caps request volume and guessing attempts.
unsubscribeRoutes.use("*", rateLimit({ windowMs: 60_000, max: 30 }));
// DB-backed hourly cap per client IP (B14), shared by all instances and surviving restarts.
unsubscribeRoutes.use("*", dbRateLimit({ bucket: "unsubscribe.ip", windowMs: HOUR_MS, max: () => envInt("UNSUBSCRIBE_IP_LIMIT_PER_HOUR", 120), message: "Too many requests from this address, try again later" }));
unsubscribeRoutes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer"); // the token is part of the URL
});

const wantsHtml = (c: Context) => (c.req.header("accept") ?? "").includes("text/html");
const INVALID = "This link is invalid or has expired";

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const CATEGORY_LABEL: Record<NotificationCategory, string> = { announcements: "Ankündigungen", events: "Termine", reminders: "Erinnerungen", board: "Vorstandsmeldungen" };

function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${esc(title)}</h1>${body}</body></html>`;
}

async function clubNameOf(clubId: string | null): Promise<string | null> {
  if (!clubId) return null;
  const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
  return club?.name ?? null;
}

/** The club a token acts on: `v: 2` tokens with a club are club-specific; older tokens (no `v`) and platform mails are global. */
const scopeOf = (p: UnsubscribePayload): { clubId: string | null; scope: "club" | "all" } => (p.v === 2 && p.k ? { clubId: p.k, scope: "club" } : { clubId: null, scope: "all" });

async function isUnsubscribed(p: UnsubscribePayload): Promise<boolean> {
  const { clubId } = scopeOf(p);
  const rows = await db
    .select({ clubId: notificationPreferences.clubId, enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(and(p.s === "u" ? eq(notificationPreferences.userId, p.p) : eq(notificationPreferences.clubMemberId, p.p), eq(notificationPreferences.category, p.c), eq(notificationPreferences.channel, "email"), clubId ? or(isNull(notificationPreferences.clubId), eq(notificationPreferences.clubId, clubId)) : isNull(notificationPreferences.clubId)));
  // club-specific row > global row > on (same as the dispatcher)
  return (rows.find((r) => r.clubId !== null)?.enabled ?? rows.find((r) => r.clubId === null)?.enabled ?? true) === false;
}

/** Turns the e-mail channel of the category off for the token's subject (and club, for current tokens). Idempotent; a subject that no longer exists changes nothing. */
async function applyUnsubscribe(p: UnsubscribePayload): Promise<void> {
  const { clubId } = scopeOf(p);
  const subject = p.s === "u" ? { userId: p.p } : { clubMemberId: p.p };
  const subjectColumns = p.s === "u" ? [notificationPreferences.userId] : [notificationPreferences.clubMemberId];
  const subjectPredicate = p.s === "u" ? sql`${notificationPreferences.userId} IS NOT NULL` : sql`${notificationPreferences.clubMemberId} IS NOT NULL`;
  try {
    await db
      .insert(notificationPreferences)
      .values({ ...subject, clubId, category: p.c, channel: "email", enabled: false })
      .onConflictDoUpdate(
        clubId
          ? { target: [...subjectColumns, notificationPreferences.clubId, notificationPreferences.category, notificationPreferences.channel], targetWhere: sql`${subjectPredicate} AND ${notificationPreferences.clubId} IS NOT NULL`, set: { enabled: false, updatedAt: new Date() } }
          : { target: [...subjectColumns, notificationPreferences.category, notificationPreferences.channel], targetWhere: sql`${subjectPredicate} AND ${notificationPreferences.clubId} IS NULL`, set: { enabled: false, updatedAt: new Date() } },
      );
  } catch (err) {
    // Deleted account / member / club: nothing left to unsubscribe, and the answer must not reveal that (no existence oracle).
    if ((err as { code?: string; cause?: { code?: string } })?.code !== "23503" && (err as { cause?: { code?: string } })?.cause?.code !== "23503") throw err;
  }
}

unsubscribeRoutes.get("/:token", async (c) => {
  const payload = verifyUnsubscribeToken(c.req.param("token"));
  if (!payload) {
    if (wantsHtml(c)) return c.html(page("Link ungültig", "<p>Dieser Link ist ungültig oder abgelaufen. Du kannst Benachrichtigungen auch in der App unter Einstellungen verwalten.</p>"), 404);
    throw new NotFoundError(INVALID);
  }
  const [clubName, unsubscribed] = await Promise.all([clubNameOf(payload.k), isUnsubscribed(payload)]);
  if (wantsHtml(c)) {
    const label = CATEGORY_LABEL[payload.c];
    // Current links act on this club only; links issued before G12 switch the category off for every club (and say so).
    const club = scopeOf(payload).scope === "club" && clubName ? ` von ${esc(clubName)}` : scopeOf(payload).scope === "all" && payload.k ? " (in allen Vereinen)" : "";
    return c.html(
      page(
        unsubscribed ? "Bereits abgemeldet" : "Benachrichtigungen abbestellen",
        unsubscribed
          ? `<p>Du erhältst keine E-Mails zu „${label}“${club} mehr.</p>`
          : `<p>Möchtest du keine E-Mails zu „${label}“${club} mehr erhalten?</p><form method="post"><button type="submit" style="padding:.6rem 1.2rem;font-size:1rem">Abbestellen</button></form>`,
      ),
    );
  }
  return c.json({ data: { category: payload.c, channel: "email", clubName, scope: scopeOf(payload).scope, unsubscribed } });
});

/** RFC 8058 one-click (`List-Unsubscribe=One-Click`, body ignored) and the confirmation button of the page. Idempotent, reusable until expiry. */
unsubscribeRoutes.post("/:token", async (c) => {
  const payload = verifyUnsubscribeToken(c.req.param("token"));
  if (!payload) {
    if (wantsHtml(c)) return c.html(page("Link ungültig", "<p>Dieser Link ist ungültig oder abgelaufen.</p>"), 404);
    throw new NotFoundError(INVALID);
  }
  await applyUnsubscribe(payload);
  if (wantsHtml(c)) {
    const scope = scopeOf(payload);
    const where = scope.scope === "club" ? ` von ${esc((await clubNameOf(scope.clubId)) ?? "diesem Verein")}` : payload.k ? " (in allen Vereinen)" : "";
    return c.html(page("Abgemeldet", `<p>Du erhältst keine E-Mails zu „${CATEGORY_LABEL[payload.c]}“${where} mehr. Wichtige Mitteilungen zu deinem Konto und deinen Anträgen bekommst du weiterhin.</p>`));
  }
  return c.json({ data: { category: payload.c, channel: "email", scope: scopeOf(payload).scope, unsubscribed: true } });
});
