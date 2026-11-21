import { db } from "../../db/client.js";
import { sponsorContacts, sponsors } from "../../db/schema/sponsors.js";
import { writeAudit } from "../../lib/audit.js";
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
