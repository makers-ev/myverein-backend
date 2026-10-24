import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { messageDeliveries } from "../../db/schema/communication.js";
import { jobs } from "../../db/schema/jobs.js";
import { EMAIL_JOB_TYPE, PUSH_JOB_TYPE } from "../../lib/notify/types.js";
import type { DemoCtx } from "./context.js";

/**
 * The seed sends invitations, announcements and reminders through the real notification pipeline so that the delivery proof is
 * real. The demo addresses are undeliverable by design (`*.local`), so the still queued e-mail deliveries of the demo club are
 * closed as sent here and their jobs removed: running the worker afterwards must not try to mail anybody. In-app entries stay.
 */
export async function neutralizeOutbound(ctx: DemoCtx): Promise<number> {
  const queued = await db
    .select({ id: messageDeliveries.id })
    .from(messageDeliveries)
    .where(and(eq(messageDeliveries.clubId, ctx.clubId), inArray(messageDeliveries.channel, ["email", "push"]), inArray(messageDeliveries.status, ["queued", "sending"])));
  if (queued.length === 0) return 0;
  const ids = queued.map((q) => q.id);
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await db.update(messageDeliveries).set({ status: "sent", sentAt: sql`${messageDeliveries.createdAt}`, address: null }).where(inArray(messageDeliveries.id, chunk));
    await db.delete(jobs).where(and(inArray(jobs.type, [EMAIL_JOB_TYPE, PUSH_JOB_TYPE]), inArray(jobs.status, ["queued", "failed"]), inArray(sql`${jobs.payload}->>'deliveryId'`, chunk)));
  }
  ctx.log(`${ids.length} wartende E-Mail-/Push-Zustellungen als versendet markiert (Demo-Adressen sind nicht zustellbar)`);
  return ids.length;
}
