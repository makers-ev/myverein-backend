import { and, eq, gte, isNotNull } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { loadAssemblyRules } from "./assembly-rules.js";
import { clubMailLanguage } from "./club-settings.js";
import { addDays, daysBetween, localDate } from "./club-time.js";
import { APP_NAME, SITE_URL } from "./emailTemplate.js";
import { clubTimezone } from "./event-notify.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notify } from "./notify/dispatcher.js";
import { formatIsoDay, tr } from "./notify/i18n.js";

/**
 * Term reminders (Wave 11 B8). The recurring sweep looks, per club with stated `termWarningDays`, at every role with a term end and
 * schedules ONE `term_notify` job per role, term end and threshold under the dedupe key `term_reminder:<role>:<end>:<days>`.
 * A threshold fires on the first sweep after it is crossed (so a missed sweep catches up, a later sweep or second instance
 * finds the key taken); `0` (the end day) is always a threshold; terms that ended more than a week ago stay silent. Renewing the term
 * changes the key. Audience: `vorsitz` and `schriftfuehrer`. Payload carries ids only.
 */

export const TERM_SWEEP_JOB_TYPE = "term_sweep";
export const TERM_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const TERM_NOTIFY_JOB_TYPE = "term_notify";
export const TERM_SILENT_AFTER_DAYS = 7;
const TERM_REMINDER_ROLES = ["vorsitz", "schriftfuehrer"];

export const termReminderKey = (roleId: string, termEndsAt: string, threshold: number): string => `term_reminder:${roleId}:${termEndsAt}:${threshold}`;

/** The smallest threshold (stated days plus 0) that the remaining days have crossed; null while none is reached. */
export function crossedThreshold(daysLeft: number, warningDays: readonly number[]): number | null {
  const sorted = [...new Set([...warningDays, 0])].sort((a, b) => a - b);
  return sorted.find((d) => daysLeft <= d) ?? null;
}

export async function runTermSweep(now: Date = new Date(), scope: { clubId?: string } = {}): Promise<number> {
  let scheduled = 0;
  const clubs = await db.select({ clubId: clubSettings.clubId }).from(clubSettings).where(scope.clubId ? eq(clubSettings.clubId, scope.clubId) : undefined);
  for (const { clubId } of clubs) {
    try {
      const rules = await loadAssemblyRules(db, clubId);
      if (!rules.termWarningDays || rules.termWarningDays.length === 0) continue;
      const today = localDate(now, await clubTimezone(clubId));
      const roles = await db
        .select({ id: clubRoles.id, termEndsAt: clubRoles.termEndsAt })
        .from(clubRoles)
        .innerJoin(member, eq(member.id, clubRoles.memberId))
        .where(and(eq(member.organizationId, clubId), isNotNull(clubRoles.termEndsAt), gte(clubRoles.termEndsAt, addDays(today, -TERM_SILENT_AFTER_DAYS))));
      for (const role of roles) {
        const left = daysBetween(today, role.termEndsAt!);
        const threshold = crossedThreshold(left, rules.termWarningDays);
        if (threshold === null) continue;
        const { created } = await enqueue({ type: TERM_NOTIFY_JOB_TYPE, payload: { roleId: role.id, termEndsAt: role.termEndsAt, threshold }, dedupeKey: termReminderKey(role.id, role.termEndsAt!, threshold) });
        if (created) scheduled += 1;
      }
    } catch (err) {
      logger.error({ errName: (err as Error)?.name, clubId }, "[terms] sweep failed for a club");
    }
  }
  if (scheduled > 0) logger.info({ scheduled }, "[terms] reminders scheduled");
  return scheduled;
}

export async function handleTermSweep(_job: JobContext): Promise<void> {
  await runTermSweep();
}

/** Job `term_notify`: tells the chair and the secretary that a term ends (or ended) and points to the election. */
export async function handleTermNotify(job: JobContext): Promise<void> {
  const p = job.payload as { roleId?: unknown; termEndsAt?: unknown };
  if (typeof p.roleId !== "string" || typeof p.termEndsAt !== "string") return;
  const [role] = await db
    .select({ roleType: clubRoles.roleType, termEndsAt: clubRoles.termEndsAt, clubId: member.organizationId })
    .from(clubRoles)
    .innerJoin(member, eq(member.id, clubRoles.memberId))
    .where(eq(clubRoles.id, p.roleId));
  // Renewed, revoked or gone meanwhile: nothing to remind of.
  if (!role || role.termEndsAt !== p.termEndsAt) return;
  const lang = await clubMailLanguage(db, role.clubId);
  const today = localDate(new Date(), await clubTimezone(role.clubId));
  const expired = role.termEndsAt < today;
  const date = formatIsoDay(role.termEndsAt, lang);
  await notify({
    clubId: role.clubId,
    class: "optional",
    eventKey: "club_role.term_expiring",
    refId: p.roleId,
    audience: { roleTypes: TERM_REMINDER_ROLES, includeGuardians: false },
    content: {
      title: expired ? tr(lang, "Amtszeit abgelaufen", "Term has ended") : tr(lang, "Amtszeit läuft bald ab", "Term ends soon"),
      body: tr(
        lang,
        `Die Amtszeit einer Vorstandsrolle ${expired ? "endete" : "endet"} am ${date}. Plane in ${APP_NAME} unter „Wahlen“ eine Neuwahl.`,
        `The term of a board role ${expired ? "ended" : "ends"} on ${date}. Plan a new election in ${APP_NAME} under "Elections".`,
      ),
      template: "reminder",
      category: "board",
      ctaLabel: tr(lang, `${APP_NAME} öffnen`, `Open ${APP_NAME}`),
      ctaUrl: SITE_URL,
      lang,
    },
    channels: ["in_app", "email"],
  });
}
