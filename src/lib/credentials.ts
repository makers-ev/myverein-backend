/**
 * Expiry semantics of `credential` custom field values (profile modules): `{ valid: true, level?, obtainedOn?, validUntil? }`.
 *
 * All dates are ISO `YYYY-MM-DD`; "today" is the Europe/Berlin calendar day (`todayBerlin`), so a credential does not flip
 * to expired an hour early/late around midnight because of UTC. A credential is valid THROUGH its `validUntil` day:
 *
 * - no value                      -> `missing`  (not held / not recorded), `daysLeft: null`
 * - value without `validUntil`    -> `valid`    (does not expire), `daysLeft: null`
 * - `validUntil < today`          -> `expired`  (`daysLeft` negative: -1 = expired yesterday)
 * - `today <= validUntil <= today + withinDays` -> `expiring` (`daysLeft` 0 = last valid day is today)
 * - later                         -> `valid`
 *
 * No notifications or reminders are sent (Wave 9); the status is only computed for display and filtering.
 */

export type CredentialStatus = "expired" | "expiring" | "valid" | "missing";
export const CREDENTIAL_STATUSES: readonly CredentialStatus[] = ["expired", "expiring", "valid", "missing"];
export const DEFAULT_EXPIRING_DAYS = 90;
export const MAX_EXPIRING_DAYS = 730;

export interface CredentialExpiry {
  status: CredentialStatus;
  /** Days from today to `validUntil` (negative once expired); null without a value or without `validUntil`. */
  daysLeft: number | null;
  validUntil: string | null;
}

/** Whole days from `from` to `to` (both strict ISO dates). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `date` plus `days` calendar days (ISO in, ISO out). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function credentialExpiry(value: unknown, today: string, withinDays = DEFAULT_EXPIRING_DAYS): CredentialExpiry {
  if (value === null || value === undefined || typeof value !== "object") return { status: "missing", daysLeft: null, validUntil: null };
  const until = (value as { validUntil?: unknown }).validUntil;
  if (typeof until !== "string") return { status: "valid", daysLeft: null, validUntil: null };
  const daysLeft = daysBetween(today, until);
  return { status: daysLeft < 0 ? "expired" : daysLeft <= withinDays ? "expiring" : "valid", daysLeft, validUntil: until };
}

/** A credential value as one export cell, e.g. `Ja, Stufe: B, seit: 2020-01-01, bis: 2027-01-01` (never starts with a formula character). */
export function formatCredential(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const v = value as { level?: unknown; obtainedOn?: unknown; validUntil?: unknown };
  const parts = ["Ja"];
  if (typeof v.level === "string" && v.level !== "") parts.push(`Stufe: ${v.level}`);
  if (typeof v.obtainedOn === "string") parts.push(`seit: ${v.obtainedOn}`);
  if (typeof v.validUntil === "string") parts.push(`bis: ${v.validUntil}`);
  return parts.join(", ");
}
