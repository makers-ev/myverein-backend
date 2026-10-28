import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";

import { member as accountMember } from "../auth/auth-schema.js";

import { db } from "../db/client.js";
import { clubMemberDepartments, clubMembers, memberCategories, type ClubMemberRow } from "../db/schema/club-members.js";
import { documentAcknowledgements, type AckStatus } from "../db/schema/documents.js";
import { consentAgeLimitOf, isUnderConsentAge } from "./consent.js";
import type { DocumentPrincipal } from "./document-access.js";
import { ValidationError } from "./errors.js";
import { liveLinkOf } from "./guardian-scope.js";
import { COUNTED_STATUSES, effectiveStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Simple digital acknowledgements (Wave 13 B11). The structure follows the consent proof of Wave 10 (`consent_records`):
 * who gave it (`self` / `guardian` / `board_paper`), when, which text (the exact `wording` and the SHA-256 of the document
 * version), and for a paper proof the date and source. A child's acknowledgement is acted on by a guardian with a live link.
 * It is a SIMPLE electronic confirmation, not a qualified signature, and says so everywhere it is shown or printed.
 */

export const ACK_NOTICE =
  "Einfache elektronische Bestätigung: Sie dokumentiert, wer welche Fassung eines Dokuments wann bestätigt hat. Sie ist keine qualifizierte elektronische Signatur und ersetzt keine Erklärung, für die Schrift- oder Textform vorgeschrieben ist.";

export const MAX_AUDIENCE = 3000;

/** `abgelaufen` is not stored: an open request past its due date reads as expired (a new request renews it). */
export function derivedStatus(row: { status: string; dueAt: Date | null }, now: Date = new Date()): AckStatus {
  if (row.status === "offen" && row.dueAt !== null && row.dueAt.getTime() < now.getTime()) return "abgelaufen";
  return row.status as AckStatus;
}

/** SQL twin of `derivedStatus`, for filters and counts. */
export const derivedStatusSql = sql<string>`CASE WHEN ${documentAcknowledgements.status} = 'offen' AND ${documentAcknowledgements.dueAt} IS NOT NULL AND ${documentAcknowledgements.dueAt} < now() THEN 'abgelaufen' ELSE ${documentAcknowledgements.status} END`;

export interface Audience {
  all?: boolean | undefined;
  departmentIds?: string[] | undefined;
  categoryKeys?: string[] | undefined;
  clubMemberIds?: string[] | undefined;
}

/** Club members the request goes to (current members only; interessent and everybody who left are not asked). */
export async function resolveAudience(clubId: string, audience: Audience): Promise<string[]> {
  const selectors = [audience.all === true, (audience.departmentIds?.length ?? 0) > 0, (audience.categoryKeys?.length ?? 0) > 0, (audience.clubMemberIds?.length ?? 0) > 0];
  if (!selectors.some(Boolean)) throw new ValidationError("Name at least one recipient group", { details: { code: "audience_empty" } });
  const today = todayBerlin();
  const members = await db
    .select({ id: clubMembers.id, status: clubMembers.status, leftAt: clubMembers.leftAt, categoryKey: memberCategories.key })
    .from(clubMembers)
    .leftJoin(memberCategories, eq(memberCategories.id, clubMembers.categoryId))
    .leftJoin(accountMember, eq(accountMember.id, clubMembers.memberId))
    // External guests (guardians who are no members) are never asked; their wards are, through the guardian.
    .where(and(eq(clubMembers.clubId, clubId), or(isNull(accountMember.id), ne(accountMember.role, "guest"))));
  const current = new Map(members.filter((m) => (COUNTED_STATUSES as readonly string[]).includes(effectiveStatus(m, today))).map((m) => [m.id, m]));

  const picked = new Set<string>();
  if (audience.all) for (const id of current.keys()) picked.add(id);
  if (audience.categoryKeys?.length) {
    const keys = new Set(audience.categoryKeys);
    for (const m of current.values()) if (m.categoryKey && keys.has(m.categoryKey)) picked.add(m.id);
  }
  if (audience.departmentIds?.length) {
    const rows = await db
      .select({ id: clubMemberDepartments.clubMemberId })
      .from(clubMemberDepartments)
      .where(and(inArray(clubMemberDepartments.departmentId, audience.departmentIds), or(isNull(clubMemberDepartments.until), sql`${clubMemberDepartments.until} > ${today}`)));
    for (const r of rows) if (current.has(r.id)) picked.add(r.id);
  }
  if (audience.clubMemberIds?.length) {
    const wanted = [...new Set(audience.clubMemberIds)];
    const known = new Set(members.map((m) => m.id));
    if (wanted.some((id) => !known.has(id))) throw new ValidationError("Unknown member", { details: { field: "clubMemberIds" } });
    // A named person who left cannot be asked any more.
    for (const id of wanted) if (current.has(id)) picked.add(id);
  }
  if (picked.size === 0) throw new ValidationError("The recipient groups contain nobody", { details: { code: "audience_empty" } });
  if (picked.size > MAX_AUDIENCE) throw new ValidationError(`At most ${MAX_AUDIENCE} people per request`, { details: { code: "audience_too_large", count: picked.size } });
  return [...picked];
}

export interface ActingRelation {
  relation: "self" | "guardian";
  /** A minor with an account sees the request but cannot answer it: the guardian does. */
  canAnswer: boolean;
}

/** How the caller relates to the person an acknowledgement is about; `null` = a stranger (the caller gets a 404). */
export async function actingRelation(p: DocumentPrincipal, person: Pick<ClubMemberRow, "id" | "clubId" | "birthDate">): Promise<ActingRelation | null> {
  if (person.clubId !== p.clubId) return null;
  if (p.clubMemberId === person.id) {
    const limit = await consentAgeLimitOf(person.clubId, { minAge: null });
    return { relation: "self", canAnswer: !isUnderConsentAge(person.birthDate, limit) };
  }
  if (await liveLinkOf(p.accountMemberId, person.id)) return { relation: "guardian", canAnswer: true };
  return null;
}
