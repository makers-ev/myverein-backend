import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
  toAppError,
} from "./errors.js";

describe("AppError subclasses", () => {
  it.each([
    [BadRequestError, "BAD_REQUEST", 400],
    [UnauthorizedError, "UNAUTHORIZED", 401],
    [ForbiddenError, "FORBIDDEN", 403],
    [NotFoundError, "NOT_FOUND", 404],
    [ConflictError, "CONFLICT", 409],
    [ValidationError, "UNPROCESSABLE_ENTITY", 422],
    [TooManyRequestsError, "TOO_MANY_REQUESTS", 429],
    [ServiceUnavailableError, "SERVICE_UNAVAILABLE", 503],
    [InternalError, "INTERNAL_ERROR", 500],
  ] as const)("%s maps to %s / %i", (ErrorClass, code, status) => {
    const err = new ErrorClass("boom");
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.toJSON()).toEqual({ error: { code, message: "boom" } });
  });

  it("includes details in toJSON when provided", () => {
    const err = new ValidationError("bad body", { details: { field: "name" } });
    expect(err.toJSON()).toEqual({
      error: { code: "UNPROCESSABLE_ENTITY", message: "bad body", details: { field: "name" } },
    });
  });
});

describe("toAppError", () => {
  it("passes AppError instances through unchanged", () => {
    const original = new NotFoundError("missing");
    expect(toAppError(original)).toBe(original);
  });

  it("wraps a generic Error as a 500 InternalError, currently preserving its message", () => {
    // Documents actual current behaviour: toAppError does NOT scrub the
    // original message for a plain Error, only the code/status are
    // normalized. If that intentionally changes, update this test.
    const result = toAppError(new Error("db connection string invalid"));
    expect(result).toBeInstanceOf(InternalError);
    expect(result.status).toBe(500);
    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).toBe("db connection string invalid");
  });

  it("wraps a non-Error throw as a generic 500 with no message leak", () => {
    const result = toAppError("some string throw");
    expect(result).toBeInstanceOf(InternalError);
    expect(result.status).toBe(500);
    expect(result.message).toBe("Unknown error");
  });

  it("returned value is always an AppError", () => {
    expect(toAppError(null)).toBeInstanceOf(AppError);
  });
});

describe("toAppError for framework HTTP errors", () => {
  it("keeps 4xx statuses of HTTPException (malformed JSON is a 400, not a 500)", () => {
    const bad = toAppError(new HTTPException(400, { message: "Malformed JSON in request body" }));
    expect([bad.status, bad.code, bad.message]).toEqual([400, "BAD_REQUEST", "Malformed JSON in request body"]);
    expect(toAppError(new HTTPException(404)).code).toBe("NOT_FOUND");
    expect(toAppError(new HTTPException(413)).status).toBe(413);
    expect(toAppError(new HTTPException(500, { message: "x" })).status).toBe(500);
    expect(toAppError(new Error("plain")).status).toBe(500);
  });
});
