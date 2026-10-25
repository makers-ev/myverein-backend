import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";

import { db } from "../db/client.js";
import { meetingAttendance, meetingInvitees, meetings, type MeetingRow } from "../db/schema/meetings.js";
import { meetingProxies } from "../db/schema/assembly.js";
import { isEligible, loadEligibility, rulesOfMeeting } from "./assembly-attendance.js";
import { loadAssemblyRules, type AssemblyRules } from "./assembly-rules.js";
import { writeAudit } from "./audit.js";
import { canReadAllMeetings } from "./meeting-access.js";
import { callerClubMemberId } from "./meeting-members.js";
import { hasClubPermission } from "./club-permissions.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { ClubEnv } from "../middleware/club-guard.js";

/**
 * Hybrid / online participation (Wave 11 B10), deliberately small: a meeting can carry a mode and a join link, invited people see
 * the link and accounts check themselves in and out (`self_online`). No video software: the link points to whatever the club uses.
 * Members without an account stay in the room or are checked in by the secretary. Everything stays off until the club states
 * `onlineAllowed` in its statute parameters (`none` by default).
 */

export const PARTICIPATION_MODES = ["praesenz", "hybrid", "virtual"] as const;
export type ParticipationMode = (typeof PARTICIPATION_MODES)[number];

/** `onlineAllowed` is a ceiling: `none` = in the room only, `hybrid` = room and online, `virtual` = also online only. */
export function allowedParticipationModes(rules: Pick<AssemblyRules, "onlineAllowed">): ParticipationMode[] {
  return rules.onlineAllowed === "virtual" ? ["praesenz", "hybrid", "virtual"] : rules.onlineAllowed === "hybrid" ? ["praesenz", "hybrid"] : ["praesenz"];
}

/** Throws 422 `online_not_allowed` / `online_url_requires_mode` unless the club's statute parameters allow the combination. */
export async function assertParticipation(clubId: string, mode: ParticipationMode, onlineUrl: string | null): Promise<void> {
  const rules = await loadAssemblyRules(db, clubId);
  if (!allowedParticipationModes(rules).includes(mode)) throw new ValidationError("The statute parameters do not allow this participation mode", { details: { code: "online_not_allowed", mode, allowed: allowedParticipationModes(rules) } });
  if (onlineUrl !== null && mode === "praesenz") throw new ValidationError("A join link needs the mode hybrid or virtual", { details: { code: "online_url_requires_mode" } });
}

/** Removes the join link from meetings the caller is not invited to (managers see it everywhere). */
export async function withVisibleOnlineUrl<T extends { id: string; onlineUrl: string | null }>(c: Context<ClubEnv>, rows: T[]): Promise<T[]> {
  const withLink = rows.filter((r) => r.onlineUrl !== null);
  if (withLink.length === 0) return rows;
  const roles = c.get("clubRoleTypes");
  if (canReadAllMeetings(roles) || hasClubPermission(roles, "assembly:manage")) return rows;
  const me = await callerClubMemberId(db, c.get("clubId"), c.get("membership").id);
  const invited = new Set(me ? (await db.select({ id: meetingInvitees.meetingId }).from(meetingInvitees).where(and(eq(meetingInvitees.clubMemberId, me), inArray(meetingInvitees.meetingId, withLink.map((r) => r.id))))).map((r) => r.id) : []);
  return rows.map((r) => (r.onlineUrl !== null && !invited.has(r.id) ? { ...r, onlineUrl: null } : r));
}

/** Self-service window: from 1 hour before the start until 12 hours after it. */
export const CHECK_IN_LEAD_MS = 60 * 60 * 1000;
export const CHECK_IN_TRAIL_MS = 12 * 60 * 60 * 1000;

const refuse = {
  conflict: (message: string, code: string) => new ConflictError(message, { details: { code } }),
  invalid: (message: string, code: string) => new ValidationError(message, { details: { code } }),
};

/**
 * An invited account joins (`join`) or leaves the online part. A rejoin after leaving keeps the first check-in time. Whoever gave a proxy
 * cannot join (withdraw the proxy first), as with the secretary's check-in.
 */
export async function selfOnlineAttendance(args: { clubId: string; meetingId: string; accountMemberId: string; userId: string; join: boolean; now?: Date }): Promise<{ present: boolean; checkedInAt: Date | null; leftAt: Date | null }> {
  return db.transaction(async (tx) => {
    const [meeting] = (await tx.select().from(meetings).where(and(eq(meetings.id, args.meetingId), eq(meetings.clubId, args.clubId))).for("update")) as MeetingRow[];
    const me = await callerClubMemberId(tx, args.clubId, args.accountMemberId);
    if (!meeting || !me) throw new NotFoundError("Meeting not found");
    const [invited] = await tx.select({ id: meetingInvitees.id }).from(meetingInvitees).where(and(eq(meetingInvitees.meetingId, meeting.id), eq(meetingInvitees.clubMemberId, me)));
    if (!invited) throw new NotFoundError("Meeting not found");

    if (meeting.participationMode === "praesenz") throw refuse.conflict("This meeting has no online part", "not_online");
    const rules = await rulesOfMeeting(tx, args.clubId, meeting);
    if (!allowedParticipationModes(rules).includes(meeting.participationMode as ParticipationMode)) throw refuse.conflict("Online participation is not allowed by the statute parameters", "online_not_allowed");
    const now = args.now ?? new Date();
    if (meeting.status === "abgesagt" || !meeting.scheduledAt || now.getTime() < meeting.scheduledAt.getTime() - CHECK_IN_LEAD_MS || now.getTime() > meeting.scheduledAt.getTime() + CHECK_IN_TRAIL_MS) {
      throw refuse.conflict("Check-in is only possible around the start of the meeting", "outside_check_in_window");
    }

    const [existing] = await tx.select().from(meetingAttendance).where(and(eq(meetingAttendance.meetingId, meeting.id), eq(meetingAttendance.clubMemberId, me)));
    let row: typeof existing;
    if (args.join) {
      if (existing?.present) return { present: true, checkedInAt: existing.checkedInAt, leftAt: existing.leftAt };
      const [given] = await tx.select({ id: meetingProxies.id }).from(meetingProxies).where(and(eq(meetingProxies.meetingId, meeting.id), eq(meetingProxies.grantorClubMemberId, me)));
      if (given) throw refuse.conflict("You gave a proxy: withdraw it before joining", "proxy_granted");
      const eligibility = await loadEligibility(tx, args.clubId, meeting);
      [row] = await tx
        .insert(meetingAttendance)
        .values({ meetingId: meeting.id, clubMemberId: me, hasVotingRight: isEligible(eligibility, me), present: true, checkedInAt: now, checkInMethod: "self_online" })
        .onConflictDoUpdate({ target: [meetingAttendance.meetingId, meetingAttendance.clubMemberId], set: { present: true, leftAt: null, checkInMethod: "self_online", checkedInAt: existing?.checkedInAt ?? now } })
        .returning();
    } else {
      if (!existing?.present) return { present: false, checkedInAt: existing?.checkedInAt ?? null, leftAt: existing?.leftAt ?? null };
      // Somebody the secretary checked in in the room is not an online participant: the secretary records leaving.
      if (existing.checkInMethod !== "self_online") throw refuse.conflict("Only the secretary can end this check-in", "not_self_online");
      [row] = await tx.update(meetingAttendance).set({ present: false, leftAt: now }).where(eq(meetingAttendance.id, existing.id)).returning();
    }
    await writeAudit(tx, { eventType: "meeting_attendance.self_online", subjectId: meeting.id, actorUserId: args.userId, payload: { clubId: args.clubId, meetingId: meeting.id, join: args.join } });
    return { present: row!.present, checkedInAt: row!.checkedInAt, leftAt: row!.leftAt };
  });
}
