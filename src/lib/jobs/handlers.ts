import { handlePublishAnnouncement, PUBLISH_JOB_TYPE } from "../announcements.js";
import { EVENT_CHANGED_JOB_TYPE, handleEventChanged } from "../event-notify.js";
import { AGE_TRANSITION_INTERVAL_MS, AGE_TRANSITION_JOB_TYPE, handleAgeTransitionSweep } from "../age-transition.js";
import { EXIT_EFFECTIVE_INTERVAL_MS, EXIT_EFFECTIVE_NOTIFY_JOB_TYPE, EXIT_EFFECTIVE_SWEEP_JOB_TYPE, handleExitEffectiveNotify, handleExitEffectiveSweep } from "../exit-effective.js";
import { runFormCleanup } from "../form-sweeper.js";
import { handleRetentionSweep, registerRetentionTasks, RETENTION_SWEEP_INTERVAL_MS, RETENTION_SWEEP_JOB_TYPE } from "../retention.js";
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
  registerRecurringJob({ type: EXIT_EFFECTIVE_SWEEP_JOB_TYPE, intervalMs: EXIT_EFFECTIVE_INTERVAL_MS }, handleExitEffectiveSweep);
  registerJob(EXIT_EFFECTIVE_NOTIFY_JOB_TYPE, handleExitEffectiveNotify);
  registerRecurringJob({ type: FORM_CLEANUP_JOB_TYPE, intervalMs: FORM_CLEANUP_INTERVAL_MS }, async () => {
    await runFormCleanup();
  });
  registerRetentionTasks();
  registerRecurringJob({ type: RETENTION_SWEEP_JOB_TYPE, intervalMs: RETENTION_SWEEP_INTERVAL_MS }, handleRetentionSweep);
}
