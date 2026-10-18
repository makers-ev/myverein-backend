import { registerNotifyJobs } from "../notify/index.js";

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
}
