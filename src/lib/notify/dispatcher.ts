import { and, eq, inArray, isNull } from "drizzle-orm";

import { db } from "../../db/client.js";
import { messageDeliveries, pushTokens, type CommunicationChannel } from "../../db/schema/communication.js";
import { normalizeEmail, resolveClubAudience, type AudienceRecipient } from "../audience.js";
import { logger } from "../logger.js";
import { enqueue } from "../jobs/queue.js";
import { handleEmailDelivery } from "./email-job.js";
import { clubMailLanguage } from "../club-settings.js";
import { DEFAULT_MAIL_LANGUAGE } from "./i18n.js";
import { loadPrefResolver } from "./preferences.js";
import { PUSH_DELIVERIES_PER_JOB } from "./push.js";
import { CORE_NOTIFICATION_CATEGORIES, EMAIL_JOB_TYPE, PUSH_JOB_TYPE, type DeliveryContent, type NotificationCategory, type NotifyInput, type NotifyRecipient, type NotifyResult, type NotifyTemplate } from "./types.js";

/**
 * Central delivery layer (Wave 9 B6, ADR-006). `notify` writes one `message_deliveries` row per recipient and channel
 * (the proof of delivery) and schedules one `notify.email` job per queued mail; the in-app copy is the delivery row itself
 * (inbox). It must be called AFTER the business transaction committed. Use `notifySafely` where a failure must never
 * surface to the caller.
 */

const INSERT_CHUNK = 400;

interface Target {
  key: string;
  clubMemberId: string | null;
  userId: string | null;
  name: string | null;
  /** Address this target is mailed at (already deduplicated); NULL = none. */
  email: string | null;
  /** The only address of the person is used for another recipient, so no row is needed. */
  emailCovered: boolean;
  inApp: boolean;
}

function templateOf(input: NotifyInput): NotifyTemplate {
  if (input.content.template) return input.content.template;
  if (input.class === "mandatory") return "decision";
  return input.content.urgent ? "urgent" : "announcement";
}

function categoryOf(input: NotifyInput, template: NotifyTemplate): DeliveryContent["category"] {
  if (input.class === "mandatory") return "decisions";
  return input.content.category ?? (template === "reminder" ? "reminders" : "announcements");
}

function targetsFromAudience(recipients: AudienceRecipient[]): Target[] {
  return recipients.map((r) => ({
    key: r.key,
    clubMemberId: r.clubMemberId,
    userId: r.userId,
    name: r.firstName?.trim() || r.displayName,
    email: r.email,
    emailCovered: r.emailCoveredBy !== null,
    inApp: r.channels.inApp,
  }));
}

function targetsFromRecipients(recipients: NotifyRecipient[]): Target[] {
  const owners = new Set<string>();
  return recipients.map((r, i) => {
    let email = normalizeEmail(r.email);
    let covered = false;
    if (email) {
      if (owners.has(email)) {
        covered = true;
        email = null;
      } else {
        owners.add(email);
      }
    }
    return { key: r.clubMemberId ?? r.userId ?? `idx:${i}`, clubMemberId: r.clubMemberId ?? null, userId: r.userId ?? null, name: r.name ?? null, email, emailCovered: covered, inApp: !!r.userId };
  });
}

type OptOut = (channel: CommunicationChannel, t: Target) => boolean;
const NEVER: OptOut = () => false;

/**
 * Whether a person switched a channel off for this message (club row > global row > on, see `preferences.ts`). With
 * `pushOnlyIfAllOff` (mandatory messages) only the push channel counts, and only for people who switched push off in EVERY core
 * category: a clear "no push at all" is honoured even for decisions, while the in-app copy and the mail stay mandatory.
 */
async function loadOptOut(category: string, targets: Target[], clubId: string | null, pushOnlyIfAllOff = false): Promise<OptOut> {
  const userIds = targets.map((t) => t.userId).filter((v): v is string => v !== null);
  const memberIds = targets.map((t) => t.clubMemberId).filter((v): v is string => v !== null);
  if (userIds.length + memberIds.length === 0) return NEVER;
  const isEnabled = await loadPrefResolver({ userIds, clubMemberIds: memberIds, clubIds: [clubId] });
  const subject = (t: Target) => ({ userId: t.userId, clubMemberId: t.clubMemberId, clubId });
  if (pushOnlyIfAllOff) return (channel, t) => channel === "push" && CORE_NOTIFICATION_CATEGORIES.every((c) => !isEnabled(subject(t), c, "push"));
  return (channel, t) => !isEnabled(subject(t), category, channel);
}

/** Users with at least one active push token. */
async function loadPushUsers(targets: Target[]): Promise<Set<string>> {
  const userIds = [...new Set(targets.map((t) => t.userId).filter((v): v is string => v !== null))];
  const out = new Set<string>();
  for (let i = 0; i < userIds.length; i += INSERT_CHUNK) {
    const rows = await db
      .selectDistinct({ userId: pushTokens.userId })
      .from(pushTokens)
      .where(and(inArray(pushTokens.userId, userIds.slice(i, i + INSERT_CHUNK)), isNull(pushTokens.disabledAt)));
    for (const r of rows) out.add(r.userId);
  }
  return out;
}

/** Push never stands alone: the in-app copy is the source of truth, and an urgent or mandatory message always has the e-mail fallback (ADR-006, O1). */
function effectiveChannels(input: NotifyInput, template: NotifyTemplate): CommunicationChannel[] {
  const channels = new Set<CommunicationChannel>(input.channels);
  if (channels.has("push")) {
    channels.add("in_app");
    if (input.class === "mandatory" || input.content.urgent === true || template === "urgent") channels.add("email");
  }
  return [...channels];
}

type DeliveryInsert = typeof messageDeliveries.$inferInsert;

export async function notify(input: NotifyInput): Promise<NotifyResult> {
  if ((input.audience === undefined) === (input.recipients === undefined)) throw new Error("notify needs exactly one of audience / recipients");
  if (input.audience !== undefined && input.clubId === null) throw new Error("notify with an audience needs a clubId");
  if (input.announcementId !== undefined && input.clubId === null) throw new Error("notify for an announcement needs a clubId");

  const template = templateOf(input);
  const category = categoryOf(input, template);
  const targets = input.audience !== undefined
    ? targetsFromAudience((await resolveClubAudience(input.clubId!, input.audience, input.limit === undefined ? {} : { limit: input.limit })).recipients)
    : targetsFromRecipients(input.recipients ?? []);

  // Language of the system chrome (mail intro/button/footer, push line): explicit, else the club's, else German.
  const lang = input.content.lang ?? (input.clubId ? await clubMailLanguage(db, input.clubId) : DEFAULT_MAIL_LANGUAGE);

  const channels = effectiveChannels(input, template);
  const wantsInApp = channels.includes("in_app");
  const wantsEmail = channels.includes("email");
  const wantsPush = channels.includes("push");
  // Mandatory messages ignore preferences (except "push off everywhere"); optional ones are filtered per channel (in-app is the source of truth and stays on).
  const optedOut =
    input.class === "optional" && (wantsEmail || wantsPush)
      ? await loadOptOut(category, targets, input.clubId)
      : input.class === "mandatory" && wantsPush
        ? await loadOptOut(category, targets, input.clubId, true)
        : NEVER;

  const pushUsers = wantsPush ? await loadPushUsers(targets) : new Set<string>();

  const now = new Date();
  const rows: DeliveryInsert[] = [];
  const base = (t: Target, channel: CommunicationChannel): DeliveryInsert => ({
    clubId: input.clubId,
    announcementId: input.announcementId ?? null,
    eventKey: input.eventKey,
    refId: input.refId ?? null,
    clubMemberId: t.clubMemberId,
    userId: t.userId,
    channel,
    content: {
      title: input.content.title,
      body: input.content.body,
      template,
      category,
      class: input.class,
      urgent: input.content.urgent === true || template === "urgent",
      // Only the e-mail needs the salutation; in-app/push rows live on in the inbox and must not carry a name.
      recipientName: channel === "email" ? t.name : null,
      ctaLabel: input.content.ctaLabel ?? null,
      ctaUrl: input.content.ctaUrl ?? null,
      lang,
      ...(input.content.rendered ? { rendered: input.content.rendered } : {}),
      ...(input.content.sensitive ? { sensitive: true } : {}),
      ...(input.content.eventId ? { eventId: input.content.eventId } : {}),
    } satisfies DeliveryContent,
  });
  const result: NotifyResult = { recipients: targets.length, inApp: 0, queuedEmail: 0, queuedPush: 0, sentEmail: 0, skippedOptout: 0, skippedNoAddress: 0, alreadyDelivered: 0 };

  for (const t of targets) {
    if (wantsInApp && t.inApp) rows.push({ ...base(t, "in_app"), status: "sent", sentAt: now });
    if (wantsEmail && !t.emailCovered) {
      if (t.email === null) rows.push({ ...base(t, "email"), status: "skipped_no_address" });
      else if (optedOut("email", t)) rows.push({ ...base(t, "email"), status: "skipped_optout" });
      else rows.push({ ...base(t, "email"), status: "queued", address: t.email });
    }
    if (wantsPush && t.userId !== null) {
      if (optedOut("push", t)) rows.push({ ...base(t, "push"), status: "skipped_optout" });
      else if (!pushUsers.has(t.userId)) rows.push({ ...base(t, "push"), status: "skipped_no_address", errorCode: "no_push_token" });
      else rows.push({ ...base(t, "push"), status: "queued" });
    }
  }

  const immediateIds: string[] = [];
  const pushIds: string[] = [];
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const inserted = await tx.insert(messageDeliveries).values(chunk).onConflictDoNothing().returning({ id: messageDeliveries.id, channel: messageDeliveries.channel, status: messageDeliveries.status });
      result.alreadyDelivered += chunk.length - inserted.length;
      for (const row of inserted) {
        if (row.channel === "in_app") result.inApp += 1;
        else if (row.channel === "push") {
          if (row.status === "queued") {
            result.queuedPush += 1;
            pushIds.push(row.id);
          } else if (row.status === "skipped_optout") result.skippedOptout += 1;
          else if (row.status === "skipped_no_address") result.skippedNoAddress += 1;
        } else if (row.status === "queued") {
          result.queuedEmail += 1;
          if (input.immediate) immediateIds.push(row.id);
          else await enqueue({ type: EMAIL_JOB_TYPE, payload: { deliveryId: row.id }, dedupeKey: `${EMAIL_JOB_TYPE}:${row.id}` }, tx);
        } else if (row.status === "skipped_optout") result.skippedOptout += 1;
        else if (row.status === "skipped_no_address") result.skippedNoAddress += 1;
      }
    }
    // One job per batch of deliveries, so the handler can fill Expo's 100-message requests.
    for (let i = 0; i < pushIds.length; i += PUSH_DELIVERIES_PER_JOB) {
      const deliveryIds = pushIds.slice(i, i + PUSH_DELIVERIES_PER_JOB);
      await enqueue({ type: PUSH_JOB_TYPE, payload: { deliveryIds }, dedupeKey: `${PUSH_JOB_TYPE}:${deliveryIds[0]}:${deliveryIds.length}` }, tx);
    }
  });
  for (const deliveryId of immediateIds) {
    await handleEmailDelivery({ id: deliveryId, type: EMAIL_JOB_TYPE, payload: { deliveryId }, attempt: 1, maxAttempts: 1 });
    const [row] = await db.select({ status: messageDeliveries.status }).from(messageDeliveries).where(eq(messageDeliveries.id, deliveryId));
    if (row?.status === "sent") result.sentEmail += 1;
  }
  return result;
}

/**
 * Best effort wrapper for status changes: never throws, logs only ids and the error class (no addresses, no message
 * text, since provider errors commonly echo the recipient).
 */
export async function notifySafely(input: NotifyInput): Promise<NotifyResult | null> {
  try {
    return await notify(input);
  } catch (err) {
    const e = err as { name?: string; code?: unknown } | undefined;
    logger.error({ eventKey: input.eventKey, refId: input.refId, clubId: input.clubId, errName: e?.name, errCode: e?.code }, "[notify] dispatch failed");
    return null;
  }
}

/** Fire-and-forget: schedules `notifySafely` without delaying the HTTP response. */
export function notifyInBackground(input: NotifyInput): void {
  void notifySafely(input);
}

export type { NotificationCategory };
