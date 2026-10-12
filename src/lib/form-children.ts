import { and, count, eq, inArray, sql } from "drizzle-orm";

import { auth } from "../auth/auth.js";
import { member } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMembers, clubMemberStatusHistory } from "../db/schema/club-members.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { formSubmissions } from "../db/schema/forms.js";
import { guardianLinks } from "../db/schema/guardian-links.js";
import { assertRejoinAllowed, type DbExecutor, ensureClubMember } from "./club-members.js";
import { ConflictError, ForbiddenError, ValidationError } from "./errors.js";
import { planAcceptance, type AcceptancePlan } from "./form-acceptance.js";
import { type FormField } from "./form-schema.js";
import { ageOn, effectiveStatus, isLeftStatus, todayBerlin } from "./member-lifecycle.js";

/**
 * Application of a parent for a child (Wave 8 B8, `on_behalf_of = 'guardian'`).
 *
 * The model, in one place:
 * - The PARENT is the submitter (`submitted_by_user_id`, `club_applications.user_id`); the form's answers describe the CHILD
 *   (the form must map `firstName` and `lastName`, otherwise there is nobody to name).
 * - Nothing about the child exists as a record until the board accepts: then an ACCOUNT-LESS `club_members` row is created
 *   (`member_id` NULL), the form is mapped onto it (same allowlist as for adults), and a `guardian_links` row (child <- parent)
 *   is written. That is the ONLY way a guardian link comes into being besides the board's own `POST /club-members/:id/guardians`:
 *   a parent never names an existing ward, so they cannot attach themselves to someone else's child.
 * - The parent keeps whatever account membership they have. Without one they get an external one (`member.role = 'guest'`,
 *   club role `erziehungsberechtigt`, `club_members.status = 'interessent'`: not a member, not shown to plain members, no dues).
 * - Consent evidence names the consenting guardian and the time (see `consentEvidence`).
 */

/** `member.role` of an external account (Better Auth stores it as free text; its typings only know the built-in roles). */
const EXTERNAL_GUEST_ROLE = "guest" as unknown as "member";

/** Child applications (draft or submitted, not yet decided) one account may have open at the same time, over all clubs. */
export const MAX_OPEN_CHILD_APPLICATIONS = 5;

/** The field definition can name a child: a visible-capable `firstName` and `lastName` mapping exist. */
export function supportsChildApplication(fields: readonly FormField[]): boolean {
  return fields.some((f) => f.mapsTo === "firstName") && fields.some((f) => f.mapsTo === "lastName");
}

export const childUnsupportedError = () =>
  new ConflictError("This club's application form cannot be used for a child (it does not ask for first and last name); ask the board", { details: { code: "child_application_unsupported" } });

/**
 * Preconditions of the parent for a child application: a verified e-mail address, at most `MAX_OPEN_CHILD_APPLICATIONS`
 * open child applications, and an account membership (if any) that is not a former one. Must run under the per-user lock
 * (`form-submission-user:<userId>`) when it is used to create a new child application.
 */
export async function assertGuardianMayApply(executor: DbExecutor, input: { clubId: string; userId: string; emailVerified: boolean; countOpen: boolean }): Promise<void> {
  if (!input.emailVerified) throw new ForbiddenError("Verify your e-mail address before applying for a child", { details: { code: "email_not_verified" } });
  if (input.countOpen) {
    if ((await countOpenChildApplications(input.userId, executor)) >= MAX_OPEN_CHILD_APPLICATIONS) {
      throw new ConflictError("Too many open applications for children; wait for a decision or withdraw one", { details: { code: "child_application_limit", limit: MAX_OPEN_CHILD_APPLICATIONS } });
    }
  }
  await assertGuardianAccountUsable(executor, input.clubId, input.userId);
}

/** A guardian who was excluded / is deceased / has left cannot sponsor a child: the person has to be reopened or re-join first. */
export async function assertGuardianAccountUsable(executor: DbExecutor, clubId: string, userId: string): Promise<void> {
  await assertRejoinAllowed(executor, clubId, userId);
  const account = await executor.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, userId)) });
  if (!account) return;
  const own = await executor.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) });
  if (!own) return;
  const state = effectiveStatus(own, todayBerlin());
  if (state === "ausgeschlossen" || state === "verstorben") {
    throw new ConflictError("This person was excluded from the club or is marked deceased; the member must be reopened by the board first", { details: { code: "member_rejoin_blocked", clubMemberId: own.id, status: state } });
  }
  if (isLeftStatus(state)) throw new ConflictError("A former member cannot apply for a child; re-join the club first", { details: { code: "guardian_not_active" } });
}

export type ChildWarning = "child_is_adult" | "birth_date_missing";

/** Advice for the board (never blocks): the child's age cannot be confirmed to be under 18. */
export function childWarnings(birthDate: string | undefined | null, today = todayBerlin()): ChildWarning[] {
  if (!birthDate) return ["birth_date_missing"];
  return ageOn(birthDate, today) >= 18 ? ["child_is_adult"] : [];
}

/**
 * Submit-time checks of a child application on the VALIDATED answers: the child needs a name (first and last name answered
 * and acceptable for the member record) and a birth date cannot lie in the future. Returns the advisory warnings.
 */
export function checkChildAnswers(fields: readonly FormField[], answers: unknown): ChildWarning[] {
  if (!supportsChildApplication(fields)) throw childUnsupportedError();
  const plan = planAcceptance(fields, answers);
  const errors: Record<string, "required" | "invalid_value"> = {};
  for (const target of ["firstName", "lastName"] as const) {
    if (plan.master[target] === undefined) {
      const field = fields.find((f) => f.mapsTo === target)!;
      errors[field.key] = "required";
    }
  }
  const birthField = fields.find((f) => f.mapsTo === "birthDate");
  if (plan.master.birthDate && plan.master.birthDate > todayBerlin() && birthField) errors[birthField.key] = "invalid_value";
  if (Object.keys(errors).length > 0) throw new ValidationError("Answers do not match the form", { details: { fields: errors } });
  return childWarnings(plan.master.birthDate);
}

/** Display name of the child from the plan (`checkChildAnswers` guarantees both names at submit; re-checked at acceptance). */
export function childDisplayName(plan: AcceptancePlan): string | null {
  const { firstName, lastName } = plan.master;
  return firstName && lastName ? `${firstName} ${lastName}`.slice(0, 200) : null;
}

export interface GuardianAccount {
  account: typeof member.$inferSelect;
  /** Created by this acceptance (outside the transaction): removed again if the acceptance aborts. */
  created: boolean;
}

/**
 * The parent's account membership in the club: the existing one, or a new external one (`role = 'guest'`). Runs OUTSIDE the
 * decision transaction like the Better Auth call of an adult acceptance.
 */
export async function ensureGuardianAccount(clubId: string, userId: string): Promise<GuardianAccount> {
  const find = () => db.query.member.findFirst({ where: and(eq(member.organizationId, clubId), eq(member.userId, userId)) });
  // Two acceptances for children of the same new parent must not both add an account membership (the member table has no
  // unique key on (club, user)): they queue on this lock, which is deliberately not the account-link key the
  // `afterAddMember` hook takes while addMember runs.
  return db.transaction(async (lockTx) => {
    await lockTx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`guardian-account:${clubId}:${userId}`}, 0))`);
    await assertGuardianAccountUsable(db, clubId, userId);
    const existing = await find();
    if (existing) return { account: existing, created: false };
    const created = await auth.api.addMember({ body: { userId, organizationId: clubId, role: EXTERNAL_GUEST_ROLE } });
    if (!created) throw new ConflictError("Could not create the guardian's account membership");
    return { account: created as typeof member.$inferSelect, created: true };
  });
}

/**
 * Inside the decision transaction: makes the (new) guest account a clean external role -- `club_members.status = 'interessent'`
 * (not a member) and the club role `erziehungsberechtigt` -- and writes the guardian link. A parent who already is a member
 * keeps their status and roles; only the link is added.
 */
export async function linkGuardian(tx: DbExecutor, input: { clubId: string; guardian: GuardianAccount; childClubMemberId: string; decidedBy: string }): Promise<{ linked: boolean }> {
  const { clubId, guardian, childClubMemberId, decidedBy } = input;
  if (guardian.account.role === "guest") {
    await tx.insert(clubRoles).values({ memberId: guardian.account.id, roleType: "erziehungsberechtigt" }).onConflictDoNothing();
    if (guardian.created) {
      const own = await ensureClubMember(tx, guardian.account);
      if (own.status === "aktiv") {
        await tx.update(clubMembers).set({ status: "interessent", updatedAt: new Date() }).where(eq(clubMembers.id, own.id));
        await tx.insert(clubMemberStatusHistory).values({
          clubMemberId: own.id,
          fromStatus: "aktiv",
          toStatus: "interessent",
          fromCategoryId: own.categoryId,
          toCategoryId: own.categoryId,
          effectiveOn: todayBerlin(),
          reason: "Externe Rolle: Erziehungsberechtigte",
          changedBy: decidedBy,
        });
      }
    }
  }
  const inserted = await tx.insert(guardianLinks).values({ guardianMemberId: guardian.account.id, wardClubMemberId: childClubMemberId }).onConflictDoNothing().returning({ id: guardianLinks.id });
  if (inserted.length > 0) {
    await tx.insert(auditLog).values({ eventType: "guardian_link.create", subjectId: childClubMemberId, payload: { clubId, guardianMemberId: guardian.account.id, via: "application", decidedBy } });
  }
  return { linked: inserted.length > 0 };
}

/** Open child applications of an account (the number the cap uses). */
export async function countOpenChildApplications(userId: string, executor: DbExecutor = db): Promise<number> {
  const [row] = await executor
    .select({ open: count() })
    .from(formSubmissions)
    .where(and(eq(formSubmissions.submittedByUserId, userId), eq(formSubmissions.onBehalfOf, "guardian"), inArray(formSubmissions.status, ["draft", "submitted"])));
  return row?.open ?? 0;
}
