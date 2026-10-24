import { and, eq, inArray, like, ne, or, sql } from "drizzle-orm";

import { member, organization, user } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { auditLog } from "../../db/schema/audit-log.js";
import { consentRecords } from "../../db/schema/privacy.js";
import { formSubmissions } from "../../db/schema/forms.js";
import { jobs } from "../../db/schema/jobs.js";
import { DEMO_MARKER, type DemoOptions } from "./context.js";

export interface FoundClub {
  id: string;
  name: string;
  /** True only for a club this seed created (`organization.metadata.demoSeed`). */
  isDemo: boolean;
}

/** The club with this slug, if any, and whether it is a demo club. */
export async function findClubBySlug(slug: string): Promise<FoundClub | null> {
  const row = await db.query.organization.findFirst({ where: eq(organization.slug, slug) });
  if (!row) return null;
  let isDemo = false;
  try {
    isDemo = (JSON.parse(row.metadata ?? "null") as Record<string, unknown> | null)?.[DEMO_MARKER] === true;
  } catch {
    isDemo = false;
  }
  return { id: row.id, name: row.name, isDemo };
}

/** Accounts of this seed: all users of the demo e-mail domain. */
export async function demoUserIds(opts: DemoOptions): Promise<string[]> {
  const rows = await db.select({ id: user.id }).from(user).where(like(user.email, `%@${opts.emailDomain}`));
  return rows.map((r) => r.id);
}

/**
 * Deletes the demo club and the demo accounts, nothing else. Refuses a club without the demo marker. Deleting the
 * organization cascades through every club table; the two RESTRICT references (consent texts, form versions) are cleared
 * first, the audit trail (no foreign key) by club id and by demo actor.
 */
export async function resetDemoClub(opts: DemoOptions, club: FoundClub | null): Promise<void> {
  if (club && !club.isDemo) {
    throw new Error(`The club "${club.name}" (slug ${opts.slug}) was not created by seed:demo (no ${DEMO_MARKER} marker). Refusing to delete it.`);
  }
  const userIds = await demoUserIds(opts);
  if (club) {
    await db.delete(consentRecords).where(eq(consentRecords.clubId, club.id));
    await db.delete(formSubmissions).where(eq(formSubmissions.clubId, club.id));
    await db.delete(jobs).where(and(inArray(jobs.status, ["queued", "failed"]), sql`${jobs.payload}::text LIKE ${"%" + club.id + "%"}`));
    await db.delete(auditLog).where(eq(auditLog.clubId, club.id));
    await db.delete(organization).where(eq(organization.id, club.id));
  }
  if (userIds.length > 0) {
    // A demo account that also belongs to a club that is not ours stays (and is reported); the seed never touches other clubs.
    const shared = await db.select({ userId: member.userId }).from(member).where(and(inArray(member.userId, userIds), ne(member.organizationId, club?.id ?? "")));
    const keep = new Set(shared.map((s) => s.userId));
    const removable = userIds.filter((id) => !keep.has(id));
    if (removable.length > 0) {
      await db.delete(auditLog).where(or(inArray(auditLog.actorUserId, removable), inArray(auditLog.subjectId, removable)));
      await db.delete(user).where(inArray(user.id, removable));
    }
  }
}
