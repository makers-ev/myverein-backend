import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import type { Hono } from "hono";

import { auth } from "../auth/auth.js";
import { organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { toAppError } from "../lib/errors.js";

/**
 * Test support for the form builder integration tests (forms.test.ts, form-submissions.test.ts). Not imported by
 * production code.
 */

export type Account = { userId: string; cookie: string };

export async function signUpAndVerify(email: string, name: string): Promise<Account> {
  const { user: created } = await auth.api.createUser({ body: { email, password: "test-password-123!", name } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
  const signIn = await auth.api.signInEmail({ body: { email, password: "test-password-123!" }, asResponse: true });
  return { userId: created.id, cookie: (signIn.headers.get("set-cookie") ?? "").split(";")[0]! };
}

export function installErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    const appError = toAppError(err);
    return c.json(appError.toJSON(), appError.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
  });
}

/** Request helper: JSON body, optional club (as `?clubId=`), fresh `x-forwarded-for` so IP rate limits never interfere. */
export function requester(app: Hono) {
  return (who: Account, path: string, init: { method?: string; body?: unknown; clubId?: string; form?: FormData; headers?: Record<string, string> } = {}) => {
    const url = init.clubId ? `${path}${path.includes("?") ? "&" : "?"}clubId=${init.clubId}` : path;
    const headers: Record<string, string> = { cookie: who.cookie, "x-forwarded-for": randomUUID(), ...init.headers };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return app.request(url, { method: init.method ?? "GET", headers, body: init.form ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) });
  };
}

/** Creates a club with a founder who holds `vorsitz`, plus optional members with one club role each. */
export async function createClub(label: string, suffix: number, extraRoles: Record<string, string | null> = {}) {
  const founder = await signUpAndVerify(`forms-${label}-founder-${suffix}@example.com`, `Founder ${label}`);
  const club = await auth.api.createOrganization({ body: { name: `Forms ${label} ${suffix}`, slug: `forms-${label}-${suffix}`, userId: founder.userId } });
  const clubId = club!.id;
  const memberOf = (userId: string) => db.query.member.findFirst({ where: (m, { and, eq: e }) => and(e(m.organizationId, clubId), e(m.userId, userId)) });
  await db.insert(clubRoles).values({ memberId: (await memberOf(founder.userId))!.id, roleType: "vorsitz" });

  const members: Record<string, Account> = {};
  const userIds = [founder.userId];
  for (const [name, roleType] of Object.entries(extraRoles)) {
    const account = await signUpAndVerify(`forms-${label}-${name}-${suffix}@example.com`, `${name} ${label}`);
    userIds.push(account.userId);
    await auth.api.addMember({ body: { userId: account.userId, organizationId: clubId, role: "member" } });
    if (roleType) await db.insert(clubRoles).values({ memberId: (await memberOf(account.userId))!.id, roleType });
    members[name] = account;
  }
  return { clubId, slug: `forms-${label}-${suffix}`, founder, members, userIds };
}

export async function dropClubs(clubIds: string[], userIds: string[]): Promise<void> {
  for (const id of clubIds) await db.delete(organization).where(eq(organization.id, id));
  for (const id of userIds) await db.delete(user).where(eq(user.id, id));
}

/** A complete, publishable Aufnahme definition (mirrors the standard form) plus one extra text field. */
export const aufnahmeFields = (extra: unknown[] = []) => [
  { key: "category", type: "select", label: "Mitgliedschaft", required: true, optionsSource: "member_categories", mapsTo: "category" },
  { key: "birth_date", type: "date", label: "Geburtsdatum", required: false, mapsTo: "birthDate" },
  { key: "privacy_notice", type: "info", infoKind: "privacy_notice", label: "Datenschutzhinweis" },
  { key: "privacy_consent", type: "consent", label: "Ich willige ein.", required: true },
  ...extra,
];

/**
 * Turns an old-style apply body (`category`, `birthDate`) into the form-builder one against the STANDARD application form
 * (the legacy request is refused with `form_required` while the club's form asks for a consent). Bodies without a club
 * (validation tests) and bodies that already carry answers pass through.
 */
export function withConsent<T extends Record<string, unknown>>(body: T): Record<string, unknown> {
  if (!("clubId" in body || "clubSlug" in body) || "answers" in body || "submissionId" in body) return body;
  const { category, birthDate, ...rest } = body;
  return { ...rest, answers: { category: category ?? "aktiv", ...(birthDate ? { birth_date: birthDate } : {}), privacy_consent: true } };
}
