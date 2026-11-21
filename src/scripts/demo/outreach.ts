import { db } from "../../db/client.js";
import { clubLeads } from "../../db/schema/club-leads.js";
import { clubPublicProfiles, type PublicProfileContent } from "../../db/schema/club-public-profiles.js";
import { clubSettings } from "../../db/schema/club-settings.js";
import { sponsorContacts, sponsors } from "../../db/schema/sponsors.js";
import { writeAudit } from "../../lib/audit.js";
import { syncPublicMedia } from "../../lib/public-profile.js";
import { accountOf, shiftDays, type DemoCtx } from "./context.js";

/**
 * Outreach (Wave 15): sponsors and partners. Status is derived from the dates, so the set covers every case the board view
 * shows: active and public, active and expiring soon, planned, expired, internal only. No amounts: billing stays outside
 * MyVerein. Logos are not seeded (the media layer is exercised by the tests); the board can upload one.
 */

interface SponsorSpec {
  name: string;
  website: string | null;
  consideration: string;
  /** Days from today; null = open. */
  starts: number | null;
  ends: number | null;
  visibility: "intern" | "oeffentlich";
  notes?: string;
  contacts: Array<{ name: string; role?: string; email?: string; phone?: string; isPrimary?: boolean }>;
}

const SPONSORS: SponsorSpec[] = [
  {
    name: "Autohaus Wiesbach GmbH",
    website: "https://autohaus-wiesbach.example",
    consideration: "Trikotwerbung Erste Mannschaft, Logo auf der Vereinsseite",
    starts: -400,
    ends: 330,
    visibility: "oeffentlich",
    notes: "Verlängerung im Frühjahr besprechen",
    contacts: [
      { name: "Ralf Krämer", role: "Geschäftsführer", email: "r.kraemer@autohaus-wiesbach.example", phone: "06123 4567", isPrimary: true },
      { name: "Svenja Ott", role: "Marketing", email: "marketing@autohaus-wiesbach.example" },
    ],
  },
  {
    name: "Bäckerei Sonnenkorn",
    website: "https://sonnenkorn.example",
    consideration: "Bandenwerbung Sportplatz, Brötchen beim Sommerfest",
    starts: -300,
    ends: 21,
    visibility: "oeffentlich",
    contacts: [{ name: "Ilse Brenner", role: "Inhaberin", phone: "06123 9988", isPrimary: true }],
  },
  {
    name: "Sparkasse Wiesbach",
    website: "https://sparkasse-wiesbach.example",
    consideration: "Jugendförderung, Banner bei Turnieren",
    starts: 45,
    ends: 410,
    visibility: "oeffentlich",
    contacts: [{ name: "Dirk Lehmann", role: "Filialleitung", email: "d.lehmann@sparkasse-wiesbach.example", isPrimary: true }],
  },
  {
    name: "Getränke Hahn",
    website: null,
    consideration: "Getränke zum Selbstkostenpreis beim Vereinsfest",
    starts: -730,
    ends: -20,
    visibility: "oeffentlich",
    notes: "Vertrag ausgelaufen, neuer Kontakt offen",
    contacts: [],
  },
  {
    name: "Physiopraxis Lindenhof",
    website: "https://physio-lindenhof.example",
    consideration: "Sonderkonditionen für Mitglieder (nicht öffentlich)",
    starts: -120,
    ends: null,
    visibility: "intern",
    contacts: [{ name: "Praxisteam", email: "info@physio-lindenhof.example", isPrimary: true }],
  },
];

export async function seedSponsors(ctx: DemoCtx): Promise<void> {
  const board = accountOf(ctx, "kasse");
  for (const spec of SPONSORS) {
    const [row] = await db
      .insert(sponsors)
      .values({
        clubId: ctx.clubId,
        name: spec.name,
        website: spec.website,
        consideration: spec.consideration,
        startsOn: spec.starts === null ? null : shiftDays(ctx.today, spec.starts),
        endsOn: spec.ends === null ? null : shiftDays(ctx.today, spec.ends),
        visibility: spec.visibility,
        notes: spec.notes ?? null,
        createdBy: board.memberId,
      })
      .returning();
    if (spec.contacts.length > 0) {
      await db.insert(sponsorContacts).values(spec.contacts.map((x) => ({ sponsorId: row!.id, name: x.name, role: x.role ?? null, email: x.email ?? null, phone: x.phone ?? null, isPrimary: x.isPrimary ?? false })));
    }
    await writeAudit(db, { eventType: "sponsor.create", subjectId: row!.id, clubId: ctx.clubId, actorUserId: board.userId, payload: { clubId: ctx.clubId, sponsorId: row!.id, visibility: spec.visibility, contacts: spec.contacts.length } });
  }
  ctx.log(`${SPONSORS.length} Sponsoren (aktiv, läuft bald aus, geplant, abgelaufen, intern)`);
}

/**
 * Public club page (Wave 15 B3): published and switched on, and findable in the club search, so the website page `/v/<slug>`,
 * the enquiry form and "Verein finden" can be tried with the demo club. (Real clubs start with both switches OFF.) The draft has
 * one unpublished change (a new tagline) to show the "not yet published" state of the editor.
 */
export async function seedPublicProfile(ctx: DemoCtx): Promise<void> {
  const board = accountOf(ctx, "vorsitz");
  const published: PublicProfileContent = {
    tagline: "Sport, Gemeinschaft und Ehrenamt in Wiesbach",
    description: "Wir sind ein Mehrspartenverein mit Fußball, Tennis, Turnen und Schwimmen. Schnuppern ist jederzeit möglich: melde dich einfach über das Formular, wir laden dich zum Probetraining ein.",
    city: "Wiesbach",
    address: "Sportplatz am Lindenweg 3, 65555 Wiesbach",
    contactEmail: "info@demo-sportverein-wiesbach.example",
    contactPhone: null,
    website: null,
    logoKey: null,
    coverKey: null,
    galleryKeys: [],
    departmentIds: ["fussball", "tennis", "turnen", "schwimmen"].map((k) => ctx.dept[k]!).filter(Boolean),
    eventCalendarIds: [ctx.cal.fussball].filter((v): v is string => !!v),
    showSponsors: true,
    leadFormEnabled: true,
    trialTrainingEnabled: true,
  };
  const now = new Date();
  await db.insert(clubPublicProfiles).values({ clubId: ctx.clubId, ...published, tagline: "Sport, Gemeinschaft und Ehrenamt in Wiesbach seit 1921", published, publishedAt: now, publishedBy: board.memberId, contactConsentAt: now, updatedBy: board.memberId });
  await db.insert(clubSettings).values({ clubId: ctx.clubId, publicProfileEnabled: true, discoverable: true }).onConflictDoUpdate({ target: clubSettings.clubId, set: { publicProfileEnabled: true, discoverable: true } });
  await writeAudit(db, { eventType: "public_profile.publish", subjectId: ctx.clubId, clubId: ctx.clubId, actorUserId: board.userId, payload: { clubId: ctx.clubId, contactConfirmed: true, enabled: true } });
  await syncPublicMedia(ctx.clubId);
  ctx.log("Öffentliche Vereinsseite veröffentlicht und auffindbar (Entwurf mit einer unveröffentlichten Änderung)");
}

/**
 * Interested people (Wave 15 B4): every status of the pipeline, a merged duplicate, trial training dates and the waitlists of
 * Tennis (two people, in order) and Schwimmen. Addresses use the reserved example domain.
 */
export async function seedLeads(ctx: DemoCtx): Promise<void> {
  const board = accountOf(ctx, "schrift");
  const day = (d: number) => new Date(ctx.now.getTime() + d * 86_400_000);
  const specs = [
    { name: "Mila Becker", email: "mila.becker@example.org", dept: "fussball", status: "neu", source: "oeffentliche_seite", trial: true, message: "Meine Tochter (9) möchte gerne Fußball spielen. Gibt es ein Probetraining?", created: -1, count: 1 },
    { name: "Jonas Krüger", email: "jonas.krueger@example.org", dept: "tennis", status: "kontaktiert", source: "oeffentliche_seite", trial: false, message: "Ich suche einen Verein für Doppel am Wochenende.", created: -6, count: 2, notes: "Angerufen, meldet sich nach dem Urlaub", waitlist: -5 },
    { name: "Aylin Demir", email: "aylin.demir@example.org", dept: "tennis", status: "neu", source: "oeffentliche_seite", trial: true, message: "Gerne auch auf die Warteliste.", created: -3, count: 1, waitlist: -3 },
    { name: "Peter Lang", email: "peter.lang@example.org", dept: "turnen", status: "probetraining", source: "manuell", trial: true, message: "Am Infostand des Sommerfests erfasst.", created: -10, count: 1, trialOn: 4 },
    { name: "Sven Otto", email: "sven.otto@example.org", dept: "schwimmen", status: "abgelehnt", source: "oeffentliche_seite", trial: false, message: "Kurs für Erwachsene?", created: -20, count: 1, notes: "Kein Erwachsenenkurs, an Nachbarverein verwiesen" },
    { name: "Clara Wendt", email: "clara.wendt@example.org", dept: "schwimmen", status: "neu", source: "oeffentliche_seite", trial: false, message: "Platz im Kinderschwimmen frei?", created: -2, count: 1, waitlist: -2 },
  ] as const;
  for (const sp of specs) {
    const created = day(sp.created);
    const [row] = await db
      .insert(clubLeads)
      .values({
        clubId: ctx.clubId,
        name: sp.name,
        email: sp.email,
        departmentId: ctx.dept[sp.dept] ?? null,
        message: sp.message,
        source: sp.source,
        status: sp.status,
        trialRequested: sp.trial,
        trialOn: "trialOn" in sp ? shiftDays(ctx.today, sp.trialOn) : null,
        waitlistedAt: "waitlist" in sp ? day(sp.waitlist) : null,
        notes: "notes" in sp ? sp.notes : null,
        privacyAcceptedAt: sp.source === "oeffentliche_seite" ? created : null,
        requestCount: sp.count,
        lastRequestAt: created,
        createdBy: sp.source === "manuell" ? board.memberId : null,
        createdAt: created,
        updatedAt: created,
      })
      .returning();
    await writeAudit(db, { eventType: sp.source === "manuell" ? "club_lead.create" : "club_lead.request", subjectId: row!.id, clubId: ctx.clubId, actorUserId: sp.source === "manuell" ? board.userId : null, payload: sp.source === "manuell" ? { clubId: ctx.clubId, leadId: row!.id } : { clubId: ctx.clubId, leadId: row!.id, merged: false } });
  }
  ctx.log(`${specs.length} Interessenten-Anfragen (alle Status, Probetraining, Wartelisten Tennis und Schwimmen)`);
}
