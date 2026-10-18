import { and, eq, gte, isNotNull, isNull, lte, notInArray } from "drizzle-orm";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubMembers, LEFT_STATUSES } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { inventoryItems, inventoryLoans } from "../db/schema/inventory.js";
import { locationKeyHolders, locations } from "../db/schema/locations.js";
import { AudienceLimitError } from "./audience.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { addDays, isDigestTime, localDate, safeTimezone } from "./club-time.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notify } from "./notify/dispatcher.js";

/**
 * "Exit becomes effective" (Wave 9 B13, left open in B11). The status itself stays derived at read time (`effectiveStatus`:
 * a stored non-left status with `left_at <= today` reads as `ausgetreten`); this job only makes the day visible. On the
 * effective day (from `REMINDER_DIGEST_HOUR` club time; up to 3 missed days are caught up after downtime) the recurring job
 * `exit_effective_sweep` schedules one `exit_effective_notify` job per member under the key
 * `exit_effective:<clubMemberId>:<left_at>`. That job tells the leadership (`members:write` roles) that the membership ends and
 * lists what still has to come back -- open loans and keys held (the return reminder). Names stay out of the queue
 * (payload: ids), the text is composed when the job runs. Exits that were booked directly (status already stored) are
 * not announced again: the leadership did that itself.
 */

export const EXIT_EFFECTIVE_SWEEP_JOB_TYPE = "exit_effective_sweep";
export const EXIT_EFFECTIVE_NOTIFY_JOB_TYPE = "exit_effective_notify";
export const EXIT_EFFECTIVE_INTERVAL_MS = 60 * 60 * 1000;
const CATCH_UP_DAYS = 3;

export const exitEffectiveDedupeKey = (clubMemberId: string, leftAt: string): string => `exit_effective:${clubMemberId}:${leftAt}`;

const dateDe = (date: string): string => date.split("-").reverse().join(".");

export async function runExitEffectiveSweep(now: Date = new Date(), scope: { clubId?: string } = {}): Promise<{ scheduled: number; alreadyScheduled: number }> {
  const horizon = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db
    .select({ id: clubMembers.id, clubId: clubMembers.clubId, leftAt: clubMembers.leftAt, timezone: clubSettings.timezone })
    .from(clubMembers)
    .innerJoin(organization, eq(organization.id, clubMembers.clubId))
    .leftJoin(clubSettings, eq(clubSettings.clubId, clubMembers.clubId))
    .where(
      and(
        isNotNull(clubMembers.leftAt),
        notInArray(clubMembers.status, [...LEFT_STATUSES]),
        // Coarse UTC window; the exact club-local day is checked below.
        gte(clubMembers.leftAt, horizon(-(CATCH_UP_DAYS + 2))),
        lte(clubMembers.leftAt, horizon(2)),
        scope.clubId ? eq(clubMembers.clubId, scope.clubId) : undefined,
      ),
    );
  const result = { scheduled: 0, alreadyScheduled: 0 };
  for (const row of rows) {
    const timezone = safeTimezone(row.timezone);
    const today = localDate(now, timezone);
    const leftAt = row.leftAt!;
    if (leftAt > today || leftAt < addDays(today, -CATCH_UP_DAYS) || !isDigestTime(now, timezone)) continue;
    const { created } = await enqueue({ type: EXIT_EFFECTIVE_NOTIFY_JOB_TYPE, payload: { clubId: row.clubId, clubMemberId: row.id, leftAt }, dedupeKey: exitEffectiveDedupeKey(row.id, leftAt) });
    if (created) result.scheduled += 1;
    else result.alreadyScheduled += 1;
  }
  if (result.scheduled > 0) logger.info(result, "[exit-effective] scheduled notifications");
  return result;
}

export async function handleExitEffectiveSweep(_job: JobContext): Promise<void> {
  await runExitEffectiveSweep();
}

/** Job handler `exit_effective_notify`: the leadership message with the return reminder. */
export async function handleExitEffectiveNotify(job: JobContext): Promise<void> {
  const { clubId, clubMemberId, leftAt } = job.payload as { clubId?: string; clubMemberId?: string; leftAt?: string };
  if (!clubId || !clubMemberId || !leftAt) return;
  const [member] = await db
    .select({ displayName: clubMembers.displayName, accountId: clubMembers.memberId, leftAt: clubMembers.leftAt, status: clubMembers.status })
    .from(clubMembers)
    .where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId), isNotNull(clubMembers.leftAt)));
  // Withdrawn in the meantime (cancellation revoked / date moved): nothing to announce.
  if (!member || member.leftAt !== leftAt) return;

  const lines: string[] = [];
  if (member.accountId) {
    const loans = await db
      .select({ name: inventoryItems.name })
      .from(inventoryLoans)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLoans.itemId))
      .where(and(eq(inventoryLoans.memberId, member.accountId), isNull(inventoryLoans.returnedAt), eq(inventoryItems.clubId, clubId)));
    const keys = await db
      .select({ location: locations.name, label: locationKeyHolders.keyLabel })
      .from(locationKeyHolders)
      .innerJoin(locations, eq(locations.id, locationKeyHolders.locationId))
      .where(and(eq(locationKeyHolders.memberId, member.accountId), eq(locations.clubId, clubId)));
    lines.push(...loans.map((l) => `• Ausleihe: ${l.name}`), ...keys.map((k) => `• Schlüssel: ${k.location}${k.label ? ` (${k.label})` : ""}`));
  }
  const body = [
    `Die Mitgliedschaft von ${member.displayName} endet seit dem ${dateDe(leftAt)}.`,
    lines.length > 0 ? `Noch zurückzugeben:\n${lines.join("\n")}\nBitte Rückgabe veranlassen und im Verein eintragen.` : "Es sind keine Ausleihen oder Schlüssel offen.",
  ].join("\n");

  try {
    await notify({
      clubId,
      class: "optional",
      eventKey: "member.exit_effective",
      refId: clubMemberId,
      audience: { roleTypes: roleTypesWithPermission("members:write"), includeGuardians: false },
      content: { title: lines.length > 0 ? `Austritt wirksam – Rückgabe offen: ${member.displayName}` : `Austritt wirksam: ${member.displayName}`, body, template: "reminder", category: "reminders" },
      channels: ["in_app", "email"],
    });
  } catch (err) {
    if (err instanceof AudienceLimitError) {
      logger.error({ clubId, clubMemberId }, "[exit-effective] audience too large, notification dropped");
      return;
    }
    throw err;
  }
}
