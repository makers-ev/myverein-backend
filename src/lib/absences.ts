import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";

import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { absenceReports, ABSENCE_KINDS, type AbsenceReportRow } from "../db/schema/absences.js";
import { clubMemberDepartments, clubMembers, type ClubMemberRow } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { writeAudit } from "./audit.js";
import { isUuid } from "./club-members.js";
import { clubMailLanguage } from "./club-settings.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { logger } from "./logger.js";
import { todayBerlin } from "./member-lifecycle.js";
import { notifySafely } from "./notify/dispatcher.js";
import { formatIsoDay, tr } from "./notify/i18n.js";

/**
 * Absence / sick notes (Wave 10 B5). Data minimisation by design: kind + period + an optional SHORT note, NO diagnosis field
 * (clients show a "no diagnoses" warning). The trainers of the member's departments are told through `notify()`; neither the
 * note nor the kind ever appears in a push, mail or in-app text (health data, Art. 9 GDPR) -- the texts are the same neutral
 * "absence report" for `krank` and `abwesend`.
 *
 * Who reads: `absences:read` (vorsitz, stellv_vorsitz for the whole club; trainer/abteilungsleitung only for the members of
 * their OWN departments), the member themself and the live guardians of a ward. Rights to write: the member themself, a
 * guardian with `can_report_absence`.
 */

export { ABSENCE_KINDS };
export type AbsenceKind = (typeof ABSENCE_KINDS)[number];

/** How far back a report may start (retroactive "was sick yesterday") and ahead it may reach. */
export const ABSENCE_BACKDATE_DAYS = 14;
export const ABSENCE_MAX_DAYS = 365;

const DAY_MS = 86_400_000;
const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
export const addDays = (iso: string, days: number) => new Date((dayNumber(iso) + days) * DAY_MS).toISOString().slice(0, 10);

/** Period rules: from <= to, not older than the backdate window, not longer than a year. */
export function assertAbsencePeriod(startsOn: string, endsOn: string, today = todayBerlin()): void {
  if (endsOn < startsOn) throw new ValidationError("`endsOn` must not be before `startsOn`", { details: { code: "invalid_period" } });
  if (startsOn < addDays(today, -ABSENCE_BACKDATE_DAYS)) throw new ValidationError(`An absence may start at most ${ABSENCE_BACKDATE_DAYS} days in the past`, { details: { code: "period_too_old" } });
  if (dayNumber(endsOn) - dayNumber(startsOn) >= ABSENCE_MAX_DAYS) throw new ValidationError(`An absence covers at most ${ABSENCE_MAX_DAYS} days`, { details: { code: "period_too_long" } });
}

export function shapeAbsence(a: AbsenceReportRow) {
  return { id: a.id, clubMemberId: a.clubMemberId, kind: a.kind, startsOn: a.startsOn, endsOn: a.endsOn, note: a.note, reportedByKind: a.reportedByKind, withdrawnAt: a.withdrawnAt, createdAt: a.createdAt, updatedAt: a.updatedAt };
}

export interface AbsenceInput {
  kind: AbsenceKind;
  startsOn: string;
  endsOn: string;
  note?: string | null | undefined;
}

export async function createAbsence(clubId: string, subject: ClubMemberRow, input: AbsenceInput, by: { userId: string; kind: "self" | "guardian" }): Promise<AbsenceReportRow> {
  assertAbsencePeriod(input.startsOn, input.endsOn);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(absenceReports)
      .values({ clubId, clubMemberId: subject.id, kind: input.kind, startsOn: input.startsOn, endsOn: input.endsOn, note: input.note ?? null, reportedByUserId: by.userId, reportedByKind: by.kind })
      .returning();
    await writeAudit(tx, { eventType: "absence.create", subjectId: created!.id, payload: { clubId, absenceId: created!.id, clubMemberId: subject.id, kind: input.kind, reportedByKind: by.kind } });
    return created!;
  });
  await notifyAbsence("reported", clubId, subject, row, by.userId);
  return row;
}

export async function updateAbsence(clubId: string, subject: ClubMemberRow, absenceId: string, patch: Partial<AbsenceInput>, byUserId: string): Promise<AbsenceReportRow> {
  if (!isUuid(absenceId)) throw new NotFoundError("Absence not found");
  const row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(absenceReports).where(and(eq(absenceReports.id, absenceId), eq(absenceReports.clubId, clubId), eq(absenceReports.clubMemberId, subject.id))).for("update");
    if (!current) throw new NotFoundError("Absence not found");
    if (current.withdrawnAt !== null) throw new ConflictError("The absence was withdrawn", { details: { code: "absence_withdrawn" } });
    const next = { kind: patch.kind ?? (current.kind as AbsenceKind), startsOn: patch.startsOn ?? current.startsOn, endsOn: patch.endsOn ?? current.endsOn, note: patch.note === undefined ? current.note : patch.note };
    // The backdate window only applies to a changed start; an existing report may be shortened or extended later on.
    if (patch.startsOn !== undefined) assertAbsencePeriod(next.startsOn, next.endsOn);
    else if (next.endsOn < next.startsOn) throw new ValidationError("`endsOn` must not be before `startsOn`", { details: { code: "invalid_period" } });
    else if (dayNumber(next.endsOn) - dayNumber(next.startsOn) >= ABSENCE_MAX_DAYS) throw new ValidationError(`An absence covers at most ${ABSENCE_MAX_DAYS} days`, { details: { code: "period_too_long" } });
    const [saved] = await tx.update(absenceReports).set({ ...next, updatedAt: new Date() }).where(eq(absenceReports.id, current.id)).returning();
    await writeAudit(tx, { eventType: "absence.update", subjectId: current.id, payload: { clubId, absenceId: current.id, clubMemberId: subject.id, changedFields: Object.keys(patch) } });
    return saved!;
  });
  await notifyAbsence("changed", clubId, subject, row, byUserId);
  return row;
}

/** Withdraws ("zurückziehen") an absence; repeating is harmless. */
export async function withdrawAbsence(clubId: string, subject: ClubMemberRow, absenceId: string, byUserId: string): Promise<void> {
  if (!isUuid(absenceId)) throw new NotFoundError("Absence not found");
  const row = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(absenceReports).where(and(eq(absenceReports.id, absenceId), eq(absenceReports.clubId, clubId), eq(absenceReports.clubMemberId, subject.id))).for("update");
    if (!current) throw new NotFoundError("Absence not found");
    if (current.withdrawnAt !== null) return null;
    const [saved] = await tx.update(absenceReports).set({ withdrawnAt: new Date(), updatedAt: new Date() }).where(eq(absenceReports.id, current.id)).returning();
    await writeAudit(tx, { eventType: "absence.withdraw", subjectId: current.id, payload: { clubId, absenceId: current.id, clubMemberId: subject.id } });
    return saved!;
  });
  if (row) await notifyAbsence("withdrawn", clubId, subject, row, byUserId);
}

/** Own / ward list: newest period first; withdrawn entries only on request. */
export async function listAbsencesOf(clubId: string, clubMemberId: string, opts: { includeWithdrawn?: boolean; from?: string } = {}): Promise<AbsenceReportRow[]> {
  return db
    .select()
    .from(absenceReports)
    .where(and(eq(absenceReports.clubId, clubId), eq(absenceReports.clubMemberId, clubMemberId), opts.includeWithdrawn ? undefined : isNull(absenceReports.withdrawnAt), opts.from ? gte(absenceReports.endsOn, opts.from) : undefined))
    .orderBy(desc(absenceReports.startsOn), asc(absenceReports.id))
    .limit(200);
}

/** Department ids (open assignments) of a club member. */
export async function departmentIdsOf(clubMemberId: string, today = todayBerlin()): Promise<string[]> {
  const rows = await db
    .select({ id: clubMemberDepartments.departmentId })
    .from(clubMemberDepartments)
    .where(and(eq(clubMemberDepartments.clubMemberId, clubMemberId), or(isNull(clubMemberDepartments.until), gte(clubMemberDepartments.until, today))));
  return rows.map((r) => r.id);
}

/**
 * Whose absences the caller may read with `absences:read`: `all` for the board (vorsitz, stellv_vorsitz), else the members of
 * the departments the caller leads or trains (department-bound `trainer` / `abteilungsleitung` roles).
 */
export async function absenceScopeOf(roleTypes: readonly string[], accountMemberId: string): Promise<{ all: boolean; departmentIds: string[] }> {
  if (roleTypes.includes("vorsitz") || roleTypes.includes("stellv_vorsitz")) return { all: true, departmentIds: [] };
  const rows = await db
    .select({ departmentId: clubRoles.departmentId })
    .from(clubRoles)
    .where(and(eq(clubRoles.memberId, accountMemberId), inArray(clubRoles.roleType, ["trainer", "abteilungsleitung"])));
  return { all: false, departmentIds: [...new Set(rows.map((r) => r.departmentId).filter((v): v is string => v !== null))] };
}

export interface ClubAbsenceFilter {
  from: string;
  to: string;
  departmentId?: string | undefined;
}

/** Absences overlapping [from, to] of the members in scope (newest first); withdrawn ones are excluded. */
export async function listAbsencesInScope(clubId: string, scope: { all: boolean; departmentIds: string[] }, filter: ClubAbsenceFilter) {
  if (!scope.all && scope.departmentIds.length === 0) return [];
  const today = todayBerlin();
  let departmentIds = scope.all ? (filter.departmentId ? [filter.departmentId] : null) : scope.departmentIds;
  if (!scope.all && filter.departmentId) departmentIds = scope.departmentIds.includes(filter.departmentId) ? [filter.departmentId] : [];
  if (departmentIds !== null && departmentIds.length === 0) return [];
  const inDepartment =
    departmentIds === null
      ? undefined
      : sql`exists (select 1 from ${clubMemberDepartments} where ${clubMemberDepartments.clubMemberId} = ${absenceReports.clubMemberId} and ${inArray(clubMemberDepartments.departmentId, departmentIds)} and (${clubMemberDepartments.until} is null or ${clubMemberDepartments.until} >= ${today}))`;
  return db
    .select({ absence: absenceReports, displayName: clubMembers.displayName })
    .from(absenceReports)
    .innerJoin(clubMembers, eq(clubMembers.id, absenceReports.clubMemberId))
    .where(and(eq(absenceReports.clubId, clubId), isNull(absenceReports.withdrawnAt), lte(absenceReports.startsOn, filter.to), gte(absenceReports.endsOn, filter.from), inDepartment))
    .orderBy(desc(absenceReports.startsOn), asc(clubMembers.displayName), asc(absenceReports.id))
    .limit(500);
}

/**
 * Trainers / department leads of the member's departments, as notification recipients (accounts only). Deliberately nobody
 * for a member without a department: the board reads the reports in the overview instead of getting a push.
 */
async function trainerRecipients(clubId: string, subject: ClubMemberRow, excludeUserId: string) {
  const departments = await departmentIdsOf(subject.id);
  if (departments.length === 0) return [];
  const rows = await db
    .selectDistinct({ userId: member.userId, clubMemberId: clubMembers.id, name: clubMembers.displayName })
    .from(clubRoles)
    .innerJoin(member, eq(member.id, clubRoles.memberId))
    .leftJoin(clubMembers, eq(clubMembers.memberId, member.id))
    .where(and(inArray(clubRoles.roleType, ["trainer", "abteilungsleitung"]), inArray(clubRoles.departmentId, departments), eq(member.organizationId, clubId)));
  return rows.filter((r) => r.userId !== excludeUserId && r.clubMemberId !== subject.id).map((r) => ({ userId: r.userId, clubMemberId: r.clubMemberId, name: r.name }));
}

/**
 * Tells the trainers of the member's departments (notification catalog, `absence.reported|changed|withdrawn`). Best effort
 * after the commit. The text names the person and the period only: no kind, no note, no word like "sick".
 */
async function notifyAbsence(kind: "reported" | "changed" | "withdrawn", clubId: string, subject: ClubMemberRow, row: AbsenceReportRow, actorUserId: string): Promise<void> {
  try {
    const recipients = await trainerRecipients(clubId, subject, actorUserId);
    if (recipients.length === 0) return;
    const lang = await clubMailLanguage(db, clubId);
    const name = subject.displayName;
    const period = row.startsOn === row.endsOn ? formatIsoDay(row.startsOn, lang) : `${formatIsoDay(row.startsOn, lang)} - ${formatIsoDay(row.endsOn, lang)}`;
    const title = {
      reported: tr(lang, "Neue Abwesenheitsmeldung", "New absence report"),
      changed: tr(lang, "Abwesenheitsmeldung geändert", "Absence report changed"),
      withdrawn: tr(lang, "Abwesenheitsmeldung zurückgezogen", "Absence report withdrawn"),
    }[kind];
    const body = {
      reported: tr(lang, `${name} hat sich für ${period} abgemeldet.`, `${name} reported an absence for ${period}.`),
      changed: tr(lang, `Die Abmeldung von ${name} gilt jetzt für ${period}.`, `The absence report of ${name} now covers ${period}.`),
      withdrawn: tr(lang, `${name} hat die Abmeldung für ${period} zurückgezogen.`, `${name} withdrew the absence report for ${period}.`),
    }[kind];
    await notifySafely({
      clubId,
      class: "optional",
      eventKey: `absence.${kind}`,
      // A change is a new message (new stamp), a withdrawal and the first report happen once per absence.
      refId: kind === "changed" ? `${row.id}#${row.updatedAt.getTime()}` : row.id,
      recipients,
      content: { title, body, template: "notice", category: "events", lang },
      channels: ["in_app", "push"],
    });
  } catch (err) {
    logger.error({ err, absenceId: row.id }, "[absence] could not notify the trainers");
  }
}
