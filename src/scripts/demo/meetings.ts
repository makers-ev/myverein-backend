import { db } from "../../db/client.js";
import { meetingAttendance, meetingInvitees, meetingResolutions, meetings } from "../../db/schema/meetings.js";
import { writeAudit } from "../../lib/audit.js";
import { accountOf, berlinTime, shiftDays, type DemoCtx } from "./context.js";

const BOARD = ["vorsitz", "stellv", "kasse", "schrift", "beisitz"] as const;

/** Board meetings (one held with minutes and resolutions, one planned) and a meeting still looking for a date (Terminfindung). */
export async function seedBoardMeetings(ctx: DemoCtx): Promise<void> {
  const creator = accountOf(ctx, "schrift");
  const t = ctx.today;
  const make = async (key: string, v: Omit<typeof meetings.$inferInsert, "clubId" | "createdBy">) => {
    const [row] = await db.insert(meetings).values({ clubId: ctx.clubId, createdBy: creator.userId, ...v }).returning({ id: meetings.id });
    ctx.meeting[key] = row!.id;
    await writeAudit(db, { eventType: "meeting.create", subjectId: row!.id, actorUserId: creator.userId, payload: { clubId: ctx.clubId, type: v.type } });
    return row!.id;
  };

  const past = await make("vorstand_past", {
    type: "vorstandssitzung",
    title: "Vorstandssitzung: Sturmschaden und Beamer",
    scheduledAt: berlinTime(shiftDays(t, -20), "19:30"),
    locationId: ctx.loc.heim!,
    agenda: "1. Begrüßung\n2. Sturmschaden am Sportplatz\n3. Anschaffung Beamer\n4. Sommerfest\n5. Verschiedenes",
    minutes: "Anwesend: Vorsitz, Stellvertretung, Kasse, Schriftführung, Beisitz.\n\nTOP 2: Der Sportplatz bleibt bis zur Reparatur gesperrt. Auftrag an die Abteilungsleitung Fußball.\nTOP 3: Der Beamer des Vereinsheims wird ersetzt (bis 600 EUR).\nTOP 4: Das Sommerfest findet im Vereinsheim statt, Planung durch die Abteilungsleitungen.",
    status: "protokolliert",
  });
  for (const key of BOARD) {
    const p = accountOf(ctx, key);
    await db.insert(meetingInvitees).values({ meetingId: past, clubMemberId: p.clubMemberId, response: "zugesagt" });
    await db.insert(meetingAttendance).values({ meetingId: past, clubMemberId: p.clubMemberId, present: true, hasVotingRight: true, checkedInAt: berlinTime(shiftDays(t, -20), "19:25"), checkInMethod: "schriftfuehrer" });
  }
  await db.insert(meetingResolutions).values([
    { meetingId: past, description: "Anschaffung eines neuen Beamers bis 600 Euro", votesFor: 4, votesAgainst: 0, votesAbstain: 1, result: "angenommen" },
    { meetingId: past, description: "Reparaturauftrag für den Sportplatz nach dem Sturmschaden", votesFor: 5, votesAgainst: 0, votesAbstain: 0, result: "angenommen" },
  ]);

  const next = await make("vorstand_next", {
    type: "vorstandssitzung",
    title: "Vorstandssitzung: Vorbereitung Mitgliederversammlung",
    scheduledAt: berlinTime(shiftDays(t, 9), "19:30"),
    locationId: ctx.loc.heim!,
    agenda: "1. Begrüßung\n2. Tagesordnung der außerordentlichen Mitgliederversammlung\n3. Kandidatensuche Kassenwart\n4. Ersatz Ballmaschine\n5. Verschiedenes",
    status: "geplant",
  });
  const answers: Record<string, string> = { vorsitz: "zugesagt", stellv: "zugesagt", kasse: "abgesagt", schrift: "zugesagt", beisitz: "ausstehend" };
  for (const key of BOARD) await db.insert(meetingInvitees).values({ meetingId: next, clubMemberId: accountOf(ctx, key).clubMemberId, response: answers[key]! });

  const orga = await make("terminfindung", {
    type: "sonstige",
    title: "Orga-Treffen Sommerfest",
    scheduledAt: null,
    locationId: ctx.loc.heim!,
    agenda: "Aufgaben verteilen: Grillstand, Spiele, Aufbau.",
    status: "terminfindung",
  });
  for (const key of ["abtleit", "abtleit2", "trainer", "mitglied", "jugend"]) {
    await db.insert(meetingInvitees).values({ meetingId: orga, clubMemberId: accountOf(ctx, key).clubMemberId, response: "ausstehend" });
  }
  ctx.log("3 Sitzungen: Vorstandssitzung (protokolliert mit Beschlüssen), geplante Vorstandssitzung, Terminfindung");
}
