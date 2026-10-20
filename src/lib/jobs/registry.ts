/** Context handed to a job handler. `payload` must only carry ids / non-personal parameters. */
export interface JobContext {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  /** 1-based number of the current attempt. */
  attempt: number;
  maxAttempts: number;
}

export type JobHandler = (job: JobContext) => Promise<void>;

export interface RecurringSpec {
  type: string;
  intervalMs: number;
  payload: Record<string, unknown>;
}

/**
 * Handler registry (`registerJob(type, handler)`). The default instance is used by the app; tests create their own so
 * workers in parallel test files never see each other's job types.
 */
export class JobRegistry {
  private readonly handlers = new Map<string, JobHandler>();
  private readonly recurring = new Map<string, RecurringSpec>();

  registerJob(type: string, handler: JobHandler): void {
    if (this.handlers.has(type)) throw new Error(`job type already registered: ${type}`);
    this.handlers.set(type, handler);
  }

  /** Registers a handler that is also scheduled every `intervalMs` (minimum 60 s) by the worker via time-bucketed dedupe keys. */
  registerRecurringJob(spec: { type: string; intervalMs: number; payload?: Record<string, unknown> }, handler: JobHandler): void {
    this.registerJob(spec.type, handler);
    this.recurring.set(spec.type, { type: spec.type, intervalMs: Math.max(60_000, Math.floor(spec.intervalMs)), payload: spec.payload ?? {} });
  }

  getHandler(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }

  recurringSpecs(): RecurringSpec[] {
    return [...this.recurring.values()];
  }
}

export const defaultRegistry = new JobRegistry();

export function registerJob(type: string, handler: JobHandler): void {
  defaultRegistry.registerJob(type, handler);
}

export function registerRecurringJob(spec: { type: string; intervalMs: number; payload?: Record<string, unknown> }, handler: JobHandler): void {
  defaultRegistry.registerRecurringJob(spec, handler);
}
