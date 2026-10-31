import { and, inArray, isNull, or } from "drizzle-orm";

import { db } from "../../db/client.js";
import { notificationPreferences } from "../../db/schema/communication.js";

/**
 * Preference resolution (G12). A preference row is (person, category, channel, enabled) with an optional `club_id`:
 * NULL = the person's global default, set = the override for that club only. For a message of club X the effective value of
 * a switch is `club X row` > `global row` > enabled (no row = on). A person is the account (`user_id`) and/or the account-less
 * member row (`club_member_id`); as before, one disabled subject is enough to switch the channel off for that message.
 */

export interface PrefSubject {
  userId: string | null;
  clubMemberId: string | null;
  /** Club the message belongs to; NULL (platform context) only ever sees the global rows. */
  clubId: string | null;
}

export type PrefResolver = (subject: PrefSubject, category: string, channel: string) => boolean;

const CHUNK = 500;

function keyOf(kind: "u" | "m", id: string, clubId: string | null, category: string, channel: string): string {
  return `${kind}:${id}:${clubId ?? ""}:${category}:${channel}`;
}

/**
 * Loads every row of the given people that can matter for the given clubs (global rows and the rows of those clubs) and
 * returns `isEnabled(subject, category, channel)`. One query per chunk of people; the closure itself does no I/O.
 */
export async function loadPrefResolver(input: { userIds: string[]; clubMemberIds: string[]; clubIds: Array<string | null> }): Promise<PrefResolver> {
  const userIds = [...new Set(input.userIds)];
  const memberIds = [...new Set(input.clubMemberIds)];
  const clubIds = [...new Set(input.clubIds.filter((v): v is string => v !== null))];
  const values = new Map<string, boolean>();
  const scope = clubIds.length ? or(isNull(notificationPreferences.clubId), inArray(notificationPreferences.clubId, clubIds)) : isNull(notificationPreferences.clubId);
  const collect = async (subject: "user" | "member", ids: string[]) => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const rows = await db
        .select({ userId: notificationPreferences.userId, clubMemberId: notificationPreferences.clubMemberId, clubId: notificationPreferences.clubId, category: notificationPreferences.category, channel: notificationPreferences.channel, enabled: notificationPreferences.enabled })
        .from(notificationPreferences)
        .where(and(subject === "user" ? inArray(notificationPreferences.userId, slice) : inArray(notificationPreferences.clubMemberId, slice), scope));
      for (const r of rows) {
        if (r.userId) values.set(keyOf("u", r.userId, r.clubId, r.category, r.channel), r.enabled);
        if (r.clubMemberId) values.set(keyOf("m", r.clubMemberId, r.clubId, r.category, r.channel), r.enabled);
      }
    }
  };
  await collect("user", userIds);
  await collect("member", memberIds);

  const effective = (kind: "u" | "m", id: string, clubId: string | null, category: string, channel: string): boolean =>
    (clubId !== null ? values.get(keyOf(kind, id, clubId, category, channel)) : undefined) ?? values.get(keyOf(kind, id, null, category, channel)) ?? true;
  return (subject, category, channel) =>
    (subject.userId === null || effective("u", subject.userId, subject.clubId, category, channel)) &&
    (subject.clubMemberId === null || effective("m", subject.clubMemberId, subject.clubId, category, channel));
}
