import { zValidator } from "@hono/zod-validator";
import { and, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { member, organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { notificationPreferences } from "../db/schema/communication.js";
import { EXCLUDED_RECIPIENT_STATUSES } from "../lib/audience.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/errors.js";
import { NOTIFICATION_CATEGORIES, type NotificationCategory } from "../lib/notify/types.js";
import { verifyUnsubscribeToken, type UnsubscribePayload } from "../lib/notify/unsubscribe-token.js";
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

/** The ids of the club_members rows linked to this account (any club). Preferences stored for them (via a link) count too. */
async function ownClubMemberIds(userId: string): Promise<string[]> {
  const rows = await db.select({ id: clubMembers.id }).from(clubMembers).innerJoin(member, eq(member.id, clubMembers.memberId)).where(eq(member.userId, userId));
  return rows.map((r) => r.id);
}

async function loadPrefs(userId: string): Promise<Prefs> {
  const memberIds = await ownClubMemberIds(userId);
  const rows = await db
    .select({ category: notificationPreferences.category, channel: notificationPreferences.channel, enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(memberIds.length ? sql`(${notificationPreferences.userId} = ${userId} OR ${inArray(notificationPreferences.clubMemberId, memberIds)})` : eq(notificationPreferences.userId, userId));
  const prefs = Object.fromEntries(NOTIFICATION_CATEGORIES.map((cat) => [cat, { email: true, push: true }])) as Prefs;
  // Same rule as the dispatcher: one disabled row is enough, no row = enabled.
  for (const r of rows) {
    if (!r.enabled && (NOTIFICATION_CATEGORIES as readonly string[]).includes(r.category) && (SWITCHABLE_CHANNELS as readonly string[]).includes(r.channel)) {
      prefs[r.category as NotificationCategory][r.channel as SwitchableChannel] = false;
    }
  }
  return prefs;
}

function shapePrefs(prefs: Prefs) {
  return {
    categories: NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      channels: [
        { channel: "in_app", enabled: true, switchable: false },
        { channel: "email", enabled: prefs[category].email, switchable: true },
        { channel: "push", enabled: prefs[category].push, switchable: true },
      ],
    })),
    mandatory: MANDATORY_CLASSES.map((key) => ({ key, switchable: false })),
  };
}

notificationPreferenceRoutes.get("/", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: shapePrefs(await loadPrefs(c.get("user").id)) });
});

const putSchema = z.object({
  preferences: z
    .array(z.object({ category: z.string().max(40), channel: z.string().max(20), enabled: z.boolean() }))
    .min(1)
    .max(20),
});

notificationPreferenceRoutes.put("/", zValidator("json", putSchema, validationHook), async (c) => {
  const userId = c.get("user").id;
  const changes = new Map<string, { category: NotificationCategory; channel: SwitchableChannel; enabled: boolean }>();
  for (const p of c.req.valid("json").preferences) {
    if (MANDATORY_CATEGORY_NAMES.includes(p.category)) throw new ValidationError("Mandatory messages cannot be switched off", { details: { code: "mandatory_not_switchable", category: p.category } });
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(p.category)) throw new ValidationError("Unknown category", { details: { category: p.category } });
    if (p.channel === "in_app") throw new ValidationError("The in-app channel cannot be switched off", { details: { code: "channel_not_switchable", channel: p.channel } });
    if (!(SWITCHABLE_CHANNELS as readonly string[]).includes(p.channel)) throw new ValidationError("Unknown channel", { details: { channel: p.channel } });
    changes.set(`${p.category}:${p.channel}`, { category: p.category as NotificationCategory, channel: p.channel as SwitchableChannel, enabled: p.enabled });
  }
  const memberIds = await ownClubMemberIds(userId);
  await db.transaction(async (tx) => {
    for (const ch of changes.values()) {
      await tx
        .insert(notificationPreferences)
        .values({ userId, category: ch.category, channel: ch.channel, enabled: ch.enabled })
        .onConflictDoUpdate({
          target: [notificationPreferences.userId, notificationPreferences.category, notificationPreferences.channel],
          targetWhere: sql`${notificationPreferences.userId} IS NOT NULL`,
          set: { enabled: ch.enabled, updatedAt: new Date() },
        });
      // A switch made earlier through an unsubscribe link of the account-less period must not outlive the explicit choice.
      if (memberIds.length) {
        await tx
          .update(notificationPreferences)
          .set({ enabled: ch.enabled, updatedAt: new Date() })
          .where(and(inArray(notificationPreferences.clubMemberId, memberIds), eq(notificationPreferences.category, ch.category), eq(notificationPreferences.channel, ch.channel)));
      }
    }
  });
  c.header("Cache-Control", "private, no-store");
  return c.json({ data: shapePrefs(await loadPrefs(userId)) });
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
  const unsubscribed = sql<boolean>`exists (
    select 1 from notification_preferences np
    where np.category = 'announcements' and np.channel = 'email' and np.enabled = false
      and (np.club_member_id = club_members.id
        or np.user_id = (select m.user_id from member m where m.id = club_members.member_id))
  )`;
  const base = and(
    eq(clubMembers.clubId, c.get("clubId")),
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
unsubscribeRoutes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer"); // the token is part of the URL
});

const wantsHtml = (c: Context) => (c.req.header("accept") ?? "").includes("text/html");
const INVALID = "This link is invalid or has expired";

const esc = (v: string) => v.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const CATEGORY_LABEL: Record<NotificationCategory, string> = { announcements: "Ankündigungen", events: "Termine", reminders: "Erinnerungen" };

function page(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${esc(title)}</h1>${body}</body></html>`;
}

async function clubNameOf(clubId: string | null): Promise<string | null> {
  if (!clubId) return null;
  const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
  return club?.name ?? null;
}

async function isUnsubscribed(p: UnsubscribePayload): Promise<boolean> {
  const [row] = await db
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(and(p.s === "u" ? eq(notificationPreferences.userId, p.p) : eq(notificationPreferences.clubMemberId, p.p), eq(notificationPreferences.category, p.c), eq(notificationPreferences.channel, "email")));
  return row?.enabled === false;
}

/** Turns the e-mail channel of the category off for the token's subject. Idempotent; a subject that no longer exists changes nothing. */
async function applyUnsubscribe(p: UnsubscribePayload): Promise<void> {
  const subject = p.s === "u" ? { userId: p.p } : { clubMemberId: p.p };
  try {
    await db
      .insert(notificationPreferences)
      .values({ ...subject, category: p.c, channel: "email", enabled: false })
      .onConflictDoUpdate({
        target: p.s === "u" ? [notificationPreferences.userId, notificationPreferences.category, notificationPreferences.channel] : [notificationPreferences.clubMemberId, notificationPreferences.category, notificationPreferences.channel],
        targetWhere: p.s === "u" ? sql`${notificationPreferences.userId} IS NOT NULL` : sql`${notificationPreferences.clubMemberId} IS NOT NULL`,
        set: { enabled: false, updatedAt: new Date() },
      });
  } catch (err) {
    // Deleted account / member: nothing left to unsubscribe, and the answer must not reveal that (no existence oracle).
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
    const club = clubName ? ` von ${esc(clubName)}` : "";
    return c.html(
      page(
        unsubscribed ? "Bereits abgemeldet" : "Benachrichtigungen abbestellen",
        unsubscribed
          ? `<p>Du erhältst keine E-Mails zu „${label}“${club} mehr.</p>`
          : `<p>Möchtest du keine E-Mails zu „${label}“${club} mehr erhalten?</p><form method="post"><button type="submit" style="padding:.6rem 1.2rem;font-size:1rem">Abbestellen</button></form>`,
      ),
    );
  }
  return c.json({ data: { category: payload.c, channel: "email", clubName, unsubscribed } });
});

/** RFC 8058 one-click (`List-Unsubscribe=One-Click`, body ignored) and the confirmation button of the page. Idempotent, reusable until expiry. */
unsubscribeRoutes.post("/:token", async (c) => {
  const payload = verifyUnsubscribeToken(c.req.param("token"));
  if (!payload) {
    if (wantsHtml(c)) return c.html(page("Link ungültig", "<p>Dieser Link ist ungültig oder abgelaufen.</p>"), 404);
    throw new NotFoundError(INVALID);
  }
  await applyUnsubscribe(payload);
  if (wantsHtml(c)) return c.html(page("Abgemeldet", `<p>Du erhältst keine E-Mails zu „${CATEGORY_LABEL[payload.c]}“ mehr. Wichtige Mitteilungen zu deinem Konto und deinen Anträgen bekommst du weiterhin.</p>`));
  return c.json({ data: { category: payload.c, channel: "email", unsubscribed: true } });
});
