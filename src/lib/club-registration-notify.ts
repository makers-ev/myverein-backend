import { and, eq, isNull, or } from "drizzle-orm";

import { user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { notification } from "../db/schema/notifications.js";
import {
  buildRegistrationApprovedEmail,
  buildRegistrationNeedsInfoEmail,
  buildRegistrationReceivedEmail,
  buildRegistrationRejectedEmail,
  buildRegistrationReviewNotifyEmail,
  SITE_URL,
} from "./emailTemplate.js";
import { logger } from "./logger.js";
import { notifySafely } from "./notify/dispatcher.js";

/**
 * Wave 6 mails of the club registration workflow, delivered by the notification dispatcher (Wave 9 B11): platform
 * context (no club yet, `club_id` NULL), class `mandatory`, e-mail only, content byte-identical to the former ad-hoc
 * mails (`rendered`). Strictly best effort: nothing here throws, mail is queued AFTER the DB change was committed, and
 * only the registration id is logged (never the recipient address).
 *
 * Delivery-level dedupe (G9): `ref_id` = `<registration id>#<transition time ms>`, so the same transition never produces a second
 * mail (a repeated call is the same delivery) while a later transition (re-submit after `needs_info`) is a new one. Applicant
 * mails carry the account id (unique index per person); mails to bare addresses (`CLUB_REVIEW_NOTIFY_EMAIL`) are covered by the
 * address index `message_deliveries_address_event_uidx`.
 */

interface Applicant {
  name: string;
  email: string;
  /** The applicant's account: makes the delivery unique per person (the dispatcher's unique index needs a person id). */
  userId?: string;
}

/** The moment of the status transition the mail belongs to (`submittedAt` for a submit, `reviewedAt` for a decision). */
export type RegistrationTransition = Date | number;
const stamp = (transition: RegistrationTransition): number => (transition instanceof Date ? transition.getTime() : transition);

/**
 * The transition moment for a registration mail, taken from the committed row (`submittedAt` / `reviewedAt` set by the
 * transaction). There is deliberately NO `?? new Date()` fallback: a made-up "now" would differ on every call, break the
 * idempotency of `ref_id` and could double-send. A missing timestamp is a data error: fail closed (no mail), log it.
 */
export function transitionOf(registrationId: string, stampedAt: Date | null | undefined, field: "submittedAt" | "reviewedAt"): Date | null {
  if (stampedAt instanceof Date && !Number.isNaN(stampedAt.getTime())) return stampedAt;
  logger.error({ registrationId, field }, "[club-registration-mail] the registration row has no transition timestamp -- mail skipped (would not be idempotent)");
  return null;
}

type RegistrationMailKind = "received" | "review-notify" | "needs-info" | "rejected" | "approved";

function queue(kind: RegistrationMailKind, registrationId: string, transition: RegistrationTransition, to: Applicant | string, title: string, html: string, toName: string | null): Promise<unknown> {
  const email = typeof to === "string" ? to : to.email;
  const userId = typeof to === "string" ? null : (to.userId ?? null);
  return notifySafely({
    clubId: null,
    class: "mandatory",
    eventKey: `club_registration.${kind}`,
    refId: `${registrationId}#${stamp(transition)}`,
    recipients: [{ name: toName, email, userId }],
    content: { title: title.replace(/[\r\n]+/g, " "), body: title.replace(/[\r\n]+/g, " "), rendered: { subject: title.replace(/[\r\n]+/g, " "), html } },
    channels: ["email"],
  });
}

export function sendRegistrationReceivedMail(applicant: Applicant, clubName: string, registrationId: string, transition: RegistrationTransition): Promise<unknown> {
  return queue("received", registrationId, transition, applicant, "Dein Antrag zur Vereinsgründung ist eingegangen", buildRegistrationReceivedEmail({ name: applicant.name, clubName, url: SITE_URL }), applicant.name);
}

/**
 * Notifies the platform reviewers. `CLUB_REVIEW_NOTIFY_EMAIL` (comma-separated) is mailed; when it is unset, nobody would
 * hear of the application, so the platform admins (accounts with role `admin`, not banned) get a bell entry instead
 * (`notification` kind `admin`, de + en, once per registration and transition) and a warning is logged.
 */
export async function sendRegistrationReviewNotifyMail(applicant: Applicant, clubName: string, registrationId: string, transition: RegistrationTransition): Promise<void> {
  const recipients = (process.env.CLUB_REVIEW_NOTIFY_EMAIL ?? "")
    .split(",")
    .map((address) => address.trim().toLowerCase())
    .filter(Boolean);
  if (recipients.length === 0) {
    logger.warn({ registrationId }, "[club-registration-mail] CLUB_REVIEW_NOTIFY_EMAIL is not set -- notifying the platform admins in the app instead");
    await notifyPlatformAdmins(applicant, clubName, registrationId, transition);
    return;
  }
  const html = buildRegistrationReviewNotifyEmail({ clubName, applicantName: applicant.name, applicantEmail: applicant.email, url: SITE_URL });
  await Promise.all([...new Set(recipients)].map((to) => queue("review-notify", registrationId, transition, to, `Neuer Vereinsantrag: ${clubName}`, html, null)));
}

/** Bell entry (platform notification, no mail) for every platform admin; idempotent per admin through `dedupe_key`. Never throws. */
export async function notifyPlatformAdmins(applicant: Applicant, clubName: string, registrationId: string, transition: RegistrationTransition): Promise<number> {
  try {
    const admins = await db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.role, "admin"), or(isNull(user.banned), eq(user.banned, false))));
    if (admins.length === 0) {
      logger.error({ registrationId }, "[club-registration-mail] no platform admin account to notify about the new club registration");
      return 0;
    }
    const inserted = await db
      .insert(notification)
      .values(
        admins.map((admin) => ({
          kind: "admin" as const,
          targetUserId: admin.id,
          dedupeKey: `club_registration.review:${registrationId}#${stamp(transition)}`,
          deletable: true,
          translations: {
            de: { title: `Neuer Vereinsantrag: ${clubName}`, body: `${applicant.name} hat einen Antrag zur Vereinsgründung eingereicht. Bitte im Admin-Dashboard unter „Vereinsanträge“ prüfen.` },
            en: { title: `New club registration: ${clubName}`, body: `${applicant.name} submitted a request to register a club. Please review it in the admin dashboard under “Club registrations”.` },
          },
        })),
      )
      .onConflictDoNothing()
      .returning({ id: notification.id });
    return inserted.length;
  } catch (err) {
    logger.error({ registrationId, errName: (err as Error)?.name, errCode: (err as { code?: unknown })?.code }, "[club-registration-mail] could not notify the platform admins");
    return 0;
  }
}

export function sendRegistrationNeedsInfoMail(applicant: Applicant, clubName: string, note: string, registrationId: string, transition: RegistrationTransition): Promise<unknown> {
  return queue("needs-info", registrationId, transition, applicant, "Rückfrage zu deinem Vereinsantrag", buildRegistrationNeedsInfoEmail({ name: applicant.name, clubName, note, url: SITE_URL }), applicant.name);
}

export function sendRegistrationRejectedMail(applicant: Applicant, clubName: string, note: string, registrationId: string, transition: RegistrationTransition): Promise<unknown> {
  return queue("rejected", registrationId, transition, applicant, "Dein Vereinsantrag wurde abgelehnt", buildRegistrationRejectedEmail({ name: applicant.name, clubName, note, url: SITE_URL }), applicant.name);
}

export function sendRegistrationApprovedMail(applicant: Applicant, clubName: string, slug: string, registrationId: string, transition: RegistrationTransition): Promise<unknown> {
  return queue("approved", registrationId, transition, applicant, "Dein Verein ist freigeschaltet", buildRegistrationApprovedEmail({ name: applicant.name, clubName, slug, url: SITE_URL }), applicant.name);
}

/** Fire-and-forget wrapper: never throws, never delays the HTTP response. */
export function inBackground(task: Promise<unknown>): void {
  void task.catch((err) => logger.error({ err }, "[club-registration-mail] unexpected mail task failure"));
}
