import { BALLOT_SWEEP_INTERVAL_MS, BALLOT_SWEEP_JOB_TYPE, handleBallotNotify, handleBallotSweep } from "../ballot-jobs.js";
import { BALLOT_NOTIFY_JOB } from "../ballots.js";
import { handlePublishAnnouncement, PUBLISH_JOB_TYPE } from "../announcements.js";
import { EVENT_CHANGED_JOB_TYPE, handleEventChanged } from "../event-notify.js";
import { AGE_TRANSITION_INTERVAL_MS, AGE_TRANSITION_JOB_TYPE, AGE_TRANSITION_MEMBER_JOB_TYPE, handleAgeTransitionMemberNotify, handleAgeTransitionSweep } from "../age-transition.js";
import { EXIT_EFFECTIVE_INTERVAL_MS, EXIT_EFFECTIVE_NOTIFY_JOB_TYPE, EXIT_EFFECTIVE_SWEEP_JOB_TYPE, handleExitEffectiveNotify, handleExitEffectiveSweep } from "../exit-effective.js";
import { handleMajorityNotify, handleMajoritySweep, MAJORITY_NOTIFY_JOB_TYPE, MAJORITY_SWEEP_INTERVAL_MS, MAJORITY_SWEEP_JOB_TYPE } from "../majority.js";
import { DPA_NOTIFY_JOB_TYPE, handleDpaVersionNotify } from "../dpa.js";
import { runFormCleanup } from "../form-sweeper.js";
import { handleRetentionSweep, registerRetentionTasks, RETENTION_SWEEP_INTERVAL_MS, RETENTION_SWEEP_JOB_TYPE } from "../retention.js";
import { handleTermNotify, handleTermSweep, TERM_NOTIFY_JOB_TYPE, TERM_SWEEP_INTERVAL_MS, TERM_SWEEP_JOB_TYPE } from "../term-jobs.js";
import { handleSeriesRefill, SERIES_REFILL_INTERVAL_MS, SERIES_REFILL_JOB_TYPE } from "../event-series-refill.js";
import { GUEST_SWEEP_INTERVAL_MS, GUEST_SWEEP_JOB_TYPE, sweepUnconfirmedGuests } from "../event-guests.js";
import { handleHelperReminders, HELPER_REMINDER_INTERVAL_MS, HELPER_REMINDER_JOB_TYPE } from "../helper-reminders.js";
import { DOCUMENT_TRASH_INTERVAL_MS, DOCUMENT_TRASH_JOB_TYPE, handleDocumentTrashPurge, handleMediaOrphanSweep, MEDIA_ORPHAN_SWEEP_INTERVAL_MS, MEDIA_ORPHAN_SWEEP_JOB_TYPE } from "../media-jobs.js";
import { registerNotifyJobs } from "../notify/index.js";
import { installUnsubscribeProvider } from "../notify/unsubscribe-token.js";
import { handleReminder, handleReminderSweep, REMINDER_JOB_TYPE, REMINDER_SWEEP_INTERVAL_MS, REMINDER_SWEEP_JOB_TYPE } from "../reminders.js";
import { registerJob, registerRecurringJob } from "./registry.js";

/**
 * Registers every job handler of the app. Called by both entry points (the API process and `worker.ts`) before the
 * worker starts. New jobs (and retention tasks, see `registerRetentionTasks`) are added here.
 */
export const FORM_CLEANUP_JOB_TYPE = "form_cleanup_sweep";
export const FORM_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let registered = false;

export function registerAllJobs(): void {
  if (registered) return;
  registered = true;
  registerNotifyJobs();
  installUnsubscribeProvider();
  registerJob(PUBLISH_JOB_TYPE, handlePublishAnnouncement);
  registerJob(EVENT_CHANGED_JOB_TYPE, handleEventChanged);
  registerRecurringJob({ type: REMINDER_SWEEP_JOB_TYPE, intervalMs: REMINDER_SWEEP_INTERVAL_MS }, handleReminderSweep);
  registerJob(REMINDER_JOB_TYPE, handleReminder);
  registerRecurringJob({ type: AGE_TRANSITION_JOB_TYPE, intervalMs: AGE_TRANSITION_INTERVAL_MS }, handleAgeTransitionSweep);
  registerJob(AGE_TRANSITION_MEMBER_JOB_TYPE, handleAgeTransitionMemberNotify);
  registerRecurringJob({ type: MAJORITY_SWEEP_JOB_TYPE, intervalMs: MAJORITY_SWEEP_INTERVAL_MS }, handleMajoritySweep);
  registerJob(MAJORITY_NOTIFY_JOB_TYPE, handleMajorityNotify);
  registerRecurringJob({ type: EXIT_EFFECTIVE_SWEEP_JOB_TYPE, intervalMs: EXIT_EFFECTIVE_INTERVAL_MS }, handleExitEffectiveSweep);
  registerJob(EXIT_EFFECTIVE_NOTIFY_JOB_TYPE, handleExitEffectiveNotify);
  registerRecurringJob({ type: FORM_CLEANUP_JOB_TYPE, intervalMs: FORM_CLEANUP_INTERVAL_MS }, async () => {
    await runFormCleanup();
  });
  registerJob(DPA_NOTIFY_JOB_TYPE, handleDpaVersionNotify);
  registerRecurringJob({ type: BALLOT_SWEEP_JOB_TYPE, intervalMs: BALLOT_SWEEP_INTERVAL_MS }, handleBallotSweep);
  registerJob(BALLOT_NOTIFY_JOB, handleBallotNotify);
  registerRecurringJob({ type: TERM_SWEEP_JOB_TYPE, intervalMs: TERM_SWEEP_INTERVAL_MS }, handleTermSweep);
  registerJob(TERM_NOTIFY_JOB_TYPE, handleTermNotify);
  registerRecurringJob({ type: SERIES_REFILL_JOB_TYPE, intervalMs: SERIES_REFILL_INTERVAL_MS }, handleSeriesRefill);
  registerRecurringJob({ type: HELPER_REMINDER_JOB_TYPE, intervalMs: HELPER_REMINDER_INTERVAL_MS }, handleHelperReminders);
  registerRecurringJob({ type: GUEST_SWEEP_JOB_TYPE, intervalMs: GUEST_SWEEP_INTERVAL_MS }, async () => {
    await sweepUnconfirmedGuests();
  });
  registerRecurringJob({ type: MEDIA_ORPHAN_SWEEP_JOB_TYPE, intervalMs: MEDIA_ORPHAN_SWEEP_INTERVAL_MS }, handleMediaOrphanSweep);
  registerRecurringJob({ type: DOCUMENT_TRASH_JOB_TYPE, intervalMs: DOCUMENT_TRASH_INTERVAL_MS }, handleDocumentTrashPurge);
  registerRetentionTasks();
  registerRecurringJob({ type: RETENTION_SWEEP_JOB_TYPE, intervalMs: RETENTION_SWEEP_INTERVAL_MS }, handleRetentionSweep);
}
