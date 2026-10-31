import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { wardEventResponses } from "../db/schema/absences.js";
import { eventAttendees, type EventAttendeeRow } from "../db/schema/event-attendees.js";
import { eventRegistrationSettings, type EventRegistrationSettingsRow } from "../db/schema/event-extras.js";
import { events, type EventRow } from "../db/schema/events.js";
import { forms, formSubmissions, formVersions, type FormRow, type FormVersionRow } from "../db/schema/forms.js";
import { writeAudit } from "./audit.js";
import type { DbExecutor } from "./club-members.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { fits, promoteWaitlist, takenSeats, type Promoted } from "./event-seats.js";
import { applicantCategories, applicantDefinition, invalidAnswers } from "./forms.js";
import { validateAnswers, type FormField } from "./form-schema.js";

/**
 * Registration for events (Wave 12 B13): who may register how, capacity with party sizes under the event lock, form answers
 * stored as a Wave 8 submission (purpose `veranstaltungsanmeldung`, the version pinned in the settings). Cost is display only.
 */

export const MAX_PARTY_SIZE = 20;

export type Identity = { kind: "account"; memberId: string } | { kind: "member"; clubMemberId: string };

export interface RegistrationSettings {
  enabled: boolean;
  formVersionId: string | null;
  deadlineAt: Date | null;
  allowGuests: boolean;
  maxCompanions: number;
  guestRetentionDays: number;
}

export const DEFAULT_SETTINGS: RegistrationSettings = { enabled: false, formVersionId: null, deadlineAt: null, allowGuests: false, maxCompanions: 0, guestRetentionDays: 30 };

export async function loadSettings(eventId: string, executor: DbExecutor = db): Promise<EventRegistrationSettingsRow | null> {
  const [row] = await executor.select().from(eventRegistrationSettings).where(eq(eventRegistrationSettings.eventId, eventId));
  return row ?? null;
}

export function effectiveSettings(row: EventRegistrationSettingsRow | null): RegistrationSettings {
  return row ? { enabled: row.enabled, formVersionId: row.formVersionId, deadlineAt: row.deadlineAt, allowGuests: row.allowGuests, maxCompanions: row.maxCompanions, guestRetentionDays: row.guestRetentionDays } : DEFAULT_SETTINGS;
}

/** Why a new registration is refused right now (null = open). */
export function closedReason(event: Pick<EventRow, "cancelledAt">, settings: RegistrationSettings, now = new Date()): "cancelled" | "deadline_passed" | null {
  if (event.cancelledAt !== null) return "cancelled";
  if (settings.enabled && settings.deadlineAt !== null && now.getTime() > settings.deadlineAt.getTime()) return "deadline_passed";
  return null;
}

/** Pinned form and version of the settings (null when none is chosen or the form was removed). */
export async function pinnedForm(formVersionId: string | null, executor: DbExecutor = db): Promise<{ form: FormRow; version: FormVersionRow } | null> {
  if (!formVersionId) return null;
  const [row] = await executor.select({ form: forms, version: formVersions }).from(formVersions).innerJoin(forms, eq(forms.id, formVersions.formId)).where(eq(formVersions.id, formVersionId));
  return row ?? null;
}

/** Checks party size and form answers against the settings; returns the cleaned answers. */
export async function checkInput(tx: DbExecutor, clubId: string, settings: RegistrationSettings, input: { partySize: number; answers: unknown }): Promise<{ answers: Record<string, unknown>; form: { form: FormRow; version: FormVersionRow } | null }> {
  if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > MAX_PARTY_SIZE) throw new ValidationError("partySize must be between 1 and " + MAX_PARTY_SIZE, { details: { code: "invalid_party_size" } });
  const allowed = settings.enabled ? 1 + settings.maxCompanions : 1;
  if (input.partySize > allowed) throw new ValidationError("Too many companions for this event", { details: { code: "companions_not_allowed", maxPartySize: allowed } });
  const form = settings.enabled ? await pinnedForm(settings.formVersionId, tx) : null;
  const provided = input.answers !== undefined && input.answers !== null && !(typeof input.answers === "object" && Object.keys(input.answers as object).length === 0);
  if (!form) {
    if (provided) throw new ValidationError("This event has no registration form", { details: { code: "no_form" } });
    return { answers: {}, form: null };
  }
  const categories = await applicantCategories(clubId, tx);
  const result = validateAnswers(form.version.fields as FormField[], input.answers ?? {}, { mode: "submit", categoryKeys: categories.map((c) => c.key) });
  if (!result.ok) throw invalidAnswers(result.errors);
  return { answers: result.answers, form };
}

/** Replaces the stored answers of a registration (new submission on the pinned version) and returns its id. */
export async function replaceSubmission(tx: DbExecutor, args: { clubId: string; form: { form: FormRow; version: FormVersionRow } | null; answers: Record<string, unknown>; previousId: string | null; submittedByUserId: string | null; subjectClubMemberId: string | null; onBehalfOf: "self" | "guardian" }): Promise<string | null> {
  // The attendee row references the submission (SET NULL), so dropping the old one first leaves no dangling pointer.
  if (args.previousId) await tx.delete(formSubmissions).where(eq(formSubmissions.id, args.previousId));
  if (!args.form) return null;
  const [created] = await tx
    .insert(formSubmissions)
    .values({
      formId: args.form.form.id,
      formVersionId: args.form.version.id,
      clubId: args.clubId,
      submittedByUserId: args.submittedByUserId,
      subjectClubMemberId: args.subjectClubMemberId,
      onBehalfOf: args.onBehalfOf,
      answers: args.answers,
      status: "submitted",
      submittedAt: new Date(),
    })
    .returning({ id: formSubmissions.id });
  return created!.id;
}

const identityFilter = (eventId: string, identity: Identity) =>
  identity.kind === "account" ? and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.memberId, identity.memberId)) : and(eq(eventAttendees.eventId, eventId), eq(eventAttendees.clubMemberId, identity.clubMemberId));

/** Locks the event row and returns it as it is NOW (capacity, cancellation). */
export async function lockEvent(tx: DbExecutor, eventId: string): Promise<EventRow> {
  const [row] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
  if (!row) throw new NotFoundError("Event not found");
  return row;
}

export interface SaveArgs {
  clubId: string;
  eventId: string;
  identity: Identity;
  partySize: number;
  answers: unknown;
  actorUserId: string;
  /** The account membership of the person who registered somebody else (guardian / board); null for own registrations. */
  registeredByMemberId: string | null;
  onBehalfOf: "self" | "guardian";
}

export interface SaveResult {
  status: "angemeldet" | "warteliste";
  partySize: number;
  attendeeId: string;
  promoted: Promoted[];
}

/**
 * Registers (or changes the registration of) one identity. All under the lock of the event row: the seats are counted with
 * `party_size`, a person who already holds a seat keeps it (a larger group that no longer fits is refused with 409 instead of
 * demoting them), someone who stays on the waitlist keeps their place. Seats freed by a smaller group move the waitlist up.
 */
export async function saveRegistration(args: SaveArgs): Promise<SaveResult> {
  return db.transaction(async (tx) => {
    const event = await lockEvent(tx, args.eventId);
    const settings = effectiveSettings(await loadSettings(event.id, tx));
    const reason = closedReason(event, settings);
    if (reason === "cancelled") throw new ConflictError("Event is cancelled");
    if (reason === "deadline_passed") throw new ConflictError("The registration deadline has passed", { details: { code: "registration_closed" } });

    const checked = await checkInput(tx, args.clubId, settings, { partySize: args.partySize, answers: args.answers });
    const [existing] = await tx.select().from(eventAttendees).where(identityFilter(event.id, args.identity));
    if (event.capacity !== null && args.partySize > event.capacity) throw new ValidationError("The group is larger than the capacity of the event", { details: { code: "party_too_large", capacity: event.capacity } });

    // A legacy answer of a guardian for a ward without account (Wave 10) moves into this registration.
    let legacyConfirmed = false;
    if (args.identity.kind === "member") {
      const removed = await tx.delete(wardEventResponses).where(and(eq(wardEventResponses.eventId, event.id), eq(wardEventResponses.wardClubMemberId, args.identity.clubMemberId))).returning();
      legacyConfirmed = removed[0]?.status === "angemeldet";
    }

    const taken = await takenSeats(tx, event.id, existing ? { attendeeId: existing.id } : {});
    const holdsSeat = existing?.status === "angemeldet" || legacyConfirmed;
    let status: "angemeldet" | "warteliste";
    if (fits(event.capacity, taken, args.partySize)) status = "angemeldet";
    else if (holdsSeat) throw new ConflictError("The larger group does not fit any more", { details: { code: "party_size_unavailable" } });
    else status = "warteliste";

    const submissionId = await replaceSubmission(tx, {
      clubId: args.clubId,
      form: checked.form,
      answers: checked.answers,
      previousId: existing?.formSubmissionId ?? null,
      submittedByUserId: args.actorUserId,
      subjectClubMemberId: args.identity.kind === "member" ? args.identity.clubMemberId : null,
      onBehalfOf: args.onBehalfOf,
    });

    let row: EventAttendeeRow;
    if (existing) {
      // Staying on the waitlist keeps the place in the queue; every other change is a new answer.
      const keepPlace = existing.status === status && status === "warteliste";
      [row] = await tx
        .update(eventAttendees)
        .set({ status, partySize: args.partySize, formSubmissionId: submissionId, registeredByMemberId: args.registeredByMemberId, ...(keepPlace ? {} : { respondedAt: new Date() }) })
        .where(eq(eventAttendees.id, existing.id))
        .returning();
    } else {
      [row] = await tx
        .insert(eventAttendees)
        .values({
          eventId: event.id,
          memberId: args.identity.kind === "account" ? args.identity.memberId : null,
          clubMemberId: args.identity.kind === "member" ? args.identity.clubMemberId : null,
          status,
          partySize: args.partySize,
          formSubmissionId: submissionId,
          registeredByMemberId: args.registeredByMemberId,
        })
        .returning();
    }

    // A smaller group (or the move of a legacy answer) can free seats for the ones waiting.
    const promoted = existing && (existing.partySize > args.partySize || existing.status !== "angemeldet") ? await promoteWaitlist(tx, event, args.clubId) : [];
    await writeAudit(tx, {
      eventType: "event_attendee.rsvp",
      subjectId: event.id,
      payload: { clubId: args.clubId, status, partySize: args.partySize, ...(args.identity.kind === "account" ? { memberId: args.identity.memberId } : { clubMemberId: args.identity.clubMemberId }), ...(args.registeredByMemberId ? { registeredBy: args.registeredByMemberId } : {}) },
    });
    return { status, partySize: args.partySize, attendeeId: row!.id, promoted };
  });
}

/** Removes a registration (answers included) and moves the waitlist up. Returns the promoted ones. */
export async function cancelRegistration(args: { clubId: string; eventId: string; identity: Identity }): Promise<Promoted[]> {
  return db.transaction(async (tx) => {
    const event = await lockEvent(tx, args.eventId);
    const [existing] = await tx.select().from(eventAttendees).where(identityFilter(event.id, args.identity));
    if (!existing) {
      // A legacy answer of a guardian (ward_event_responses) is removed the same way.
      if (args.identity.kind === "member") {
        const [legacy] = await tx.delete(wardEventResponses).where(and(eq(wardEventResponses.eventId, event.id), eq(wardEventResponses.wardClubMemberId, args.identity.clubMemberId))).returning();
        if (legacy) return legacy.status === "angemeldet" ? promoteWaitlist(tx, event, args.clubId) : [];
      }
      throw new NotFoundError("RSVP not found");
    }
    await tx.delete(eventAttendees).where(eq(eventAttendees.id, existing.id));
    if (existing.formSubmissionId) await tx.delete(formSubmissions).where(eq(formSubmissions.id, existing.formSubmissionId));
    await writeAudit(tx, {
      eventType: "event_attendee.cancel",
      subjectId: event.id,
      payload: { clubId: args.clubId, ...(args.identity.kind === "account" ? { memberId: args.identity.memberId } : { clubMemberId: args.identity.clubMemberId }) },
    });
    return existing.status === "angemeldet" ? promoteWaitlist(tx, event, args.clubId) : [];
  });
}

/** The own registration with its answers (for editing). */
export async function loadRegistration(eventId: string, identity: Identity): Promise<{ status: string; partySize: number; answers: Record<string, unknown>; respondedAt: Date } | null> {
  const [row] = await db.select().from(eventAttendees).where(identityFilter(eventId, identity));
  if (!row) return null;
  let answers: Record<string, unknown> = {};
  if (row.formSubmissionId) {
    const [sub] = await db.select({ answers: formSubmissions.answers }).from(formSubmissions).where(eq(formSubmissions.id, row.formSubmissionId));
    answers = (sub?.answers as Record<string, unknown>) ?? {};
  }
  return { status: row.status, partySize: row.partySize, answers, respondedAt: row.respondedAt };
}

/** What a member sees of the registration of an event: rules, form definition, whether it is open. */
export async function describeRegistration(clubId: string, event: EventRow) {
  const settings = effectiveSettings(await loadSettings(event.id));
  const pinned = settings.enabled ? await pinnedForm(settings.formVersionId) : null;
  const form = pinned ? applicantDefinition(pinned.form, pinned.version, await applicantCategories(clubId)) : null;
  const reason = closedReason(event, settings);
  return {
    enabled: settings.enabled,
    open: reason === null,
    closedReason: reason,
    deadlineAt: settings.deadlineAt,
    maxCompanions: settings.enabled ? settings.maxCompanions : 0,
    allowGuests: settings.enabled && settings.allowGuests,
    costNote: event.costNote,
    costCents: event.costCents,
    form,
  };
}

