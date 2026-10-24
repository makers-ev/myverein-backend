import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { ballotVotesOpen, ballots, clubRoleTerms, elections, meetingAgendaItems, meetingInvitationDeliveries } from "../../db/schema/assembly.js";
import { messageDeliveries } from "../../db/schema/communication.js";
import { meetingAttendance, meetingInvitees, meetingResolutions, meetings, type MeetingRow } from "../../db/schema/meetings.js";
import { freezeVotingRoll, grantProxy, isEligible, loadEligibility } from "../../lib/assembly-attendance.js";
import { hashContent, sendInvitation } from "../../lib/assembly-invitation.js";
import { writeAudit } from "../../lib/audit.js";
import { castVote, closeBallot, countBallot, createBallot, finalizeBallot, openBallot, optionsOf } from "../../lib/ballots.js";
import { answerElection, createElection, createRound, decideElection, proposeCandidate, setCandidateStatus } from "../../lib/elections.js";
import { addMinutesAmendment, approveMinutes, archiveMinutes, confirmMinutes, saveMinutesDraft, submitMinutes } from "../../lib/minutes.js";
import { accountOf, berlinTime, clubMemberOf, monthsAgo, shiftDays, type DemoCtx } from "./context.js";

type Vote = "yes" | "no" | "abstain";

const meetingRow = async (id: string): Promise<MeetingRow> => {
  const row = await db.query.meetings.findFirst({ where: eq(meetings.id, id) });
  if (!row) throw new Error("meeting vanished");
  return row;
};

async function createMeeting(ctx: DemoCtx, key: string, v: { title: string; date: string; time: string; participationMode?: string; onlineUrl?: string | null }): Promise<MeetingRow> {
  const [row] = await db
    .insert(meetings)
    .values({
      clubId: ctx.clubId,
      type: "mitgliederversammlung",
      title: v.title,
      scheduledAt: berlinTime(v.date, v.time),
      locationId: ctx.loc.heim!,
      status: "geplant",
      participationMode: v.participationMode ?? "praesenz",
      onlineUrl: v.onlineUrl ?? null,
      createdBy: accountOf(ctx, "schrift").userId,
    })
    .returning();
  ctx.meeting[key] = row!.id;
  await writeAudit(db, { eventType: "meeting.create", subjectId: row!.id, actorUserId: accountOf(ctx, "schrift").userId, payload: { clubId: ctx.clubId, type: "mitgliederversammlung" } });
  return row!;
}

interface AgendaSpec {
  title: string;
  description?: string;
  voteKind?: "none" | "resolution" | "election";
  topic?: string;
}

async function addAgenda(meetingId: string, items: AgendaSpec[], startAt = 1): Promise<string[]> {
  const ids: string[] = [];
  let position = startAt;
  for (const it of items) {
    const [row] = await db
      .insert(meetingAgendaItems)
      .values({ meetingId, position: position++, title: it.title, description: it.description ?? null, voteKind: it.voteKind ?? "none", topic: it.topic ?? "allgemein" })
      .returning({ id: meetingAgendaItems.id });
    ids.push(row!.id);
  }
  return ids;
}

/** Sends the formal invitation through the real service (period check, content hash, delivery proof) with an optional historic send time. */
async function invite(ctx: DemoCtx, meeting: MeetingRow, message: string, now?: Date) {
  const result = await sendInvitation({ clubId: ctx.clubId, meeting, actorUserId: accountOf(ctx, "schrift").userId, message, ...(now ? { now } : {}) });
  if (now) {
    // A historic invitation: its in-app messages and delivery proof carry the sending time, not the seed time.
    await db.update(messageDeliveries).set({ createdAt: now, sentAt: now, readAt: now }).where(and(eq(messageDeliveries.eventKey, "meeting.invitation"), eq(messageDeliveries.refId, result.invitation.id)));
    await db.update(meetingInvitationDeliveries).set({ statusAt: now }).where(eq(meetingInvitationDeliveries.invitationId, result.invitation.id));
  }
  return result.invitation;
}

/** Check-in rows for the people present; the voting right comes from the (frozen) roll. */
async function checkIn(ctx: DemoCtx, meeting: MeetingRow, present: Array<{ key: string; method?: "schriftfuehrer" | "self_online" | "vollmacht" }>): Promise<string[]> {
  const eligibility = await loadEligibility(db, ctx.clubId, meeting);
  const base = (meeting.scheduledAt ?? ctx.now).getTime() - 25 * 60_000;
  const eligibleIds: string[] = [];
  let i = 0;
  for (const p of present) {
    const id = clubMemberOf(ctx, p.key);
    const right = isEligible(eligibility, id);
    if (right) eligibleIds.push(id);
    await db.insert(meetingAttendance).values({ meetingId: meeting.id, clubMemberId: id, present: true, hasVotingRight: right, checkedInAt: new Date(base + i++ * 40_000), checkInMethod: p.method ?? "schriftfuehrer" });
  }
  return eligibleIds;
}

/** Moves the timestamps of a finished ballot (and what hangs on it) to the evening of the meeting and re-seals the result hash. */
async function moveBallotTo(ballotId: string, target: Date): Promise<void> {
  const b = await db.query.ballots.findFirst({ where: eq(ballots.id, ballotId) });
  if (!b?.opensAt || !b.finalizedAt) throw new Error("ballot is not finalized");
  const delta = target.getTime() - b.opensAt.getTime();
  const shift = (d: Date | null) => (d ? new Date(d.getTime() + delta) : null);
  const finalizedAt = shift(b.finalizedAt)!;
  const result = { ...(b.result ?? {}), finalizedAt: finalizedAt.toISOString() };
  await db
    .update(ballots)
    .set({ opensAt: shift(b.opensAt), closesAt: shift(b.closesAt), closedAt: shift(b.closedAt), countedAt: shift(b.countedAt), finalizedAt, createdAt: shift(b.createdAt)!, updatedAt: finalizedAt, result, resultHash: hashContent(result) })
    .where(eq(ballots.id, ballotId));
  await db.update(ballotVotesOpen).set({ createdAt: sql`${ballotVotesOpen.createdAt} + ${delta} * interval '1 millisecond'` }).where(eq(ballotVotesOpen.ballotId, ballotId));
  await db.update(meetingResolutions).set({ createdAt: finalizedAt }).where(eq(meetingResolutions.ballotId, ballotId));
}

interface BallotRun {
  ballotId: string;
  /** Who votes what: member key -> vote. Proxy votes are given as `{ holder, for }`. */
  votes: (clubMemberId: string, index: number) => Vote;
  voters: string[];
  proxyVotes?: Array<{ holder: string; grantor: string; vote: Vote }>;
}

/** Opens, votes on, closes, counts and finalizes a yes/no ballot through the real functions. */
async function runYesNo(ctx: DemoCtx, run: BallotRun): Promise<void> {
  const actor = accountOf(ctx, "vorsitz").userId;
  await openBallot({ clubId: ctx.clubId, ballotId: run.ballotId, actorUserId: actor });
  const opts = await optionsOf(db, run.ballotId);
  const byKind = (k: Vote) => opts.find((o) => o.kind === k)!.id;
  let i = 0;
  for (const voter of run.voters) {
    await castVote({ clubId: ctx.clubId, ballotId: run.ballotId, callerClubMemberId: voter, optionIds: [byKind(run.votes(voter, i++))] });
  }
  for (const p of run.proxyVotes ?? []) {
    await castVote({ clubId: ctx.clubId, ballotId: run.ballotId, callerClubMemberId: p.holder, forClubMemberId: p.grantor, optionIds: [byKind(p.vote)] });
  }
  await closeBallot(ctx.clubId, run.ballotId, actor);
  await countBallot(ctx.clubId, run.ballotId, actor);
  await finalizeBallot(ctx.clubId, run.ballotId, actor);
}

const tallyLine = (b: { result: Record<string, unknown> | null; title: string }): string => {
  const r = (b.result ?? {}) as { yes?: number; no?: number; abstain?: number; outcome?: string };
  return `${b.title}: ${r.yes ?? 0} Ja, ${r.no ?? 0} Nein, ${r.abstain ?? 0} Enthaltungen - ${String(r.outcome ?? "").replace(/_/g, " ")}.`;
};

/** The assembly of last year: held, minutes confirmed by chair and secretary, submitted (the approval comes from the next assembly). */
async function seedPreviousAssembly(ctx: DemoCtx, date: string): Promise<{ meeting: MeetingRow; minutesText: string }> {
  const vorsitz = accountOf(ctx, "vorsitz");
  const meeting = await createMeeting(ctx, "mv_prev", { title: "Ordentliche Mitgliederversammlung (Vorjahr)", date, time: "19:00" });
  await addAgenda(meeting.id, [
    { title: "Begrüßung und Feststellung der Beschlussfähigkeit" },
    { title: "Berichte des Vorstands" },
    { title: "Kassenbericht und Bericht der Kassenprüfer" },
    { title: "Entlastung des Vorstands", voteKind: "resolution", topic: "entlastung" },
    { title: "Verschiedenes" },
  ]);
  await freezeVotingRoll(ctx.clubId, meeting.id, vorsitz.userId);
  const frozen = await meetingRow(meeting.id);
  const present = ["vorsitz", "stellv", "kasse", "schrift", "beisitz", "trainer", "abtleit", "abtleit2", "mitglied", "dieter", "walter", "renate", "klaus", "stefan", "peter", "anja", "birgit"].map((key) => ({ key }));
  await checkIn(ctx, frozen, present);
  await db.insert(meetingResolutions).values({ meetingId: meeting.id, description: "Entlastung des Vorstands für das abgelaufene Geschäftsjahr", votesFor: 12, votesAgainst: 0, votesAbstain: 5, result: "angenommen", source: "manual" });
  await db.update(meetings).set({ status: "protokolliert", updatedAt: new Date() }).where(eq(meetings.id, meeting.id));
  const text = [
    "# Protokoll der ordentlichen Mitgliederversammlung (Vorjahr)",
    "",
    "Ort: Vereinsheim, Beginn 19:00 Uhr. Versammlungsleitung: Heike Brandt, Protokoll: Jan Köhler.",
    "",
    "## TOP 1 Begrüßung und Beschlussfähigkeit",
    "Die Versammlung wurde fristgerecht einberufen. Es sind 17 Mitglieder anwesend, die Versammlung ist beschlussfähig.",
    "",
    "## TOP 2 und 3 Berichte",
    "Der Vorstand und der Kassenwart berichteten. Die Kassenprüfer bestätigten die ordnungsgemäße Kassenführung.",
    "",
    "## TOP 4 Entlastung des Vorstands",
    "Die Entlastung wurde per Handzeichen beschlossen: 12 Ja, 0 Nein, 5 Enthaltungen (der Vorstand).",
    "",
    "## TOP 5 Verschiedenes",
    "Keine Wortmeldungen. Ende der Versammlung 21:10 Uhr.",
  ].join("\n");
  await saveMinutesDraft({ clubId: ctx.clubId, meetingId: meeting.id, content: text, userId: accountOf(ctx, "schrift").userId });
  await confirmMinutes({ clubId: ctx.clubId, meetingId: meeting.id, role: "leitung", userId: vorsitz.userId, roleTypes: ["vorsitz"] });
  await confirmMinutes({ clubId: ctx.clubId, meetingId: meeting.id, role: "schriftfuehrung", userId: accountOf(ctx, "schrift").userId, roleTypes: ["schriftfuehrer"] });
  await submitMinutes({ clubId: ctx.clubId, meetingId: meeting.id, userId: accountOf(ctx, "schrift").userId });
  const created = new Date(berlinTime(date, "19:00").getTime() - 60 * 86_400_000);
  await db.update(meetings).set({ createdAt: created }).where(eq(meetings.id, meeting.id));
  return { meeting: await meetingRow(meeting.id), minutesText: text };
}

/**
 * The recent assembly (hybrid): formal invitation 30 days ahead, proxies (one recorded by the board with proof), frozen voting
 * roll, check-in (clerk, self-online, proxy holder), quorum, four digital ballots (open yes/no, secret, rejected motion), an
 * election with an accepted candidate, a hand-counted resolution and minutes submitted for approval.
 */
async function seedRecentAssembly(ctx: DemoCtx, date: string, previous: MeetingRow): Promise<void> {
  const vorsitz = accountOf(ctx, "vorsitz");
  const schrift = accountOf(ctx, "schrift");
  const meeting = await createMeeting(ctx, "mv_recent", { title: "Jahreshauptversammlung", date, time: "19:00", participationMode: "hybrid", onlineUrl: "https://meet.example.org/svw-jahreshauptversammlung" });
  const [tProtokoll, , , tEntlastung, tWahl, tAntrag] = await addAgenda(meeting.id, [
    { title: "Begrüßung und Feststellung der Beschlussfähigkeit" },
    { title: "Genehmigung des Protokolls der letzten Mitgliederversammlung", voteKind: "resolution", topic: "allgemein" },
    { title: "Berichte des Vorstands und Kassenbericht" },
    { title: "Entlastung des Vorstands", voteKind: "resolution", topic: "entlastung" },
    { title: "Wahl einer Beisitzerin / eines Beisitzers", voteKind: "election", topic: "wahl" },
    { title: "Antrag: Anhebung des Jugendbeitrags", description: "Der Jugendbeitrag soll von 60 auf 72 Euro steigen.", voteKind: "resolution", topic: "allgemein" },
    { title: "Verschiedenes" },
  ]);
  const sentAt = new Date(berlinTime(date, "19:00").getTime() - 30 * 86_400_000);
  const invitation = await invite(ctx, await meetingRow(meeting.id), "Wir laden herzlich zur Jahreshauptversammlung ein. Die Teilnahme ist vor Ort und online möglich.", sentAt);

  // Proxies: one given by the member, one recorded by the board with a documented proof.
  const live = await meetingRow(meeting.id);
  await db.transaction(async (tx) => {
    await grantProxy(tx, { clubId: ctx.clubId, meeting: live, grantorClubMemberId: clubMemberOf(ctx, "peter"), holderClubMemberId: clubMemberOf(ctx, "stefan"), grantedBy: vorsitz.userId, byBoard: false });
    await grantProxy(tx, { clubId: ctx.clubId, meeting: live, grantorClubMemberId: clubMemberOf(ctx, "klaus"), holderClubMemberId: clubMemberOf(ctx, "stefan"), grantedBy: schrift.userId, byBoard: true, proofSource: "Vollmacht per Brief, abgeheftet im Ordner Mitgliederversammlung" });
  });
  await freezeVotingRoll(ctx.clubId, meeting.id, schrift.userId);
  const frozen = await meetingRow(meeting.id);

  const presentKeys: Array<{ key: string; method?: "schriftfuehrer" | "self_online" | "vollmacht" }> = [
    ...["vorsitz", "stellv", "kasse", "schrift", "beisitz", "trainer", "abtleit", "abtleit2", "mitglied", "dieter", "walter", "julia", "murat", "oliver", "nadine"].map((key) => ({ key })),
    { key: "trainer2", method: "self_online" },
    { key: "anja", method: "self_online" },
    { key: "stefan", method: "vollmacht" },
    // present without a voting right: youth category, sponsor, under-age sibling-sized guest
    { key: "jugend" },
    { key: "birgit" },
    { key: "tim" },
  ];
  const voters = await checkIn(ctx, frozen, presentKeys);
  const proxyVotes = (v: Vote) => [
    { holder: clubMemberOf(ctx, "stefan"), grantor: clubMemberOf(ctx, "peter"), vote: v },
    { holder: clubMemberOf(ctx, "stefan"), grantor: clubMemberOf(ctx, "klaus"), vote: v },
  ];
  const boardIds = new Set(["vorsitz", "stellv", "kasse", "schrift", "beisitz"].map((k) => clubMemberOf(ctx, k)));
  const target = (minutesAfter: number) => new Date(berlinTime(date, "19:00").getTime() + minutesAfter * 60_000);

  // 1. Protocol of last year: open vote, accepted. (This resolution approves the previous minutes below.)
  const b1 = await createBallot({ clubId: ctx.clubId, actorUserId: schrift.userId, mode: "in_session", meetingId: meeting.id, agendaItemId: tProtokoll!, title: "Genehmigung des Protokolls der letzten Mitgliederversammlung", secret: false, maxChoices: 1 });
  await runYesNo(ctx, { ballotId: b1.id, voters, votes: (id, i) => (i % 9 === 8 ? "abstain" : "yes"), proxyVotes: proxyVotes("yes") });
  await moveBallotTo(b1.id, target(25));

  // 2. Discharge of the board: secret, the board abstains.
  const b2 = await createBallot({ clubId: ctx.clubId, actorUserId: schrift.userId, mode: "in_session", meetingId: meeting.id, agendaItemId: tEntlastung!, title: "Entlastung des Vorstands", secret: true, maxChoices: 1 });
  await runYesNo(ctx, { ballotId: b2.id, voters, votes: (id, i) => (boardIds.has(id) ? "abstain" : i === 11 ? "no" : "yes"), proxyVotes: proxyVotes("yes") });
  await moveBallotTo(b2.id, target(55));

  // 3. Election of a Beisitz: two candidates, secret ballot, the winner accepts.
  const election = await createElection({ clubId: ctx.clubId, actorUserId: vorsitz.userId, meetingId: meeting.id, roleType: "beisitzer", seats: 1, termMonths: 24, electionLeadClubMemberId: clubMemberOf(ctx, "dieter") });
  ctx.ev.election_recent = election.id;
  await proposeCandidate({ clubId: ctx.clubId, electionId: election.id, clubMemberId: clubMemberOf(ctx, "beisitz"), proposedBy: clubMemberOf(ctx, "vorsitz"), actorUserId: vorsitz.userId, willing: true });
  await proposeCandidate({ clubId: ctx.clubId, electionId: election.id, clubMemberId: clubMemberOf(ctx, "julia"), proposedBy: clubMemberOf(ctx, "trainer"), actorUserId: vorsitz.userId, willing: true });
  const round = await createRound({ clubId: ctx.clubId, electionId: election.id, actorUserId: vorsitz.userId, secret: true, agendaItemId: tWahl! });
  await openBallot({ clubId: ctx.clubId, ballotId: round.ballotId, actorUserId: vorsitz.userId });
  const roundOptions = await optionsOf(db, round.ballotId);
  const winnerOption = roundOptions.find((o) => o.candidateClubMemberId === clubMemberOf(ctx, "beisitz"))!.id;
  const otherOption = roundOptions.find((o) => o.candidateClubMemberId === clubMemberOf(ctx, "julia"))!.id;
  const abstainOption = roundOptions.find((o) => o.kind === "abstain")!.id;
  let n = 0;
  for (const voter of voters) {
    const choice = n % 7 === 6 ? abstainOption : n % 3 === 2 ? otherOption : winnerOption;
    await castVote({ clubId: ctx.clubId, ballotId: round.ballotId, callerClubMemberId: voter, optionIds: [choice] });
    n += 1;
  }
  for (const p of proxyVotes("yes")) await castVote({ clubId: ctx.clubId, ballotId: round.ballotId, callerClubMemberId: p.holder, forClubMemberId: p.grantor, optionIds: [winnerOption] });
  await closeBallot(ctx.clubId, round.ballotId, vorsitz.userId);
  await countBallot(ctx.clubId, round.ballotId, vorsitz.userId);
  await finalizeBallot(ctx.clubId, round.ballotId, vorsitz.userId);
  await moveBallotTo(round.ballotId, target(85));
  const decided = await decideElection({ clubId: ctx.clubId, electionId: election.id, actorUserId: vorsitz.userId });
  const winner = await db.query.electionCandidates.findFirst({ where: (c, { and, eq }) => and(eq(c.electionId, election.id), eq(c.clubMemberId, clubMemberOf(ctx, "beisitz"))) });
  if (!winner || !decided.electedCandidateIds.includes(winner.id)) throw new Error("The demo election did not elect the expected candidate");
  await answerElection({ clubId: ctx.clubId, electionId: election.id, candidateId: winner.id, accept: true, actorUserId: vorsitz.userId, onBehalf: false });
  await db.update(elections).set({ decidedAt: target(90) }).where(eq(elections.id, election.id));

  // 4. A motion that fails: open vote, rejected.
  const b4 = await createBallot({ clubId: ctx.clubId, actorUserId: schrift.userId, mode: "in_session", meetingId: meeting.id, agendaItemId: tAntrag!, title: "Anhebung des Jugendbeitrags von 60 auf 72 Euro", secret: false, maxChoices: 1 });
  await runYesNo(ctx, { ballotId: b4.id, voters, votes: (id, i) => (i % 5 === 0 ? "yes" : i % 11 === 10 ? "abstain" : "no"), proxyVotes: proxyVotes("no") });
  await moveBallotTo(b4.id, target(115));

  // 5. A hand-counted resolution without digital ballot.
  await db.insert(meetingResolutions).values({ meetingId: meeting.id, description: "Haushaltsplan des kommenden Geschäftsjahres (Handzeichen)", votesFor: 19, votesAgainst: 1, votesAbstain: 2, result: "angenommen", source: "manual", createdAt: target(130) });

  await db.update(meetings).set({ status: "protokolliert", updatedAt: new Date() }).where(eq(meetings.id, meeting.id));

  // Minutes of this assembly: written from the real results, confirmed by chair and secretary, submitted for the next assembly.
  const done = await db.select().from(ballots).where(and(eq(ballots.meetingId, meeting.id), inArray(ballots.status, ["finalized"])));
  const lines = done.filter((b) => b.kind === "resolution").map((b) => `- ${tallyLine({ result: b.result, title: b.title })}`);
  const content = [
    "# Protokoll der Jahreshauptversammlung",
    "",
    "Ort: Vereinsheim (hybrid, Zugang online möglich). Versammlungsleitung: Heike Brandt, Protokoll: Jan Köhler.",
    "",
    `Die Einladung ging in Textform am ${sentAt.toISOString().slice(0, 10)} an alle Mitglieder (Prüfsumme ${invitation.contentHash.slice(0, 12)}).`,
    "",
    "## Beschlussfähigkeit",
    "Die Versammlung war beschlussfähig. Zwei Vollmachten wurden ausgeübt, eine davon vom Vorstand mit Nachweis erfasst.",
    "",
    "## Digitale Abstimmungen",
    ...lines,
    "",
    "## Wahl",
    "Sabine Neumann wurde in geheimer Wahl zur Beisitzerin gewählt und nahm die Wahl an (Amtszeit 24 Monate).",
    "",
    "## Beschluss per Handzeichen",
    "- Haushaltsplan: 19 Ja, 1 Nein, 2 Enthaltungen - angenommen.",
  ].join("\n");
  await saveMinutesDraft({ clubId: ctx.clubId, meetingId: meeting.id, content, userId: schrift.userId });
  await confirmMinutes({ clubId: ctx.clubId, meetingId: meeting.id, role: "leitung", userId: vorsitz.userId, roleTypes: ["vorsitz"] });
  await confirmMinutes({ clubId: ctx.clubId, meetingId: meeting.id, role: "schriftfuehrung", userId: schrift.userId, roleTypes: ["schriftfuehrer"] });
  await submitMinutes({ clubId: ctx.clubId, meetingId: meeting.id, userId: schrift.userId });
  await db.update(meetings).set({ createdAt: new Date(sentAt.getTime() - 15 * 86_400_000) }).where(eq(meetings.id, meeting.id));
  // The election term started when the winner accepted, i.e. at the assembly.
  await db.update(clubRoleTerms).set({ startsOn: date }).where(and(eq(clubRoleTerms.electionId, election.id)));

  // The vote on the previous minutes approves them now.
  const approving = await db.query.meetingResolutions.findFirst({ where: eq(meetingResolutions.ballotId, b1.id) });
  if (!approving) throw new Error("The resolution approving the previous minutes is missing");
  await approveMinutes({ clubId: ctx.clubId, meetingId: previous.id, resolutionId: approving.id, userId: schrift.userId });
  await archiveMinutes({ clubId: ctx.clubId, meetingId: previous.id, userId: schrift.userId });
  await addMinutesAmendment({ clubId: ctx.clubId, meetingId: previous.id, note: "Berichtigung zu TOP 1: Es waren 17 (nicht 16) Mitglieder anwesend.", userId: schrift.userId });
}

/** The upcoming extraordinary assembly: invitation and supplement with delivery proof, frozen roll, proxies, RSVPs, planned election. */
async function seedUpcomingAssembly(ctx: DemoCtx): Promise<void> {
  const vorsitz = accountOf(ctx, "vorsitz");
  const schrift = accountOf(ctx, "schrift");
  const date = shiftDays(ctx.today, 35);
  const meeting = await createMeeting(ctx, "mv_next", { title: "Außerordentliche Mitgliederversammlung", date, time: "19:00", participationMode: "hybrid", onlineUrl: "https://meet.example.org/svw-ausserordentliche-mv" });
  await addAgenda(meeting.id, [
    { title: "Begrüßung und Feststellung der Beschlussfähigkeit" },
    { title: "Genehmigung des Protokolls der Jahreshauptversammlung", voteKind: "resolution", topic: "allgemein" },
    { title: "Änderung der Beitragsordnung (Satzungsänderung § 4)", description: "Neue Beitragsstufe für Studierende und Familien.", voteKind: "resolution", topic: "satzungsaenderung" },
    { title: "Verschiedenes" },
  ]);
  await invite(ctx, await meetingRow(meeting.id), "Wir laden zur außerordentlichen Mitgliederversammlung ein. Die Tagesordnung finden Sie in der App.");

  // Supplement ("Nachtrag"): the Kassenwart election is added, Verschiedenes moves to the end.
  const [electionItem] = await addAgenda(meeting.id, [{ title: "Wahl der Kassenwartin / des Kassenwarts", description: "Die Amtszeit der Kassenwartin läuft aus.", voteKind: "election", topic: "wahl" }], 5);
  await db.update(meetingAgendaItems).set({ position: 6 }).where(and(eq(meetingAgendaItems.meetingId, meeting.id), eq(meetingAgendaItems.title, "Verschiedenes")));
  await db.update(meetingAgendaItems).set({ position: 5 }).where(eq(meetingAgendaItems.id, electionItem!));
  await invite(ctx, await meetingRow(meeting.id), "Nachtrag zur Tagesordnung: Wahl der Kassenwartin / des Kassenwarts.");

  const live = await meetingRow(meeting.id);
  await db.transaction(async (tx) => {
    await grantProxy(tx, { clubId: ctx.clubId, meeting: live, grantorClubMemberId: clubMemberOf(ctx, "murat"), holderClubMemberId: clubMemberOf(ctx, "julia"), grantedBy: vorsitz.userId, byBoard: false });
    await grantProxy(tx, { clubId: ctx.clubId, meeting: live, grantorClubMemberId: clubMemberOf(ctx, "dieter"), holderClubMemberId: clubMemberOf(ctx, "walter"), grantedBy: schrift.userId, byBoard: true, proofSource: "Vollmacht per Brief, im Vereinsheim abgegeben" });
  });
  await freezeVotingRoll(ctx.clubId, meeting.id, schrift.userId);

  const answers: Array<[string, string]> = [
    ["vorsitz", "zugesagt"], ["stellv", "zugesagt"], ["schrift", "zugesagt"], ["trainer", "zugesagt"], ["abtleit", "zugesagt"], ["mitglied", "zugesagt"],
    ["stefan", "zugesagt"], ["julia", "zugesagt"], ["abtleit2", "abgesagt"], ["oliver", "abgesagt"],
  ];
  for (const [key, response] of answers) {
    await db.update(meetingInvitees).set({ response }).where(and(eq(meetingInvitees.meetingId, meeting.id), eq(meetingInvitees.clubMemberId, clubMemberOf(ctx, key))));
  }

  // The planned election with candidates in different states.
  const election = await createElection({ clubId: ctx.clubId, actorUserId: vorsitz.userId, meetingId: meeting.id, roleType: "kassenwart", seats: 1, termMonths: 36, electionLeadClubMemberId: clubMemberOf(ctx, "dieter") });
  await proposeCandidate({ clubId: ctx.clubId, electionId: election.id, clubMemberId: clubMemberOf(ctx, "kasse"), proposedBy: clubMemberOf(ctx, "vorsitz"), actorUserId: vorsitz.userId });
  await proposeCandidate({ clubId: ctx.clubId, electionId: election.id, clubMemberId: clubMemberOf(ctx, "stefan"), proposedBy: clubMemberOf(ctx, "trainer"), actorUserId: vorsitz.userId, willing: true });
  const anja = await proposeCandidate({ clubId: ctx.clubId, electionId: election.id, clubMemberId: clubMemberOf(ctx, "anja"), proposedBy: clubMemberOf(ctx, "abtleit2"), actorUserId: vorsitz.userId });
  await setCandidateStatus({ clubId: ctx.clubId, electionId: election.id, candidateId: anja.id, status: "declined", actorUserId: schrift.userId, manager: true });
}

/** Circular resolutions: a finished one of the board, an open one for all voting members (the demo logins can still vote). */
async function seedCircularResolutions(ctx: DemoCtx): Promise<void> {
  const vorsitz = accountOf(ctx, "vorsitz");
  const finished = await createBallot({
    clubId: ctx.clubId,
    actorUserId: vorsitz.userId,
    mode: "circular",
    title: "Ersatzteil für die Tennis-Ballmaschine bis 400 Euro",
    description: "Der Motor der Ballmaschine ist defekt. Der Vorstand beschließt die Beschaffung des Ersatzteils.",
    secret: false,
    audience: "board",
    topic: "allgemein",
    maxChoices: 1,
    closesAt: new Date(Date.now() + 3_600_000),
  });
  await openBallot({ clubId: ctx.clubId, ballotId: finished.id, actorUserId: vorsitz.userId, closesAt: new Date(Date.now() + 3_600_000) });
  const opts = await optionsOf(db, finished.id);
  const id = (k: Vote) => opts.find((o) => o.kind === k)!.id;
  const board: Array<[string, Vote]> = [["vorsitz", "yes"], ["stellv", "yes"], ["kasse", "yes"], ["schrift", "yes"], ["beisitz", "abstain"]];
  for (const [key, vote] of board) await castVote({ clubId: ctx.clubId, ballotId: finished.id, callerClubMemberId: clubMemberOf(ctx, key), optionIds: [id(vote)] });
  await closeBallot(ctx.clubId, finished.id, vorsitz.userId);
  await countBallot(ctx.clubId, finished.id, vorsitz.userId);
  await finalizeBallot(ctx.clubId, finished.id, vorsitz.userId);

  const open = await createBallot({
    clubId: ctx.clubId,
    actorUserId: vorsitz.userId,
    mode: "circular",
    title: "Termin des Sommerfests: Samstag oder Sonntag?",
    description: "Wegen der Platzbelegung steht das Sommerfest an einem Samstag oder Sonntag zur Wahl. Abstimmung noch fünf Tage.",
    secret: false,
    audience: "all_voting_members",
    topic: "allgemein",
    maxChoices: 1,
    closesAt: new Date(Date.now() + 5 * 86_400_000),
  });
  await openBallot({ clubId: ctx.clubId, ballotId: open.id, actorUserId: vorsitz.userId, closesAt: new Date(Date.now() + 5 * 86_400_000) });
  ctx.ev.circular_open = open.id;
  const openOpts = await optionsOf(db, open.id);
  const oid = (k: Vote) => openOpts.find((o) => o.kind === k)!.id;
  // Several have voted already; the demo logins "mitglied" and "trainer" have not, so they can try it.
  const voted: Array<[string, Vote]> = [["vorsitz", "yes"], ["stellv", "yes"], ["schrift", "no"], ["abtleit", "yes"], ["stefan", "yes"], ["julia", "no"], ["dieter", "yes"]];
  for (const [key, vote] of voted) await castVote({ clubId: ctx.clubId, ballotId: open.id, callerClubMemberId: clubMemberOf(ctx, key), optionIds: [oid(vote)] });
}

export async function seedAssembly(ctx: DemoCtx): Promise<void> {
  const prevDate = monthsAgo(ctx.today, 13);
  const { meeting: previous } = await seedPreviousAssembly(ctx, prevDate);
  await seedRecentAssembly(ctx, shiftDays(ctx.today, -9), previous);
  await seedUpcomingAssembly(ctx);
  await seedCircularResolutions(ctx);
  ctx.log("Versammlungen: Vorjahr (Protokoll genehmigt, archiviert, Berichtigungsvermerk), Jahreshauptversammlung (4 Abstimmungen, Wahl, Protokoll zur Genehmigung), kommende MV (Einladung + Nachtrag, Vollmachten, Wahl geplant), 2 Umlaufbeschlüsse");
}
