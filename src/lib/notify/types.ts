import type { MailLanguage } from "./i18n.js";
import type { AnnouncementAudience, CommunicationChannel } from "../../db/schema/communication.js";

/** `mandatory` = account/security, decisions about the person's own request (never suppressible); `optional` = opt-out-able (ADR-006). */
export type NotifyClass = "mandatory" | "optional";

/** Email/in-app layout variants. `notice` = neutral information (account security, "account linked"). */
export const NOTIFY_TEMPLATES = ["announcement", "urgent", "reminder", "decision", "notice"] as const;
export type NotifyTemplate = (typeof NOTIFY_TEMPLATES)[number];

/** Preference categories of `notification_preferences.category` (B9 exposes them). `decisions` is mandatory-only, never stored as a preference. */
export const NOTIFICATION_CATEGORIES = ["announcements", "events", "reminders", "board"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];
/**
 * `board` = digests for the people who run the club (age-transition summary, exit effective); GET /notification-preferences only
 * lists it for accounts that hold a role with `members:write`, so ordinary members never see it. Kept apart from `reminders` so
 * switching off personal reminders does not silence what the board has to act on.
 */
export const BOARD_CATEGORY: NotificationCategory = "board";
/** The categories every member sees; "push off everywhere" (mandatory push) is judged on these. */
export const CORE_NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = ["announcements", "events", "reminders"];

export interface NotifyContent {
  title: string;
  /** Plain text (no HTML); URLs are linkified when rendered. */
  body: string;
  /** Default: `announcement` (`urgent` if `urgent` is set) for optional, `decision` for mandatory. */
  template?: NotifyTemplate;
  urgent?: boolean;
  /** Preference category of an optional message. Default derived from the template (`reminder` -> reminders, else announcements). */
  category?: NotificationCategory;
  ctaLabel?: string;
  ctaUrl?: string;
  /**
   * Pre-rendered mail (subject + html) that is sent as is instead of the generic layout. Only for the migrated
   * platform/invite mails whose wording must stay byte-identical; `title`/`body` remain the in-app text.
   */
  rendered?: { subject: string; html: string };
  /** Language of the mail chrome (intro, button, footer) and the push line. Default: the club's `mail_language`, else `de`. The text itself is as composed. */
  lang?: MailLanguage;
  /** The content carries a secret (e.g. an invite link): it is wiped from the delivery row once the mail is sent or failed for good. */
  sensitive?: boolean;
}

/** An explicitly addressed recipient (e.g. the applicant of a decision mail, who may have no club_members row). */
export interface NotifyRecipient {
  clubMemberId?: string | null;
  userId?: string | null;
  name?: string | null;
  /** Required for e-mail; account-less members: their contact e-mail. */
  email?: string | null;
}

export interface NotifyInput {
  /** NULL for platform-context mails (e.g. club registration), then no club signature/sender name. */
  clubId: string | null;
  class: NotifyClass;
  eventKey: string;
  refId?: string;
  announcementId?: string;
  /** Exactly one of `audience` / `recipients`. `audience` requires `clubId`. */
  audience?: AnnouncementAudience;
  recipients?: NotifyRecipient[];
  content: NotifyContent;
  /** `push` needs an account; it always implies `in_app`, and an urgent message with push also gets e-mail (never push-only). */
  channels: CommunicationChannel[];
  /** Overrides the audience size limit. */
  limit?: number;
  /**
   * Send the queued e-mails inline (one attempt, no job) so an interactive caller learns the outcome (invite: `emailSent`).
   * A failed attempt ends as `failed` instead of being retried. Default: scheduled as `notify.email` jobs.
   */
  immediate?: boolean;
}

export interface NotifyResult {
  recipients: number;
  inApp: number;
  queuedEmail: number;
  queuedPush: number;
  /** Only with `immediate`: mails actually handed to the transport. */
  sentEmail: number;
  skippedOptout: number;
  skippedNoAddress: number;
  /** Rows that already existed for this announcement (idempotent re-send). */
  alreadyDelivered: number;
}

/** Content snapshot stored in `message_deliveries.content`, rendered by the channel handlers. */
export interface DeliveryContent {
  title: string;
  body: string;
  template: NotifyTemplate;
  category: NotificationCategory | "decisions";
  class: NotifyClass;
  urgent: boolean;
  recipientName: string | null;
  ctaLabel: string | null;
  ctaUrl: string | null;
  rendered?: { subject: string; html: string } | null;
  sensitive?: boolean;
  /** Language of the chrome around the text (absent = `de`, rows written before G12). */
  lang?: MailLanguage;
}

export const EMAIL_JOB_TYPE = "notify.email";
export const PUSH_JOB_TYPE = "notify.push";
export const PUSH_RECEIPTS_JOB_TYPE = "notify.push_receipts";
export const DELIVERY_REAPER_JOB_TYPE = "notify.reap_dead_deliveries";
export const DELIVERY_REAPER_INTERVAL_MS = 10 * 60 * 1000;
