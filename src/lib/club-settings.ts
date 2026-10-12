import { eq } from "drizzle-orm";

import { clubSettings } from "../db/schema/club-settings.js";
import type { DbExecutor } from "./club-members.js";

export interface EffectiveClubSettings {
  noticePeriodDays: number | null;
  noticeMode: string | null;
  memberNumberPrefix: string | null;
  allowSelfLoans: boolean;
}

/** The club's settings; a club without a `club_settings` row runs on the defaults (no notice period, self loans on). */
export async function loadClubSettings(executor: DbExecutor, clubId: string): Promise<EffectiveClubSettings> {
  const row = await executor.query.clubSettings.findFirst({ where: eq(clubSettings.clubId, clubId) });
  return {
    noticePeriodDays: row?.noticePeriodDays ?? null,
    noticeMode: row?.noticeMode ?? null,
    memberNumberPrefix: row?.memberNumberPrefix ?? null,
    allowSelfLoans: row?.allowSelfLoans ?? true,
  };
}
