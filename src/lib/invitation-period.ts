import { addDays, daysBetween, localDate, safeTimezone } from "./club-time.js";
import type { AssemblyRules } from "./assembly-rules.js";

/**
 * Invitation period check (Wave 11 B3), pure. Counts calendar days in the club's time zone (default Europe/Berlin), never
 * 24 h multiples, so a daylight saving switch between sending and the meeting cannot shift the result by a day.
 *
 * Reading used here (an assumption of the club's statute, not legal advice): the invitation is valid when the number of
 * calendar days from the sending day to the meeting day is at least `invitationMinDays + invitationDeliveryBufferDays`.
 * Sending day and meeting day themselves are not counted as extra days.
 */

export type PeriodReason = "ok" | "too_late" | "no_date" | "rules_missing";

export interface PeriodCheck {
  ok: boolean;
  reason: PeriodReason;
  minDays: number | null;
  bufferDays: number | null;
  /** `minDays + bufferDays` (null while a rule is missing). */
  requiredDays: number | null;
  /** Calendar day of sending (club time). */
  sendDay: string;
  /** Calendar day of the meeting (club time); null without a date. */
  meetingDay: string | null;
  /** Calendar days between sending and the meeting; null without a date. */
  daysAvailable: number | null;
  /** Earliest meeting day that is valid for an invitation sent now. */
  earliestMeetingDay: string | null;
  /** Latest day on which the invitation must go out for the planned meeting day. */
  latestSendDay: string | null;
  timezone: string;
}

export function checkInvitationPeriod(
  meeting: { scheduledAt: Date | null },
  rules: Pick<AssemblyRules, "invitationMinDays" | "invitationDeliveryBufferDays">,
  now: Date,
  timezone: string | null | undefined = undefined,
): PeriodCheck {
  const tz = safeTimezone(timezone);
  const sendDay = localDate(now, tz);
  const minDays = rules.invitationMinDays;
  const bufferDays = rules.invitationDeliveryBufferDays;
  const requiredDays = minDays === null || bufferDays === null ? null : minDays + bufferDays;
  const meetingDay = meeting.scheduledAt ? localDate(meeting.scheduledAt, tz) : null;
  const base = {
    minDays,
    bufferDays,
    requiredDays,
    sendDay,
    meetingDay,
    daysAvailable: meetingDay ? daysBetween(sendDay, meetingDay) : null,
    earliestMeetingDay: requiredDays === null ? null : addDays(sendDay, requiredDays),
    latestSendDay: requiredDays === null || meetingDay === null ? null : addDays(meetingDay, -requiredDays),
    timezone: tz,
  };
  if (requiredDays === null) return { ...base, ok: false, reason: "rules_missing" };
  if (meetingDay === null) return { ...base, ok: false, reason: "no_date" };
  return base.daysAvailable! >= requiredDays ? { ...base, ok: true, reason: "ok" } : { ...base, ok: false, reason: "too_late" };
}
