import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMembers, LEFT_STATUSES } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { writeAudit } from "./audit.js";
import { AudienceLimitError } from "./audience.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { addDays, localDate, safeTimezone } from "./club-time.js";
import { clubMailLanguage } from "./club-settings.js";
import { CONFIRM_DAYS, memberConsentViews } from "./consent.js";
import { GUARDIAN_LINK_END_AGE } from "./guardian-scope.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { notify } from "./notify/dispatcher.js";
import { formatIsoDay, tr } from "./notify/i18n.js";
import { BOARD_CATEGORY } from "./notify/types.js";

/**
 * Transition to adulthood (Wave 10 B6), on the Wave 9 job infrastructure. The read-time guard of `guardianScope` stays the
 * authority (a guardian link grants nothing for a ward of 18, whatever this job did); the job makes the transition visible and tidy:
 *
 * - 28 days before the 18th birthday (`MAJORITY_NOTICE_DAYS`, catches up after downtime): a notice to the member (if reachable)
 *   and the guardians; for a member WITHOUT account additionally to the leadership (`members:write`), who can send the account
 *   invitation (`POST /club-members/:id/invite`) -- the job never invites on its own, that needs a contact address the person gave;
 * - on the birthday (club calendar day): `guardian_links.valid_until` is set to the last day as a minor, one audit entry
 *   (`club_member.majority`) and a notice to the now adult person. Consents given by a guardian (or on paper) while the person was
 *   a minor then read as "confirmation pending" in the consent views (`confirmation`, due `MAJORITY_CONFIRM_DAYS` later); the
 *   person confirms by granting again or revokes. Nothing is revoked automatically and nothing is blocked.
 *
 * Idempotent: job keys carry member and birthday, the link update only touches open links.
 */

export const MAJORITY_SWEEP_JOB_TYPE = "majority_sweep";
export const MAJORITY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const MAJORITY_NOTIFY_JOB_TYPE = "majority_notify";
export const MAJORITY_NOTICE_DAYS = 28;
/** Days after the birthday in which the person is asked to confirm the consents a guardian gave for them. */
export const MAJORITY_CONFIRM_DAYS = CONFIRM_DAYS;
/** Days after the birthday the sweep still ends the links and announces it (downtime). Older cases rest on the read-time guard alone. */
const CATCH_UP_DAYS = 30;

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The day the person reaches `age` (29 February is celebrated on 1 March, as `ageOn` counts). */
export function majorityDate(birthDate: string, age: number = GUARDIAN_LINK_END_AGE): string {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  const year = y + age;
  if (m === 2 && d === 29 && !isLeap(year)) return `${year}-03-01`;
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const majorityNoticeKey = (clubMemberId: string, majority: string): string => `majority_notice:${clubMemberId}:${majority}`;
export const majorityDoneKey = (clubMemberId: string, majority: string): string => `majority_done:${clubMemberId}:${majority}`;

const SQL_MAJORITY = sql`(${clubMembers.birthDate}::date + (${GUARDIAN_LINK_END_AGE} * interval '1 year'))::date`;

export interface MajoritySweepResult {
  noticed: number;
  transitioned: number;
}

export async function runMajoritySweep(now: Date = new Date(), scope: { clubId?: string } = {}): Promise<MajoritySweepResult> {
  const result: MajoritySweepResult = { noticed: 0, transitioned: 0 };
  const utcToday = now.toISOString().slice(0, 10);

  // 1. Notice: the birthday is within the next 28 days.
  const upcoming = await db
    .select({ id: clubMembers.id, clubId: clubMembers.clubId, birthDate: clubMembers.birthDate, timezone: clubSettings.timezone })
    .from(clubMembers)
    .leftJoin(clubSettings, eq(clubSettings.clubId, clubMembers.clubId))
    .where(
      and(
        sql`${clubMembers.birthDate} IS NOT NULL`,
        notInArray(clubMembers.status, [...LEFT_STATUSES]),
        or(isNull(clubMembers.leftAt), sql`${clubMembers.leftAt} > ${utcToday}`),
        sql`${SQL_MAJORITY} BETWEEN ${addDays(utcToday, -2)}::date AND ${addDays(utcToday, MAJORITY_NOTICE_DAYS + 2)}::date`,
        scope.clubId ? eq(clubMembers.clubId, scope.clubId) : undefined,
      ),
    );
  for (const row of upcoming) {
    const today = localDate(now, safeTimezone(row.timezone));
    const majority = majorityDate(row.birthDate!);
    if (today >= majority || today < addDays(majority, -MAJORITY_NOTICE_DAYS)) continue;
    const { created } = await enqueue({ type: MAJORITY_NOTIFY_JOB_TYPE, payload: { kind: "notice", clubId: row.clubId, clubMemberId: row.id, majority }, dedupeKey: majorityNoticeKey(row.id, majority) });
    if (created) result.noticed += 1;
  }

  // 2. Transition: open guardian links of wards who are 18 by now.
  const links = await db
    .select({ wardId: guardianLinks.wardClubMemberId, clubId: clubMembers.clubId, birthDate: clubMembers.birthDate, validUntil: guardianLinks.validUntil, timezone: clubSettings.timezone })
    .from(guardianLinks)
    .innerJoin(clubMembers, eq(clubMembers.id, guardianLinks.wardClubMemberId))
    .leftJoin(clubSettings, eq(clubSettings.clubId, clubMembers.clubId))
    .where(
      and(
        sql`${clubMembers.birthDate} IS NOT NULL`,
        sql`${SQL_MAJORITY} BETWEEN ${addDays(utcToday, -CATCH_UP_DAYS - 1)}::date AND ${addDays(utcToday, 1)}::date`,
        or(isNull(guardianLinks.validUntil), sql`${guardianLinks.validUntil} >= ${SQL_MAJORITY} - 1`),
        scope.clubId ? eq(clubMembers.clubId, scope.clubId) : undefined,
      ),
    );
  const due = new Map<string, { clubId: string; majority: string }>();
  for (const l of links) {
    const today = localDate(now, safeTimezone(l.timezone));
    const majority = majorityDate(l.birthDate!);
    if (majority > today || majority < addDays(today, -CATCH_UP_DAYS)) continue;
    if (l.validUntil !== null && l.validUntil < majority) continue;
    due.set(l.wardId, { clubId: l.clubId, majority });
  }
  for (const [wardId, { clubId, majority }] of due) {
    try {
      const changed = await db.transaction(async (tx) => {
        const updated = await tx
          .update(guardianLinks)
          .set({ validUntil: addDays(majority, -1) })
          .where(and(eq(guardianLinks.wardClubMemberId, wardId), or(isNull(guardianLinks.validUntil), sql`${guardianLinks.validUntil} >= ${majority}`)))
          .returning({ id: guardianLinks.id });
        if (updated.length === 0) return 0;
        await writeAudit(tx, { eventType: "club_member.majority", subjectId: wardId, clubId, actorUserId: null, payload: { clubId, links: updated.length, majority } });
        await enqueue({ type: MAJORITY_NOTIFY_JOB_TYPE, payload: { kind: "done", clubId, clubMemberId: wardId, majority }, dedupeKey: majorityDoneKey(wardId, majority) }, tx);
        return updated.length;
      });
      if (changed > 0) result.transitioned += 1;
    } catch (err) {
      logger.error({ errName: (err as Error)?.name, clubId }, "[majority] could not end the guardian links of a member");
    }
  }
  if (result.noticed + result.transitioned > 0) logger.info(result, "[majority] processed");
  return result;
}

export async function handleMajoritySweep(_job: JobContext): Promise<void> {
  await runMajoritySweep();
}

/** Job handler `majority_notify` (payload: ids and dates only). */
export async function handleMajorityNotify(job: JobContext): Promise<void> {
  const p = job.payload as { kind?: unknown; clubId?: unknown; clubMemberId?: unknown; majority?: unknown };
  if (!["notice", "done"].includes(p.kind as string) || ![p.clubId, p.clubMemberId, p.majority].every((v) => typeof v === "string" && v)) return;
  const { clubId, clubMemberId, majority } = p as Record<"clubId" | "clubMemberId" | "majority", string>;
  const [row] = await db
    .select({ name: clubMembers.displayName, birthDate: clubMembers.birthDate, accountId: clubMembers.memberId, status: clubMembers.status })
    .from(clubMembers)
    .where(and(eq(clubMembers.id, clubMemberId), eq(clubMembers.clubId, clubId)));
  // Gone, left or the birth date was corrected meanwhile: nothing to announce.
  if (!row || row.birthDate === null || majorityDate(row.birthDate) !== majority || (LEFT_STATUSES as readonly string[]).includes(row.status)) return;
  const lang = await clubMailLanguage(db, clubId);
  const day = formatIsoDay(majority, lang);

  try {
    if (p.kind === "notice") {
      await notify({
        clubId,
        class: "optional",
        eventKey: "member.majority_ahead",
        refId: `${clubMemberId}#${majority}`,
        audience: { memberIds: [clubMemberId], includeGuardians: true },
        content: {
          title: tr(lang, `${row.name} wird bald volljährig`, `${row.name} turns 18 soon`),
          body: tr(
            lang,
            `${row.name} wird am ${day} volljährig. Ab diesem Tag endet die Verknüpfung der Erziehungsberechtigten automatisch: Sie sehen dann keine Daten des Mitglieds mehr, und das Mitglied entscheidet selbst, auch über bereits erteilte Einwilligungen.\n${row.accountId ? "Das Mitglied kann seine Einwilligungen in der App oder auf der Website bestätigen." : "Das Mitglied hat noch kein Konto: Bitte beim Verein ein Konto einrichten lassen, damit es selbst Zugriff hat."}`,
            `${row.name} turns 18 on ${day}. From that day the guardian link ends automatically: guardians no longer see the member's data and the member decides for themself, including on consents already given.\n${row.accountId ? "The member can confirm their consents in the app or on the website." : "The member has no account yet: please ask the club to set one up so they have access themself."}`,
          ),
          lang,
          category: "announcements",
          template: "reminder",
        },
        channels: ["in_app", "email"],
      });
      if (!row.accountId) {
        await notify({
          clubId,
          class: "optional",
          eventKey: "member.majority_ahead_board",
          refId: `${clubMemberId}#${majority}`,
          audience: { roleTypes: roleTypesWithPermission("members:write"), includeGuardians: false },
          content: {
            title: tr(lang, `Volljährig ohne Konto: ${row.name}`, `Turns 18 without an account: ${row.name}`),
            body: tr(
              lang,
              `${row.name} wird am ${day} volljährig und hat noch kein Konto. Bitte eine Einladung versenden (Mitgliederverwaltung, „Einladen“), sonst endet der Zugriff der Erziehungsberechtigten ohne Ersatz.`,
              `${row.name} turns 18 on ${day} and has no account yet. Please send an invitation (member management, “Invite”); otherwise the guardians' access ends without a replacement.`,
            ),
            lang,
            category: BOARD_CATEGORY,
            template: "reminder",
          },
          channels: ["in_app", "email"],
        });
      }
      return;
    }

    const views = await memberConsentViews(clubId, clubMemberId);
    const pending = views.filter((v) => v.confirmation.pending).length;
    await notify({
      clubId,
      class: "optional",
      eventKey: "member.majority_reached",
      refId: `${clubMemberId}#${majority}`,
      audience: { memberIds: [clubMemberId], includeGuardians: false },
      content: {
        title: tr(lang, "Du bist jetzt volljährig", "You are an adult now"),
        body: tr(
          lang,
          `Ab heute entscheidest du selbst. Die Verknüpfung deiner Erziehungsberechtigten ist beendet.${pending > 0 ? `\nBitte bestätige deine Einwilligungen (${pending}) innerhalb von ${MAJORITY_CONFIRM_DAYS} Tagen oder widerrufe sie. Alles ist freiwillig; ohne Antwort ändert sich für dich nichts.` : ""}`,
          `From today you decide for yourself. The link to your guardians has ended.${pending > 0 ? `\nPlease confirm your consents (${pending}) within ${MAJORITY_CONFIRM_DAYS} days or revoke them. Everything is voluntary; without an answer nothing changes for you.` : ""}`,
        ),
        lang,
        category: "announcements",
        template: "reminder",
      },
      channels: ["in_app", "email"],
    });
  } catch (err) {
    if (err instanceof AudienceLimitError) return;
    throw err;
  }
}
