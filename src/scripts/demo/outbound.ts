import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { meetingInvitationDeliveries, meetingInvitations } from "../../db/schema/assembly.js";
import { meetings } from "../../db/schema/meetings.js";
import { messageDeliveries } from "../../db/schema/communication.js";
import { jobs } from "../../db/schema/jobs.js";
import { syncInvitationDeliveries } from "../../lib/assembly-invitation.js";
import { EMAIL_JOB_TYPE, PUSH_JOB_TYPE } from "../../lib/notify/types.js";
import type { DemoCtx } from "./context.js";

/**
 * The seed sends invitations, announcements and reminders through the real notification pipeline so that the delivery proof is
 * real. The demo addresses are undeliverable by design (`*.local`), so the still queued e-mail deliveries of the demo club are
 * closed as sent here and their jobs removed: running the worker afterwards must not try to mail anybody. In-app entries stay.
 */
export async function neutralizeOutbound(ctx: DemoCtx): Promise<number> {
  const count = await closeQueuedMessages(ctx);
  await settleInvitationProof(ctx);
  return count;
}

async function closeQueuedMessages(ctx: DemoCtx): Promise<number> {
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

/**
 * The delivery proof of every invitation follows the (now closed) mails; members without any address stay on the post list.
 * Older invitations were posted by hand ("manual_posted"), the newest one still waits for the clerk.
 */
async function settleInvitationProof(ctx: DemoCtx): Promise<void> {
  const rows = await db
    .select({ id: meetingInvitations.id, meetingId: meetingInvitations.meetingId, sentAt: meetingInvitations.sentAt, version: meetingInvitations.version })
    .from(meetingInvitations)
    .innerJoin(meetings, eq(meetings.id, meetingInvitations.meetingId))
    .where(eq(meetings.clubId, ctx.clubId))
    .orderBy(asc(meetingInvitations.sentAt));
  const newestPerMeeting = new Map<string, number>();
  for (const r of rows) newestPerMeeting.set(r.meetingId, Math.max(newestPerMeeting.get(r.meetingId) ?? 0, r.version));
  for (const inv of rows) {
    await syncInvitationDeliveries(inv.id);
    const proofAt = new Date(inv.sentAt.getTime() + 2 * 60_000);
    await db.update(meetingInvitationDeliveries).set({ statusAt: proofAt }).where(and(eq(meetingInvitationDeliveries.invitationId, inv.id), inArray(meetingInvitationDeliveries.channel, ["email", "inapp"])));
    const posted = inv.version < (newestPerMeeting.get(inv.meetingId) ?? 0) || inv.sentAt.getTime() < ctx.now.getTime() - 7 * 86_400_000;
    if (posted) {
      const day = new Date(inv.sentAt.getTime() + 86_400_000);
      await db
        .update(meetingInvitationDeliveries)
        .set({ status: "manual_posted", postedAt: day, statusAt: day })
        .where(and(eq(meetingInvitationDeliveries.invitationId, inv.id), eq(meetingInvitationDeliveries.channel, "post")));
    }
  }
}
