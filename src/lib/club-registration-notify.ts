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
 */

interface Applicant {
  name: string;
  email: string;
}

type RegistrationMailKind = "received" | "review-notify" | "needs-info" | "rejected" | "approved";

function queue(kind: RegistrationMailKind, registrationId: string, to: Applicant | string, title: string, html: string, toName: string | null): Promise<unknown> {
  const email = typeof to === "string" ? to : to.email;
  return notifySafely({
    clubId: null,
    class: "mandatory",
    eventKey: `club_registration.${kind}`,
    refId: registrationId,
    recipients: [{ name: toName, email }],
    content: { title: title.replace(/[\r\n]+/g, " "), body: title.replace(/[\r\n]+/g, " "), rendered: { subject: title.replace(/[\r\n]+/g, " "), html } },
    channels: ["email"],
  });
}

export function sendRegistrationReceivedMail(applicant: Applicant, clubName: string, registrationId: string): Promise<unknown> {
  return queue("received", registrationId, applicant, "Dein Antrag zur Vereinsgründung ist eingegangen", buildRegistrationReceivedEmail({ name: applicant.name, clubName, url: SITE_URL }), applicant.name);
}

/** Notifies the platform reviewers (CLUB_REVIEW_NOTIFY_EMAIL, comma-separated). Unset -> warning only. */
export async function sendRegistrationReviewNotifyMail(applicant: Applicant, clubName: string, registrationId: string): Promise<void> {
  const recipients = (process.env.CLUB_REVIEW_NOTIFY_EMAIL ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  if (recipients.length === 0) {
    logger.warn({ registrationId }, "[club-registration-mail] CLUB_REVIEW_NOTIFY_EMAIL is not set -- no reviewer notified about the new club registration");
    return;
  }
  const html = buildRegistrationReviewNotifyEmail({ clubName, applicantName: applicant.name, applicantEmail: applicant.email, url: SITE_URL });
  await Promise.all(recipients.map((to) => queue("review-notify", registrationId, to, `Neuer Vereinsantrag: ${clubName}`, html, null)));
}

export function sendRegistrationNeedsInfoMail(applicant: Applicant, clubName: string, note: string, registrationId: string): Promise<unknown> {
  return queue("needs-info", registrationId, applicant, "Rückfrage zu deinem Vereinsantrag", buildRegistrationNeedsInfoEmail({ name: applicant.name, clubName, note, url: SITE_URL }), applicant.name);
}

export function sendRegistrationRejectedMail(applicant: Applicant, clubName: string, note: string, registrationId: string): Promise<unknown> {
  return queue("rejected", registrationId, applicant, "Dein Vereinsantrag wurde abgelehnt", buildRegistrationRejectedEmail({ name: applicant.name, clubName, note, url: SITE_URL }), applicant.name);
}

export function sendRegistrationApprovedMail(applicant: Applicant, clubName: string, slug: string, registrationId: string): Promise<unknown> {
  return queue("approved", registrationId, applicant, "Dein Verein ist freigeschaltet", buildRegistrationApprovedEmail({ name: applicant.name, clubName, slug, url: SITE_URL }), applicant.name);
}

/** Fire-and-forget wrapper: never throws, never delays the HTTP response. */
export function inBackground(task: Promise<unknown>): void {
  void task.catch((err) => logger.error({ err }, "[club-registration-mail] unexpected mail task failure"));
}
