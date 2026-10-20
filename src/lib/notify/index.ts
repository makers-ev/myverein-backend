import { defaultRegistry, type JobRegistry } from "../jobs/registry.js";
import { handleEmailDelivery, reapDeadDeliveries } from "./email-job.js";
import { handlePushDelivery, handlePushReceipts } from "./push.js";
import { DELIVERY_REAPER_INTERVAL_MS, DELIVERY_REAPER_JOB_TYPE, EMAIL_JOB_TYPE, PUSH_JOB_TYPE, PUSH_RECEIPTS_JOB_TYPE } from "./types.js";

export { notify, notifyInBackground, notifySafely } from "./dispatcher.js";
export { handleEmailDelivery, reapDeadDeliveries } from "./email-job.js";
export { getMailSender, mailSendRate, resetMailThrottle, setMailSender, waitForMailSlot, type MailSender } from "./mailer.js";
export { genericPushText, handlePushDelivery, handlePushReceipts, pushDataFor, setPushFetch, type PushFetch } from "./push.js";
export { renderNotifyEmail, textToHtml, type RenderMailInput } from "./templates.js";
export { setUnsubscribeUrlProvider, unsubscribeHeaders, unsubscribeUrlFor, type UnsubscribeSubject, type UnsubscribeUrlProvider } from "./unsubscribe.js";
export { createUnsubscribeToken, installUnsubscribeProvider, unsubscribeBaseUrl, unsubscribeUrlForSubject, verifyUnsubscribeToken, type UnsubscribePayload } from "./unsubscribe-token.js";
export * from "./types.js";

/** Registers the channel job handlers of the dispatcher (called from `registerAllJobs`). */
export function registerNotifyJobs(registry: JobRegistry = defaultRegistry): void {
  registry.registerJob(EMAIL_JOB_TYPE, handleEmailDelivery);
  registry.registerJob(PUSH_JOB_TYPE, handlePushDelivery);
  registry.registerJob(PUSH_RECEIPTS_JOB_TYPE, handlePushReceipts);
  registry.registerRecurringJob({ type: DELIVERY_REAPER_JOB_TYPE, intervalMs: DELIVERY_REAPER_INTERVAL_MS }, async () => {
    await reapDeadDeliveries();
  });
}
