import { and, eq } from "drizzle-orm";

import { auth } from "../../auth/auth.js";
import { organization } from "../../auth/auth-schema.js";
import { db } from "../../db/client.js";
import { clubInfoPages } from "../../db/schema/club-info-pages.js";
import { clubRegistrations } from "../../db/schema/club-registrations.js";
import { clubSettings, type ClubTextBlock } from "../../db/schema/club-settings.js";
import { departments } from "../../db/schema/departments.js";
import { memberCategories } from "../../db/schema/club-members.js";
import { assemblyRulesSchema, emptyAssemblyRules } from "../../lib/assembly-rules.js";
import { writeAudit } from "../../lib/audit.js";
import { ensureDefaultCalendar } from "../../lib/calendar-defaults.js";
import { ensureClubFormDefaults } from "../../lib/form-defaults.js";
import { ensureConsentPurposes } from "../../lib/consent-purposes.js";
import { DEMO_MARKER, accountOf, type DemoCtx } from "./context.js";

export const CLUB_ADDRESS = { street: "Sportplatzweg 1", postalCode: "55555", city: "Wiesbach" };

/** Statute parameters of the general assembly, complete so that invitations, ballots and circular resolutions work. */
export function demoAssemblyRules() {
  return assemblyRulesSchema.parse({
    ...emptyAssemblyRules(),
    invitationMinDays: 14,
    invitationDeliveryBufferDays: 3,
    invitationForm: "textform",
    agendaRequiredInInvitation: true,
    quorumMode: "fraction",
    quorumValue: 0.25,
    majorityByTopic: { allgemein: "einfach", satzungsaenderung: "drei_viertel", zweckaenderung: "drei_viertel", wahl: "einfach", entlastung: "einfach", aufloesung: "drei_viertel" },
    abstainCountsAs: "not_counted",
    proxyAllowed: true,
    maxProxiesPerPerson: 2,
    onlineAllowed: "hybrid",
    circularAllowed: true,
    circularMinParticipation: 0.5,
    circularUnanimity: false,
    secretBallotDigitalAllowed: true,
    votingMinAge: 16,
    votingStatuses: ["aktiv"],
    termWarningDays: [60, 30, 7, 0],
    termExpiryEffect: "suspend_permissions",
    satzungReference: "Satzung § 9 (Mitgliederversammlung), § 10 (Einladung), § 11 (Beschlussfassung)",
    satzungPageSlug: "satzung",
  });
}

const TEXT_BLOCKS: ClubTextBlock[] = [
  { key: "kuendigung", title: "Kündigung bestätigt", text: "Wir bestätigen den Eingang Ihrer Kündigung. Ihre Mitgliedschaft endet zum nächstmöglichen Termin laut Satzung." },
  { key: "willkommen", title: "Willkommen im Verein", text: "Herzlich willkommen im Demo Sportverein Wiesbach! Bei Fragen helfen wir gerne weiter." },
  { key: "absage", title: "Training fällt aus", text: "Das Training muss leider ausfallen. Wir melden uns mit einem Ersatztermin." },
];

/** Verified club: creates the organization with the vorsitz account as owner and the approved registration that "verifies" it. */
export async function createClub(ctx: DemoCtx): Promise<void> {
  const vorsitz = accountOf(ctx, "vorsitz");
  const created = await auth.api.createOrganization({
    body: { name: ctx.opts.clubName, slug: ctx.opts.slug, userId: vorsitz.userId, metadata: { [DEMO_MARKER]: true } },
  });
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, ctx.opts.slug) });
  if (!org || !created) throw new Error("createOrganization succeeded but the club cannot be found afterwards");
  ctx.clubId = org.id;
  const owner = await db.query.member.findFirst({ where: (m, { and, eq }) => and(eq(m.organizationId, org.id), eq(m.userId, vorsitz.userId)) });
  if (!owner) throw new Error("The founder has no membership");
  vorsitz.memberId = owner.id;

  const admin = accountOf(ctx, "admin");
  const approvedAt = new Date(ctx.now.getTime() - 400 * 86_400_000);
  await db.insert(clubRegistrations).values({
    userId: vorsitz.userId,
    clubName: ctx.opts.clubName,
    legalForm: "e_v",
    registerCourt: "Amtsgericht Wiesbach",
    registerNumber: "VR 4711",
    ...CLUB_ADDRESS,
    websiteUrl: "https://demo-sportverein-wiesbach.example.org",
    claimedRole: "vorsitz",
    status: "approved",
    reviewedBy: admin.userId,
    reviewedAt: approvedAt,
    clubId: org.id,
    slugSuggestion: ctx.opts.slug,
    submittedAt: new Date(approvedAt.getTime() - 3 * 86_400_000),
  });
  // A second, still open registration so the platform admin has something to review.
  const gruender = accountOf(ctx, "gruender");
  await db.insert(clubRegistrations).values({
    userId: gruender.userId,
    clubName: "Schachfreunde Wiesbach",
    legalForm: "nicht_eingetragen",
    street: "Marktplatz 3",
    postalCode: "55555",
    city: "Wiesbach",
    claimedRole: "vorsitz",
    status: "pending",
    slugSuggestion: "schachfreunde-wiesbach",
    submittedAt: new Date(ctx.now.getTime() - 2 * 86_400_000),
  });
  await writeAudit(db, { eventType: "club_registration.approve", subjectId: org.id, actorUserId: admin.userId, payload: { clubId: org.id, slug: org.slug, userId: vorsitz.userId, memberId: owner.id, decidedBy: owner.id, claimedRole: "vorsitz" } });
  ctx.log(`Verein "${org.name}" angelegt (${org.slug})`);
}

/** Club settings: reminders, statute and assembly parameters, consent age limit, privacy contact. */
export async function seedSettings(ctx: DemoCtx): Promise<void> {
  const rules = demoAssemblyRules();
  await db
    .insert(clubSettings)
    .values({
      clubId: ctx.clubId,
      noticePeriodDays: 90,
      noticeMode: "quarter_end",
      allowSelfLoans: true,
      senderName: "Demo Sportverein Wiesbach",
      signature: "Mit sportlichen Grüßen\nIhr Vorstand\nDemo Sportverein Wiesbach e.V.",
      replyTo: `vorstand@${ctx.opts.emailDomain}`,
      textBlocks: TEXT_BLOCKS,
      timezone: "Europe/Berlin",
      reminderEventEnabled: true,
      reminderEventLeadHours: 24,
      reminderLoanEnabled: true,
      reminderLoanLeadDays: 1,
      reminderMaintenanceEnabled: true,
      reminderMaintenanceLeadDays: 7,
      reminderRsvpEnabled: true,
      reminderRsvpLeadDays: 3,
      reminderInvitationEnabled: true,
      reminderInvitationLeadDays: 3,
      reminderCredentialEnabled: true,
      reminderCredentialLeadDays: 30,
      ageTransitionAuto: false,
      notifyBoardRequests: true,
      notifyMeetingInvites: true,
      notifyAgeTransition: true,
      notifyHandover: true,
      mailLanguage: "de",
      consentAgeLimit: 16,
      consentBothGuardians: false,
      privacyContact: `datenschutz@${ctx.opts.emailDomain}`,
      privacyController: "Demo Sportverein Wiesbach e.V., Sportplatzweg 1, 55555 Wiesbach, vertreten durch die Vorsitzende Heike Brandt",
      assemblyRules: rules as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing();
  await ensureConsentPurposes(ctx.clubId);
  ctx.log("Vereinseinstellungen (Satzung/Versammlung vollständig, Altersgrenze 16, Datenschutzkontakt)");
}

/** The five default categories plus two club-specific ones; age rules feed the age transition. */
export async function seedCategories(ctx: DemoCtx): Promise<void> {
  await ensureClubFormDefaults(ctx.clubId);
  const extra = [
    { key: "kind", name: "Kinder", votingRight: false, applicantSelectable: true, minAge: 0, maxAge: 13, autoTransitionToKey: "jugend", sortOrder: 5 },
    { key: "studierende", name: "Studierende", votingRight: true, applicantSelectable: true, minAge: null, maxAge: null, autoTransitionToKey: null, sortOrder: 6 },
  ];
  for (const c of extra) {
    await db.insert(memberCategories).values({ clubId: ctx.clubId, ...c }).onConflictDoNothing();
  }
  // Age rules of the youth category: 14-17, then the suggestion "Aktiv" appears (the board decides, auto transition is off).
  await db.update(memberCategories).set({ minAge: 14, maxAge: 17, autoTransitionToKey: "aktiv" }).where(and(eq(memberCategories.key, "jugend"), eq(memberCategories.clubId, ctx.clubId)));
  const rows = await db.select().from(memberCategories).where(eq(memberCategories.clubId, ctx.clubId));
  for (const r of rows) ctx.cat[r.key] = r.id;
  ctx.log(`${rows.length} Mitgliedskategorien`);
}

const PAGES: Array<{ slug: string; title: string; markdown: string | null; url?: string }> = [
  {
    slug: "satzung",
    title: "Satzung",
    markdown: [
      "# Satzung des Demo Sportverein Wiesbach e.V.",
      "",
      "## § 1 Name und Sitz",
      "Der Verein führt den Namen „Demo Sportverein Wiesbach e.V.“ und hat seinen Sitz in Wiesbach.",
      "",
      "## § 2 Zweck",
      "Der Verein fördert den Breitensport, insbesondere Fußball, Tennis, Turnen und Schwimmen sowie die Jugendarbeit.",
      "",
      "## § 9 Mitgliederversammlung",
      "Die ordentliche Mitgliederversammlung findet einmal im Jahr statt. Stimmberechtigt sind aktive Mitglieder ab 16 Jahren.",
      "",
      "## § 10 Einladung",
      "Die Einladung erfolgt in Textform mindestens 14 Tage vor dem Termin unter Angabe der Tagesordnung.",
      "",
      "## § 11 Beschlussfassung",
      "Die Versammlung ist beschlussfähig, wenn mindestens ein Viertel der Stimmberechtigten anwesend oder vertreten ist. Satzungsänderungen bedürfen einer Dreiviertelmehrheit.",
    ].join("\n"),
  },
  { slug: "leitbild", title: "Leitbild", markdown: "# Unser Leitbild\n\nSport verbindet Generationen. Wir sind ein Verein für alle: offen, fair und ehrenamtlich getragen.\n\n- Breitensport vor Spitzensport\n- Jugend fördern\n- Verantwortung im Ehrenamt teilen" },
  { slug: "geschichte", title: "Vereinsgeschichte", markdown: "# Geschichte\n\n**1952** Gründung als Turnverein Wiesbach.\n\n**1974** Bau des Vereinsheims.\n\n**1998** Gründung der Tennisabteilung.\n\n**2019** Einweihung des Kunstrasenplatzes." },
  { slug: "beitragsordnung", title: "Beitragsordnung", markdown: "# Beitragsordnung\n\n| Kategorie | Jahresbeitrag |\n| --- | --- |\n| Aktiv | 120 € |\n| Passiv | 60 € |\n| Fördernd | ab 100 € |\n| Jugend | 60 € |\n| Kinder | 48 € |\n| Studierende | 72 € |\n\nDie Beiträge werden einmal jährlich eingezogen. (Die Beitragsabrechnung selbst läuft außerhalb von MyVerein.)" },
  { slug: "hausordnung", title: "Hausordnung Vereinsheim", markdown: "# Hausordnung\n\n1. Das Vereinsheim ist sauber zu hinterlassen.\n2. Der letzte Nutzer schließt ab und meldet das im Schlüsselbuch.\n3. Ab 22 Uhr ist Nachtruhe." },
  { slug: "verband", title: "Landesverband", markdown: null, url: "https://example.org/landesverband" },
];

export async function seedInfoPages(ctx: DemoCtx): Promise<void> {
  for (const p of PAGES) {
    await db.insert(clubInfoPages).values({ clubId: ctx.clubId, slug: p.slug, title: p.title, contentMarkdown: p.markdown, externalUrl: p.url ?? null }).onConflictDoNothing();
    await writeAudit(db, { eventType: "club_info_page.create", subjectId: ctx.clubId, actorUserId: accountOf(ctx, "vorsitz").userId, payload: { clubId: ctx.clubId, slug: p.slug } });
  }
  ctx.log(`${PAGES.length} Vereinsinfo-Seiten`);
}

export const DEPARTMENTS = [
  { key: "fussball", name: "Fußball" },
  { key: "tennis", name: "Tennis" },
  { key: "turnen", name: "Turnen" },
  { key: "schwimmen", name: "Schwimmen" },
] as const;

export async function seedDepartments(ctx: DemoCtx): Promise<void> {
  for (const d of DEPARTMENTS) {
    const [row] = await db.insert(departments).values({ clubId: ctx.clubId, name: d.name }).returning({ id: departments.id });
    ctx.dept[d.key] = row!.id;
  }
  ctx.log(`${DEPARTMENTS.length} Abteilungen`);
}

/** Default calendar of the club (the club approval flow creates it too). */
export async function seedDefaultCalendar(ctx: DemoCtx): Promise<void> {
  const cal = await ensureDefaultCalendar(ctx.clubId, { createdBy: accountOf(ctx, "vorsitz").userId, source: "club_creation" });
  if (cal) ctx.cal.verein = cal.id;
}
