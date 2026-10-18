import { and, eq, inArray, or } from "drizzle-orm";

import { db } from "../../db/client.js";
import { clubAnnouncements, notificationPreferences, type MessageDeliveryRow } from "../../db/schema/communication.js";
import type { DeliveryContent } from "./types.js";

/**
 * Send-time re-checks for queued deliveries (the channel handlers and resend-failed): a message may have been withdrawn
 * or cancelled, and a recipient may have opted out of an optional class, between `notify` and the actual send.
 */

type GuardRow = Pick<MessageDeliveryRow, "id" | "announcementId" | "userId" | "clubMemberId" | "channel" | "content">;

/** Announcement ids (of `ids`) that are cancelled or expired/withdrawn right now. */
export async function withdrawnAnnouncementIds(ids: Array<string | null>): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Set();
  const rows = await db.select({ id: clubAnnouncements.id, status: clubAnnouncements.status, expiresAt: clubAnnouncements.expiresAt }).from(clubAnnouncements).where(inArray(clubAnnouncements.id, wanted));
  const now = Date.now();
  return new Set(rows.filter((r) => r.status === "cancelled" || (r.expiresAt !== null && r.expiresAt.getTime() <= now)).map((r) => r.id));
}

/** Delivery ids of `rows` whose recipient currently has the (category, channel) of an OPTIONAL message switched off. Mandatory ones are never listed. */
export async function optedOutDeliveryIds(rows: GuardRow[]): Promise<Set<string>> {
  const optional = rows.filter((r) => (r.content as Partial<DeliveryContent> | null)?.class === "optional" && (r.userId !== null || r.clubMemberId !== null));
  if (optional.length === 0) return new Set();
  const userIds = [...new Set(optional.map((r) => r.userId).filter((v): v is string => v !== null))];
  const memberIds = [...new Set(optional.map((r) => r.clubMemberId).filter((v): v is string => v !== null))];
  const subject = [userIds.length ? inArray(notificationPreferences.userId, userIds) : undefined, memberIds.length ? inArray(notificationPreferences.clubMemberId, memberIds) : undefined];
  const prefs = await db
    .select({ userId: notificationPreferences.userId, clubMemberId: notificationPreferences.clubMemberId, category: notificationPreferences.category, channel: notificationPreferences.channel })
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.enabled, false), or(...subject)));
  const off = new Set<string>();
  for (const p of prefs) {
    if (p.userId) off.add(`${p.channel}:${p.category}:u:${p.userId}`);
    if (p.clubMemberId) off.add(`${p.channel}:${p.category}:m:${p.clubMemberId}`);
  }
  return new Set(
    optional
      .filter((r) => {
        const category = (r.content as Partial<DeliveryContent>).category;
        return (r.userId !== null && off.has(`${r.channel}:${category}:u:${r.userId}`)) || (r.clubMemberId !== null && off.has(`${r.channel}:${category}:m:${r.clubMemberId}`));
      })
      .map((r) => r.id),
  );
}
