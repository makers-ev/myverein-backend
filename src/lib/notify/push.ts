import { and, eq, inArray, isNull } from "drizzle-orm";

import { organization } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { messageDeliveries, pushTokens } from "../../db/schema/communication.js";
import { enqueue } from "../jobs/queue.js";
import type { JobContext } from "../jobs/registry.js";
import { logger } from "../logger.js";
import { optedOutDeliveryIds, withdrawnAnnouncementIds } from "./guards.js";
import type { MailLanguage } from "./i18n.js";
import { PUSH_RECEIPTS_JOB_TYPE, type DeliveryContent } from "./types.js";

/**
 * Push channel (Wave 9 B8, ADR-006) via the Expo push API with plain `fetch` (no SDK dependency).
 *
 * One `message_deliveries` row (channel `push`) exists per recipient; the handler sends it to every active device token of
 * that user. The push payload deliberately carries NO personal data and no message text: a generic title/body plus
 * deep-link ids (`type`, `announcementId`/`eventId`/`meetingId`); the app loads the content from the inbox after opening.
 * Sending happens in chunks of at most `EXPO_PUSH_CHUNK_SIZE` (100, the Expo limit per request). Tickets are processed by
 * the follow-up job `notify.push_receipts`, which disables tokens Expo reports as `DeviceNotRegistered`.
 */

export const EXPO_PUSH_CHUNK_SIZE = 100;
/** Expo accepts up to 1000 ticket ids per receipt request. */
const EXPO_RECEIPT_CHUNK_SIZE = 1000;
/** Deliveries per `notify.push` job. */
export const PUSH_DELIVERIES_PER_JOB = 100;

export type PushFetch = (endpoint: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Pick<Response, "ok" | "status" | "json">>;

let pushFetch: PushFetch | null = null;

/** Test seam: inject a fetch double (`null` restores the global `fetch`). */
export function setPushFetch(next: PushFetch | null): void {
  pushFetch = next;
}

function expoBaseUrl(): string {
  return (process.env.EXPO_PUSH_API_URL || "https://exp.host/--/api/v2/push").replace(/\/+$/, "");
}

/** Minutes between sending and fetching the receipts (Expo recommends waiting at least 15 minutes). */
export function receiptDelayMs(): number {
  const n = Number(process.env.PUSH_RECEIPT_DELAY_MINUTES ?? 15);
  return (Number.isFinite(n) && n >= 0 && n <= 24 * 60 ? n : 15) * 60_000;
}

async function expoPost(path: string, body: unknown): Promise<unknown> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (process.env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  const doFetch = pushFetch ?? ((endpoint, init) => fetch(endpoint, init));
  const res = await doFetch(`${expoBaseUrl()}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  // Status only: the response body may echo tokens and must never end up in jobs.last_error.
  if (!res.ok) throw new Error(`expo push api responded ${res.status}`);
  return res.json();
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, string | boolean>;
  priority: "default" | "high";
  channelId: "default" | "urgent";
  sound: "default";
  interruptionLevel?: "time-sensitive";
}

interface ExpoTicket {
  status?: string;
  id?: string;
  details?: { error?: string };
}

/** Deep-link data (ids only) derived from the delivery's event key. */
export function pushDataFor(eventKey: string | null, refId: string | null, announcementId: string | null, clubId: string | null, urgent: boolean): Record<string, string | boolean> {
  const key = eventKey ?? "";
  // `refId` may carry a `#discriminator` suffix (idempotency, see dispatcher); the deep link only wants the id.
  refId = refId ? refId.split("#")[0]! : refId;
  const data: Record<string, string | boolean> = { type: "message", urgent };
  // Decisions about a person's own request: the app opens the inbox (type `message`); the person may no longer have access to the club, so no club id.
  if (clubId && !key.startsWith("application.") && !key.startsWith("exit.")) data.clubId = clubId;
  if (announcementId || key === "announcement") {
    data.type = "announcement";
    if (announcementId) data.announcementId = announcementId;
  } else if (key.startsWith("event.") || key === "reminder.event") {
    data.type = "event";
    if (refId) data.eventId = refId;
  } else if (key.startsWith("meeting.") || key === "reminder.rsvp") {
    data.type = "meeting";
    if (refId) data.meetingId = refId;
  } else if (key.startsWith("reminder.")) {
    data.type = "reminder";
  }
  return data;
}

const GENERIC_TEXT: Record<DeliveryContent["template"], string> = {
  announcement: "Neue Mitteilung",
  urgent: "Dringende Mitteilung",
  reminder: "Neue Erinnerung",
  decision: "Neuigkeit zu deinem Antrag",
  notice: "Neuer Hinweis",
};

/** Generic push text (no titles, names or dates): by event key first, then by layout template. */
const GENERIC_TEXT_BY_KEY: Record<string, string> = {
  "event.changed": "Terminänderung",
  "event.cancelled": "Termin abgesagt",
  "event.promoted": "Du bist nachgerückt",
  "meeting.changed": "Treffen verschoben",
  "meeting.cancelled": "Treffen abgesagt",
  "meeting.invited": "Einladung zu einem Treffen",
  "reminder.event": "Erinnerung an einen Termin",
  "reminder.rsvp": "Bitte antworten",
  "reminder.loan_due": "Rückgabe fällig",
  "reminder.loan_overdue": "Rückgabe überfällig",
};

const GENERIC_TEXT_EN: Record<DeliveryContent["template"], string> = {
  announcement: "New message",
  urgent: "Urgent message",
  reminder: "New reminder",
  decision: "News about your request",
  notice: "New notice",
};

const GENERIC_TEXT_BY_KEY_EN: Record<string, string> = {
  "event.changed": "Event changed",
  "event.cancelled": "Event cancelled",
  "event.promoted": "You moved up",
  "meeting.changed": "Meeting rescheduled",
  "meeting.cancelled": "Meeting cancelled",
  "meeting.invited": "Invitation to a meeting",
  "reminder.event": "Reminder for an event",
  "reminder.rsvp": "Please respond",
  "reminder.loan_due": "Return due",
  "reminder.loan_overdue": "Return overdue",
};

export function genericPushText(eventKey: string | null, template: DeliveryContent["template"], lang: MailLanguage = "de"): string {
  if (lang === "en") return (eventKey ? GENERIC_TEXT_BY_KEY_EN[eventKey] : undefined) ?? GENERIC_TEXT_EN[template] ?? GENERIC_TEXT_EN.announcement;
  return (eventKey ? GENERIC_TEXT_BY_KEY[eventKey] : undefined) ?? GENERIC_TEXT[template] ?? GENERIC_TEXT.announcement;
}

interface PendingDelivery {
  id: string;
  messages: Array<{ tokenId: string; message: ExpoMessage }>;
}

/** Marks a token as unusable (Expo said `DeviceNotRegistered`); it is never sent to again until the app re-registers it. */
async function disableTokens(tokenIds: string[]): Promise<void> {
  if (tokenIds.length === 0) return;
  await db.update(pushTokens).set({ disabledAt: new Date() }).where(and(inArray(pushTokens.id, tokenIds), isNull(pushTokens.disabledAt)));
}

/**
 * Job handler `notify.push`: sends the queued push deliveries named in the payload (`deliveryIds`). Idempotent (only `queued`
 * rows are touched). A transport failure throws (queue retry with backoff); on the last attempt the remaining deliveries
 * become `failed`. Per-token errors from Expo mark the delivery `failed` only when no device accepted the message.
 */
export async function handlePushDelivery(job: JobContext): Promise<void> {
  const ids = Array.isArray(job.payload.deliveryIds) ? job.payload.deliveryIds.filter((v): v is string => typeof v === "string").slice(0, PUSH_DELIVERIES_PER_JOB) : [];
  if (ids.length === 0) return;
  let rows = await db.select().from(messageDeliveries).where(and(inArray(messageDeliveries.id, ids), eq(messageDeliveries.channel, "push"), eq(messageDeliveries.status, "queued")));
  if (rows.length === 0) return;

  // Send-time re-checks: withdrawn/cancelled announcement, or an opt-out since the delivery was queued.
  const withdrawn = await withdrawnAnnouncementIds(rows.map((r) => r.announcementId));
  const optedOut = await optedOutDeliveryIds(rows);
  const skipWithdrawn = rows.filter((r) => r.announcementId !== null && withdrawn.has(r.announcementId)).map((r) => r.id);
  const skipOptout = rows.filter((r) => !skipWithdrawn.includes(r.id) && optedOut.has(r.id)).map((r) => r.id);
  if (skipWithdrawn.length) await db.update(messageDeliveries).set({ status: "skipped", errorCode: "withdrawn" }).where(and(inArray(messageDeliveries.id, skipWithdrawn), eq(messageDeliveries.status, "queued")));
  if (skipOptout.length) await db.update(messageDeliveries).set({ status: "skipped_optout" }).where(and(inArray(messageDeliveries.id, skipOptout), eq(messageDeliveries.status, "queued")));
  const skipped = new Set([...skipWithdrawn, ...skipOptout]);
  rows = rows.filter((r) => !skipped.has(r.id));
  if (rows.length === 0) return;

  const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => v !== null))];
  const tokens = userIds.length ? await db.select({ id: pushTokens.id, userId: pushTokens.userId, token: pushTokens.token }).from(pushTokens).where(and(inArray(pushTokens.userId, userIds), isNull(pushTokens.disabledAt))) : [];
  const clubIds = [...new Set(rows.map((r) => r.clubId).filter((v): v is string => v !== null))];
  const clubs = clubIds.length ? await db.select({ id: organization.id, name: organization.name }).from(organization).where(inArray(organization.id, clubIds)) : [];
  const clubName = new Map(clubs.map((c) => [c.id, c.name]));

  const pending: PendingDelivery[] = [];
  const noToken: string[] = [];
  for (const row of rows) {
    const content = row.content as DeliveryContent | null;
    const own = tokens.filter((t) => t.userId === row.userId);
    if (!content || own.length === 0) {
      noToken.push(row.id);
      continue;
    }
    const urgent = content.urgent === true;
    const template = content.template ?? "announcement";
    pending.push({
      id: row.id,
      messages: own.map((t) => ({
        tokenId: t.id,
        message: {
          to: t.token,
          title: (row.clubId ? clubName.get(row.clubId) : null) ?? "MyVerein",
          body: genericPushText(row.eventKey, template, content.lang ?? "de"),
          data: pushDataFor(row.eventKey, row.refId, row.announcementId, row.clubId, urgent),
          priority: urgent ? "high" : "default",
          channelId: urgent ? "urgent" : "default",
          sound: "default",
          ...(urgent ? { interruptionLevel: "time-sensitive" as const } : {}),
        },
      })),
    });
  }
  if (noToken.length) {
    await db.update(messageDeliveries).set({ status: "skipped_no_address", errorCode: "no_push_token" }).where(and(inArray(messageDeliveries.id, noToken), eq(messageDeliveries.status, "queued")));
  }

  // Chunks never split a delivery, so every delivery is settled by exactly one request.
  const chunks: PendingDelivery[][] = [];
  let current: PendingDelivery[] = [];
  let size = 0;
  for (const d of pending) {
    if (size + d.messages.length > EXPO_PUSH_CHUNK_SIZE && current.length) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(d);
    size += d.messages.length;
  }
  if (current.length) chunks.push(current);

  const final = job.attempt >= job.maxAttempts;
  for (const chunk of chunks) {
    const flat = chunk.flatMap((d) => d.messages.map((m) => ({ deliveryId: d.id, tokenId: m.tokenId, message: m.message })));
    let tickets: ExpoTicket[];
    try {
      const response = (await expoPost("/send", flat.map((m) => m.message))) as { data?: ExpoTicket[] };
      tickets = Array.isArray(response?.data) ? response.data : [];
      if (tickets.length !== flat.length) throw new Error("expo push api returned an unexpected number of tickets");
    } catch (err) {
      const message = err instanceof Error ? err.message : "push_failed";
      logger.error({ deliveries: chunk.length, attempt: job.attempt, final, errMessage: message.slice(0, 120) }, "[notify] push request failed");
      if (final) {
        const open = chunks.slice(chunks.indexOf(chunk)).flat().map((d) => d.id);
        await db.update(messageDeliveries).set({ status: "failed", errorCode: "push_failed", attempts: job.attempt }).where(and(inArray(messageDeliveries.id, open), eq(messageDeliveries.status, "queued")));
        return;
      }
      // Deliberately no `cause`: keeps provider response details out of jobs.last_error.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("push delivery failed");
    }

    const receiptItems: Array<{ t: string; k: string }> = [];
    const dead: string[] = [];
    const outcome = new Map<string, { ok: number; error: string | null }>();
    flat.forEach((m, i) => {
      const ticket = tickets[i] ?? {};
      const o = outcome.get(m.deliveryId) ?? { ok: 0, error: null };
      if (ticket.status === "ok" && typeof ticket.id === "string") {
        o.ok += 1;
        receiptItems.push({ t: ticket.id, k: m.tokenId });
      } else {
        const code = String(ticket.details?.error ?? "push_error").replace(/[^\w.-]/g, "").slice(0, 60) || "push_error";
        o.error ??= code;
        if (code === "DeviceNotRegistered") dead.push(m.tokenId);
      }
      outcome.set(m.deliveryId, o);
    });
    await disableTokens(dead);
    const now = new Date();
    for (const [deliveryId, o] of outcome) {
      await db
        .update(messageDeliveries)
        .set(o.ok > 0 ? { status: "sent", sentAt: now, attempts: job.attempt, errorCode: null } : { status: "failed", attempts: job.attempt, errorCode: o.error ?? "push_error" })
        .where(and(eq(messageDeliveries.id, deliveryId), eq(messageDeliveries.status, "queued")));
    }
    for (let i = 0; i < receiptItems.length; i += EXPO_RECEIPT_CHUNK_SIZE) {
      const items = receiptItems.slice(i, i + EXPO_RECEIPT_CHUNK_SIZE);
      await enqueue({ type: PUSH_RECEIPTS_JOB_TYPE, payload: { items }, runAt: new Date(Date.now() + receiptDelayMs()), dedupeKey: `${PUSH_RECEIPTS_JOB_TYPE}:${items[0]!.t}` });
    }
  }
}

/**
 * Job handler `notify.push_receipts`: asks Expo for the receipts of earlier tickets and disables tokens reported as
 * `DeviceNotRegistered`. Other receipt errors are logged by code only (no token, no address).
 */
export async function handlePushReceipts(job: JobContext): Promise<void> {
  const items = Array.isArray(job.payload.items)
    ? (job.payload.items as unknown[]).filter((v): v is { t: string; k: string } => !!v && typeof (v as { t?: unknown }).t === "string" && typeof (v as { k?: unknown }).k === "string").slice(0, EXPO_RECEIPT_CHUNK_SIZE)
    : [];
  if (items.length === 0) return;
  const response = (await expoPost("/getReceipts", { ids: items.map((i) => i.t) })) as { data?: Record<string, ExpoTicket> };
  const receipts = response?.data && typeof response.data === "object" ? response.data : {};
  const dead: string[] = [];
  const errors: Record<string, number> = {};
  let missing = 0;
  for (const item of items) {
    const receipt = receipts[item.t];
    if (!receipt) {
      missing += 1;
      continue;
    }
    if (receipt.status === "error") {
      const code = String(receipt.details?.error ?? "unknown").replace(/[^\w.-]/g, "").slice(0, 60);
      errors[code] = (errors[code] ?? 0) + 1;
      if (code === "DeviceNotRegistered") dead.push(item.k);
    }
  }
  await disableTokens([...new Set(dead)]);
  if (Object.keys(errors).length) logger.warn({ errors }, "[notify] push receipts reported errors");
  // Receipts that are not available yet: retry later (the queue's backoff) unless this was the last attempt.
  if (missing > 0 && job.attempt < job.maxAttempts) throw new Error(`push receipts not ready (${missing} missing)`);
}
