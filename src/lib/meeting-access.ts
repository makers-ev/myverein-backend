import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "../db/client.js";
import { meetingInvitees, meetings } from "../db/schema/meetings.js";
import { hasClubPermission } from "./club-permissions.js";
import { NotFoundError } from "./errors.js";
import { callerClubMemberId } from "./meeting-members.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/** Board-level readers: meetings:write or meetings:read_board see every meeting of the club. */
export function canReadAllMeetings(roleTypes: readonly string[]) {
  return hasClubPermission(roleTypes, "meetings:write") || hasClubPermission(roleTypes, "meetings:read_board");
}

/**
 * External guests (`member.role === "guest"`, e.g. guardians) never read meetings: 404, like a meeting that does not
 * exist (Wave 10 brings dedicated guardian routes). Applied to the list and to every route that loads a meeting.
 */
export function denyGuests(c: Context<ClubEnv>) {
  if (c.get("membership").role === "guest") throw new NotFoundError("Meeting not found");
}

/**
 * Loads a meeting scoped to the caller's club AND to what the caller may read, 404s (never 403, never leaks
 * existence) otherwise. Read scoping (B8): a `vorstandssitzung` is only visible to invitees and to
 * meetings:write / meetings:read_board; `mitgliederversammlung` and `sonstige` are visible to every member.
 */
export async function loadClubMeeting(c: Context<ClubEnv>, id: string) {
  const clubId = c.get("clubId");
  denyGuests(c);
  const row = await db.query.meetings.findFirst({ where: and(eq(meetings.id, id), eq(meetings.clubId, clubId)) });
  if (!row) throw new NotFoundError("Meeting not found");
  if (row.type === "vorstandssitzung" && !canReadAllMeetings(c.get("clubRoleTypes"))) {
    const me = await callerClubMemberId(db, clubId, c.get("membership").id);
    const invited = me ? await db.query.meetingInvitees.findFirst({ where: and(eq(meetingInvitees.meetingId, id), eq(meetingInvitees.clubMemberId, me)) }) : undefined;
    if (!invited) throw new NotFoundError("Meeting not found");
  }
  return row;
}
