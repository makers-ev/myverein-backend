import { eq, and } from "drizzle-orm";

import { organization } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { clubSettings } from "../../db/schema/club-settings.js";
import { messageDeliveries } from "../../db/schema/communication.js";
import { normalizeEmail } from "../audience.js";
import { LOGO_CID, LOGO_PATH } from "../emailTemplate.js";
import { logger } from "../logger.js";
import type { JobContext } from "../jobs/registry.js";
import { getMailSender, waitForMailSlot } from "./mailer.js";
import { oneLine, renderNotifyEmail } from "./templates.js";
import { unsubscribeHeaders, unsubscribeUrlFor } from "./unsubscribe.js";
import type { DeliveryContent } from "./types.js";

const logoAttachment = [{ filename: "logo.png", path: LOGO_PATH, cid: LOGO_CID }];

function errorCode(err: unknown): string {
  const e = err as { code?: unknown; responseCode?: unknown; name?: unknown } | undefined;
  const raw = e?.code ?? e?.responseCode ?? e?.name ?? "send_failed";
  return String(raw).replace(/[^\w.-]/g, "").slice(0, 60) || "send_failed";
}

/**
 * Job handler `notify.email`: sends the mail of ONE delivery row (one mail per recipient, a single `to`, never CC/BCC).
 * Failure -> the job is retried with backoff (the queue's job); on the last attempt the delivery becomes `failed` and
 * the job ends normally. Idempotent: only a `queued` row is ever sent.
 */
export async function handleEmailDelivery(job: JobContext): Promise<void> {
  const deliveryId = typeof job.payload.deliveryId === "string" ? job.payload.deliveryId : null;
  if (!deliveryId) return;
  const [delivery] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, deliveryId));
  if (!delivery || delivery.channel !== "email" || delivery.status !== "queued") return;

  const content = delivery.content as DeliveryContent | null;
  if (!delivery.address || !content) {
    await db.update(messageDeliveries).set({ status: "skipped_no_address", errorCode: "no_address" }).where(and(eq(messageDeliveries.id, deliveryId), eq(messageDeliveries.status, "queued")));
    return;
  }

  let clubName: string | null = null;
  let fromName: string | null = null;
  let replyTo: string | null = null;
  let signature: string | null = null;
  if (delivery.clubId) {
    const [club] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, delivery.clubId));
    const [settings] = await db.select().from(clubSettings).where(eq(clubSettings.clubId, delivery.clubId));
    clubName = club?.name ?? null;
    fromName = settings?.senderName?.trim() || clubName;
    replyTo = normalizeEmail(settings?.replyTo);
    signature = settings?.signature ?? null;
  }

  // The unsubscribe link only belongs to optional messages; mandatory ones cannot be switched off.
  const unsubscribeUrl =
    content.class === "optional" ? unsubscribeUrlFor({ clubId: delivery.clubId, userId: delivery.userId, clubMemberId: delivery.clubMemberId, category: content.category }) : null;

  const { subject, html } = content.rendered ?? renderNotifyEmail({
    template: content.template,
    title: content.title,
    body: content.body,
    recipientName: content.recipientName,
    clubName,
    ctaLabel: content.ctaLabel,
    ctaUrl: content.ctaUrl,
    signature,
    unsubscribeUrl,
  });

  await waitForMailSlot();
  try {
    await getMailSender()({
      to: delivery.address,
      subject: oneLine(subject),
      html,
      attachments: logoAttachment,
      fromName,
      replyTo,
      ...(unsubscribeUrl ? { headers: unsubscribeHeaders(unsubscribeUrl) } : {}),
    });
  } catch (err) {
    const code = errorCode(err);
    const final = job.attempt >= job.maxAttempts;
    await db
      .update(messageDeliveries)
      .set({ attempts: job.attempt, errorCode: code, ...(final ? { status: "failed" } : {}) })
      .where(and(eq(messageDeliveries.id, deliveryId), eq(messageDeliveries.status, "queued")));
    // Never log the address or the raw error (SMTP errors echo the recipient).
    logger.error({ deliveryId, eventKey: delivery.eventKey, attempt: job.attempt, errCode: code, final }, "[notify] failed to send email");
    if (final) {
      if (content.sensitive) await scrubContent(deliveryId, content);
      return;
    }
    // Deliberately no `cause`: the provider error usually echoes the recipient address and ends up in jobs.last_error.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`mail delivery failed (${code})`);
  }
  await db
    .update(messageDeliveries)
    .set({ status: "sent", sentAt: new Date(), attempts: job.attempt, errorCode: null })
    .where(and(eq(messageDeliveries.id, deliveryId), eq(messageDeliveries.status, "queued")));
  if (content.sensitive) await scrubContent(deliveryId, content);
}

/** Wipes secrets (invite link) from the proof-of-delivery row; title and the fact of delivery stay. */
async function scrubContent(deliveryId: string, content: DeliveryContent): Promise<void> {
  const scrubbed: Record<string, unknown> = { ...content, body: "", ctaUrl: null, rendered: null };
  await db.update(messageDeliveries).set({ content: scrubbed }).where(eq(messageDeliveries.id, deliveryId));
}
