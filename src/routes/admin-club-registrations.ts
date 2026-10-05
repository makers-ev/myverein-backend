import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { auth } from "../auth/auth.js";
import { member, organization, user } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { auditLog } from "../db/schema/audit-log.js";
import { clubMemberships } from "../db/schema/club-memberships.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { clubRegistrations, REGISTRATION_STATUSES, type ClubRegistrationRow } from "../db/schema/club-registrations.js";
import { hasClubPermission } from "../lib/club-permissions.js";
import {
  inBackground,
  sendRegistrationApprovedMail,
  sendRegistrationNeedsInfoMail,
  sendRegistrationRejectedMail,
} from "../lib/club-registration-mail.js";
import { documentResponse, findDocument, isUuid, shapeRegistration, shapeRegistrations } from "../lib/club-registrations.js";
import { assertValidClubSlug, slugifyClubName, uniqueClubSlug } from "../lib/club-slug.js";
import { ConflictError, InternalError, NotFoundError, ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { nextMemberNumber } from "../lib/member-number.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { adminGuard, type SessionEnv } from "../middleware/session-guard.js";

/**
 * Reviewer side of "Verein gruenden" (Wave 6): platform admins (Better Auth
 * role `admin`) decide on submitted registrations. Decisions are only
 * possible from `pending` (otherwise 409); the club is created by `approve`.
 */
export const adminClubRegistrationRoutes = new Hono<SessionEnv>();

adminClubRegistrationRoutes.use("*", rateLimit({ windowMs: 60_000, max: 60 }));
adminClubRegistrationRoutes.use("*", adminGuard);

const MAX_SLUG_ATTEMPTS = 5;

const noteSchema = z.object({ note: z.string().trim().min(1).max(2000) });
const approveSchema = z.object({ slug: z.string().trim().min(1).max(100).optional() });

const validationHook = (result: { success: boolean; error?: { issues: unknown } }) => {
  if (!result.success) throw new ValidationError("Invalid request body", { details: result.error?.issues });
};

async function loadRegistration(id: string): Promise<ClubRegistrationRow> {
  if (!isUuid(id)) throw new NotFoundError("Registration not found");
  const row = await db.query.clubRegistrations.findFirst({ where: eq(clubRegistrations.id, id) });
  if (!row) throw new NotFoundError("Registration not found");
  return row;
}

interface DuplicateHint {
  clubId: string;
  name: string;
  city: string | null;
  postalCode: string | null;
}

/**
 * Possible duplicates among existing clubs, shown to the reviewer only:
 * clubs with the same name (or the same generated slug) and clubs approved
 * through a registration with the same postal code + city. City/postal code
 * are only known for clubs that were created via a registration (null for
 * e.g. the seeded demo club).
 */
async function duplicateHintsFor(reg: ClubRegistrationRow): Promise<DuplicateHint[]> {
  const base = slugifyClubName(reg.clubName);
  const hints = new Map<string, DuplicateHint>();

  const byName = await db
    .select({ clubId: organization.id, name: organization.name, city: clubRegistrations.city, postalCode: clubRegistrations.postalCode })
    .from(organization)
    .leftJoin(clubRegistrations, and(eq(clubRegistrations.clubId, organization.id), eq(clubRegistrations.status, "approved")))
    .where(sql`(lower(trim(${organization.name})) = lower(trim(${reg.clubName})) OR ${organization.slug} = ${base} OR ${organization.slug} ~ ${`^${base}-[0-9]+$`})`)
    .limit(10);
  for (const h of byName) hints.set(h.clubId, h);

  const byLocation = await db
    .select({ clubId: organization.id, name: organization.name, city: clubRegistrations.city, postalCode: clubRegistrations.postalCode })
    .from(clubRegistrations)
    .innerJoin(organization, eq(organization.id, clubRegistrations.clubId))
    .where(
      and(
        eq(clubRegistrations.status, "approved"),
        ne(clubRegistrations.id, reg.id),
        eq(clubRegistrations.postalCode, reg.postalCode),
        sql`lower(trim(${clubRegistrations.city})) = lower(trim(${reg.city}))`,
      ),
    )
    .limit(10);
  for (const h of byLocation) hints.set(h.clubId, h);

  return [...hints.values()].slice(0, 10);
}

async function shapeForAdmin(rows: ClubRegistrationRow[]) {
  const shaped = await shapeRegistrations(rows);
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const applicants = userIds.length > 0 ? await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(user.id, userIds)) : [];
  const applicantById = new Map(applicants.map((a) => [a.id, a]));
  const hints = await Promise.all(rows.map((r) => duplicateHintsFor(r)));

  return shaped.map((registration, i) => ({
    ...registration,
    applicant: applicantById.get(rows[i]!.userId) ?? null,
    duplicateHints: hints[i]!,
  }));
}

async function applicantOf(userId: string): Promise<{ name: string; email: string } | null> {
  const row = await db.query.user.findFirst({ where: eq(user.id, userId) });
  return row ? { name: row.name, email: row.email } : null;
}

// --- queue -------------------------------------------------------------

adminClubRegistrationRoutes.get("/", async (c) => {
  const statusParam = c.req.query("status");
  let statuses: string[] = REGISTRATION_STATUSES.filter((s) => s !== "draft");
  if (statusParam !== undefined) {
    // Drafts are private to their applicant and never part of the review queue.
    const parsed = z.enum(REGISTRATION_STATUSES.filter((s) => s !== "draft") as [string, ...string[]]).safeParse(statusParam);
    if (!parsed.success) throw new ValidationError(`status must be one of: ${statuses.join(", ")}`);
    statuses = [parsed.data];
  }

  const rows = await db
    .select()
    .from(clubRegistrations)
    .where(inArray(clubRegistrations.status, statuses))
    .orderBy(sql`${clubRegistrations.submittedAt} ASC NULLS LAST`, asc(clubRegistrations.createdAt), asc(clubRegistrations.id))
    .limit(200);

  return c.json({ data: await shapeForAdmin(rows) });
});

adminClubRegistrationRoutes.get("/:id", async (c) => {
  const row = await loadRegistration(c.req.param("id"));
  if (row.status === "draft") throw new NotFoundError("Registration not found");
  return c.json({ data: (await shapeForAdmin([row]))[0] });
});

adminClubRegistrationRoutes.get("/:id/documents/:docId", async (c) => {
  const row = await loadRegistration(c.req.param("id"));
  const doc = await findDocument(row.id, c.req.param("docId"));
  return documentResponse(c, doc);
});

// --- decisions ---------------------------------------------------------

/** Shared body of request-info / reject: claim pending -> `status` with the reviewer's note. */
async function decideWithNote(c: { get: (k: "user") => { id: string } }, id: string, status: "needs_info" | "rejected", note: string, eventType: string) {
  const reviewer = c.get("user");
  const reg = await loadRegistration(id);

  const decided = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(clubRegistrations)
      .set({ status, reviewNote: note, reviewedBy: reviewer.id, reviewedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(clubRegistrations.id, reg.id), eq(clubRegistrations.status, "pending")))
      .returning();
    if (!row) throw new ConflictError("Registration has already been decided or is not pending");
    await tx.insert(auditLog).values({
      eventType,
      subjectId: row.id,
      payload: { userId: row.userId, decidedBy: reviewer.id, note },
    });
    return row;
  });

  const applicant = await applicantOf(decided.userId).catch((err) => {
    logger.error({ err, registrationId: decided.id }, "[admin-club-registrations] could not load applicant for notification mail");
    return null;
  });
  if (applicant) {
    inBackground(status === "needs_info" ? sendRegistrationNeedsInfoMail(applicant, decided.clubName, note) : sendRegistrationRejectedMail(applicant, decided.clubName, note));
  }
  return decided;
}

adminClubRegistrationRoutes.post("/:id/request-info", zValidator("json", noteSchema, validationHook), async (c) => {
  const decided = await decideWithNote(c, c.req.param("id"), "needs_info", c.req.valid("json").note, "club_registration.request_info");
  return c.json({ data: { registration: await shapeRegistration(decided) } });
});

adminClubRegistrationRoutes.post("/:id/reject", zValidator("json", noteSchema, validationHook), async (c) => {
  const decided = await decideWithNote(c, c.req.param("id"), "rejected", c.req.valid("json").note, "club_registration.reject");
  return c.json({ data: { registration: await shapeRegistration(decided) } });
});

adminClubRegistrationRoutes.post("/:id/approve", async (c) => {
  const reviewer = c.get("user");

  const rawBody: unknown = await c.req.json().catch(() => ({}));
  const parsedBody = approveSchema.safeParse(rawBody ?? {});
  if (!parsedBody.success) throw new ValidationError("Invalid request body", { details: parsedBody.error.issues });
  const explicitSlug = parsedBody.data.slug;
  if (explicitSlug !== undefined) assertValidClubSlug(explicitSlug);

  const initial = await loadRegistration(c.req.param("id"));
  if (initial.status !== "pending") throw new ConflictError("Registration has already been decided or is not pending");

  // E4: the claimed board role must be able to administer the new club afterwards.
  if (!hasClubPermission([initial.claimedRole], "members:write") || !hasClubPermission([initial.claimedRole], "roles:write")) {
    throw new ValidationError(`Claimed role ${initial.claimedRole} cannot administer a club (needs members:write and roles:write)`);
  }

  let createdClubId: string | null = null;
  let result: { registration: ClubRegistrationRow; club: { id: string; name: string; slug: string } };
  try {
    result = await db.transaction(async (tx) => {
      // Serialize concurrent decisions on this registration: the loser waits here, then sees a non-pending
      // status and answers 409 -- and, importantly, never creates a second organization.
      const [reg] = await tx.select().from(clubRegistrations).where(eq(clubRegistrations.id, initial.id)).for("update");
      if (!reg) throw new NotFoundError("Registration not found");
      if (reg.status !== "pending") throw new ConflictError("Registration has already been decided or is not pending");

      // createOrganization runs on its own pool connection (committed immediately) and makes the applicant
      // `owner`. If anything below fails, the catch block removes the organization again.
      const baseSlug = explicitSlug ?? reg.slugSuggestion ?? slugifyClubName(reg.clubName);
      let org: { id: string; name: string; slug: string } | null = null;
      for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !org; attempt++) {
        const slug = explicitSlug ?? (await uniqueClubSlug(db, baseSlug));
        try {
          org = await auth.api.createOrganization({ body: { name: reg.clubName, slug, userId: reg.userId } });
        } catch (err) {
          // organization_slug_uidx is the last line of defence: someone else took the slug between our lookup and the insert.
          const taken = await db.query.organization.findFirst({ where: eq(organization.slug, slug) });
          if (!taken) throw err;
          if (explicitSlug !== undefined) throw new ConflictError("This slug is already taken");
        }
      }
      if (!org) throw new ConflictError("Could not assign a unique slug, please try again");
      createdClubId = org.id;

      const owner = await tx.query.member.findFirst({ where: and(eq(member.organizationId, org.id), eq(member.userId, reg.userId)) });
      if (!owner) throw new InternalError("Organization was created without an owner membership");

      const [decided] = await tx
        .update(clubRegistrations)
        .set({ status: "approved", clubId: org.id, reviewedBy: reviewer.id, reviewedAt: new Date(), reviewNote: null, updatedAt: new Date() })
        .where(and(eq(clubRegistrations.id, reg.id), eq(clubRegistrations.status, "pending")))
        .returning();
      if (!decided) throw new ConflictError("Registration has already been decided or is not pending");

      const memberNumber = await nextMemberNumber(tx, org.id);
      await tx.insert(clubMemberships).values({
        memberId: owner.id,
        memberNumber,
        category: "aktiv",
        joinedAt: new Date().toISOString().slice(0, 10),
      });
      await tx.insert(clubRoles).values({ memberId: owner.id, roleType: reg.claimedRole });

      await tx.insert(auditLog).values({
        eventType: "club_registration.approve",
        subjectId: reg.id,
        payload: { clubId: org.id, slug: org.slug, userId: reg.userId, memberId: owner.id, decidedBy: reviewer.id, claimedRole: reg.claimedRole, memberNumber },
      });

      return { registration: decided, club: { id: org.id, name: org.name, slug: org.slug } };
    });
  } catch (err) {
    // The organization was created outside the transaction -- remove it again so a failed approval leaves no
    // orphan club (and no squatted slug). Never swallow a failed cleanup silently.
    const orphanId = createdClubId as string | null;
    if (orphanId) {
      await db
        .delete(organization)
        .where(eq(organization.id, orphanId))
        .catch((cleanupErr) => logger.error({ err: cleanupErr, clubId: orphanId, registrationId: initial.id }, "[admin-club-registrations] failed to remove organization after aborted approval"));
    }
    throw err;
  }

  // Committed from here on: nothing below may undo or fail the approval (mail is best effort).
  const applicant = await applicantOf(result.registration.userId).catch((err) => {
    logger.error({ err, registrationId: result.registration.id }, "[admin-club-registrations] could not load applicant for approval mail");
    return null;
  });
  if (applicant) inBackground(sendRegistrationApprovedMail(applicant, result.club.name, result.club.slug));

  return c.json({ data: { registration: await shapeRegistration(result.registration), club: result.club } });
});
