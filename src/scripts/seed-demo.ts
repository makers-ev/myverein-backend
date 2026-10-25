import "dotenv/config";
import { pathToFileURL } from "node:url";

import { and, eq } from "drizzle-orm";

import { member, user } from "../auth/auth-schema.js";
import { closeDatabase, db } from "../db/client.js";
import { clubRoles } from "../db/schema/club-roles.js";
import { departments } from "../db/schema/departments.js";
import { ACCOUNT_SPECS, createUsers, joinAccounts } from "./demo/accounts.js";
import { createClub, seedCategories, seedDefaultCalendar, seedDepartments, seedInfoPages, seedSettings } from "./demo/club.js";
import {
  DEFAULT_DEMO_DOMAIN,
  DEFAULT_DEMO_NAME,
  DEFAULT_DEMO_PASSWORD,
  DEFAULT_DEMO_SLUG,
  DEMO_MARKER,
  todayIso,
  type DemoCtx,
  type DemoOptions,
} from "./demo/context.js";
import { seedAssembly } from "./demo/assembly.js";
import { demoCounts } from "./demo/counts.js";
import { seedAnnouncements, seedNotificationPreferences } from "./demo/communication.js";
import { seedRequests } from "./demo/forms.js";
import { seedAbsences, seedAvailability, seedCalendars, seedEvents } from "./demo/calendar.js";
import { seedCustomFields } from "./demo/fields.js";
import { seedGuardians } from "./demo/guardians.js";
import { seedDepartmentLeads, seedMembers } from "./demo/members.js";
import { findClubBySlug, resetDemoClub } from "./demo/reset.js";
import { neutralizeOutbound } from "./demo/outbound.js";
import { seedBoardMeetings } from "./demo/meetings.js";
import { seedInventory, seedLocations } from "./demo/places.js";
import { seedConsents, seedPrivacy } from "./demo/privacy.js";
import { seedRoles } from "./demo/roles.js";

/**
 * Demo club seed (`npm run seed:demo`): ONE fully populated club ("Demo Sportverein Wiesbach e.V.") so the whole MyVerein
 * feature set can be viewed, tested and demonstrated. Same style as seed-admin.ts / seed-club.ts.
 *
 * - Idempotent: the club is found by slug. Existing demo club -> nothing is changed (exit 0) unless `--reset`, which deletes
 *   THIS club (and the demo accounts of its e-mail domain) and builds it again. A club with that slug that this seed did not
 *   create (no `organization.metadata.demoSeed`) is never touched.
 * - Refuses to run with NODE_ENV=production unless `--force`.
 * - Real service functions wherever they exist (Better Auth users and memberships, ensureClubMember, ballots, elections,
 *   minutes, invitations, consents, announcements), so hashes, snapshots, audit entries and invariants hold.
 * - Environment: DEMO_PASSWORD (shared password of all demo logins, default below), DEMO_CLUB_SLUG, DEMO_CLUB_NAME,
 *   DEMO_EMAIL_DOMAIN.
 * - Skipped on purpose: file uploads (profile photos, location photos, documents, proofs). They need real files in the media layer.
 */

export interface SeedResult {
  clubId: string;
  /** False when the club existed and `--reset` was not given. */
  created: boolean;
  ctx: DemoCtx | null;
}

type Step = { name: string; run: (ctx: DemoCtx) => Promise<void> };

const STEPS: Step[] = [
  { name: "Konten", run: createUsers },
  { name: "Verein", run: createClub },
  { name: "Einstellungen", run: seedSettings },
  { name: "Kategorien", run: seedCategories },
  { name: "Info-Seiten", run: seedInfoPages },
  { name: "Abteilungen", run: seedDepartments },
  { name: "Kalender (Standard)", run: seedDefaultCalendar },
  { name: "Kontomitgliedschaften", run: joinAccounts },
  { name: "Mitglieder", run: seedMembers },
  { name: "Abteilungsleitungen", run: seedDepartmentLeads },
  { name: "Vereinsrollen", run: seedRoles },
  { name: "Erziehungsberechtigte", run: seedGuardians },
  { name: "Zusatzfelder und Qualifikationen", run: async (ctx) => void (await seedCustomFields(ctx)) },
  { name: "Standorte", run: seedLocations },
  { name: "Inventar", run: seedInventory },
  { name: "Kalender", run: seedCalendars },
  { name: "Termine", run: seedEvents },
  { name: "Verfügbarkeiten", run: seedAvailability },
  { name: "Abwesenheiten", run: seedAbsences },
  { name: "Vorstandssitzungen", run: seedBoardMeetings },
  { name: "Mitgliederversammlungen", run: seedAssembly },
  { name: "Einwilligungen", run: seedConsents },
  { name: "Datenschutz", run: seedPrivacy },
  { name: "Anträge, Austritte und Einladungen", run: seedRequests },
  { name: "Benachrichtigungseinstellungen", run: seedNotificationPreferences },
  { name: "Mitteilungen", run: seedAnnouncements },
  { name: "Versand abschließen", run: async (ctx) => void (await neutralizeOutbound(ctx)) },
];

export function optionsFromEnv(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): DemoOptions {
  const password = env.DEMO_PASSWORD ?? DEFAULT_DEMO_PASSWORD;
  if (password.length < 8) throw new Error("DEMO_PASSWORD must be at least 8 characters.");
  return {
    slug: env.DEMO_CLUB_SLUG ?? DEFAULT_DEMO_SLUG,
    clubName: env.DEMO_CLUB_NAME ?? DEFAULT_DEMO_NAME,
    emailDomain: env.DEMO_EMAIL_DOMAIN ?? DEFAULT_DEMO_DOMAIN,
    password,
    reset: argv.includes("--reset"),
    force: argv.includes("--force"),
    quiet: false,
    platformData: env.DEMO_PLATFORM_DATA !== "false",
  };
}

/** Builds the demo club. Safe to call repeatedly (see the header comment). */
export async function seedDemoClub(opts: DemoOptions): Promise<SeedResult> {
  if (process.env.NODE_ENV === "production" && !opts.force) {
    throw new Error("Refusing to seed demo data with NODE_ENV=production. Pass --force if you really mean it.");
  }
  const log = (msg: string) => {
    if (!opts.quiet) console.log(`[seed-demo] ${msg}`);
  };

  const existing = await findClubBySlug(opts.slug);
  if (existing && !existing.isDemo) {
    throw new Error(`A club with slug "${opts.slug}" exists but was not created by seed:demo (no ${DEMO_MARKER} marker). Choose another DEMO_CLUB_SLUG; nothing was changed.`);
  }
  if (existing && !opts.reset) {
    log(`Demo-Verein "${existing.name}" existiert bereits (id=${existing.id}) - nichts zu tun. Mit --reset neu aufbauen.`);
    return { clubId: existing.id, created: false, ctx: null };
  }
  if (opts.reset) {
    await resetDemoClub(opts, existing);
    if (existing) log(`Demo-Verein "${existing.name}" und Demo-Konten gelöscht (--reset)`);
  }

  const now = new Date();
  const ctx: DemoCtx = { opts, clubId: "", today: todayIso(now), now, people: {}, cm: {}, dept: {}, cat: {}, loc: {}, cal: {}, ev: {}, meeting: {}, log };
  for (const step of STEPS) {
    log(`-> ${step.name}`);
    await step.run(ctx);
  }
  return { clubId: ctx.clubId, created: true, ctx };
}

/** One line per demo login: e-mail, name, account role in the club, club roles (with department), purpose. Read from the database. */
export async function loginRows(opts: DemoOptions, clubId: string): Promise<Array<{ email: string; name: string; account: string; roles: string; purpose: string }>> {
  const rows: Array<{ email: string; name: string; account: string; roles: string; purpose: string }> = [];
  for (const a of ACCOUNT_SPECS) {
    const email = `${a.local}@${opts.emailDomain}`;
    const u = await db.query.user.findFirst({ where: eq(user.email, email) });
    const m = u ? await db.query.member.findFirst({ where: and(eq(member.userId, u.id), eq(member.organizationId, clubId)) }) : undefined;
    const roles = m
      ? await db
          .select({ roleType: clubRoles.roleType, department: departments.name })
          .from(clubRoles)
          .leftJoin(departments, eq(departments.id, clubRoles.departmentId))
          .where(eq(clubRoles.memberId, m.id))
      : [];
    const names = [...(m && m.role !== "guest" ? ["mitglied"] : []), ...roles.map((r) => (r.department ? `${r.roleType} (${r.department})` : r.roleType))];
    rows.push({ email, name: a.name, account: m ? m.role : u?.role === "admin" ? "Plattform-Admin" : "kein Mitglied", roles: names.join(", ") || "-", purpose: a.purpose });
  }
  return rows;
}

export function formatLoginTable(rows: Awaited<ReturnType<typeof loginRows>>): string {
  const cols = [
    ["E-Mail", "email"],
    ["Name", "name"],
    ["Konto", "account"],
    ["Vereinsrollen", "roles"],
    ["Zweck", "purpose"],
  ] as const;
  const width = (key: (typeof cols)[number][1], label: string) => Math.max(label.length, ...rows.map((r) => r[key].length));
  const widths = cols.map(([label, key]) => width(key, label));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  return [line(cols.map(([label]) => label)), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map(([, key]) => r[key])))].join("\n");
}

async function main() {
  const opts = optionsFromEnv();
  const result = await seedDemoClub(opts);
  console.log(`\n[seed-demo] ${result.created ? "fertig" : "übersprungen (Verein existiert, --reset zum Neuaufbau)"}. clubId=${result.clubId}, slug=${opts.slug}`);
  console.log(`\nDemo-Logins, Passwort für alle: ${opts.password}\n`);
  console.log(formatLoginTable(await loginRows(opts, result.clubId)));
  const counts = await demoCounts(result.clubId);
  console.log("\nAnzahl je Bereich\n");
  console.log(Object.entries(counts).map(([k, v]) => `${k.padEnd(30)} ${v}`).join("\n"));
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main()
    .then(() => closeDatabase())
    .catch(async (err) => {
      console.error("[seed-demo] failed", err);
      await closeDatabase();
      process.exit(1);
    });
}
