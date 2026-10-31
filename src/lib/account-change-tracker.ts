import { inArray, or } from "drizzle-orm";

import { user as userTable } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { logger } from "./logger.js";
import { pickMailLanguage, type MailLanguage } from "./notify/i18n.js";

/**
 * Detects e-mail and two-factor changes on the `user` table for the security notices (G8).
 *
 * Better Auth's `databaseHooks.user.update.before(data, context)` sees only the partial update, never the row id, while
 * `.after(updatedRow, context)` sees the written row. Both run with the SAME request context object, so:
 *   - `before` snapshots (email, name, twoFactorEnabled) of every user the request could be writing to, stored under that
 *     context object in a WeakMap (per request, garbage-collected with it; nothing is keyed by a user id across requests);
 *   - `after` takes the id from the WRITTEN row, looks up that row's snapshot and compares. Which endpoint, body or
 *     session caused the write does not matter for the decision -- those sources are only used to choose whom to
 *     snapshot (admin body.userId, acting/new session, the e-mail inside a verify-email token).
 *
 * Multi-instance: a request is handled start to finish by one process, and before/after of one write run in that same
 * request, so no state is shared between requests or instances. The one thing that does not carry over is a write made
 * outside a request (seed scripts, workers, a direct `db.update`): there is no context, so it is neither tracked nor
 * announced (and `logger.debug` notes it). If a snapshot is missing although a write was announced (a request wrote a user
 * we did not predict), an e-mail change cannot be announced (the old address is unknown; logged as an error), while a
 * two-factor change is announced from the written row (over-announcing is the safe side; the dispatcher dedupes per minute).
 */
export interface UserSnapshot {
  email: string;
  name: string | null;
  twoFactorEnabled: boolean;
}

export interface AccountChange {
  userId: string;
  lang: MailLanguage;
  /** Set when the address changed: the address the person had before (to warn it) and the name stored at the time. */
  previousEmail?: { address: string; name: string | null };
  /** Set when the two-factor flag changed: its new value. */
  twoFactor?: boolean;
}

interface RequestState {
  snapshots: Map<string, UserSnapshot>;
  /** Two-factor value requested by the write(s) of this request, for the missing-snapshot fallback. */
  wantsTwoFactor?: boolean;
  wantsEmail: boolean;
}

export type HookContext = {
  body?: { userId?: unknown };
  query?: { token?: unknown };
  request?: Request;
  headers?: Headers;
  context?: { session?: { user?: { id?: string } } | null; newSession?: { user?: { id?: string } } | null };
} | null | undefined;

const states = new WeakMap<object, RequestState>();

/** Language of an account notice: the `Accept-Language` of the request that caused it (German if absent). */
export const langOfHook = (source: HookContext): MailLanguage =>
  pickMailLanguage(source?.headers?.get("accept-language") ?? source?.request?.headers.get("accept-language"));

/** The `email` claim of a verify-email token, read WITHOUT verifying it: only used to choose whom to snapshot. */
function tokenEmail(token: unknown): string | null {
  if (typeof token !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Call from `user.update.before`. Snapshots the candidate rows when the update touches the address or the two-factor flag. */
export async function rememberBeforeUserUpdate(data: Record<string, unknown>, context: HookContext): Promise<void> {
  const wantsEmail = typeof data.email === "string";
  const wantsTwoFactor = typeof data.twoFactorEnabled === "boolean";
  if (!wantsEmail && !wantsTwoFactor) return;
  if (!context) {
    logger.debug("[auth] user e-mail/two-factor update outside a request: not announced");
    return;
  }
  let state = states.get(context);
  if (!state) {
    state = { snapshots: new Map(), wantsEmail: false };
    states.set(context, state);
  }
  state.wantsEmail ||= wantsEmail;
  if (wantsTwoFactor) state.wantsTwoFactor = Boolean(data.twoFactorEnabled);

  const ids = new Set<string>();
  const bodyUserId = context.body?.userId;
  if (typeof bodyUserId === "string") ids.add(bodyUserId);
  for (const id of [context.context?.session?.user?.id, context.context?.newSession?.user?.id]) if (id) ids.add(id);
  const emails = new Set<string>();
  const fromToken = tokenEmail(context.query?.token);
  if (fromToken) emails.add(fromToken);

  const conditions = [ids.size ? inArray(userTable.id, [...ids]) : undefined, emails.size ? inArray(userTable.email, [...emails]) : undefined].filter((c) => c !== undefined);
  if (conditions.length === 0) return;
  const rows = await db
    .select({ id: userTable.id, email: userTable.email, name: userTable.name, twoFactorEnabled: userTable.twoFactorEnabled })
    .from(userTable)
    .where(or(...conditions));
  // The earliest snapshot of a request is kept: a second write in the same request must compare against the original state.
  for (const row of rows) if (!state.snapshots.has(row.id)) state.snapshots.set(row.id, { email: row.email, name: row.name, twoFactorEnabled: Boolean(row.twoFactorEnabled) });
}

/** Call from `user.update.after` with the written row. Returns what to announce (and moves the baseline to the written row). */
export function changesAfterUserUpdate(updated: { id: string; email: string; twoFactorEnabled?: boolean | null } | null | undefined, context: HookContext): AccountChange | null {
  if (!updated || !context) return null;
  const state = states.get(context);
  if (!state) return null;
  const lang = langOfHook(context);
  const snapshot = state.snapshots.get(updated.id);
  const nowTwoFactor = Boolean(updated.twoFactorEnabled);
  const change: AccountChange = { userId: updated.id, lang };

  if (snapshot) {
    if (updated.email.toLowerCase() !== snapshot.email.toLowerCase()) change.previousEmail = { address: snapshot.email, name: snapshot.name };
    if (nowTwoFactor !== snapshot.twoFactorEnabled) change.twoFactor = nowTwoFactor;
    state.snapshots.set(updated.id, { email: updated.email, name: snapshot.name, twoFactorEnabled: nowTwoFactor });
  } else {
    if (state.wantsTwoFactor !== undefined && nowTwoFactor === state.wantsTwoFactor) change.twoFactor = nowTwoFactor;
    if (state.wantsEmail) logger.error({ userId: updated.id }, "[auth] e-mail changed but no snapshot of the old address: change notice skipped");
  }
  return change.previousEmail || change.twoFactor !== undefined ? change : null;
}
