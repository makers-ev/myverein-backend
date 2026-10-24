import "dotenv/config";
import { pathToFileURL } from "node:url";

import { closeDatabase } from "../db/client.js";
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

/** Table of all demo logins (printed at the end). */
export function loginTable(opts: DemoOptions): string {
  const rows = ACCOUNT_SPECS.map((a) => ({ email: `${a.local}@${opts.emailDomain}`, name: a.name, role: a.orgRole ?? (a.platformRole === "admin" ? "Plattform-Admin" : "-"), purpose: a.purpose }));
  const w = (key: "email" | "name" | "role") => Math.max(key.length, ...rows.map((r) => r[key].length));
  const [we, wn, wr] = [w("email"), w("name"), w("role")];
  const line = (e: string, n: string, r: string, p: string) => `${e.padEnd(we)}  ${n.padEnd(wn)}  ${r.padEnd(wr)}  ${p}`;
  return [line("E-Mail", "Name", "Rolle", "Zweck"), line("-".repeat(we), "-".repeat(wn), "-".repeat(wr), "-".repeat(20)), ...rows.map((r) => line(r.email, r.name, r.role, r.purpose))].join("\n");
}

async function main() {
  const opts = optionsFromEnv();
  const result = await seedDemoClub(opts);
  console.log(`\n[seed-demo] ${result.created ? "fertig" : "übersprungen"}. clubId=${result.clubId}, slug=${opts.slug}`);
  console.log(`\nDemo-Logins (alle mit dem Passwort aus DEMO_PASSWORD, Standard: ${DEFAULT_DEMO_PASSWORD}; Passwort dieses Laufs: ${opts.password})\n`);
  console.log(loginTable(opts));
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
