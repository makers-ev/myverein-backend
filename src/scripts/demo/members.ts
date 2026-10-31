import { and, eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { clubMemberDepartments, clubMembers, clubMemberStatusHistory } from "../../db/schema/club-members.js";
import { departments } from "../../db/schema/departments.js";
import { writeAudit } from "../../lib/audit.js";
import { nextMemberNumber } from "../../lib/member-number.js";
import { accountOf, shiftDays, yearsAgo, type DemoCtx } from "./context.js";

/** A step of a member's status/category history (what `club_member_status_history` would hold after the board's changes). */
interface HistoryStep {
  /** ISO date or negative day offset from today. */
  on: string;
  from: string | null;
  to: string | null;
  fromCat?: string | null;
  toCat?: string | null;
  reason: string;
}

interface DeptStep {
  key: string;
  /** Default: the entry date. */
  since?: string;
  until?: string | null;
}

interface MemberSpec {
  key: string;
  /** Key of the demo account behind this member, if any. */
  account?: string;
  first: string | null;
  last: string;
  /** Overrides "first last" (organizations as sponsors). */
  display?: string;
  birth: string | null;
  cat: string;
  status: string;
  joined: string;
  left?: string | null;
  exitReason?: string | null;
  /** Account-less members get no number while only interested. */
  noNumber?: boolean;
  /** Local part of the contact e-mail (shared by siblings); null = no e-mail address (reached by post). Default: derived from the name. */
  email?: string | null;
  phone?: boolean;
  address?: boolean;
  emergency?: [string, string];
  depts?: DeptStep[];
  history?: HistoryStep[];
  legalHold?: string;
}

const STREETS = ["Lindenstraße", "Bahnhofstraße", "Am Mühlbach", "Gartenweg", "Schulstraße", "Kirchplatz", "Birkenallee", "Waldweg", "Hauptstraße", "Rosenweg"];

/** All demo members, accounts first. Dates are computed from `today`, so ages and expiry states stay true over time. */
function specs(today: string): MemberSpec[] {
  const A = (age: number, extra = 0) => yearsAgo(today, age, extra);
  const D = (days: number) => shiftDays(today, days);
  const J = (years: number, extra = 0) => yearsAgo(today, years, extra);
  const entry = (on: string, to: string, cat: string | null = null): HistoryStep => ({ on, from: null, to, toCat: cat, reason: "Eintritt" });
  return [
    // --- accounts ---
    { key: "vorsitz", account: "vorsitz", first: "Heike", last: "Brandt", birth: A(55, 40), cat: "aktiv", status: "aktiv", joined: J(18, 12), phone: true, address: true, emergency: ["Rolf Brandt", "0151 5550 1001"], depts: [] },
    { key: "stellv", account: "stellv", first: "Thomas", last: "Lindner", birth: A(51, 100), cat: "aktiv", status: "aktiv", joined: J(14, 30), phone: true, address: true, depts: [] },
    { key: "kasse", account: "kasse", first: "Monika", last: "Schäfer", birth: A(58, 200), cat: "aktiv", status: "aktiv", joined: J(21, 70), phone: true, address: true, depts: [{ key: "tennis" }] },
    { key: "schrift", account: "schrift", first: "Jan", last: "Köhler", birth: A(43, 30), cat: "aktiv", status: "aktiv", joined: J(11, 5), phone: true, address: true },
    { key: "beisitz", account: "beisitz", first: "Sabine", last: "Neumann", birth: A(36, 170), cat: "aktiv", status: "aktiv", joined: J(8, 90), phone: true, address: true, depts: [{ key: "turnen" }] },
    { key: "trainer", account: "trainer", first: "Marco", last: "Vogel", birth: A(40, 60), cat: "aktiv", status: "aktiv", joined: J(9, 44), phone: true, address: true, depts: [{ key: "fussball" }] },
    { key: "trainer2", account: "trainer2", first: "Lena", last: "Wolff", birth: A(31, 10), cat: "aktiv", status: "aktiv", joined: J(5, 120), phone: true, depts: [{ key: "tennis" }] },
    { key: "trainer3", account: "trainer3", first: "Nina", last: "Hoffmeister", birth: A(29, 75), cat: "aktiv", status: "aktiv", joined: J(2, 40), phone: true, depts: [{ key: "schwimmen" }] },
    { key: "abtleit", account: "abtleit", first: "Ute", last: "Hartmann", birth: A(47, 250), cat: "aktiv", status: "aktiv", joined: J(16, 8), phone: true, address: true, depts: [{ key: "fussball" }] },
    { key: "abtleit2", account: "abtleit2", first: "Frank", last: "Bergmann", birth: A(54, 90), cat: "aktiv", status: "aktiv", joined: J(20, 150), phone: true, address: true, depts: [{ key: "tennis" }] },
    { key: "mitglied", account: "mitglied", first: "Lukas", last: "Fischer", birth: A(38, 120), cat: "aktiv", status: "aktiv", joined: J(6, 77), phone: true, address: true, depts: [{ key: "tennis" }, { key: "schwimmen" }] },
    { key: "jugend", account: "jugend", first: "Emma", last: "Richter", birth: A(16, 45), cat: "jugend", status: "aktiv", joined: J(3, 40), phone: true, emergency: ["Karin Richter", "0151 5550 1011"], depts: [{ key: "turnen" }], history: [entry(J(3, 40), "aktiv", "kind"), { on: J(2, 20), from: "aktiv", to: "aktiv", fromCat: "kind", toCat: "jugend", reason: "Altersübergang Kinder -> Jugend" }] },
    { key: "eltern", account: "eltern", first: "Petra", last: "Wagner", birth: A(40, 200), cat: "aktiv", status: "interessent", joined: J(3, 15), phone: true, address: true, noNumber: true, history: [] },
    { key: "gast", account: "gast", first: "Katrin", last: "Meyer", display: "Dr. Katrin Meyer", birth: A(46, 60), cat: "aktiv", status: "interessent", joined: D(-120), noNumber: true, history: [] },
    // --- children and youth (without account) ---
    { key: "noah", email: "petra.wagner", first: "Noah", last: "Wagner", birth: A(10, 80), cat: "kind", status: "aktiv", joined: J(3, 10), emergency: ["Petra Wagner", "0151 5550 2001"], depts: [{ key: "turnen" }], history: [entry(J(3, 10), "aktiv", "kind")] },
    { key: "mia", email: "petra.wagner", first: "Mia", last: "Wagner", birth: A(8, 150), cat: "kind", status: "aktiv", joined: J(2, 30), emergency: ["Petra Wagner", "0151 5550 2001"], depts: [{ key: "turnen" }] },
    { key: "lina", email: "petra.wagner", first: "Lina", last: "Wagner", birth: A(6, 20), cat: "kind", status: "aktiv", joined: D(-20), emergency: ["Petra Wagner", "0151 5550 2001"], depts: [{ key: "turnen" }] },
    { key: "tim", email: "petra.wagner", first: "Tim", last: "Wagner", birth: A(18, 25), cat: "jugend", status: "aktiv", joined: J(9, 60), depts: [{ key: "fussball", until: D(-60) }], history: [entry(J(9, 60), "aktiv", "kind"), { on: J(4, 20), from: "aktiv", to: "aktiv", fromCat: "kind", toCat: "jugend", reason: "Altersübergang Kinder -> Jugend" }] },
    { key: "finn", first: "Finn", last: "Fischer", birth: A(9, 33), cat: "kind", status: "aktiv", joined: J(2, 12), emergency: ["Lukas Fischer", "0151 5550 3001"], depts: [{ key: "turnen" }] },
    { key: "leon", first: "Leon", last: "Schulze", birth: A(12, 110), cat: "kind", status: "aktiv", joined: J(1, 40), depts: [{ key: "schwimmen" }] },
    { key: "hannah", first: "Hannah", last: "Becker", birth: A(14, 70), cat: "jugend", status: "aktiv", joined: J(3, 90), depts: [{ key: "schwimmen" }] },
    {
      key: "jonas",
      first: "Jonas",
      last: "Keller",
      birth: A(15, 190),
      cat: "jugend",
      status: "ruhend",
      joined: J(4, 7),
      depts: [{ key: "fussball" }],
      history: [entry(J(4, 7), "aktiv", "jugend"), { on: D(-45), from: "aktiv", to: "ruhend", reason: "Verletzungspause (Bänderriss)" }],
    },
    { key: "sophie", first: "Sophie", last: "Lang", birth: yearsAgo(today, 14, -20), cat: "kind", status: "aktiv", joined: J(2, 100), depts: [{ key: "turnen" }] },
    // --- honorary / passive / sponsors ---
    { key: "dieter", email: null, first: "Dieter", last: "Hoffmann", birth: A(78, 20), cat: "ehrenmitglied", status: "aktiv", joined: J(51, 30), phone: true, address: true },
    { key: "gisela", first: "Gisela", last: "Hoffmann", birth: A(76, 100), cat: "ehrenmitglied", status: "verstorben", joined: J(48, 10), left: D(-150), exitReason: "Verstorben", address: true, history: [entry(J(48, 10), "aktiv", "ehrenmitglied"), { on: D(-150), from: "aktiv", to: "verstorben", reason: "Verstorben" }] },
    { key: "walter", first: "Walter", last: "Krüger", birth: A(81, 140), cat: "ehrenmitglied", status: "aktiv", joined: J(55, 9), address: true },
    { key: "renate", email: null, first: "Renate", last: "Albrecht", birth: A(66, 50), cat: "passiv", status: "aktiv", joined: J(30, 20), phone: true, address: true, history: [entry(J(30, 20), "aktiv", "aktiv"), { on: J(6, 0), from: "aktiv", to: "aktiv", fromCat: "aktiv", toCat: "passiv", reason: "Wechsel zur passiven Mitgliedschaft" }], depts: [{ key: "tennis" }] },
    { key: "klaus", first: "Klaus", last: "Zimmermann", birth: A(59, 210), cat: "passiv", status: "aktiv", joined: J(22, 60), phone: true, depts: [{ key: "tennis" }] },
    { key: "birgit", first: "Birgit", last: "Roth", birth: A(52, 15), cat: "foerdernd", status: "aktiv", joined: J(7, 100), address: true },
    { key: "meier", first: null, last: "Autohaus Meier GmbH", display: "Autohaus Meier GmbH", birth: null, cat: "foerdernd", status: "aktiv", joined: J(6, 5), address: true },
    { key: "sommer", first: null, last: "Bäckerei Sommer", display: "Bäckerei Sommer", birth: null, cat: "foerdernd", status: "aktiv", joined: J(4, 80), address: true },
    // --- active adults ---
    { key: "stefan", first: "Stefan", last: "Wolf", birth: A(34, 12), cat: "aktiv", status: "aktiv", joined: J(8, 14), phone: true, depts: [{ key: "fussball" }] },
    { key: "julia", first: "Julia", last: "Schwarz", birth: A(29, 140), cat: "aktiv", status: "aktiv", joined: J(5, 66), phone: true, depts: [{ key: "fussball" }] },
    { key: "murat", first: "Murat", last: "Yilmaz", birth: A(31, 99), cat: "aktiv", status: "aktiv", joined: J(4, 22), phone: true, depts: [{ key: "fussball" }] },
    { key: "anja", first: "Anja", last: "Schmitt", birth: A(41, 250), cat: "aktiv", status: "aktiv", joined: J(10, 44), phone: true, address: true, depts: [{ key: "tennis" }] },
    { key: "peter", first: "Peter", last: "Braun", birth: A(47, 5), cat: "aktiv", status: "aktiv", joined: J(13, 31), phone: true, depts: [{ key: "fussball" }] },
    { key: "katharina", first: "Katharina", last: "Hahn", birth: A(22, 130), cat: "studierende", status: "aktiv", joined: J(2, 50), phone: true, depts: [{ key: "tennis" }], history: [entry(J(2, 50), "aktiv", "studierende")] },
    // --- exits and pauses ---
    { key: "oliver", first: "Oliver", last: "Peters", birth: A(38, 70), cat: "aktiv", status: "aktiv", joined: J(7, 20), left: D(40), exitReason: "Wegzug in eine andere Stadt", phone: true, history: [entry(J(7, 20), "aktiv", "aktiv"), { on: D(40), from: "aktiv", to: "ausgetreten", reason: "Kündigung zum Quartalsende (vorgemerkt)" }] },
    { key: "nadine", first: "Nadine", last: "Fuchs", birth: A(33, 180), cat: "aktiv", status: "aktiv", joined: J(5, 3), phone: true },
    { key: "christian", first: "Christian", last: "Vogt", birth: A(44, 222), cat: "aktiv", status: "ruhend", joined: J(12, 12), history: [entry(J(12, 12), "aktiv", "aktiv"), { on: D(-200), from: "aktiv", to: "ruhend", reason: "Längere Auslandsentsendung" }] },
    { key: "melanie", first: "Melanie", last: "Kraus", birth: A(36, 18), cat: "aktiv", status: "ruhend", joined: J(6, 90), depts: [{ key: "turnen" }], history: [entry(J(6, 90), "aktiv", "aktiv"), { on: D(-100), from: "aktiv", to: "ruhend", reason: "Elternzeit" }] },
    { key: "uwe", first: "Uwe", last: "Lehmann", birth: A(50, 40), cat: "aktiv", status: "ausgetreten", joined: J(14, 0), left: D(-85), exitReason: "Kündigung zum Quartalsende", history: [entry(J(14, 0), "aktiv", "aktiv"), { on: D(-85), from: "aktiv", to: "ausgetreten", reason: "Kündigung zum Quartalsende" }] },
    { key: "svenja", first: "Svenja", last: "Otto", birth: A(27, 77), cat: "aktiv", status: "ausgetreten", joined: J(4, 200), left: D(-400), exitReason: "Kündigung zum Jahresende", history: [entry(J(4, 200), "aktiv", "aktiv"), { on: D(-400), from: "aktiv", to: "ausgetreten", reason: "Kündigung zum Jahresende" }] },
    { key: "rainer", first: "Rainer", last: "Winter", birth: A(55, 12), cat: "aktiv", status: "ausgeschlossen", joined: J(9, 0), left: D(-60), exitReason: "Ausschluss wegen vereinsschädigenden Verhaltens", legalHold: "Offene Rückforderung des Vereins", history: [entry(J(9, 0), "aktiv", "aktiv"), { on: D(-60), from: "aktiv", to: "ausgeschlossen", reason: "Ausschluss durch Vorstandsbeschluss" }] },
    // --- pipeline ---
    { key: "tobias", first: "Tobias", last: "Brandl", birth: A(25, 33), cat: "aktiv", status: "interessent", joined: D(-10), noNumber: true, phone: true, history: [{ on: D(-10), from: null, to: "interessent", toCat: "aktiv", reason: "Aufnahmeantrag eingegangen" }] },
    { key: "sandra", first: "Sandra", last: "Koch", birth: A(35, 88), cat: "aktiv", status: "interessent", joined: D(-3), noNumber: true, history: [{ on: D(-3), from: null, to: "interessent", toCat: "aktiv", reason: "Interesse am Probetraining" }] },
    { key: "fatima", first: "Fatima", last: "Hassan", birth: A(27, 15), cat: "aktiv", status: "probe", joined: D(-21), phone: true, depts: [{ key: "schwimmen" }], history: [{ on: D(-21), from: null, to: "interessent", toCat: "aktiv", reason: "Anfrage" }, { on: D(-14), from: "interessent", to: "probe", reason: "Probetraining vereinbart" }] },
    { key: "ali", first: "Ali", last: "Demir", birth: A(17, 10), cat: "jugend", status: "probe", joined: D(-14), phone: true, depts: [{ key: "fussball" }], history: [{ on: D(-14), from: null, to: "probe", toCat: "jugend", reason: "Probemitgliedschaft Fußball" }] },
  ];
}

const slugName = (s: string) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");

/**
 * Master data of every member: the account members created by Better Auth get their real data, the others are inserted with
 * the automatic member number. Status history, department assignments and one audit entry per member are written as well.
 */
export async function seedMembers(ctx: DemoCtx): Promise<void> {
  const founder = accountOf(ctx, "vorsitz");
  const list = specs(ctx.today);
  const catId = (key: string) => ctx.cat[key] ?? null;
  let i = 0;
  for (const s of list) {
    i += 1;
    const display = s.display ?? `${s.first} ${s.last}`;
    const street = `${STREETS[i % STREETS.length]} ${(i * 7) % 40 + 1}`;
    const contactFields = {
      displayName: display,
      firstName: s.first,
      lastName: s.last,
      birthDate: s.birth,
      street: s.address ? street : null,
      postalCode: s.address ? "55555" : null,
      city: s.address ? "Wiesbach" : null,
      phone: s.phone ? `0151 5550 ${String(4000 + i * 13).padStart(4, "0")}` : null,
      emergencyContactName: s.emergency?.[0] ?? null,
      emergencyContactPhone: s.emergency?.[1] ?? null,
      categoryId: catId(s.cat),
      status: s.status,
      joinedAt: s.joined,
      leftAt: s.left ?? null,
      exitReason: s.exitReason ?? null,
      legalHoldAt: s.legalHold ? ctx.now : null,
      legalHoldReason: s.legalHold ?? null,
      updatedAt: new Date(),
    };
    let rowId: string;
    if (s.account) {
      const person = accountOf(ctx, s.account);
      rowId = person.clubMemberId;
      // The account e-mail stays the contact address (set by Better Auth's hook); the master data gets the real values.
      await db
        .update(clubMembers)
        .set({ ...contactFields, ...(s.noNumber ? { memberNumber: null } : {}) })
        .where(eq(clubMembers.id, rowId));
    } else {
      const created = await db.transaction(async (tx) => {
        const memberNumber = s.noNumber ? null : await nextMemberNumber(tx, ctx.clubId);
        const [row] = await tx
          .insert(clubMembers)
          .values({
            clubId: ctx.clubId,
            ...contactFields,
            contactEmail: s.email === null ? null : `${s.email ?? slugName(display)}@${ctx.opts.emailDomain}`,
            memberNumber,
            privacyNoticeSentAt: null,
          })
          .returning({ id: clubMembers.id });
        return row!.id;
      });
      rowId = created;
    }
    ctx.cm[s.key] = rowId;

    // Status / category history: the default is one "Eintritt" entry; explicit steps replace it.
    const steps: HistoryStep[] = s.history ?? [{ on: s.joined, from: null, to: s.status, toCat: s.cat, reason: "Eintritt" }];
    for (const h of steps) {
      await db.insert(clubMemberStatusHistory).values({
        clubMemberId: rowId,
        fromStatus: h.from,
        toStatus: h.to,
        fromCategoryId: h.fromCat ? catId(h.fromCat) : null,
        toCategoryId: h.toCat ? catId(h.toCat) : catId(s.cat),
        effectiveOn: h.on,
        reason: h.reason,
        changedBy: founder.memberId,
      });
    }
    await writeAudit(db, {
      eventType: "club_member.create",
      subjectId: rowId,
      actorUserId: founder.userId,
      payload: { clubId: ctx.clubId, categoryId: catId(s.cat), createdBy: founder.memberId, status: s.status },
    });

    for (const d of s.depts ?? []) {
      await db.insert(clubMemberDepartments).values({ clubMemberId: rowId, departmentId: ctx.dept[d.key]!, since: d.since ?? s.joined, until: d.until ?? null });
    }
  }
  ctx.log(`${list.length} Mitglieder (davon ${list.filter((s) => s.account).length} mit Konto)`);
}

/** Department leads (pointer on the department; the authoritative role lives in club_roles). Schwimmen stays without a lead on purpose. */
export async function seedDepartmentLeads(ctx: DemoCtx): Promise<void> {
  const leads: Array<[string, string]> = [
    ["fussball", "abtleit"],
    ["tennis", "abtleit2"],
    ["turnen", "beisitz"],
  ];
  for (const [dept, who] of leads) {
    await db
      .update(departments)
      .set({ leadMemberId: accountOf(ctx, who).memberId })
      .where(and(eq(departments.id, ctx.dept[dept]!), eq(departments.clubId, ctx.clubId)));
  }
}
