import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers, clubMemberStatusHistory, memberCategories } from "../db/schema/club-members.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { roleTypesWithPermission } from "./club-permissions.js";
import { localDate, safeTimezone } from "./club-time.js";
import { enqueue } from "./jobs/queue.js";
import type { JobContext } from "./jobs/registry.js";
import { logger } from "./logger.js";
import { suggestCategory } from "./member-lifecycle.js";
import { REMINDER_JOB_TYPE, reminderDedupeKey, type ReminderPayload } from "./reminders.js";

/**
 * Age transition as a job (Wave 9 B13, formerly only suggested -- `GET /club-members/transition-suggestions`). The recurring
 * job `age_transition_sweep` (hourly) applies, for every club with `club_settings.age_transition_auto`, exactly the
 * transitions `suggestCategory` proposes (member older than the category's `max_age`, target category exists and is not
 * archived), on the club's calendar day. Each move is written to `club_member_status_history` with `changed_by = NULL`
 * (the actor "system") and the reason `Altersübergang (automatisch)`, plus one audit entry per club and run. The
 * leadership (`members:write` roles) gets a summary without names (counts per category move); it is enqueued in the same
 * transaction as the moves, so there is no summary without moves and no moves without a summary. A second run finds
 * nothing to do (idempotent).
 */

export const AGE_TRANSITION_JOB_TYPE = "age_transition_sweep";
export const AGE_TRANSITION_INTERVAL_MS = 60 * 60 * 1000;
export const AGE_TRANSITION_REASON = "Altersübergang (automatisch)";

export interface AgeTransitionResult {
  clubs: number;
  moved: number;
}

/** Applies the pending age transitions of one club. Returns the number of moved members. */
export async function applyAgeTransitionsForClub(clubId: string, today: string): Promise<number> {
  return db.transaction(async (tx) => {
    // Lock order as in the apply route: categories (share, id order) first, then the member rows (id order).
    const categories = await tx.select().from(memberCategories).where(eq(memberCategories.clubId, clubId)).orderBy(asc(memberCategories.id)).for("share");
    const byId = new Map(categories.map((c) => [c.id, c]));
    const byKey = new Map(categories.map((c) => [c.key, c]));
    const sourceIds = categories.filter((c) => c.autoTransitionToKey && c.maxAge !== null && !c.archivedAt).map((c) => c.id);
    if (sourceIds.length === 0) return 0;
    const rows = await tx
      .select()
      .from(clubMembers)
      .where(and(eq(clubMembers.clubId, clubId), inArray(clubMembers.categoryId, sourceIds), isNotNull(clubMembers.birthDate)))
      .orderBy(asc(clubMembers.id))
      .for("update");

    const moves: Array<{ id: string; fromId: string; toId: string }> = [];
    for (const row of rows) {
      const s = suggestCategory(row, byId, byKey, today);
      if (!s) continue;
      await tx.update(clubMembers).set({ categoryId: s.to.id, updatedAt: new Date() }).where(eq(clubMembers.id, row.id));
      await tx.insert(clubMemberStatusHistory).values({
        clubMemberId: row.id,
        fromStatus: row.status,
        toStatus: row.status,
        fromCategoryId: s.from.id,
        toCategoryId: s.to.id,
        effectiveOn: today,
        reason: AGE_TRANSITION_REASON,
        changedBy: null,
      });
      moves.push({ id: row.id, fromId: s.from.id, toId: s.to.id });
    }
    if (moves.length === 0) return 0;

    await tx.insert(auditLog).values({ eventType: "club_member.age_transition", subjectId: clubId, payload: { clubId, count: moves.length, memberIds: moves.map((m) => m.id), changedBy: "system", automatic: true } });

    const counts = new Map<string, number>();
    for (const m of moves) counts.set(`${m.fromId}>${m.toId}`, (counts.get(`${m.fromId}>${m.toId}`) ?? 0) + 1);
    const lines = [...counts].map(([k, n]) => {
      const [from, to] = k.split(">") as [string, string];
      return `• ${n} ${n === 1 ? "Mitglied" : "Mitglieder"}: ${byId.get(from)?.name ?? "?"} → ${byId.get(to)?.name ?? "?"}`;
    });
    const payload: ReminderPayload = {
      clubId,
      kind: "age_transition",
      refId: clubId,
      date: today,
      title: moves.length === 1 ? "Altersübergang: 1 Mitglied verschoben" : `Altersübergang: ${moves.length} Mitglieder verschoben`,
      body: `Wegen des Alters wurden automatisch neue Kategorien zugewiesen:\n${lines.join("\n")}\nDie Änderungen stehen im Verlauf der Mitglieder (Urheber: System).`,
      audience: { roleTypes: roleTypesWithPermission("members:write"), includeGuardians: false },
    };
    // One summary per run: the first moved member makes the key unique (a member moves once per category).
    await enqueue({ type: REMINDER_JOB_TYPE, payload, dedupeKey: reminderDedupeKey("age_transition", clubId, `${today}:${moves[0]!.id}`) }, tx);
    return moves.length;
  });
}

/** Sweeps all clubs with the switch on. One failing club does not stop the others. */
export async function runAgeTransitionSweep(now: Date = new Date(), scope: { clubId?: string } = {}): Promise<AgeTransitionResult> {
  const clubs = await db
    .select({ id: organization.id, timezone: clubSettings.timezone })
    .from(clubSettings)
    .innerJoin(organization, eq(organization.id, clubSettings.clubId))
    .where(and(eq(clubSettings.ageTransitionAuto, true), scope.clubId ? eq(clubSettings.clubId, scope.clubId) : undefined));
  const result: AgeTransitionResult = { clubs: 0, moved: 0 };
  for (const club of clubs) {
    try {
      const moved = await applyAgeTransitionsForClub(club.id, localDate(now, safeTimezone(club.timezone)));
      result.clubs += 1;
      result.moved += moved;
    } catch (err) {
      logger.error({ clubId: club.id, errName: (err as Error)?.name, errCode: (err as { code?: unknown })?.code }, "[age-transition] club sweep failed");
    }
  }
  if (result.moved > 0) logger.info(result, "[age-transition] applied age transitions");
  return result;
}

export async function handleAgeTransitionSweep(_job: JobContext): Promise<void> {
  await runAgeTransitionSweep();
}
