import { and, eq, inArray, or, sql } from "drizzle-orm";

import { organization } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { clubSettings } from "../../db/schema/club-settings.js";
import { messageDeliveries } from "../../db/schema/communication.js";
import { normalizeEmail } from "../audience.js";
import { LOGO_CID, LOGO_PATH } from "../emailTemplate.js";
import { logger } from "../logger.js";
import { optedOutDeliveryIds, withdrawnAnnouncementIds } from "./guards.js";
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
 * the job ends normally. Idempotent: the row is claimed `queued` -> `sending` before the send, so a second runner skips it
 * (a `sending` row is only taken over by a LATER attempt of the job, i.e. after a crash). A withdrawn/cancelled announcement
 * or a recipient who opted out of an optional class in the meantime is skipped at send time.
 */
export async function handleEmailDelivery(job: JobContext): Promise<void> {
  const deliveryId = typeof job.payload.deliveryId === "string" ? job.payload.deliveryId : null;
  if (!deliveryId) return;
  const [delivery] = await db.select().from(messageDeliveries).where(eq(messageDeliveries.id, deliveryId));
  if (!delivery || delivery.channel !== "email") return;
  const takeOver = delivery.status === "sending" && delivery.attempts < job.attempt;
  if (delivery.status !== "queued" && !takeOver) return;
  const open = and(eq(messageDeliveries.id, deliveryId), inArray(messageDeliveries.status, ["queued", "sending"]));

  if ((await withdrawnAnnouncementIds([delivery.announcementId])).size > 0) {
    await db.update(messageDeliveries).set({ status: "skipped", errorCode: "withdrawn" }).where(open);
    return;
  }
  if ((await optedOutDeliveryIds([delivery])).size > 0) {
    await db.update(messageDeliveries).set({ status: "skipped_optout" }).where(open);
    return;
  }

  const content = delivery.content as DeliveryContent | null;
  if (!delivery.address || !content) {
    await db.update(messageDeliveries).set({ status: "skipped_no_address", errorCode: "no_address" }).where(open);
    return;
  }

  const claimed = await db
    .update(messageDeliveries)
    .set({ status: "sending", attempts: job.attempt })
    .where(and(eq(messageDeliveries.id, deliveryId), or(eq(messageDeliveries.status, "queued"), and(eq(messageDeliveries.status, "sending"), sql`${messageDeliveries.attempts} < ${job.attempt}`))))
    .returning({ id: messageDeliveries.id });
  if (claimed.length === 0) return;

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
      .set({ attempts: job.attempt, errorCode: code, status: final ? "failed" : "queued" })
      .where(and(eq(messageDeliveries.id, deliveryId), eq(messageDeliveries.status, "sending")));
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
    .where(and(eq(messageDeliveries.id, deliveryId), eq(messageDeliveries.status, "sending")));
  if (content.sensitive) await scrubContent(deliveryId, content);
}

/**
 * Reaper: a delivery still `queued`/`sending` although its job ended `dead` (lease expired after the last attempt, so the
 * handler never got to mark it) becomes `failed` (`job_dead`) and shows up for resend-failed. Rows with a live job
 * (e.g. re-queued by resend-failed) are left alone. Returns the number of rows changed.
 */
export async function reapDeadDeliveries(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE message_deliveries d SET status = 'failed', error_code = 'job_dead'
    WHERE d.status IN ('queued', 'sending')
      AND (
        (d.channel = 'email' AND EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'notify.email' AND j.status = 'dead' AND j.payload->>'deliveryId' = d.id::text)
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'notify.email' AND j.status IN ('queued', 'running', 'failed') AND j.payload->>'deliveryId' = d.id::text))
        OR
        (d.channel = 'push' AND EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'notify.push' AND j.status = 'dead' AND j.payload->'deliveryIds' ? d.id::text)
          AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'notify.push' AND j.status IN ('queued', 'running', 'failed') AND j.payload->'deliveryIds' ? d.id::text))
      )`);
  return result.rowCount ?? 0;
}

/** Wipes secrets (invite link) from the proof-of-delivery row; title and the fact of delivery stay. */
async function scrubContent(deliveryId: string, content: DeliveryContent): Promise<void> {
  const scrubbed: Record<string, unknown> = { ...content, body: "", ctaUrl: null, rendered: null };
  await db.update(messageDeliveries).set({ content: scrubbed }).where(eq(messageDeliveries.id, deliveryId));
}
