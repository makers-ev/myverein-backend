import { and, asc, eq, isNull, lte } from "drizzle-orm";

import { db } from "../../db/client.js";
import { rateCards, timeEntries } from "../../db/schema/event-extras.js";
import { events } from "../../db/schema/events.js";
import { writeAudit } from "../../lib/audit.js";
import { assertEntryWindow, assertNoOverlap } from "../../lib/time-tracking.js";
import { accountOf, berlinTime, shiftDays, type DemoCtx } from "./context.js";

/**
 * Time tracking, hourly rates and the time report (Wave 12 B20, P2). Rules come from `src/lib/time-tracking.ts`: a rate card
 * belongs to a person OR a role type, a personal card beats a role card, cards of the same target never overlap, an entry is
 * priced with the rate of its Berlin start day, only confirmed entries count, nobody confirms their own entry.
 *
 * Rates (EUR per hour, role cards are valid from 1 January of last year):
 *   mitglied 8 (everybody with an account except external guests), trainer 18, abteilungsleitung 22 (until the end of this month)
 *   and 24 (from the first of next month, future dated), Marco Vogel personal 20 (lapsed 31 days ago) and 25 (since 30 days ago).
 *
 * Who is in the data: Marco (trainer Fußball, personal rate, two rates in the report), Nina (trainer Schwimmen, role rate),
 * Ute (Abteilungsleitung Fußball), Lukas, Jan and Lena (rate "Alle Mitglieder"; Lena's trainer term is over). External guests
 * (`gast@`, `erziehungsberechtigt@`) have no rate and no entries: they get 403 `no_rate` when they try to track time.
 */

type Source = "stempeln" | "aus_termin" | "manuell";
type Status = "offen" | "bestaetigt" | "abgelehnt";

interface EntrySpec {
  who: string;
  /** Days from today (negative) of the start. */
  day: number;
  from: string;
  to: string;
  /** Days from today of the end when the entry runs over Berlin midnight (default: same day). */
  endDay?: number;
  source: Source;
  status: Status;
  /** Key of the seeded event the entry belongs to. */
  event?: string;
  /** Who decided (board); never the person themselves. */
  by?: "vorsitz" | "stellv";
}

const firstOfNextMonth = (today: string): string => {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
};

/** The ISO date with the last-year January 1st as a start for the standing role cards. */
const startOfLastYear = (today: string): string => `${Number(today.slice(0, 4)) - 1}-01-01`;

const FIXED_ENTRIES: EntrySpec[] = [
  // Marco, personal card of 20 EUR/h (lapsed): hours without event (preparation, courses)
  { who: "trainer", day: -52, from: "18:00", to: "20:00", source: "stempeln", status: "bestaetigt", by: "vorsitz" },
  { who: "trainer", day: -45, from: "17:30", to: "20:30", source: "manuell", status: "bestaetigt", by: "vorsitz" },
  { who: "trainer", day: -38, from: "18:00", to: "19:30", source: "stempeln", status: "bestaetigt", by: "stellv" },
  { who: "trainer", day: -33, from: "09:00", to: "13:00", source: "manuell", status: "bestaetigt", by: "vorsitz" },
  // Nina, Trainerin Schwimmen: weekly pool hours at the role rate of 18 EUR/h; the department has no lead, only the board sees them
  { who: "trainer3", day: -54, from: "17:00", to: "19:00", source: "stempeln", status: "bestaetigt", by: "vorsitz" },
  { who: "trainer3", day: -47, from: "17:00", to: "19:00", source: "stempeln", status: "bestaetigt", by: "vorsitz" },
  { who: "trainer3", day: -40, from: "17:00", to: "19:00", source: "stempeln", status: "bestaetigt", by: "stellv" },
  { who: "trainer3", day: -33, from: "17:00", to: "19:00", source: "stempeln", status: "bestaetigt", by: "vorsitz" },
  { who: "trainer3", day: -26, from: "17:00", to: "19:00", source: "stempeln", status: "bestaetigt", by: "vorsitz" },
  { who: "trainer3", day: -19, from: "17:00", to: "19:00", source: "stempeln", status: "bestaetigt", by: "stellv" },
  { who: "trainer3", day: -12, from: "17:00", to: "19:00", source: "stempeln", status: "offen" },
  { who: "trainer3", day: -5, from: "17:00", to: "19:00", source: "stempeln", status: "offen" },
  // Ute, Abteilungsleitung Fußball (22 EUR/h)
  { who: "abtleit", day: -48, from: "19:00", to: "21:00", source: "stempeln", status: "bestaetigt", by: "vorsitz" },
  { who: "abtleit", day: -41, from: "18:00", to: "22:00", source: "manuell", status: "bestaetigt", by: "vorsitz" },
  { who: "abtleit", day: -27, from: "17:00", to: "19:30", source: "stempeln", status: "bestaetigt", by: "stellv" },
  { who: "abtleit", day: -13, from: "10:00", to: "12:00", source: "manuell", status: "bestaetigt", by: "vorsitz" },
  { who: "abtleit", day: -2, from: "17:00", to: "18:00", source: "stempeln", status: "offen" },
  // Lukas, ordinary member (8 EUR/h); his clock is running (see below)
  { who: "mitglied", day: -30, from: "10:00", to: "12:30", source: "manuell", status: "bestaetigt", by: "vorsitz" },
  { who: "mitglied", day: -20, from: "14:00", to: "17:00", source: "stempeln", status: "bestaetigt", by: "stellv" },
  { who: "mitglied", day: -7, from: "16:00", to: "18:00", source: "manuell", status: "offen" },
  // Jan, ordinary member: one entry runs over Berlin midnight, one was rejected
  { who: "schrift", day: -31, from: "18:00", to: "20:00", source: "manuell", status: "bestaetigt", by: "vorsitz" },
  { who: "schrift", day: -20, from: "22:15", to: "01:45", endDay: -19, source: "stempeln", status: "bestaetigt", by: "stellv" },
  { who: "schrift", day: -4, from: "18:00", to: "20:00", source: "manuell", status: "abgelehnt", by: "vorsitz" },
  { who: "schrift", day: -1, from: "18:00", to: "20:30", source: "stempeln", status: "offen" },
  // Lena: trainer term over, so the rate for all members applies
  { who: "trainer2", day: -44, from: "16:00", to: "19:00", source: "manuell", status: "bestaetigt", by: "vorsitz" },
  { who: "trainer2", day: -37, from: "15:00", to: "18:00", source: "manuell", status: "bestaetigt", by: "stellv" },
  { who: "trainer2", day: -16, from: "16:00", to: "17:30", source: "manuell", status: "offen" },
];

/** The Vereinsputztag: several people on one event (from the event: 09:00 to 13:00). */
const PUTZTAG: Array<{ who: string; by: "vorsitz" | "stellv" }> = [
  { who: "abtleit", by: "vorsitz" },
  { who: "trainer3", by: "stellv" },
  { who: "mitglied", by: "vorsitz" },
  { who: "schrift", by: "vorsitz" },
];

/** Rate cards, time entries (all sources and statuses), one running clock. */
export async function seedTimeTracking(ctx: DemoCtx): Promise<void> {
  const today = ctx.today;
  const creator = accountOf(ctx, "vorsitz");
  const marco = accountOf(ctx, "trainer");

  // --- Rate cards ----------------------------------------------------------------------------------------------------
  const cards: Array<{ clubMemberId?: string; roleType?: string; cents: number; from: string; until: string | null }> = [
    { roleType: "mitglied", cents: 800, from: startOfLastYear(today), until: null },
    { roleType: "trainer", cents: 1800, from: startOfLastYear(today), until: null },
    { roleType: "abteilungsleitung", cents: 2200, from: startOfLastYear(today), until: shiftDays(firstOfNextMonth(today), -1) },
    { roleType: "abteilungsleitung", cents: 2400, from: firstOfNextMonth(today), until: null },
    { clubMemberId: marco.clubMemberId, cents: 2000, from: startOfLastYear(today), until: shiftDays(today, -31) },
    { clubMemberId: marco.clubMemberId, cents: 2500, from: shiftDays(today, -30), until: null },
  ];
  for (const [i, c] of cards.entries()) {
    // Same rule as the rate card routes: cards of one target must not overlap.
    const clash = cards.slice(0, i).find((o) => (c.clubMemberId ? o.clubMemberId === c.clubMemberId : o.roleType === c.roleType) && o.from <= (c.until ?? "9999-12-31") && (o.until ?? "9999-12-31") >= c.from);
    if (clash) throw new Error("demo rate cards overlap");
    const [row] = await db
      .insert(rateCards)
      .values({ clubId: ctx.clubId, clubMemberId: c.clubMemberId ?? null, roleType: c.roleType ?? null, hourlyRateCents: c.cents, validFrom: c.from, validUntil: c.until, createdBy: creator.memberId })
      .returning({ id: rateCards.id });
    await writeAudit(db, { eventType: "rate_card.create", subjectId: c.clubMemberId ?? null, actorUserId: creator.userId, payload: { clubId: ctx.clubId, cardId: row!.id } });
  }

  // --- Entries ---------------------------------------------------------------------------------------------------------
  let created = 0;
  /** One entry the way the routes create it (window rules, overlap check, audit); a decided entry carries its decision. */
  const add = async (who: string, startedAt: Date, endedAt: Date | null, source: Source, status: Status, eventId: string | null, by?: "vorsitz" | "stellv") => {
    const person = accountOf(ctx, who);
    if (endedAt) assertEntryWindow(startedAt, endedAt, ctx.now);
    await db.transaction(async (tx) => {
      if (endedAt) await assertNoOverlap(tx, person.clubMemberId, startedAt, endedAt);
      const decider = by ? accountOf(ctx, by) : null;
      if (status !== "offen" && (!decider || decider.clubMemberId === person.clubMemberId)) throw new Error("nobody decides about their own time entry");
      const end = endedAt ?? ctx.now;
      const decidedAt = new Date(Math.min(end.getTime() + 20 * 3_600_000, ctx.now.getTime()));
      const [row] = await tx
        .insert(timeEntries)
        .values({
          clubId: ctx.clubId,
          clubMemberId: person.clubMemberId,
          eventId,
          startedAt,
          endedAt,
          source,
          status,
          confirmedBy: status === "offen" ? null : decider!.userId,
          confirmedAt: status === "offen" ? null : decidedAt,
          createdAt: new Date(Math.min(end.getTime() + 10 * 60_000, ctx.now.getTime())),
        })
        .returning({ id: timeEntries.id });
      const base = { clubId: ctx.clubId, clubMemberId: person.clubMemberId, entryId: row!.id };
      if (source === "stempeln") {
        await writeAudit(tx, { eventType: "time_entry.clock_in", subjectId: person.clubMemberId, actorUserId: person.userId, payload: base });
        if (endedAt) await writeAudit(tx, { eventType: "time_entry.clock_out", subjectId: person.clubMemberId, actorUserId: person.userId, payload: base });
      } else {
        await writeAudit(tx, { eventType: "time_entry.create", subjectId: person.clubMemberId, actorUserId: person.userId, payload: { ...base, source } });
      }
      if (status !== "offen") await writeAudit(tx, { eventType: status === "bestaetigt" ? "time_entry.confirm" : "time_entry.reject", subjectId: person.clubMemberId, actorUserId: decider!.userId, payload: base });
    });
    created += 1;
  };

  for (const e of FIXED_ENTRIES) {
    await add(e.who, berlinTime(shiftDays(today, e.day), e.from), berlinTime(shiftDays(today, e.endDay ?? e.day), e.to), e.source, e.status, e.event ? (ctx.ev[e.event] ?? null) : null, e.by);
  }

  // The Vereinsputztag: taken over from the event (source aus_termin, the times are those of the event).
  const putztag = ctx.ev.putztag;
  if (putztag) {
    const [ev] = await db.select().from(events).where(eq(events.id, putztag));
    if (ev?.endsAt) for (const p of PUTZTAG) await add(p.who, ev.startsAt, ev.endsAt, "aus_termin", "bestaetigt", putztag, p.by);
  }

  // Marco's trainings of the last weeks: taken over from the real (not cancelled, finished) football events at 25 EUR/h; the latest one is still open.
  const trainings = await db
    .select()
    .from(events)
    .where(and(eq(events.calendarId, ctx.cal.fussball!), isNull(events.cancelledAt), lte(events.endsAt, new Date(ctx.now.getTime() - 5 * 60_000))))
    .orderBy(asc(events.startsAt));
  for (const [i, ev] of trainings.entries()) {
    if (!ev.endsAt) continue;
    const latest = i === trainings.length - 1;
    await add("trainer", ev.startsAt, ev.endsAt, "aus_termin", latest ? "offen" : "bestaetigt", ev.id, latest ? undefined : i % 2 === 0 ? "vorsitz" : "stellv");
  }

  // Lukas has started his clock about 90 minutes ago and has not stopped it (ended_at stays NULL).
  await add("mitglied", new Date(ctx.now.getTime() - 90 * 60_000), null, "stempeln", "offen", null);

  ctx.log(`${cards.length} Stundensätze (Rollen- und persönliche Sätze, abgelaufen und zukünftig), ${created} Zeiteinträge (bestätigt, offen, abgelehnt, über Mitternacht, eine laufende Uhr)`);
}

/** "Which login for what" of the time tracking demo (printed at the end of the seed). */
export const TIME_LOGIN_HINTS: ReadonlyArray<{ login: string; use: string }> = [
  { login: "vorsitz@ / stellv.vorsitz@", use: "Stundenbericht mit Beträgen (Filter, Gruppierung, CSV/XLSX), Stundensätze pflegen, offene Zeiten bestätigen oder ablehnen" },
  { login: "kassenwart@", use: "Stundenbericht mit Beträgen und Stundensätzen lesen; bestätigen darf der Kassenwart nicht" },
  { login: "abteilungsleitung@", use: "Stundenbericht nur mit Stunden (keine Beträge), nur Abteilung Fußball (Marco, Ute); bestätigt Zeiten der Abteilung, nicht die eigenen" },
  { login: "abteilungsleitung2@", use: "Stundenbericht nur Stunden der Abteilung Tennis (Lukas, Lena, Monika)" },
  { login: "trainer@", use: "Zeiterfassung mit persönlichem Satz: 20 EUR/h bis vor 31 Tagen, danach 25 EUR/h; Vorschläge aus Terminen" },
  { login: "trainer3@", use: "Trainerin Schwimmen: Satz der Rolle Trainer (18 EUR/h), offene Zeiten; Abteilung ohne Leitung, nur der Vorstand sieht ihre Stunden" },
  { login: "mitglied@", use: "Zeiterfassung ohne Trainer- oder Leitungsrolle über den Satz für alle Mitglieder (8 EUR/h); die Stempeluhr läuft seit dem Seed" },
  { login: "gast@ / erziehungsberechtigt@", use: "Externe ohne Stundensatz: Zeiterfassung wird mit no_rate abgelehnt (Fall \"kein Satz\")" },
];
