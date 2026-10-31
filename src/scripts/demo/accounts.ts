import { and, eq } from "drizzle-orm";

import { auth } from "../../auth/auth.js";
import { member, user } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { clubMembers, clubMemberStatusHistory } from "../../db/schema/club-members.js";
import { clubRoles } from "../../db/schema/club-roles.js";
import { ensureClubMember } from "../../lib/club-members.js";
import { ensureGuardianAccount } from "../../lib/form-children.js";
import { inviteLinkContext } from "../../lib/invite-context.js";
import { accountOf, emailOf, type DemoCtx, type Person } from "./context.js";

/** `member.role` of an external account (Better Auth's typings only know the built-in roles). */
const EXTERNAL_GUEST_ROLE = "guest" as unknown as "member";

interface AccountSpec {
  key: string;
  local: string;
  name: string;
  purpose: string;
  orgRole: Person["orgRole"];
  platformRole?: "admin" | "user";
}

/** Every demo login. `orgRole` null = no membership in the demo club. */
export const ACCOUNT_SPECS: readonly AccountSpec[] = [
  { key: "admin", local: "admin", name: "Plattform Admin", purpose: "Plattform-Administration (Vereinsgründungen, Jobs, E-Mail-Protokoll, AV-Vertrag)", orgRole: null, platformRole: "admin" },
  { key: "vorsitz", local: "vorsitz", name: "Heike Brandt", purpose: "Vorsitzende: alle Vorstandsrechte, Eigentümerin des Vereins; Stundenbericht mit Beträgen, bestätigt Zeiten, pflegt Stundensätze", orgRole: "owner" },
  { key: "stellv", local: "stellv.vorsitz", name: "Thomas Lindner", purpose: "Stellvertretender Vorsitzender: dieselben Rechte wie die Vorsitzende", orgRole: "admin" },
  { key: "kasse", local: "kassenwart", name: "Monika Schäfer", purpose: "Kassenwartin: sieht sensible Mitgliederdaten und Kennzahlen, Amtszeit läuft bald ab; Stundenbericht mit Beträgen (bestätigt aber nichts)", orgRole: "member" },
  { key: "schrift", local: "schriftfuehrer", name: "Jan Köhler", purpose: "Schriftführer: Sitzungen, Protokolle, Versammlung, Formulare, Mitteilungen", orgRole: "member" },
  { key: "beisitz", local: "beisitzer", name: "Sabine Neumann", purpose: "Beisitzerin (in der Versammlung gewählt) und Abteilungsleitung Turnen", orgRole: "member" },
  { key: "trainer", local: "trainer", name: "Marco Vogel", purpose: "Trainer Fußball: Abteilungsmitteilungen, Abwesenheiten der eigenen Abteilung; Zeiterfassung mit persönlichem Stundensatz (zwei Sätze im Verlauf)", orgRole: "member" },
  { key: "trainer2", local: "trainer2", name: "Lena Wolff", purpose: "Trainerin Tennis mit abgelaufener Amtszeit (Rechte ruhen)", orgRole: "member" },
  { key: "trainer3", local: "trainer3", name: "Nina Hoffmeister", purpose: "Trainerin Schwimmen (Abteilung ohne Leitung): Zeiterfassung nach Rollensatz Trainer, offene Zeiten", orgRole: "member" },
  { key: "abtleit", local: "abteilungsleitung", name: "Ute Hartmann", purpose: "Abteilungsleitung Fußball: Kalender, Standorte, Material; Stundenbericht NUR Stunden der eigenen Abteilung, bestätigt Zeiten der Abteilung", orgRole: "member" },
  { key: "abtleit2", local: "abteilungsleitung2", name: "Frank Bergmann", purpose: "Abteilungsleitung Tennis, Amtszeit läuft in Kürze ab; Stundenbericht nur Stunden der Abteilung Tennis", orgRole: "member" },
  { key: "mitglied", local: "mitglied", name: "Lukas Fischer", purpose: "Ganz normales Mitglied (nur Leserechte), zugleich Vater von Finn; Zeiterfassung über den Satz für alle Mitglieder, Stempeluhr läuft", orgRole: "member" },
  { key: "jugend", local: "jugend", name: "Emma Richter", purpose: "Jugendmitglied (16) mit eigenem Konto, ohne Stimmrecht", orgRole: "member" },
  { key: "eltern", local: "erziehungsberechtigt", name: "Petra Wagner", purpose: "Erziehungsberechtigte (externes Konto) mit mehreren Kindern: gültig, unbestätigt, abgelaufen", orgRole: "guest" },
  { key: "gast", local: "gast", name: "Dr. Katrin Meyer", purpose: "Externe Gästin (Verbands-Kampfrichterin): sieht nur Gast-Inhalte; Zeiterfassung ohne Stundensatz (Fall \"kein Satz\")", orgRole: "guest" },
  { key: "bewerber", local: "bewerber", name: "Daniel Roth", purpose: "Bewerber ohne Mitgliedschaft: offener Aufnahmeantrag (früherer wurde abgelehnt)", orgRole: null },
  { key: "bewerber_eltern", local: "eltern.bewerber", name: "Nicole Sander", purpose: "Mutter, die ihre Tochter per Aufnahmeantrag anmeldet", orgRole: null },
  { key: "gruender", local: "gruender", name: "Gerd Albers", purpose: "Möchte einen Verein gründen: offene Gründungsanfrage in der Plattform-Prüfung", orgRole: null },
];

/** Creates (or reuses) the Better Auth users with the shared demo password. Verified e-mail, like seed-admin. */
export async function createUsers(ctx: DemoCtx): Promise<void> {
  for (const spec of ACCOUNT_SPECS) {
    const email = emailOf(ctx.opts, spec.local);
    let row = await db.query.user.findFirst({ where: eq(user.email, email) });
    if (!row) {
      const { user: created } = await auth.api.createUser({
        body: { email, password: ctx.opts.password, name: spec.name, role: spec.platformRole ?? "user" },
      });
      await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.id));
      row = await db.query.user.findFirst({ where: eq(user.id, created.id) });
    } else if (!row.emailVerified || (spec.platformRole === "admin" && row.role !== "admin")) {
      await db.update(user).set({ emailVerified: true, ...(spec.platformRole === "admin" ? { role: "admin" } : {}) }).where(eq(user.id, row.id));
    }
    if (!row) throw new Error(`createUser succeeded but ${email} cannot be found`);
    ctx.people[spec.key] = {
      key: spec.key,
      email,
      name: spec.name,
      purpose: spec.purpose,
      orgRole: spec.orgRole,
      platformRole: spec.platformRole ?? "user",
      userId: row.id,
      memberId: "",
      clubMemberId: "",
    };
  }
  ctx.log(`${ACCOUNT_SPECS.length} Konten angelegt (Passwort ${ctx.opts.password})`);
}

/** Adds an external guest (`member.role = guest`) the way the guardian flow does: a club_members row as `interessent`, no number. */
async function addExternalGuest(ctx: DemoCtx, person: Person, reason: string): Promise<void> {
  const created = await inviteLinkContext.run({ clubMemberId: "guest" }, () =>
    auth.api.addMember({ body: { userId: person.userId, organizationId: ctx.clubId, role: EXTERNAL_GUEST_ROLE } }),
  );
  if (!created) throw new Error("Could not add the external guest");
  const account = created as typeof member.$inferSelect;
  const row = await ensureClubMember(db, account, { memberNumber: null });
  if (row.status !== "interessent") {
    await db.update(clubMembers).set({ status: "interessent", updatedAt: new Date() }).where(eq(clubMembers.id, row.id));
    await db.insert(clubMemberStatusHistory).values({ clubMemberId: row.id, fromStatus: null, toStatus: "interessent", toCategoryId: row.categoryId, effectiveOn: ctx.today, reason });
  }
  person.memberId = account.id;
  person.clubMemberId = row.id;
}

/** Account memberships of the demo club (the founder already exists as owner). Fills `memberId` / `clubMemberId`. */
export async function joinAccounts(ctx: DemoCtx): Promise<void> {
  for (const spec of ACCOUNT_SPECS) {
    const person = accountOf(ctx, spec.key);
    if (spec.orgRole === null) continue;
    if (spec.key === "eltern") {
      const { account } = await ensureGuardianAccount(ctx.clubId, person.userId);
      const row = await db.query.clubMembers.findFirst({ where: eq(clubMembers.memberId, account.id) });
      person.memberId = account.id;
      person.clubMemberId = row!.id;
      continue;
    }
    if (spec.key === "gast") {
      await addExternalGuest(ctx, person, "Externe Rolle: Gast");
      continue;
    }
    let account = await db.query.member.findFirst({ where: and(eq(member.organizationId, ctx.clubId), eq(member.userId, person.userId)) });
    if (!account) {
      await auth.api.addMember({ body: { userId: person.userId, organizationId: ctx.clubId, role: spec.orgRole as "member" } });
      account = await db.query.member.findFirst({ where: and(eq(member.organizationId, ctx.clubId), eq(member.userId, person.userId)) });
    }
    if (!account) throw new Error(`addMember succeeded but the membership of ${person.email} cannot be found`);
    // The Better Auth hook creates the club_members row; this repairs it when the hook failed (as seed-club does).
    const row = await ensureClubMember(db, account, { user: { name: person.name, email: person.email } });
    person.memberId = account.id;
    person.clubMemberId = row.id;
  }
  ctx.log("Kontomitgliedschaften angelegt");
}

/** Assigns a club role; the same (member, role, department) twice is ignored. */
export async function giveRole(memberId: string, roleType: string, departmentId: string | null, termEndsAt: string | null): Promise<void> {
  await db.insert(clubRoles).values({ memberId, roleType, departmentId, termEndsAt }).onConflictDoNothing();
}
