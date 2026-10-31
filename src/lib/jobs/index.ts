export { enqueue, enqueueRecurring, bucketDedupeKey, deleteFinishedJobs, type EnqueueInput } from "./queue.js";
export { registerJob, registerRecurringJob, JobRegistry, defaultRegistry, type JobContext, type JobHandler } from "./registry.js";
export { JobWorker, startJobWorker, getWorkerHeartbeat, backoffDelayMs, type WorkerOptions } from "./worker.js";
export { registerAllJobs } from "./handlers.js";

/** The worker runs in the API process unless `WORKER_ENABLED=false` (then run `dist/worker.js` separately). */
export function workerEnabled(): boolean {
  return process.env.WORKER_ENABLED !== "false";
}
