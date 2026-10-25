import { createHash, randomBytes } from "node:crypto";

import { and, count, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { eventAttendees, type EventAttendeeRow } from "../db/schema/event-attendees.js";
import { events, type EventRow } from "../db/schema/events.js";
import { calendars } from "../db/schema/calendars.js";
import { formSubmissions } from "../db/schema/forms.js";
import { writeAudit } from "./audit.js";
import { SITE_URL } from "./emailTemplate.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { clubTimezone, formatWhen, locationName } from "./event-notify.js";
import { checkInput, closedReason, effectiveSettings, loadSettings, lockEvent, replaceSubmission } from "./event-registration.js";
import { fits, promoteWaitlist, takenSeats, type Promoted } from "./event-seats.js";
import { clubMailLanguage } from "./club-settings.js";
import { notifySafely } from "./notify/dispatcher.js";
import { isMailLanguage, tr, type MailLanguage } from "./notify/i18n.js";

/**
 * Registration of guests without account (Wave 12 B14). A guest is an `event_attendees` row with `guest_email` as its identity.
 * Flow: register (row `unbestaetigt`, holds no seat, expires after 48 h) -> confirm the e-mail address (double opt-in: the row
 * becomes `angemeldet` or `warteliste` under the event lock) -> manage / cancel with the management link. Only SHA-256 hashes of
 * the three secrets are stored (public event link on `events`, confirmation code and management token on the row); the plain
 * values live in the mails and in the responses of the one request that creates them.
 */

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newToken = (): string => randomBytes(32).toString("base64url");
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** An unconfirmed registration is dropped after this long. */
export const UNCONFIRMED_TTL_MS = 48 * 3_600_000;
/** At most this many unconfirmed rows per event (a flood of fake addresses must not fill the table). */
export const MAX_PENDING_PER_EVENT = 300;

export const publicEventUrl = (token: string): string => `${SITE_URL.replace(/\/+$/, "")}/anmeldung/${token}`;
const confirmUrl = (code: string): string => `${SITE_URL.replace(/\/+$/, "")}/anmeldung/bestaetigen/${code}`;
const manageUrl = (token: string): string => `${SITE_URL.replace(/\/+$/, "")}/anmeldung/verwalten/${token}`;

/** The event behind a public link, or null (unknown, revoked or malformed). */
export async function eventByPublicToken(token: string): Promise<{ event: EventRow; clubId: string } | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select({ event: events, clubId: calendars.clubId })
    .from(events)
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(eq(events.publicRegistrationTokenHash, hashToken(token)));
  return row ?? null;
}

async function languageFor(clubId: string, requested: unknown): Promise<MailLanguage> {
  return isMailLanguage(requested) ? requested : await clubMailLanguage(db, clubId);
}

/** End of retention for a confirmed guest: the end of the event (or now) plus the days chosen for the event. */
function deleteAfterFor(event: Pick<EventRow, "startsAt" | "endsAt">, retentionDays: number, now = new Date()): Date {
  const over = Math.max((event.endsAt ?? event.startsAt).getTime(), now.getTime());
  return new Date(over + retentionDays * 86_400_000);
}

async function eventFacts(clubId: string, event: EventRow, lang: MailLanguage): Promise<string> {
  const when = formatWhen(event.startsAt, await clubTimezone(clubId), event.endsAt, lang);
  const place = await locationName(clubId, event.locationId);
  return `${tr(lang, "Wann", "When")}: ${when}${place ? `\n${tr(lang, "Ort", "Location")}: ${place}` : ""}`;
}

async function clubName(clubId: string): Promise<string> {
  const [row] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
  return row?.name ?? "";
}

async function sendGuestMail(args: { clubId: string; row: Pick<EventAttendeeRow, "id" | "guestEmail" | "guestName">; kind: "confirm" | "registered"; lang: MailLanguage; event: EventRow; status?: string; link: string; stamp: string }): Promise<void> {
  const { clubId, row, kind, lang, event } = args;
  if (!row.guestEmail) return;
  const club = await clubName(clubId);
  const facts = await eventFacts(clubId, event, lang);
  const content =
    kind === "confirm"
      ? {
          title: `${tr(lang, "Bitte bestätige deine Anmeldung", "Please confirm your registration")}: ${event.title}`,
          body: `${tr(lang, `Du hast dich für „${event.title}“ (${club}) angemeldet. Deine Anmeldung gilt erst, wenn du deine E-Mail-Adresse bestätigst. Der Link ist 48 Stunden gültig.`, `You registered for “${event.title}” (${club}). Your registration only counts once you confirm your e-mail address. The link is valid for 48 hours.`)}\n${facts}\n${tr(lang, "Wenn du dich nicht angemeldet hast, ignoriere diese Nachricht: es wird nichts gespeichert, was darüber hinausgeht.", "If you did not register, ignore this message: nothing beyond this is kept.")}`,
          ctaLabel: tr(lang, "Anmeldung bestätigen", "Confirm registration"),
        }
      : {
          title: `${args.status === "warteliste" ? tr(lang, "Du stehst auf der Warteliste", "You are on the waitlist") : tr(lang, "Du bist angemeldet", "You are registered")}: ${event.title}`,
          body: `${args.status === "warteliste" ? tr(lang, `Für „${event.title}“ (${club}) sind aktuell alle Plätze vergeben. Du bist auf der Warteliste und wirst per E-Mail benachrichtigt, sobald ein Platz frei wird.`, `“${event.title}” (${club}) is fully booked right now. You are on the waitlist and will be told by e-mail as soon as a spot opens up.`) : tr(lang, `Deine Anmeldung für „${event.title}“ (${club}) ist bestätigt.`, `Your registration for “${event.title}” (${club}) is confirmed.`)}\n${facts}\n${tr(lang, "Mit dem Link unten kannst du deine Anmeldung ändern oder absagen. Bewahre diese E-Mail auf: der Link ist dein Zugang, wir speichern ihn nur verschlüsselt.", "Use the link below to change or cancel your registration. Keep this e-mail: the link is your access, we only store it hashed.")}`,
          ctaLabel: tr(lang, "Anmeldung verwalten", "Manage registration"),
        };
  await notifySafely({
    clubId,
    class: "mandatory",
    eventKey: kind === "confirm" ? "event.guest_confirm" : "event.guest_registered",
    refId: `${event.id}#${args.stamp}`,
    recipients: [{ email: row.guestEmail, name: row.guestName }],
    content: { ...content, template: "notice", lang, ctaUrl: args.link, sensitive: true },
    channels: ["email"],
  });
}

export interface GuestRegisterInput {
  name: string;
  email: string;
  partySize: number;
  answers: unknown;
  language?: string | undefined;
}

/**
 * Starts (or refreshes) the registration of a guest. Always answers the same to the caller, whether the address is new,
 * pending or already registered (no oracle for e-mail addresses): the outcome is only visible in the mail.
 */
export async function registerGuest(clubId: string, event: EventRow, input: GuestRegisterInput): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const lang = await languageFor(clubId, input.language);
  const code = newToken();
  const result = await db.transaction(async (tx) => {
    const locked = await lockEvent(tx, event.id);
    const settings = effectiveSettings(await loadSettings(locked.id, tx));
    const reason = closedReason(locked, settings);
    if (!settings.enabled || !settings.allowGuests || reason !== null) throw new ConflictError("Registration is closed", { details: { code: "registration_closed", reason: reason ?? "guests_not_allowed" } });
    const checked = await checkInput(tx, clubId, settings, { partySize: input.partySize, answers: input.answers });
    if (locked.capacity !== null && input.partySize > locked.capacity) throw new ValidationError("The group is larger than the capacity of the event", { details: { code: "party_too_large" } });

    const [existing] = await tx.select().from(eventAttendees).where(and(eq(eventAttendees.eventId, locked.id), sql`lower(${eventAttendees.guestEmail}) = ${email}`));
    const expires = new Date(Date.now() + UNCONFIRMED_TTL_MS);
    if (existing && existing.guestConfirmedAt !== null) {
      // Already registered: the address owner gets a fresh management link (the old one stops working); nothing else changes.
      const token = newToken();
      await tx.update(eventAttendees).set({ guestTokenHash: hashToken(token) }).where(eq(eventAttendees.id, existing.id));
      return { kind: "registered" as const, row: existing, token, status: existing.status };
    }
    if (existing) {
      const submissionId = await replaceSubmission(tx, { clubId, form: checked.form, answers: checked.answers, previousId: existing.formSubmissionId, submittedByUserId: null, subjectClubMemberId: null, onBehalfOf: "self" });
      const [row] = await tx.update(eventAttendees).set({ guestName: input.name, partySize: input.partySize, formSubmissionId: submissionId, guestConfirmTokenHash: hashToken(code), guestDeleteAfter: expires }).where(eq(eventAttendees.id, existing.id)).returning();
      return { kind: "confirm" as const, row: row! };
    }
    const [pending] = await tx.select({ n: count() }).from(eventAttendees).where(and(eq(eventAttendees.eventId, locked.id), eq(eventAttendees.status, "unbestaetigt")));
    if ((pending?.n ?? 0) >= MAX_PENDING_PER_EVENT) throw new ConflictError("Too many unconfirmed registrations, try again later", { details: { code: "too_many_pending" } });
    const submissionId = await replaceSubmission(tx, { clubId, form: checked.form, answers: checked.answers, previousId: null, submittedByUserId: null, subjectClubMemberId: null, onBehalfOf: "self" });
    const [row] = await tx
      .insert(eventAttendees)
      .values({ eventId: locked.id, guestEmail: email, guestName: input.name, status: "unbestaetigt", partySize: input.partySize, formSubmissionId: submissionId, guestConfirmTokenHash: hashToken(code), guestDeleteAfter: expires })
      .returning();
    await writeAudit(tx, { eventType: "event_guest.register", subjectId: locked.id, payload: { clubId, eventId: locked.id, partySize: input.partySize } });
    return { kind: "confirm" as const, row: row! };
  });

  if (result.kind === "confirm") await sendGuestMail({ clubId, row: result.row, kind: "confirm", lang, event, link: confirmUrl(code), stamp: `${result.row.id}:c:${Date.now()}` });
  else await sendGuestMail({ clubId, row: result.row, kind: "registered", lang, event, status: result.status, link: manageUrl(result.token), stamp: `${result.row.id}:m:${Date.now()}` });
}

/** The confirmation link was opened: the address is real, the registration gets its seat (or its place on the waitlist). */
export async function confirmGuest(code: string, languageHint?: unknown): Promise<{ status: string; partySize: number; manageToken: string | null; event: EventRow; clubId: string; alreadyConfirmed: boolean } | null> {
  if (!TOKEN_RE.test(code)) return null;
  const [found] = await db
    .select({ row: eventAttendees, event: events, clubId: calendars.clubId })
    .from(eventAttendees)
    .innerJoin(events, eq(events.id, eventAttendees.eventId))
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(eq(eventAttendees.guestConfirmTokenHash, hashToken(code)));
  if (!found) return null;
  const lang = await languageFor(found.clubId, languageHint);
  if (found.row.guestConfirmedAt !== null) return { status: found.row.status, partySize: found.row.partySize, manageToken: null, event: found.event, clubId: found.clubId, alreadyConfirmed: true };

  const outcome = await db.transaction(async (tx) => {
    const event = await lockEvent(tx, found.event.id);
    const [row] = await tx.select().from(eventAttendees).where(eq(eventAttendees.id, found.row.id)).for("update");
    if (!row) return null;
    if (row.guestConfirmedAt !== null) return { row, token: null as string | null, event };
    if (row.guestDeleteAfter !== null && row.guestDeleteAfter.getTime() < Date.now()) return null;
    const settings = effectiveSettings(await loadSettings(event.id, tx));
    const reason = closedReason(event, settings);
    if (!settings.enabled || !settings.allowGuests || reason !== null) throw new ConflictError("Registration is closed", { details: { code: "registration_closed", reason: reason ?? "guests_not_allowed" } });
    const status = fits(event.capacity, await takenSeats(tx, event.id, { attendeeId: row.id }), row.partySize) ? "angemeldet" : "warteliste";
    const token = newToken();
    const [updated] = await tx
      .update(eventAttendees)
      .set({ status, guestConfirmedAt: new Date(), guestTokenHash: hashToken(token), respondedAt: new Date(), guestDeleteAfter: deleteAfterFor(event, settings.guestRetentionDays) })
      .where(eq(eventAttendees.id, row.id))
      .returning();
    await writeAudit(tx, { eventType: "event_guest.confirm", subjectId: event.id, payload: { clubId: found.clubId, eventId: event.id, status } });
    return { row: updated!, token, event };
  });
  if (!outcome) return null;
  if (outcome.token) await sendGuestMail({ clubId: found.clubId, row: outcome.row, kind: "registered", lang, event: outcome.event, status: outcome.row.status, link: manageUrl(outcome.token), stamp: `${outcome.row.id}:r:${Date.now()}` });
  return { status: outcome.row.status, partySize: outcome.row.partySize, manageToken: outcome.token, event: outcome.event, clubId: found.clubId, alreadyConfirmed: outcome.token === null };
}

export interface GuestRegistration {
  row: EventAttendeeRow;
  event: EventRow;
  clubId: string;
}

/** The confirmed registration behind a management token, or null. */
export async function guestByManageToken(token: string): Promise<GuestRegistration | null> {
  if (!TOKEN_RE.test(token)) return null;
  const [found] = await db
    .select({ row: eventAttendees, event: events, clubId: calendars.clubId })
    .from(eventAttendees)
    .innerJoin(events, eq(events.id, eventAttendees.eventId))
    .innerJoin(calendars, eq(calendars.id, events.calendarId))
    .where(eq(eventAttendees.guestTokenHash, hashToken(token)));
  return found ?? null;
}

/** Changes party size / answers of a guest registration (same seat rules as for members). */
export async function updateGuest(reg: GuestRegistration, input: { partySize?: number | undefined; answers?: unknown; name?: string | undefined }): Promise<{ status: string; partySize: number; promoted: Promoted[] }> {
  return db.transaction(async (tx) => {
    const event = await lockEvent(tx, reg.event.id);
    const [row] = await tx.select().from(eventAttendees).where(eq(eventAttendees.id, reg.row.id)).for("update");
    if (!row) throw new NotFoundError("Registration not found");
    if (event.cancelledAt !== null) throw new ConflictError("Event is cancelled");
    const settings = effectiveSettings(await loadSettings(event.id, tx));
    if (closedReason(event, settings) === "deadline_passed") throw new ConflictError("The registration deadline has passed", { details: { code: "registration_closed" } });
    const partySize = input.partySize ?? row.partySize;
    const checked = await checkInput(tx, reg.clubId, settings, { partySize, answers: input.answers === undefined ? await currentAnswers(tx, row) : input.answers });
    if (event.capacity !== null && partySize > event.capacity) throw new ValidationError("The group is larger than the capacity of the event", { details: { code: "party_too_large" } });
    let status = row.status;
    if (partySize !== row.partySize) {
      const taken = await takenSeats(tx, event.id, { attendeeId: row.id });
      if (fits(event.capacity, taken, partySize)) status = row.status === "warteliste" ? "warteliste" : "angemeldet";
      else if (row.status === "angemeldet") throw new ConflictError("The larger group does not fit any more", { details: { code: "party_size_unavailable" } });
    }
    const submissionId = input.answers === undefined ? row.formSubmissionId : await replaceSubmission(tx, { clubId: reg.clubId, form: checked.form, answers: checked.answers, previousId: row.formSubmissionId, submittedByUserId: null, subjectClubMemberId: null, onBehalfOf: "self" });
    const [updated] = await tx.update(eventAttendees).set({ partySize, status, formSubmissionId: submissionId, ...(input.name ? { guestName: input.name } : {}) }).where(eq(eventAttendees.id, row.id)).returning();
    const promoted = row.partySize > partySize && row.status === "angemeldet" ? await promoteWaitlist(tx, event, reg.clubId) : [];
    return { status: updated!.status, partySize: updated!.partySize, promoted };
  });
}

async function currentAnswers(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], row: EventAttendeeRow): Promise<Record<string, unknown>> {
  if (!row.formSubmissionId) return {};
  const [sub] = await tx.select({ answers: formSubmissions.answers }).from(formSubmissions).where(eq(formSubmissions.id, row.formSubmissionId));
  return (sub?.answers as Record<string, unknown>) ?? {};
}

/** A guest cancels: the row (name, address, answers) is deleted, the waitlist moves up. */
export async function cancelGuest(reg: GuestRegistration): Promise<Promoted[]> {
  return db.transaction(async (tx) => {
    const event = await lockEvent(tx, reg.event.id);
    const [row] = await tx.select().from(eventAttendees).where(eq(eventAttendees.id, reg.row.id)).for("update");
    if (!row) return [];
    await tx.delete(eventAttendees).where(eq(eventAttendees.id, row.id));
    if (row.formSubmissionId) await tx.delete(formSubmissions).where(eq(formSubmissions.id, row.formSubmissionId));
    await writeAudit(tx, { eventType: "event_guest.cancel", subjectId: event.id, payload: { clubId: reg.clubId, eventId: event.id } });
    return row.status === "angemeldet" ? promoteWaitlist(tx, event, reg.clubId) : [];
  });
}

/** Own answers of a guest registration (for the edit form of the management page). */
export async function guestAnswers(row: EventAttendeeRow): Promise<Record<string, unknown>> {
  return currentAnswers(db as never, row);
}

export const GUEST_SWEEP_JOB_TYPE = "event_guest_sweep";
export const GUEST_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Deletes registrations of guests who never confirmed their address once the 48 hours are over (data minimisation: an unconfirmed
 * sign-up is not a registration). This runs independently of the retention dry-run switch; confirmed guests are handled by the
 * retention category `event_guests`.
 */
export async function sweepUnconfirmedGuests(now: Date = new Date()): Promise<number> {
  const due = await db
    .select({ id: eventAttendees.id, submission: eventAttendees.formSubmissionId })
    .from(eventAttendees)
    .where(and(isNotNull(eventAttendees.guestEmail), isNull(eventAttendees.guestConfirmedAt), isNotNull(eventAttendees.guestDeleteAfter), lt(eventAttendees.guestDeleteAfter, now)))
    .limit(500);
  if (due.length === 0) return 0;
  await db.transaction(async (tx) => {
    await tx.delete(eventAttendees).where(inArray(eventAttendees.id, due.map((d) => d.id)));
    const submissions = due.flatMap((d) => (d.submission ? [d.submission] : []));
    if (submissions.length > 0) await tx.delete(formSubmissions).where(inArray(formSubmissions.id, submissions));
  });
  return due.length;
}
