/**
 * AppError hierarchy -> HTTP status mapping.
 *
 * Keep this generic and framework-light: routes/middleware catch `AppError`
 * (or its subclasses) and translate them into a JSON error response. This is
 * intentionally the ONLY place HTTP status codes are decided for domain
 * errors, so behaviour stays consistent across every route.
 */

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE_ENTITY"
  | "TOO_MANY_REQUESTS"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE";

export interface AppErrorOptions {
  cause?: unknown;
  details?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, status: number, message: string, options: AppErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = options.details;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", options?: AppErrorOptions) {
    super("BAD_REQUEST", 400, message, options);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", options?: AppErrorOptions) {
    super("UNAUTHORIZED", 401, message, options);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", options?: AppErrorOptions) {
    super("FORBIDDEN", 403, message, options);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", options?: AppErrorOptions) {
    super("NOT_FOUND", 404, message, options);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", options?: AppErrorOptions) {
    super("CONFLICT", 409, message, options);
    this.name = "ConflictError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", options?: AppErrorOptions) {
    super("UNPROCESSABLE_ENTITY", 422, message, options);
    this.name = "ValidationError";
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests", options?: AppErrorOptions) {
    super("TOO_MANY_REQUESTS", 429, message, options);
    this.name = "TooManyRequestsError";
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", options?: AppErrorOptions) {
    super("SERVICE_UNAVAILABLE", 503, message, options);
    this.name = "ServiceUnavailableError";
  }
}

export class InternalError extends AppError {
  constructor(message = "Internal server error", options?: AppErrorOptions) {
    super("INTERNAL_ERROR", 500, message, options);
    this.name = "InternalError";
  }
}

/** Normalizes any thrown value into an AppError, without leaking internals. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new InternalError(err.message, { cause: err });
  }
  return new InternalError("Unknown error", { cause: err });
}
