import { sendEmail } from "./email.js";
import {
  buildRegistrationApprovedEmail,
  buildRegistrationNeedsInfoEmail,
  buildRegistrationReceivedEmail,
  buildRegistrationRejectedEmail,
  buildRegistrationReviewNotifyEmail,
  LOGO_CID,
  LOGO_PATH,
  SITE_URL,
} from "./emailTemplate.js";
import { logger } from "./logger.js";

/**
 * Wave 6 notification mails for the club registration workflow. Strictly best
 * effort: every function resolves normally even when sending fails (the error
 * is logged), and callers must not await them in a way that could change a
 * status transition -- mail is sent AFTER the DB change has been committed.
 */

const logoAttachment = [{ filename: "logo.png", path: LOGO_PATH, cid: LOGO_CID }];

/**
 * Logs only the registration id and the error class/code -- never the
 * recipient address (personal data) nor the raw error, since SMTP error
 * messages commonly echo the address.
 */
async function sendSafely(kind: string, registrationId: string, to: string, subject: string, html: string): Promise<void> {
  try {
    await sendEmail({ to, subject, html, attachments: logoAttachment });
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ kind, registrationId, errName: e?.name, errCode: e?.code }, "[club-registration-mail] failed to send email");
  }
}

interface Applicant {
  name: string;
  email: string;
}

export function sendRegistrationReceivedMail(applicant: Applicant, clubName: string, registrationId: string): Promise<void> {
  return sendSafely("received", registrationId, applicant.email, "Dein Antrag zur Vereinsgründung ist eingegangen", buildRegistrationReceivedEmail({ name: applicant.name, clubName, url: SITE_URL }));
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
  await Promise.all(recipients.map((to) => sendSafely("review-notify", registrationId, to, `Neuer Vereinsantrag: ${clubName}`.replace(/[\r\n]+/g, " "), html)));
}

export function sendRegistrationNeedsInfoMail(applicant: Applicant, clubName: string, note: string, registrationId: string): Promise<void> {
  return sendSafely("needs-info", registrationId, applicant.email, "Rückfrage zu deinem Vereinsantrag", buildRegistrationNeedsInfoEmail({ name: applicant.name, clubName, note, url: SITE_URL }));
}

export function sendRegistrationRejectedMail(applicant: Applicant, clubName: string, note: string, registrationId: string): Promise<void> {
  return sendSafely("rejected", registrationId, applicant.email, "Dein Vereinsantrag wurde abgelehnt", buildRegistrationRejectedEmail({ name: applicant.name, clubName, note, url: SITE_URL }));
}

export function sendRegistrationApprovedMail(applicant: Applicant, clubName: string, slug: string, registrationId: string): Promise<void> {
  return sendSafely("approved", registrationId, applicant.email, "Dein Verein ist freigeschaltet", buildRegistrationApprovedEmail({ name: applicant.name, clubName, slug, url: SITE_URL }));
}

/** Fire-and-forget wrapper: never throws, never delays the HTTP response. */
export function inBackground(task: Promise<void>): void {
  void task.catch((err) => logger.error({ err }, "[club-registration-mail] unexpected mail task failure"));
}
