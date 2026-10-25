import { asc, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { formSubmissions, formVersions } from "../db/schema/forms.js";
import type { FormField } from "./form-schema.js";

/** Participant list of an event (Wave 12 B15): registrations of accounts, members without account and guests, with form answers. */

export interface ParticipantField {
  key: string;
  label: string;
  type: string;
  sensitive: boolean;
}

export interface Participant {
  id: string;
  kind: "account" | "member" | "guest";
  clubMemberId: string | null;
  displayName: string;
  /** Only guests: the address they registered with (the board needs it to reach them). */
  email: string | null;
  status: string;
  partySize: number;
  respondedAt: Date;
  /** Guests: the e-mail address was confirmed. */
  confirmed: boolean;
  registeredBy: string | null;
  answers: Record<string, unknown>;
}

/**
 * All registrations of an event, oldest first. Sensitive answers (fields marked `sensitive` in the form version the person
 * filled in) are only included with `includeSensitive`; `hasSensitive` tells whether any exist, so the caller can audit the read.
 */
export async function loadParticipants(eventId: string, includeSensitive: boolean): Promise<{ participants: Participant[]; fields: ParticipantField[]; hasSensitive: boolean }> {
  const rows = await db.select().from(eventAttendees).where(eq(eventAttendees.eventId, eventId)).orderBy(asc(eventAttendees.respondedAt), asc(eventAttendees.id));
  const accountIds = rows.flatMap((r) => (r.memberId ? [r.memberId] : []));
  const memberIds = rows.flatMap((r) => (r.clubMemberId ? [r.clubMemberId] : []));
  const byAccount = accountIds.length ? await db.select({ memberId: clubMembers.memberId, id: clubMembers.id, name: clubMembers.displayName }).from(clubMembers).where(inArray(clubMembers.memberId, accountIds)) : [];
  const byMember = memberIds.length ? await db.select({ id: clubMembers.id, name: clubMembers.displayName }).from(clubMembers).where(inArray(clubMembers.id, memberIds)) : [];
  const registrarIds = rows.flatMap((r) => (r.registeredByMemberId ? [r.registeredByMemberId] : []));
  const registrars = registrarIds.length ? await db.select({ memberId: clubMembers.memberId, name: clubMembers.displayName }).from(clubMembers).where(inArray(clubMembers.memberId, registrarIds)) : [];

  const submissionIds = rows.flatMap((r) => (r.formSubmissionId ? [r.formSubmissionId] : []));
  const submissions = submissionIds.length
    ? await db.select({ id: formSubmissions.id, answers: formSubmissions.answers, fields: formVersions.fields }).from(formSubmissions).innerJoin(formVersions, eq(formVersions.id, formSubmissions.formVersionId)).where(inArray(formSubmissions.id, submissionIds))
    : [];
  const subById = new Map(submissions.map((s) => [s.id, s]));

  const fields = new Map<string, ParticipantField>();
  let hasSensitive = false;
  const participants = rows.map((r): Participant => {
    const sub = r.formSubmissionId ? subById.get(r.formSubmissionId) : undefined;
    const answers: Record<string, unknown> = {};
    if (sub) {
      const defs = new Map((sub.fields as FormField[]).map((f) => [f.key, f]));
      for (const [key, value] of Object.entries(sub.answers as Record<string, unknown>)) {
        const def = defs.get(key);
        const sensitive = def?.sensitive === true;
        if (!fields.has(key)) fields.set(key, { key, label: def?.label ?? key, type: def?.type ?? "text", sensitive });
        if (sensitive) {
          hasSensitive = true;
          if (!includeSensitive) continue;
        }
        answers[key] = value;
      }
    }
    const account = r.memberId ? byAccount.find((m) => m.memberId === r.memberId) : undefined;
    const ward = r.clubMemberId ? byMember.find((m) => m.id === r.clubMemberId) : undefined;
    return {
      id: r.id,
      kind: r.memberId ? "account" : r.clubMemberId ? "member" : "guest",
      clubMemberId: account?.id ?? r.clubMemberId,
      displayName: account?.name ?? ward?.name ?? r.guestName ?? "",
      email: r.guestEmail,
      status: r.status,
      partySize: r.partySize,
      respondedAt: r.respondedAt,
      confirmed: r.guestEmail ? r.guestConfirmedAt !== null : true,
      registeredBy: r.registeredByMemberId ? (registrars.find((m) => m.memberId === r.registeredByMemberId)?.name ?? null) : null,
      answers,
    };
  });
  // Sensitive columns the caller may not see are not announced either.
  const visibleFields = [...fields.values()].filter((f) => includeSensitive || !f.sensitive);
  return { participants, fields: visibleFields, hasSensitive };
}

/** One answer as a cell: booleans as Ja/Nein, lists joined, everything else as text. */
export function answerCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "Ja" : "Nein";
  if (Array.isArray(value)) return value.map((v) => answerCell(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
