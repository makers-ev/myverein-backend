import { and, asc, eq, ne, sql } from "drizzle-orm";

import { wardEventResponses } from "../db/schema/absences.js";
import { eventAttendees } from "../db/schema/event-attendees.js";
import { writeAudit } from "./audit.js";
import type { DbExecutor } from "./club-members.js";

/**
 * Seats of an event (Wave 12 B13). A registration takes `party_size` seats (the person plus companions); guardians' answers for
 * wards without account (`ward_event_responses`, one seat each) count like registrations. Only `angemeldet` takes seats; the
 * waitlist is `warteliste` (guests become `warteliste`/`angemeldet` when they confirm their e-mail, an unconfirmed guest is
 * `unbestaetigt` and holds no seat). Every function must run in a transaction that holds the lock on the event row.
 */

export interface WaitingEntry {
  kind: "attendee" | "ward";
  id: string;
  size: number;
  respondedAt: Date;
  memberId?: string | null;
  clubMemberId?: string | null;
}

/** Seats taken by confirmed registrations and ward answers, optionally without one of them (a re-registration). */
export async function takenSeats(tx: DbExecutor, eventId: string, exclude: { attendeeId?: string; wardClubMemberId?: string } = {}): Promise<number> {
  const [accounts] = await tx
    .select({ n: sql<number>`coalesce(sum(${eventAttendees.partySize}), 0)::int` })
    .from(eventAttendees)
    .where(and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.status, "angemeldet"), exclude.attendeeId ? ne(eventAttendees.id, exclude.attendeeId) : undefined));
  const [wards] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(wardEventResponses)
    .where(and(eq(wardEventResponses.eventId, eventId), eq(wardEventResponses.status, "angemeldet"), exclude.wardClubMemberId ? ne(wardEventResponses.wardClubMemberId, exclude.wardClubMemberId) : undefined));
  return (accounts?.n ?? 0) + (wards?.n ?? 0);
}

/** Everybody waiting, oldest answer first (FIFO). */
export async function waitingEntries(tx: DbExecutor, eventId: string): Promise<WaitingEntry[]> {
  const attendees = await tx
    .select({ id: eventAttendees.id, size: eventAttendees.partySize, respondedAt: eventAttendees.respondedAt, memberId: eventAttendees.memberId, clubMemberId: eventAttendees.clubMemberId })
    .from(eventAttendees)
    .where(and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.status, "warteliste")))
    .orderBy(asc(eventAttendees.respondedAt), asc(eventAttendees.id));
  const wards = await tx
    .select({ id: wardEventResponses.id, respondedAt: wardEventResponses.respondedAt, clubMemberId: wardEventResponses.wardClubMemberId })
    .from(wardEventResponses)
    .where(and(eq(wardEventResponses.eventId, eventId), eq(wardEventResponses.status, "warteliste")))
    .orderBy(asc(wardEventResponses.respondedAt), asc(wardEventResponses.id));
  return [...attendees.map((a): WaitingEntry => ({ kind: "attendee", ...a })), ...wards.map((w): WaitingEntry => ({ kind: "ward", id: w.id, size: 1, respondedAt: w.respondedAt, clubMemberId: w.clubMemberId }))].sort(
    (a, b) => a.respondedAt.getTime() - b.respondedAt.getTime() || a.id.localeCompare(b.id),
  );
}

export interface Promoted {
  kind: "attendee" | "ward";
  /** `event_attendees.id` or `ward_event_responses.id`. */
  id: string;
  respondedAt: Date;
}

/**
 * Fills free seats from the waitlist: strictly FIFO, but a group that does not fit does not block the ones behind it (the first
 * entry that fits moves up; larger groups stay on the list -- ADR-009). `capacity === null` means unlimited: everybody moves up.
 */
export async function promoteWaitlist(tx: DbExecutor, event: { id: string; capacity: number | null }, clubId?: string): Promise<Promoted[]> {
  const waiting = await waitingEntries(tx, event.id);
  if (waiting.length === 0) return [];
  let free = event.capacity === null ? Number.POSITIVE_INFINITY : event.capacity - (await takenSeats(tx, event.id));
  const promoted: Promoted[] = [];
  for (const entry of waiting) {
    if (free <= 0) break;
    if (entry.size > free) continue;
    if (entry.kind === "attendee") await tx.update(eventAttendees).set({ status: "angemeldet" }).where(eq(eventAttendees.id, entry.id));
    else await tx.update(wardEventResponses).set({ status: "angemeldet" }).where(eq(wardEventResponses.id, entry.id));
    free -= entry.size;
    if (clubId) await writeAudit(tx, { eventType: "event_attendee.promote", subjectId: event.id, payload: { clubId, ...(entry.memberId ? { memberId: entry.memberId } : {}), ...(entry.clubMemberId ? { clubMemberId: entry.clubMemberId } : {}) } });
    promoted.push({ kind: entry.kind, id: entry.id, respondedAt: entry.respondedAt });
  }
  return promoted;
}

/** Whether `size` seats fit next to the confirmed ones (capacity `null` = unlimited). */
export function fits(capacity: number | null, taken: number, size: number): boolean {
  return capacity === null || taken + size <= capacity;
}
