import type { AnnouncementAudience, CommunicationChannel } from "../../db/schema/communication.js";

/** `mandatory` = account/security, decisions about the person's own request (never suppressible); `optional` = opt-out-able (ADR-006). */
export type NotifyClass = "mandatory" | "optional";

/** Email/in-app layout variants. */
export const NOTIFY_TEMPLATES = ["announcement", "urgent", "reminder", "decision"] as const;
export type NotifyTemplate = (typeof NOTIFY_TEMPLATES)[number];

/** Preference categories of `notification_preferences.category` (B9 exposes them). `decisions` is mandatory-only, never stored as a preference. */
export const NOTIFICATION_CATEGORIES = ["announcements", "events", "reminders"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

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
  /** `push` rows are created by the push dispatcher (B8), not here. */
  channels: CommunicationChannel[];
  /** Overrides the audience size limit. */
  limit?: number;
}

export interface NotifyResult {
  recipients: number;
  inApp: number;
  queuedEmail: number;
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
}

export const EMAIL_JOB_TYPE = "notify.email";
