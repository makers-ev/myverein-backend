import { handlePublishAnnouncement, PUBLISH_JOB_TYPE } from "../announcements.js";
import { EVENT_CHANGED_JOB_TYPE, handleEventChanged } from "../event-notify.js";
import { registerNotifyJobs } from "../notify/index.js";
import { installUnsubscribeProvider } from "../notify/unsubscribe-token.js";
import { registerJob } from "./registry.js";

/**
 * Registers every job handler of the app. Called by both entry points (the API process and `worker.ts`) before the
 * worker starts. Wave 9 packages add their handlers here (reminder-sweep, notification dispatch, age_transition_sweep, ...);
 * B4 ships the engine without functional jobs.
 */
let registered = false;

export function registerAllJobs(): void {
  if (registered) return;
  registered = true;
  registerNotifyJobs();
  installUnsubscribeProvider();
  registerJob(PUBLISH_JOB_TYPE, handlePublishAnnouncement);
  registerJob(EVENT_CHANGED_JOB_TYPE, handleEventChanged);
}
