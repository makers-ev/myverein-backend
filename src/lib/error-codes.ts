import type { ErrorCode } from "./errors.js";

/**
 * Registry of the top-level `error.code` values (Wave 14 DS2). Every client-facing error body is
 * `{ error: { code, message, details? } }`; `code` is one of these, the more specific reason (if any) is
 * `error.details.code` in snake_case. The README "Error codes" section is generated from this file and from a scan of the source
 * (`npm run docs:error-codes`); `error-codes.test.ts` fails when README and code drift apart. Existing codes are never renamed.
 */
export const ERROR_CODES: Record<ErrorCode, { status: number; meaning: string }> = {
  BAD_REQUEST: { status: 400, meaning: "Malformed request (missing club id, malformed JSON, bad parameter)" },
  UNAUTHORIZED: { status: 401, meaning: "No valid session" },
  FORBIDDEN: { status: 403, meaning: "Signed in, but the role lacks the permission" },
  NOT_FOUND: { status: 404, meaning: "Unknown id, unknown route, or a resource of a club the caller does not belong to (existence is never leaked)" },
  CONFLICT: { status: 409, meaning: "The state does not allow the action (duplicate, wrong status, race); `details.code` names the reason" },
  UNPROCESSABLE_ENTITY: { status: 422, meaning: "Validation failed; `details` carries the Zod issues or a `details.code` reason" },
  TOO_MANY_REQUESTS: { status: 429, meaning: "Rate limit exceeded, retry later" },
  INTERNAL_ERROR: { status: 500, meaning: "Unexpected server error (message is not shown to users)" },
  SERVICE_UNAVAILABLE: { status: 503, meaning: "A dependency (database, mail, render engine) is temporarily unavailable" },
  ALREADY_MEMBER: { status: 409, meaning: "The caller already is a member of the club (application)" },
  APPLICATION_PENDING: { status: 409, meaning: "The caller already has an open application for the club" },
  QUOTA_EXCEEDED: { status: 422, meaning: "Storage quota or upload cap exhausted; `details.code` is `club_quota`, `unattached_cap` or `draft_upload_cap`" },
  FORM_VERSION_OUTDATED: { status: 409, meaning: "The form was republished; re-render it and keep the answers by key" },
  RECIPIENT_CONFIRMATION_REQUIRED: { status: 422, meaning: "The announcement reaches many people; resend with `confirmRecipients` set to the shown number" },
  DPA_REQUIRED: { status: 403, meaning: "The club has not accepted the processor agreement (AV-Vertrag) yet; writing is locked" },
  QUERY_TOO_SHORT: { status: 400, meaning: "Search text shorter than 2 characters (`details.code = query_too_short`)" },
};
