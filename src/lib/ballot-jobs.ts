import { and, eq, isNotNull, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { ballotVoters, ballots } from "../db/schema/assembly.js";
import { AudienceLimitError } from "./audience.js";
import { BALLOT_NOTIFY_JOB, countBallot, finalizeBallot, settleBallot } from "./ballots.js";
import { clubTimezone, formatWhen } from "./event-notify.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notify } from "./notify/dispatcher.js";
import { clubMailLanguage } from "./club-settings.js";
import { APP_NAME, SITE_URL } from "./emailTemplate.js";
import { tr } from "./notify/i18n.js";

/**
 * Scheduler side of the ballots (Wave 11 B5/B6). Correctness never depends on it: the voting window is enforced in the
 * vote query and an expired window is materialized whenever a ballot is read. The sweep makes the end visible without
 * anybody looking: it closes expired windows, counts every closed ballot, finalizes circular resolutions on their own
 * (an in-session result is finalized by the board) and schedules the reminder for circular resolutions shortly before the end.
 * Notifications carry ids only; the texts never mention how anybody voted.
 */

export const BALLOT_SWEEP_JOB_TYPE = "ballot_sweep";
export const BALLOT_SWEEP_INTERVAL_MS = 60 * 1000;
/** A circular resolution reminds the members who have not voted this long before the window ends. */
export const BALLOT_REMINDER_HOURS = 24;

export const ballotReminderKey = (ballotId: string): string => `ballot_reminder:${ballotId}`;

export interface BallotSweepResult {
  closed: number;
  counted: number;
  finalized: number;
  reminders: number;
}

export async function runBallotSweep(scope: { clubId?: string } = {}): Promise<BallotSweepResult> {
  const result: BallotSweepResult = { closed: 0, counted: 0, finalized: 0, reminders: 0 };
  const clubWhere = scope.clubId ? eq(ballots.clubId, scope.clubId) : undefined;

  const expired = await db
    .select({ id: ballots.id, clubId: ballots.clubId })
    .from(ballots)
    .where(and(eq(ballots.status, "open"), isNotNull(ballots.closesAt), sql`${ballots.closesAt} <= clock_timestamp()`, clubWhere));
  for (const b of expired) {
    try {
      if ((await settleBallot(b.clubId, b.id)).status === "closed") result.closed += 1;
    } catch (err) {
      logger.error({ errName: (err as Error)?.name, ballotId: b.id }, "[ballots] could not close an expired ballot");
    }
  }

  const closed = await db.select({ id: ballots.id, clubId: ballots.clubId }).from(ballots).where(and(eq(ballots.status, "closed"), clubWhere));
  for (const b of closed) {
    try {
      await countBallot(b.clubId, b.id, null);
      result.counted += 1;
    } catch (err) {
      logger.error({ errName: (err as Error)?.name, ballotId: b.id }, "[ballots] could not count a closed ballot");
    }
  }

  const circular = await db.select({ id: ballots.id, clubId: ballots.clubId }).from(ballots).where(and(eq(ballots.status, "counted"), eq(ballots.mode, "circular"), clubWhere));
  for (const b of circular) {
    try {
      await finalizeBallot(b.clubId, b.id, null);
      result.finalized += 1;
    } catch (err) {
      logger.error({ errName: (err as Error)?.name, ballotId: b.id }, "[ballots] could not finalize a circular resolution");
    }
  }

  const due = await db
    .select({ id: ballots.id })
    .from(ballots)
    .where(
      and(
        eq(ballots.status, "open"),
        eq(ballots.mode, "circular"),
        isNotNull(ballots.closesAt),
        sql`${ballots.closesAt} > clock_timestamp()`,
        sql`${ballots.closesAt} <= clock_timestamp() + (${BALLOT_REMINDER_HOURS} * interval '1 hour')`,
        sql`${ballots.opensAt} <= clock_timestamp()`,
        clubWhere,
      ),
    );
  for (const b of due) {
    const { created } = await enqueue({ type: BALLOT_NOTIFY_JOB, payload: { kind: "reminder", ballotId: b.id }, dedupeKey: ballotReminderKey(b.id) });
    if (created) result.reminders += 1;
  }
  if (result.closed + result.counted + result.finalized + result.reminders > 0) logger.info(result, "[ballots] swept");
  return result;
}

export async function handleBallotSweep(_job: JobContext): Promise<void> {
  await runBallotSweep();
}

/** Job `ballot_notify`: the call to vote of a circular resolution (mandatory) and the reminder to those who have not voted (optional). */
export async function handleBallotNotify(job: JobContext): Promise<void> {
  const p = job.payload as { kind?: unknown; ballotId?: unknown };
  if ((p.kind !== "opened" && p.kind !== "reminder") || typeof p.ballotId !== "string") return;
  const ballot = await db.query.ballots.findFirst({ where: eq(ballots.id, p.ballotId) });
  // Closed, cancelled or gone meanwhile: nothing to ask for any more.
  if (!ballot || ballot.status !== "open" || ballot.mode !== "circular") return;
  const voters = await db
    .select({ id: ballotVoters.clubMemberId })
    .from(ballotVoters)
    .where(and(eq(ballotVoters.ballotId, ballot.id), eq(ballotVoters.eligible, true), p.kind === "reminder" ? eq(ballotVoters.hasVoted, false) : undefined, isNotNull(ballotVoters.clubMemberId)));
  const ids = voters.flatMap((v) => (v.id ? [v.id] : []));
  if (ids.length === 0) return;
  const lang = await clubMailLanguage(db, ballot.clubId);
  const until = formatWhen(ballot.closesAt, await clubTimezone(ballot.clubId), null, lang);
  const reminder = p.kind === "reminder";
  try {
    await notify({
      clubId: ballot.clubId,
      class: reminder ? "optional" : "mandatory",
      eventKey: reminder ? "ballot.reminder" : "ballot.opened",
      refId: ballot.id,
      audience: { memberIds: ids, includeGuardians: false },
      content: {
        title: tr(lang, `${reminder ? "Erinnerung: Abstimmung" : "Abstimmung"}: ${ballot.title}`, `${reminder ? "Reminder: vote" : "Vote"}: ${ballot.title}`),
        body: tr(
          lang,
          `Bitte gib deine Stimme bis ${until} ab. Öffne dazu ${APP_NAME} und wähle „Abstimmungen“.`,
          `Please cast your vote by ${until}. Open ${APP_NAME} and choose "Votes".`,
        ),
        template: reminder ? "reminder" : "announcement",
        ...(reminder ? { category: "reminders" as const } : {}),
        ctaLabel: tr(lang, `${APP_NAME} öffnen`, `Open ${APP_NAME}`),
        ctaUrl: SITE_URL,
        lang,
      },
      channels: ["in_app", "email", "push"],
      limit: ids.length,
    });
  } catch (err) {
    if (err instanceof AudienceLimitError) return;
    throw err;
  }
}
