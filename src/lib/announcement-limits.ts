import { and, count, eq, gt, inArray, ne, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubAnnouncements, type ClubAnnouncementRow } from "../db/schema/communication.js";
import { AudienceLimitError, resolveClubAudience } from "./audience.js";
import { TooManyRequestsError, ValidationError } from "./errors.js";
import { DAY_MS, envInt, HOUR_MS } from "./rate-limits.js";

/**
 * Anti-spam limits for announcements (Wave 9 B14). All counters are derived from `club_announcements` (DB, so every
 * instance and every restart sees the same state). A violation is a `429` with a clear message plus an audit entry
 * `club_announcement.limit_exceeded` (rule + ids, no text); the missing confirmation is a `422`.
 */

export interface AnnouncementLimits {
  perClubDay: number;
  perAuthorHour: number;
  urgentPerClubDay: number;
  maxRecipients: number;
  confirmThreshold: number;
  duplicateWindowMinutes: number;
}

export function announcementLimits(): AnnouncementLimits {
  return {
    perClubDay: envInt("ANNOUNCEMENT_MAX_PER_CLUB_DAY", 20),
    perAuthorHour: envInt("ANNOUNCEMENT_MAX_PER_AUTHOR_HOUR", 10),
    urgentPerClubDay: envInt("ANNOUNCEMENT_MAX_URGENT_PER_DAY", 3),
    maxRecipients: envInt("ANNOUNCEMENT_MAX_RECIPIENTS", 1000, 1, 100_000),
    confirmThreshold: envInt("ANNOUNCEMENT_CONFIRM_THRESHOLD", 50, 0, 100_000),
    duplicateWindowMinutes: envInt("ANNOUNCEMENT_DUPLICATE_WINDOW_MINUTES", 10, 0, 1440),
  };
}

/** `send`: all rules; `schedule`: recipient rules + confirmation (the counters are checked when it actually goes out); `publish`: all counters, no confirmation (given at scheduling). */
export type LimitMode = "send" | "schedule" | "publish";

export interface LimitContext {
  actorUserId: string | null;
  confirmRecipients?: number | null;
  mode: LimitMode;
}

async function violation(row: ClubAnnouncementRow, ctx: LimitContext, rule: string, message: string, extra: Record<string, unknown> = {}): Promise<never> {
  await db.insert(auditLog).values({ eventType: "club_announcement.limit_exceeded", subjectId: row.id, payload: { clubId: row.clubId, actor: ctx.actorUserId, rule, mode: ctx.mode, ...extra } });
  throw new TooManyRequestsError(message, { details: { rule, ...extra } });
}

/** Announcements of the club that went out (or are going out) since `since`, the one being checked excluded. */
function sentSince(row: ClubAnnouncementRow, since: Date) {
  return and(
    eq(clubAnnouncements.clubId, row.clubId),
    ne(clubAnnouncements.id, row.id),
    inArray(clubAnnouncements.status, ["sending", "sent"]),
    gt(sql`coalesce(${clubAnnouncements.sentAt}, ${clubAnnouncements.updatedAt})`, since),
  );
}

/**
 * Throws if sending `row` would break a limit. Rules in order: recipients per send, announcements per club and day, per
 * author and hour, urgent per club and day, duplicate (same text and audience shortly before), and finally the
 * recipient confirmation (`confirmRecipients` must equal the recipient count above the threshold).
 */
export async function assertWithinSendLimits(row: ClubAnnouncementRow, ctx: LimitContext): Promise<void> {
  const limits = announcementLimits();
  let recipients: number;
  try {
    recipients = (await resolveClubAudience(row.clubId, row.audience)).recipients.length;
  } catch (err) {
    if (err instanceof AudienceLimitError) return violation(row, ctx, "announcement.max_recipients", `This announcement would reach ${err.size} people, more than the allowed ${limits.maxRecipients} per send`, { recipients: err.size, limit: limits.maxRecipients });
    throw err;
  }
  if (recipients > limits.maxRecipients) {
    return violation(row, ctx, "announcement.max_recipients", `This announcement would reach ${recipients} people, more than the allowed ${limits.maxRecipients} per send. Narrow the audience or send in parts`, { recipients, limit: limits.maxRecipients });
  }

  if (ctx.mode !== "schedule") {
    const now = Date.now();
    const [club] = await db.select({ n: count() }).from(clubAnnouncements).where(sentSince(row, new Date(now - DAY_MS)));
    if ((club?.n ?? 0) >= limits.perClubDay) {
      return violation(row, ctx, "announcement.club_day", `Your club has already sent ${limits.perClubDay} announcements in the last 24 hours. Try again later`, { limit: limits.perClubDay });
    }
    if (row.authorMemberId) {
      const [author] = await db.select({ n: count() }).from(clubAnnouncements).where(and(sentSince(row, new Date(now - HOUR_MS)), eq(clubAnnouncements.authorMemberId, row.authorMemberId)));
      if ((author?.n ?? 0) >= limits.perAuthorHour) {
        return violation(row, ctx, "announcement.author_hour", `You have already sent ${limits.perAuthorHour} announcements in the last hour. Try again later`, { limit: limits.perAuthorHour });
      }
    }
    if (row.urgent) {
      const [urgent] = await db.select({ n: count() }).from(clubAnnouncements).where(and(sentSince(row, new Date(now - DAY_MS)), eq(clubAnnouncements.urgent, true)));
      if ((urgent?.n ?? 0) >= limits.urgentPerClubDay) {
        return violation(row, ctx, "announcement.urgent_day", `Your club has already sent ${limits.urgentPerClubDay} urgent announcements in the last 24 hours. Send this one without the urgent flag or try again later`, { limit: limits.urgentPerClubDay });
      }
    }
    const [duplicate] = limits.duplicateWindowMinutes === 0 ? [] : await db
      .select({ id: clubAnnouncements.id })
      .from(clubAnnouncements)
      .where(and(sentSince(row, new Date(now - limits.duplicateWindowMinutes * 60_000)), eq(clubAnnouncements.title, row.title), eq(clubAnnouncements.body, row.body), sql`${clubAnnouncements.audience} = ${JSON.stringify(row.audience)}::jsonb`))
      .limit(1);
    if (duplicate) {
      return violation(row, ctx, "announcement.duplicate", `An announcement with the same text and audience was sent in the last ${limits.duplicateWindowMinutes} minutes`, { windowMinutes: limits.duplicateWindowMinutes });
    }
  }

  if (ctx.mode !== "publish" && recipients > limits.confirmThreshold && ctx.confirmRecipients !== recipients) {
    throw new ValidationError(`This announcement reaches ${recipients} people. Confirm the number of recipients to send it`, {
      code: "RECIPIENT_CONFIRMATION_REQUIRED",
      details: { recipients, threshold: limits.confirmThreshold, confirmRecipients: ctx.confirmRecipients ?? null },
    });
  }
}
