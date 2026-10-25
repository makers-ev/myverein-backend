import { eq } from "drizzle-orm";

import { clubSettings, type ClubTextBlock } from "../db/schema/club-settings.js";
import type { DbExecutor } from "./club-members.js";
import { DEFAULT_MAIL_LANGUAGE, isMailLanguage, type MailLanguage } from "./notify/i18n.js";

export interface EffectiveClubSettings {
  noticePeriodDays: number | null;
  noticeMode: string | null;
  memberNumberPrefix: string | null;
  allowSelfLoans: boolean;
  /** Club mail template (B15): display name of the sender; the sender ADDRESS stays `EMAIL_FROM`. */
  senderName: string | null;
  /** Plain-text signature / footer appended to club mails. */
  signature: string | null;
  replyTo: string | null;
  textBlocks: ClubTextBlock[];
  /** IANA zone of the club's time-based logic (reminders, sweeps). */
  timezone: string;
  /** German federal state code (e.g. "BY") for the public holidays of event series; null = nationwide holidays only. */
  state: string | null;
  reminderEventEnabled: boolean;
  reminderEventLeadHours: number;
  reminderLoanEnabled: boolean;
  reminderLoanLeadDays: number;
  reminderMaintenanceEnabled: boolean;
  reminderMaintenanceLeadDays: number;
  reminderRsvpEnabled: boolean;
  reminderRsvpLeadDays: number;
  reminderInvitationEnabled: boolean;
  reminderInvitationLeadDays: number;
  reminderCredentialEnabled: boolean;
  reminderCredentialLeadDays: number;
  /** Apply the age transition automatically (job `age_transition_sweep`) instead of only suggesting it. */
  ageTransitionAuto: boolean;
  /** Tell the `members:write` roles about a new admission application or exit request (optional message, in-app + mail). */
  notifyBoardRequests: boolean;
  /** Tell people when they are invited to a meeting or a Terminfindung (optional message, category events). */
  notifyMeetingInvites: boolean;
  /** Tell a member (and the guardians) when the age transition moved them to another category (optional message, category announcements). */
  notifyAgeTransition: boolean;
  /** Tell the borrower / key holder when a loan or key is handed out, returned or a loan extended (optional message). */
  notifyHandover: boolean;
  /** Language of the system texts of club mails and pushes (decisions, reminders, event changes, invitations); text written by a person stays as written. */
  mailLanguage: MailLanguage;
  /** Privacy (Wave 10): age from which a person consents alone (default 18), whether both guardians are needed, privacy contact and controller (free text for the privacy notice). */
  consentAgeLimit: number;
  consentBothGuardians: boolean;
  privacyContact: string | null;
  privacyController: string | null;
}

export const DEFAULT_CLUB_TIMEZONE = "Europe/Berlin";

/** The club's settings; a club without a `club_settings` row runs on the defaults (no notice period, self loans on). */
export async function loadClubSettings(executor: DbExecutor, clubId: string): Promise<EffectiveClubSettings> {
  const row = await executor.query.clubSettings.findFirst({ where: eq(clubSettings.clubId, clubId) });
  return {
    noticePeriodDays: row?.noticePeriodDays ?? null,
    noticeMode: row?.noticeMode ?? null,
    memberNumberPrefix: row?.memberNumberPrefix ?? null,
    allowSelfLoans: row?.allowSelfLoans ?? true,
    senderName: row?.senderName ?? null,
    signature: row?.signature ?? null,
    replyTo: row?.replyTo ?? null,
    textBlocks: row?.textBlocks ?? [],
    timezone: row?.timezone ?? DEFAULT_CLUB_TIMEZONE,
    state: row?.state ?? null,
    reminderEventEnabled: row?.reminderEventEnabled ?? true,
    reminderEventLeadHours: row?.reminderEventLeadHours ?? 24,
    reminderLoanEnabled: row?.reminderLoanEnabled ?? true,
    reminderLoanLeadDays: row?.reminderLoanLeadDays ?? 1,
    reminderMaintenanceEnabled: row?.reminderMaintenanceEnabled ?? true,
    reminderMaintenanceLeadDays: row?.reminderMaintenanceLeadDays ?? 7,
    reminderRsvpEnabled: row?.reminderRsvpEnabled ?? true,
    reminderRsvpLeadDays: row?.reminderRsvpLeadDays ?? 3,
    reminderInvitationEnabled: row?.reminderInvitationEnabled ?? true,
    reminderInvitationLeadDays: row?.reminderInvitationLeadDays ?? 3,
    reminderCredentialEnabled: row?.reminderCredentialEnabled ?? true,
    reminderCredentialLeadDays: row?.reminderCredentialLeadDays ?? 30,
    ageTransitionAuto: row?.ageTransitionAuto ?? false,
    notifyBoardRequests: row?.notifyBoardRequests ?? true,
    notifyMeetingInvites: row?.notifyMeetingInvites ?? true,
    notifyAgeTransition: row?.notifyAgeTransition ?? true,
    notifyHandover: row?.notifyHandover ?? true,
    mailLanguage: isMailLanguage(row?.mailLanguage) ? row.mailLanguage : DEFAULT_MAIL_LANGUAGE,
    consentAgeLimit: row?.consentAgeLimit ?? 18,
    consentBothGuardians: row?.consentBothGuardians ?? false,
    privacyContact: row?.privacyContact ?? null,
    privacyController: row?.privacyController ?? null,
  };
}

/** The club's mail language (`de` without a settings row). */
export async function clubMailLanguage(executor: DbExecutor, clubId: string): Promise<MailLanguage> {
  const row = await executor.query.clubSettings.findFirst({ where: eq(clubSettings.clubId, clubId), columns: { mailLanguage: true } });
  return isMailLanguage(row?.mailLanguage) ? row.mailLanguage : DEFAULT_MAIL_LANGUAGE;
}
