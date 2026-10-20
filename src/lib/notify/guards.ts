import { inArray } from "drizzle-orm";

import { db } from "../../db/client.js";
import { clubAnnouncements, type MessageDeliveryRow } from "../../db/schema/communication.js";
import { loadPrefResolver } from "./preferences.js";
import type { DeliveryContent } from "./types.js";

/**
 * Send-time re-checks for queued deliveries (the channel handlers and resend-failed): a message may have been withdrawn
 * or cancelled, and a recipient may have opted out of an optional class, between `notify` and the actual send.
 */

type GuardRow = Pick<MessageDeliveryRow, "id" | "announcementId" | "clubId" | "userId" | "clubMemberId" | "channel" | "content">;

/** Announcement ids (of `ids`) that are cancelled or expired/withdrawn right now. */
export async function withdrawnAnnouncementIds(ids: Array<string | null>): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Set();
  const rows = await db.select({ id: clubAnnouncements.id, status: clubAnnouncements.status, expiresAt: clubAnnouncements.expiresAt }).from(clubAnnouncements).where(inArray(clubAnnouncements.id, wanted));
  const now = Date.now();
  return new Set(rows.filter((r) => r.status === "cancelled" || (r.expiresAt !== null && r.expiresAt.getTime() <= now)).map((r) => r.id));
}

/**
 * Delivery ids of `rows` whose recipient currently has the (category, channel) of an OPTIONAL message switched off for the
 * club of the message (club row > global row > on). Mandatory ones are never listed.
 */
export async function optedOutDeliveryIds(rows: GuardRow[]): Promise<Set<string>> {
  const optional = rows.filter((r) => (r.content as Partial<DeliveryContent> | null)?.class === "optional" && (r.userId !== null || r.clubMemberId !== null));
  if (optional.length === 0) return new Set();
  const isEnabled = await loadPrefResolver({
    userIds: optional.map((r) => r.userId).filter((v): v is string => v !== null),
    clubMemberIds: optional.map((r) => r.clubMemberId).filter((v): v is string => v !== null),
    clubIds: optional.map((r) => r.clubId),
  });
  return new Set(optional.filter((r) => !isEnabled({ userId: r.userId, clubMemberId: r.clubMemberId, clubId: r.clubId }, (r.content as Partial<DeliveryContent>).category ?? "", r.channel)).map((r) => r.id));
}
