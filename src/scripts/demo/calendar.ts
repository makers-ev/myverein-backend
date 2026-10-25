import { eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { wardEventResponses } from "../../db/schema/absences.js";
import { availabilityExceptions, availabilitySlots } from "../../db/schema/availability.js";
import { calendarVisibility } from "../../db/schema/calendar-visibility.js";
import { calendars } from "../../db/schema/calendars.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { eventAttendees } from "../../db/schema/event-attendees.js";
import { events } from "../../db/schema/events.js";
import { createAbsence, withdrawAbsence } from "../../lib/absences.js";
import { writeAudit } from "../../lib/audit.js";
import { BOARD_ROLE_TYPES } from "../../lib/club-permissions.js";
import { accountOf, berlinTime, clubMemberOf, isoWeekday, nextWeekday, shiftDays, type DemoCtx } from "./context.js";

interface EventSpec {
  key?: string;
  cal: string;
  title: string;
  description?: string;
  date: string;
  from: string;
  to?: string;
  category: string;
  capacity?: number;
  loc?: string;
  cancelled?: string;
}

/** Calendars (club-wide, per department, board only) and their visibility rules. */
export async function seedCalendars(ctx: DemoCtx): Promise<void> {
  const creator = accountOf(ctx, "vorsitz");
  const mk = async (key: string, name: string, departmentId: string | null) => {
    const [row] = await db.insert(calendars).values({ clubId: ctx.clubId, departmentId, name, createdBy: creator.userId }).returning({ id: calendars.id });
    ctx.cal[key] = row!.id;
    await writeAudit(db, { eventType: "calendar.create", subjectId: row!.id, actorUserId: creator.userId, payload: { clubId: ctx.clubId, calendarId: row!.id } });
    return row!.id;
  };
  for (const [key, name] of [["fussball", "Fußball"], ["tennis", "Tennis"], ["turnen", "Turnen"]] as const) {
    const id = await mk(key, name, ctx.dept[key]!);
    // Visible to the members of that department; everybody else does not see the calendar at all.
    await db.insert(calendarVisibility).values({ calendarId: id, departmentId: ctx.dept[key]! });
  }
  const board = await mk("vorstand", "Vorstand", null);
  await db.insert(calendarVisibility).values(BOARD_ROLE_TYPES.map((roleType) => ({ calendarId: board, roleType })));
  ctx.log("Kalender: Verein, 3 Abteilungskalender, Vorstandskalender mit Sichtbarkeitsregeln");
}

function eventSpecs(ctx: DemoCtx): EventSpec[] {
  const t = ctx.today;
  const out: EventSpec[] = [];
  // Weekly football training, Tuesday and Thursday: three weeks back, five weeks ahead (the series is stored as single events).
  for (let d = -21; d <= 35; d++) {
    const date = shiftDays(t, d);
    const wd = isoWeekday(date);
    if (wd !== 2 && wd !== 4) continue;
    out.push({ cal: "fussball", title: wd === 2 ? "Training Herren" : "Training Herren (Taktik)", date, from: "18:30", to: "20:00", category: "Training", loc: "platz", description: "Wöchentliches Training. Bitte bis 17:30 Uhr zu- oder absagen." });
  }
  // The next Tuesday's training is cancelled, one in the past as well.
  const nextTue = nextWeekday(shiftDays(t, 1), 2);
  const cancelled = out.find((e) => e.date === nextTue);
  if (cancelled) cancelled.cancelled = "Platz wegen Sturmschaden gesperrt.";
  const pastTue = out.find((e) => e.date < t && isoWeekday(e.date) === 4);
  if (pastTue) pastTue.cancelled = "Trainer erkrankt, kein Ersatz.";
  for (let w = 0; w < 4; w++) {
    out.push({ cal: "tennis", title: "Tennis-Training Erwachsene", date: shiftDays(nextWeekday(t, 3), w * 7), from: "17:00", to: "18:30", category: "Training", loc: "tennis" });
  }
  for (let w = -2; w < 5; w++) {
    out.push({ cal: "turnen", title: "Kinderturnen", date: shiftDays(nextWeekday(t, 5), w * 7), from: "16:00", to: "17:00", category: "Training", loc: "halle", description: "Für Kinder von 5 bis 10 Jahren." });
  }
  const sat = (weeks: number) => shiftDays(nextWeekday(t, 6), weeks * 7);
  out.push(
    { key: "putztag", cal: "verein", title: "Vereinsputztag", description: "Gemeinsam Platz und Vereinsheim herrichten, danach Grillen.", date: shiftDays(t, -10), from: "09:00", to: "13:00", category: "Arbeitseinsatz", loc: "platz" },
    { key: "sommerfest", cal: "verein", title: "Sommerfest", description: "Familienfest mit Spielen, Grillbuffet und Siegerehrung. Bitte melden Sie sich bis zum Vortag an.", date: sat(3), from: "14:00", to: "22:00", category: "Fest", capacity: 120, loc: "heim" },
    { key: "fortbildung", cal: "verein", title: "Trainerfortbildung Erste Hilfe", description: "Auffrischung für alle Trainerinnen und Trainer. Nur vier Plätze.", date: sat(1), from: "10:00", to: "14:00", category: "Fortbildung", capacity: 4, loc: "heim" },
    { key: "schnupper", cal: "turnen", title: "Schnuppertraining Kinderturnen", description: "Probestunde für neue Kinder. Eltern melden ihre Kinder über die App an.", date: shiftDays(nextWeekday(t, 5), 14), from: "15:00", to: "16:00", category: "Training", capacity: 4, loc: "halle" },
    { key: "saisonstart", cal: "tennis", title: "Saisoneröffnung Tennis", date: sat(2), from: "11:00", to: "15:00", category: "Fest", capacity: 24, loc: "tennis" },
    { key: "weihnacht", cal: "verein", title: "Weihnachtsfeier", description: "Jahresabschluss mit Ehrungen.", date: shiftDays(t, 60), from: "18:00", to: "22:30", category: "Fest", capacity: 80, loc: "heim" },
    { key: "mv_event", cal: "verein", title: "Außerordentliche Mitgliederversammlung", description: "Einladung und Tagesordnung unter Sitzungen.", date: shiftDays(t, 35), from: "19:00", to: "21:30", category: "Versammlung", loc: "heim" },
    { key: "vorstand_event", cal: "vorstand", title: "Vorstandssitzung", date: shiftDays(t, 9), from: "19:30", to: "21:30", category: "Vorstandssitzung", loc: "heim" },
    { key: "vorstand_past", cal: "vorstand", title: "Vorstandssitzung", date: shiftDays(t, -20), from: "19:30", to: "21:30", category: "Vorstandssitzung", loc: "heim" },
  );
  return out;
}

/** Events past and future (a recurring series, a cancelled event, capacity and waiting lists), RSVPs of accounts and wards. */
export async function seedEvents(ctx: DemoCtx): Promise<void> {
  const creator = accountOf(ctx, "vorsitz");
  const specs = eventSpecs(ctx);
  for (const e of specs) {
    const [row] = await db
      .insert(events)
      .values({
        calendarId: ctx.cal[e.cal]!,
        title: e.title,
        description: e.description ?? null,
        startsAt: berlinTime(e.date, e.from),
        endsAt: e.to ? berlinTime(e.date, e.to) : null,
        category: e.category,
        capacity: e.capacity ?? null,
        locationId: e.loc ? ctx.loc[e.loc]! : null,
        createdBy: creator.userId,
        cancelledAt: e.cancelled ? new Date(ctx.now.getTime() - 3_600_000) : null,
        cancelReason: e.cancelled ?? null,
      })
      .returning({ id: events.id });
    if (e.key) ctx.ev[e.key] = row!.id;
    if (e.cal === "fussball" && !ctx.ev.training_next && e.date >= ctx.today && !e.cancelled) ctx.ev.training_next = row!.id;
  }

  const rsvp = async (eventKey: string, who: string, status: "angemeldet" | "abgesagt" | "warteliste", daysAgo = 2) => {
    await db.insert(eventAttendees).values({ eventId: ctx.ev[eventKey]!, memberId: accountOf(ctx, who).memberId, status, respondedAt: new Date(ctx.now.getTime() - daysAgo * 86_400_000) });
  };
  // Capacity 4 with a waiting list and a decline.
  for (const w of ["trainer", "trainer2", "abtleit", "abtleit2"]) await rsvp("fortbildung", w, "angemeldet", 5);
  await rsvp("fortbildung", "mitglied", "warteliste", 1);
  await rsvp("fortbildung", "jugend", "warteliste", 1);
  await rsvp("fortbildung", "beisitz", "abgesagt", 3);
  // Sommerfest: plenty of room.
  for (const w of ["vorsitz", "stellv", "kasse", "schrift", "mitglied", "trainer", "jugend"]) await rsvp("sommerfest", w, "angemeldet", 4);
  await rsvp("sommerfest", "abtleit2", "abgesagt", 1);
  // Regular training: a few answers on the next session.
  for (const w of ["trainer", "abtleit"]) await rsvp("training_next", w, "angemeldet", 1);
  await rsvp("training_next", "mitglied", "abgesagt", 1);
  // Kids' trial class (capacity 4): Emma helps, Petra and Lukas answer for their children (accounts-less wards), the fourth child waits.
  await rsvp("schnupper", "jugend", "angemeldet", 3);
  const ward = async (who: string, status: "angemeldet" | "abgesagt" | "warteliste", guardian: string) => {
    await db.insert(wardEventResponses).values({ eventId: ctx.ev.schnupper!, wardClubMemberId: clubMemberOf(ctx, who), status, respondedByUserId: accountOf(ctx, guardian).userId, respondedAt: new Date(ctx.now.getTime() - 2 * 86_400_000) });
  };
  await ward("noah", "angemeldet", "eltern");
  await ward("mia", "angemeldet", "eltern");
  await ward("finn", "angemeldet", "mitglied");
  await ward("lina", "warteliste", "eltern");
  ctx.log(`${specs.length} Termine inkl. wöchentlicher Serie, 2 abgesagten Terminen, Teilnehmerlimit/Warteliste und Anmeldungen für Kinder`);
}

/** Weekly availability windows and one-off exceptions of trainers and a member. */
export async function seedAvailability(ctx: DemoCtx): Promise<void> {
  const slots: Array<[string, number, string, string, string?]> = [
    ["trainer", 1, "17:00", "20:30", "Dienstag"],
    ["trainer", 3, "17:00", "20:30", "Donnerstag"],
    ["trainer2", 2, "16:00", "19:00"],
    ["trainer2", 5, "09:00", "12:00", "Samstagvormittag"],
    ["abtleit", 0, "18:00", "21:00"],
    ["abtleit", 2, "18:00", "21:00"],
    ["mitglied", 5, "10:00", "14:00", "Nur samstags"],
  ];
  for (const [who, weekday, start, end, note] of slots) {
    await db.insert(availabilitySlots).values({ memberId: accountOf(ctx, who).memberId, weekday, startTime: start, endTime: end, note: note ?? null });
  }
  await db.insert(availabilityExceptions).values([
    { memberId: accountOf(ctx, "trainer").memberId, date: shiftDays(ctx.today, 12), isAvailable: false, note: "Urlaub" },
    { memberId: accountOf(ctx, "trainer").memberId, date: shiftDays(ctx.today, 13), isAvailable: false, note: "Urlaub" },
    { memberId: accountOf(ctx, "trainer2").memberId, date: shiftDays(ctx.today, 8), isAvailable: true, note: "Springt am Samstag ein" },
  ]);
  ctx.log(`${slots.length} Verfügbarkeiten, 3 Ausnahmen`);
}

/** Absence reports: sick (self), away (self), sick for a child (guardian) and a withdrawn one. */
export async function seedAbsences(ctx: DemoCtx): Promise<void> {
  const row = async (key: string) => {
    const found = await db.query.clubMembers.findFirst({ where: eq(clubMembers.id, clubMemberOf(ctx, key)) });
    if (!found) throw new Error(`club member ${key} not found`);
    return found;
  };
  const t = ctx.today;
  await createAbsence(ctx.clubId, await row("trainer"), { kind: "krank", startsOn: shiftDays(t, -1), endsOn: shiftDays(t, 2), note: "Grippe, melde mich zurück." }, { userId: accountOf(ctx, "trainer").userId, kind: "self" });
  await createAbsence(ctx.clubId, await row("mitglied"), { kind: "abwesend", startsOn: shiftDays(t, 10), endsOn: shiftDays(t, 24), note: "Urlaub" }, { userId: accountOf(ctx, "mitglied").userId, kind: "self" });
  await createAbsence(ctx.clubId, await row("noah"), { kind: "krank", startsOn: t, endsOn: shiftDays(t, 4), note: "Magen-Darm-Infekt" }, { userId: accountOf(ctx, "eltern").userId, kind: "guardian" });
  await createAbsence(ctx.clubId, await row("finn"), { kind: "abwesend", startsOn: shiftDays(t, 3), endsOn: shiftDays(t, 9), note: "Familienurlaub" }, { userId: accountOf(ctx, "mitglied").userId, kind: "guardian" });
  const withdrawn = await createAbsence(ctx.clubId, await row("trainer2"), { kind: "abwesend", startsOn: shiftDays(t, -2), endsOn: shiftDays(t, 5), note: "Dienstreise" }, { userId: accountOf(ctx, "trainer2").userId, kind: "self" });
  await withdrawAbsence(ctx.clubId, await row("trainer2"), withdrawn.id, accountOf(ctx, "trainer2").userId);
  ctx.log("5 Abwesenheitsmeldungen (krank/abwesend, Eltern, eine zurückgezogen)");
}
