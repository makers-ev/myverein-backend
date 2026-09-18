import "dotenv/config";
import { and, eq } from "drizzle-orm";

import { auth } from "../auth/auth.js";
import { user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMemberships } from "../db/schema/club-memberships.js";
import { clubRoles } from "../db/schema/club-roles.js";

/**
 * Idempotent demo-club bootstrap, same pattern as seed-admin.ts. Creates one
 * club ("Demo Sportverein e.V.") and makes ADMIN_EMAIL its "vorsitz" --
 * there is no public "create club" route in Wave 1 (see
 * Technical Reference - MyVerein Backend §4), so local/dev testing needs
 * this script to get a clubId to exercise clubGuard-protected routes at
 * all. Safe to re-run.
 *
 * Re-fetches the organization/member rows from the DB after each
 * auth.api.* call instead of trusting their return shape directly --
 * `createOrganization`/`addMember` return slightly different (looser)
 * shapes than the Drizzle schema types (e.g. an extra `members` array,
 * `logo?: string | null | undefined` vs the schema's `string | null`).
 */
async function main() {
  const email = process.env.ADMIN_EMAIL;
  if (!email) {
    throw new Error("ADMIN_EMAIL must be set (run seed:admin first).");
  }

  const adminUser = await db.query.user.findFirst({ where: eq(user.email, email) });
  if (!adminUser) {
    throw new Error(`No user found for ADMIN_EMAIL=${email}. Run "npm run seed:admin" first.`);
  }

  let clubId: string;
  const bySlug = await db.query.organization.findFirst({ where: (o, { eq }) => eq(o.slug, "demo-sportverein") });
  if (bySlug) {
    clubId = bySlug.id;
    console.log(`[seed-club] club "${bySlug.name}" already exists (id=${clubId})`);
  } else {
    await auth.api.createOrganization({
      body: { name: "Demo Sportverein e.V.", slug: "demo-sportverein", userId: adminUser.id },
    });
    const created = await db.query.organization.findFirst({ where: (o, { eq }) => eq(o.slug, "demo-sportverein") });
    if (!created) throw new Error("createOrganization succeeded but the row can't be found afterwards");
    clubId = created.id;
    console.log(`[seed-club] created club "${created.name}" (id=${clubId})`);
  }

  const existingMembership = await db.query.member.findFirst({
    where: (m, { and, eq }) => and(eq(m.organizationId, clubId), eq(m.userId, adminUser.id)),
  });

  let membershipId: string;
  if (existingMembership) {
    membershipId = existingMembership.id;
  } else {
    await auth.api.addMember({ body: { userId: adminUser.id, organizationId: clubId, role: "owner" } });
    const created = await db.query.member.findFirst({
      where: (m, { and, eq }) => and(eq(m.organizationId, clubId), eq(m.userId, adminUser.id)),
    });
    if (!created) throw new Error("addMember succeeded but the row can't be found afterwards");
    membershipId = created.id;
    console.log(`[seed-club] added ${email} as member (id=${membershipId})`);
  }

  const existingClubMembership = await db.query.clubMemberships.findFirst({ where: eq(clubMemberships.memberId, membershipId) });
  if (!existingClubMembership) {
    await db.insert(clubMemberships).values({
      memberId: membershipId,
      category: "aktiv",
      joinedAt: new Date().toISOString().slice(0, 10),
    });
    console.log("[seed-club] created club_memberships row");
  }

  const existingRole = await db.query.clubRoles.findFirst({
    where: and(eq(clubRoles.memberId, membershipId), eq(clubRoles.roleType, "vorsitz")),
  });
  if (!existingRole) {
    await db.insert(clubRoles).values({ memberId: membershipId, roleType: "vorsitz" });
    console.log("[seed-club] assigned role vorsitz");
  }

  console.log(`[seed-club] done. clubId=${clubId}`);
}

main()
  .then(() => closeDatabase())
  .catch(async (err) => {
    console.error("[seed-club] failed", err);
    await closeDatabase();
    process.exit(1);
  });
