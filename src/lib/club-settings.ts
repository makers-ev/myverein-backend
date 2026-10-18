import { eq } from "drizzle-orm";

import { clubSettings } from "../db/schema/club-settings.js";
import type { DbExecutor } from "./club-members.js";

export interface EffectiveClubSettings {
  noticePeriodDays: number | null;
  noticeMode: string | null;
  memberNumberPrefix: string | null;
  allowSelfLoans: boolean;
  /** IANA zone of the club's time-based logic (reminders, sweeps). */
  timezone: string;
  reminderEventEnabled: boolean;
  reminderEventLeadHours: number;
  reminderLoanEnabled: boolean;
  reminderLoanLeadDays: number;
  reminderMaintenanceEnabled: boolean;
  reminderMaintenanceLeadDays: number;
  reminderRsvpEnabled: boolean;
  reminderRsvpLeadDays: number;
  /** Apply the age transition automatically (job `age_transition_sweep`) instead of only suggesting it. */
  ageTransitionAuto: boolean;
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
    timezone: row?.timezone ?? DEFAULT_CLUB_TIMEZONE,
    reminderEventEnabled: row?.reminderEventEnabled ?? true,
    reminderEventLeadHours: row?.reminderEventLeadHours ?? 24,
    reminderLoanEnabled: row?.reminderLoanEnabled ?? true,
    reminderLoanLeadDays: row?.reminderLoanLeadDays ?? 1,
    reminderMaintenanceEnabled: row?.reminderMaintenanceEnabled ?? true,
    reminderMaintenanceLeadDays: row?.reminderMaintenanceLeadDays ?? 7,
    reminderRsvpEnabled: row?.reminderRsvpEnabled ?? true,
    reminderRsvpLeadDays: row?.reminderRsvpLeadDays ?? 3,
    ageTransitionAuto: row?.ageTransitionAuto ?? false,
  };
}
