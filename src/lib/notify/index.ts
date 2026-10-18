import { defaultRegistry, type JobRegistry } from "../jobs/registry.js";
import { handleEmailDelivery } from "./email-job.js";
import { EMAIL_JOB_TYPE } from "./types.js";

export { notify, notifyInBackground, notifySafely } from "./dispatcher.js";
export { handleEmailDelivery } from "./email-job.js";
export { getMailSender, mailSendRate, resetMailThrottle, setMailSender, waitForMailSlot, type MailSender } from "./mailer.js";
export { renderNotifyEmail, textToHtml, type RenderMailInput } from "./templates.js";
export { setUnsubscribeUrlProvider, unsubscribeHeaders, unsubscribeUrlFor, type UnsubscribeSubject, type UnsubscribeUrlProvider } from "./unsubscribe.js";
export { createUnsubscribeToken, installUnsubscribeProvider, unsubscribeUrlForSubject, verifyUnsubscribeToken, type UnsubscribePayload } from "./unsubscribe-token.js";
export * from "./types.js";

/** Registers the channel job handlers of the dispatcher (called from `registerAllJobs`). */
export function registerNotifyJobs(registry: JobRegistry = defaultRegistry): void {
  registry.registerJob(EMAIL_JOB_TYPE, handleEmailDelivery);
}
