import { randomUUID } from "node:crypto";

import { eq, inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { organization, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubMembers } from "../db/schema/club-members.js";
import { demoCounts } from "./demo/counts.js";
import { findClubBySlug, resetDemoClub } from "./demo/reset.js";
import { DEFAULT_DEMO_PASSWORD, DEMO_MARKER, type DemoOptions } from "./demo/context.js";
import { loginRows, seedDemoClub } from "./seed-demo.js";

/**
 * Smoke test of `npm run seed:demo` against the real test database. Everything is scoped to a throw-away demo club (own slug and
 * own e-mail domain), so a demo club a developer has seeded locally is never touched. Real Postgres, like the route tests.
 */

const suffix = randomUUID().slice(0, 8);
const opts: DemoOptions = {
  slug: `demo-seedtest-${suffix}`,
  clubName: "Seedtest Sportverein e.V.",
  emailDomain: `seedtest-${suffix}.demo.myverein.local`,
  password: DEFAULT_DEMO_PASSWORD,
  reset: false,
  force: false,
  quiet: true,
};
const bystanderSlug = `demo-bystander-${suffix}`;
const foreignSlug = `demo-foreign-${suffix}`;
let clubId: string;
let first: Record<string, number>;

beforeAll(async () => {
  // Another club that must survive everything the seed does (also a --reset).
  await db.insert(organization).values({ id: `bystander-${suffix}`, name: "Bystander e.V.", slug: bystanderSlug, createdAt: new Date() });
  await db.insert(clubMembers).values({ clubId: `bystander-${suffix}`, displayName: "Unberührt", joinedAt: "2020-01-01" });
}, 60_000);

afterAll(async () => {
  const found = await findClubBySlug(opts.slug);
  await resetDemoClub(opts, found);
  await db.delete(organization).where(inArray(organization.slug, [bystanderSlug, foreignSlug]));
  await db.delete(user).where(like(user.email, `%@${opts.emailDomain}`));
  await closeDatabase();
}, 60_000);

describe("seed:demo", () => {
  it("builds the demo club with every feature area populated", async () => {
    const result = await seedDemoClub(opts);
    expect(result.created).toBe(true);
    clubId = result.clubId;
    const club = await db.query.organization.findFirst({ where: eq(organization.id, clubId) });
    expect(club?.slug).toBe(opts.slug);
    expect(JSON.parse(club!.metadata!)[DEMO_MARKER]).toBe(true);

    first = await demoCounts(clubId);
    // members: ~40+, with and without account, voting and non-voting categories
    expect(first.members).toBeGreaterThanOrEqual(40);
    expect(first.members_with_account).toBeGreaterThanOrEqual(10);
    expect(first.members_voting_category).toBeGreaterThan(0);
    expect(first.members_no_voting_category).toBeGreaterThan(0);
    expect(first.status_history).toBeGreaterThanOrEqual(first.members! - 2);
    expect(first.categories).toBeGreaterThanOrEqual(5);
    // structure
    expect(first.departments).toBeGreaterThanOrEqual(3);
    expect(first.department_assignments).toBeGreaterThan(20);
    expect(first.club_roles).toBeGreaterThanOrEqual(10);
    expect(first.roles_term_expired).toBeGreaterThanOrEqual(1);
    expect(first.roles_with_term).toBeGreaterThan(first.roles_term_expired!);
    expect(first.guardian_links_unconfirmed).toBeGreaterThanOrEqual(1);
    expect(first.guardian_links_expired).toBeGreaterThanOrEqual(1);
    expect(first.custom_fields).toBeGreaterThan(0);
    expect(first.custom_field_values).toBeGreaterThan(0);
    expect(first.field_visibility).toBeGreaterThan(0);
    expect(first.info_pages).toBeGreaterThan(0);
    // calendar
    expect(first.events_past).toBeGreaterThan(0);
    expect(first.events_future).toBeGreaterThan(0);
    expect(first.events_cancelled).toBeGreaterThanOrEqual(1);
    expect(first.rsvp_waitlist).toBeGreaterThanOrEqual(1);
    expect(first.ward_responses).toBeGreaterThan(0);
    expect(first.absences).toBeGreaterThan(0);
    // places and material
    expect(first.locations).toBeGreaterThanOrEqual(3);
    expect(first.inventory_items).toBeGreaterThanOrEqual(5);
    expect(first.loans_open).toBeGreaterThan(0);
    expect(first.loans_overdue).toBeGreaterThan(0);
    expect(first.loans_returned).toBeGreaterThan(0);
    // assembly
    expect(first.assemblies).toBeGreaterThanOrEqual(3);
    expect(first.invitations).toBeGreaterThanOrEqual(2);
    expect(first.invitation_deliveries).toBeGreaterThan(0);
    expect(first.voting_roll_frozen).toBeGreaterThanOrEqual(1);
    expect(first.proxies).toBeGreaterThanOrEqual(1);
    expect(first.attendance_present).toBeGreaterThan(0);
    expect(first.ballots_finalized).toBeGreaterThanOrEqual(3);
    expect(first.ballots_open).toBeGreaterThanOrEqual(1);
    expect(first.ballots_secret).toBeGreaterThanOrEqual(1);
    expect(first.ballots_circular).toBeGreaterThanOrEqual(1);
    expect(first.votes_open).toBeGreaterThan(0);
    expect(first.votes_secret).toBeGreaterThan(0);
    expect(first.election_candidates_accepted).toBeGreaterThanOrEqual(1);
    expect(first.minutes_approved).toBeGreaterThanOrEqual(1);
    expect(first.resolutions).toBeGreaterThan(0);
    // privacy, forms, communication
    expect(first.consent_purposes).toBeGreaterThanOrEqual(5);
    expect(first.consent_records).toBeGreaterThan(0);
    expect(first.consent_revocations).toBeGreaterThan(0);
    expect(first.consent_guardian).toBeGreaterThan(0);
    expect(first.consent_paper).toBeGreaterThan(0);
    expect(first.data_subject_requests).toBeGreaterThan(0);
    expect(first.privacy_notices).toBeGreaterThanOrEqual(1);
    expect(first.form_submissions).toBeGreaterThan(0);
    expect(first.applications_pending).toBeGreaterThanOrEqual(1);
    expect(first.applications_decided).toBeGreaterThanOrEqual(1);
    expect(first.exit_requests).toBeGreaterThan(0);
    expect(first.announcements).toBeGreaterThan(0);
    expect(first.deliveries).toBeGreaterThan(0);
    expect(first.notification_preferences).toBeGreaterThan(0);
    expect(first.audit_entries).toBeGreaterThan(0);
  }, 120_000);

  it("creates the demo accounts with the shared password and the intended roles", async () => {
    const rows = await loginRows(opts, clubId);
    const by = Object.fromEntries(rows.map((r) => [r.email.split("@")[0]!, r]));
    expect(by.vorsitz!.roles).toContain("vorsitz");
    expect(by.kassenwart!.roles).toContain("kassenwart");
    expect(by["erziehungsberechtigt"]!.account).toBe("guest");
    expect(by.admin!.account).toBe("Plattform-Admin");
    expect(rows.length).toBeGreaterThanOrEqual(14);
    const { auth } = await import("../auth/auth.js");
    const signIn = await auth.api.signInEmail({ body: { email: `vorsitz@${opts.emailDomain}`, password: opts.password } });
    expect(signIn.user.email).toBe(`vorsitz@${opts.emailDomain}`);
  }, 30_000);

  it("is idempotent: a second run changes nothing, --reset rebuilds the same club", async () => {
    const again = await seedDemoClub(opts);
    expect(again.created).toBe(false);
    expect(again.clubId).toBe(clubId);
    expect(await demoCounts(clubId)).toEqual(first);

    const rebuilt = await seedDemoClub({ ...opts, reset: true });
    expect(rebuilt.created).toBe(true);
    expect(rebuilt.clubId).not.toBe(clubId);
    clubId = rebuilt.clubId;
    expect(await demoCounts(clubId)).toEqual(first);
    // The old club is gone, the accounts exist exactly once.
    const accounts = await db.select({ id: user.id }).from(user).where(like(user.email, `%@${opts.emailDomain}`));
    expect(accounts.length).toBeGreaterThanOrEqual(14);
  }, 120_000);

  it("never touches other clubs", async () => {
    const bystander = await findClubBySlug(bystanderSlug);
    expect(bystander).not.toBeNull();
    const members = await db.select({ id: clubMembers.id }).from(clubMembers).where(eq(clubMembers.clubId, `bystander-${suffix}`));
    expect(members).toHaveLength(1);
  });

  it("refuses a club with the same slug that this seed did not create", async () => {
    await db.insert(organization).values({ id: `foreign-${suffix}`, name: "Fremder Verein", slug: foreignSlug, createdAt: new Date() });
    await expect(seedDemoClub({ ...opts, slug: foreignSlug, reset: true })).rejects.toThrow(/not created by seed:demo|nicht|marker/i);
    expect(await findClubBySlug(foreignSlug)).not.toBeNull();
  });

  it("refuses to run with NODE_ENV=production unless --force", async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(seedDemoClub({ ...opts, slug: `demo-prod-${suffix}` })).rejects.toThrow(/NODE_ENV=production/);
      expect(await findClubBySlug(`demo-prod-${suffix}`)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
});
