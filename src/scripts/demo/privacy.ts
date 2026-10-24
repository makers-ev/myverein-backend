import { eq, sql } from "drizzle-orm";

import { db } from "../../db/client.js";
import { clubMembers } from "../../db/schema/club-members.js";
import { consentPurposes, consentTexts, dataSubjectRequests, dpaVersions, retentionRuns } from "../../db/schema/privacy.js";
import { writeAudit } from "../../lib/audit.js";
import { recordConsent, sha256Hex } from "../../lib/consent.js";
import { dpaChecksum } from "../../lib/dpa.js";
import { generateNoticeDraft, publishNotice } from "../../lib/privacy-notice.js";
import { dueAtOf } from "../../lib/privacy/requests.js";
import { setClubOverride } from "../../lib/retention/policy.js";
import { ruleOf } from "../../lib/retention/rules.js";
import { accountOf, clubMemberOf, shiftDays, type DemoCtx } from "./context.js";

const TEXTS: Record<string, string[]> = {
  foto_video: [
    "Ich willige ein, dass der Verein Fotos und Videos von mir bei Training und Veranstaltungen erstellt und im Verein (Aushang, Mitgliederbereich) verwendet. Die Einwilligung ist freiwillig und kann jederzeit mit Wirkung für die Zukunft widerrufen werden.",
    "Ich willige ein, dass der Verein Fotos und Videos von mir bei Training und Veranstaltungen erstellt und im Verein (Aushang, Mitgliederbereich, Vereins-App) verwendet. Neu: auch Gruppenfotos aus Turnieren. Die Einwilligung ist freiwillig und kann jederzeit mit Wirkung für die Zukunft widerrufen werden.",
  ],
  veroeffentlichung: ["Ich willige ein, dass Fotos, mein Name und Ergebnisse auf der Website, in sozialen Medien und in der Presse veröffentlicht werden. Freiwillig, jederzeit widerrufbar."],
  messenger_verteiler: ["Ich willige ein, dass meine Telefonnummer in die Messenger-Gruppen meiner Mannschaft aufgenommen wird. Freiwillig, jederzeit widerrufbar."],
  profilfoto_ausweis: ["Ich willige ein, dass mein Profilfoto im Verein angezeigt und auf dem Mitgliedsausweis verwendet wird. Freiwillig, jederzeit widerrufbar."],
  newsletter: ["Ich möchte den Vereinsnewsletter mit Neuigkeiten und Terminen per E-Mail erhalten. Freiwillig, jederzeit widerrufbar."],
};

async function publishText(ctx: DemoCtx, purposeId: string, version: number, body: string, daysAgo: number, publish = true): Promise<string> {
  const [row] = await db
    .insert(consentTexts)
    .values({
      purposeId,
      version,
      body,
      sha256: sha256Hex(body),
      publishedAt: publish ? new Date(ctx.now.getTime() - daysAgo * 86_400_000) : null,
      publishedBy: publish ? accountOf(ctx, "vorsitz").userId : null,
      createdAt: new Date(ctx.now.getTime() - daysAgo * 86_400_000),
    })
    .returning({ id: consentTexts.id });
  return row!.id;
}

/**
 * Consents (Wave 10): purposes with published texts (one with a changed text version), a purpose still without text, grants,
 * revocations, guardian consents for minors and paper proofs of the board. Events go through `recordConsent`, so the append-only
 * log, the text hash reference and the audit entries are real.
 */
export async function seedConsents(ctx: DemoCtx): Promise<void> {
  const purposes = await db.select().from(consentPurposes).where(eq(consentPurposes.clubId, ctx.clubId));
  const byKey = new Map(purposes.map((p) => [p.key, p]));
  const [newsletter] = await db
    .insert(consentPurposes)
    .values({ clubId: ctx.clubId, key: "newsletter", name: "Vereinsnewsletter", description: "Neuigkeiten und Termine per E-Mail.", system: false, requested: false, active: false, sortOrder: 60 })
    .returning();
  byKey.set("newsletter", newsletter!);

  const activate = async (key: string, requested: boolean) => {
    await db.update(consentPurposes).set({ active: true, requested, updatedAt: new Date() }).where(eq(consentPurposes.id, byKey.get(key)!.id));
  };
  // foto_video: text v1 a year ago, text v2 two months ago (older grants refer to v1).
  const foto = byKey.get("foto_video")!;
  await publishText(ctx, foto.id, 1, TEXTS.foto_video![0]!, 400);
  await activate("foto_video", true);

  // Members without an account are recorded by the board.
  const userFor = (key: string) => accountOf(ctx, key in ctx.people ? key : "vorsitz").userId;
  const at = (days: number) => new Date(ctx.now.getTime() - days * 86_400_000);
  type Who = string;
  const grant = (purposeKey: string, who: Who, daysAgo: number, givenBy: "self" | "guardian" | "board_paper" = "self", recordedBy = who) =>
    db.transaction((tx) =>
      recordConsent(tx, {
        clubId: ctx.clubId,
        clubMemberId: clubMemberOf(ctx, who),
        purposeId: byKey.get(purposeKey)!.id,
        action: "granted",
        givenBy,
        recordedByUserId: userFor(recordedBy),
        via: givenBy === "guardian" ? "guardian" : givenBy === "board_paper" ? "board" : "member",
        at: at(daysAgo),
        ...(givenBy === "board_paper" ? { proofDate: shiftDays(ctx.today, -daysAgo), proofSource: "Unterschriebenes Formular im Vereinsordner (Mitgliederversammlung)" } : {}),
      }),
    );
  const revoke = (purposeKey: string, who: Who, daysAgo: number, recordedBy = who) =>
    db.transaction((tx) =>
      recordConsent(tx, {
        clubId: ctx.clubId,
        clubMemberId: clubMemberOf(ctx, who),
        purposeId: byKey.get(purposeKey)!.id,
        action: "revoked",
        givenBy: "self",
        recordedByUserId: userFor(recordedBy),
        via: "member",
        at: at(daysAgo),
      }),
    );

  for (const who of ["vorsitz", "stellv", "schrift", "trainer", "abtleit", "stefan", "julia", "murat", "anja"]) await grant("foto_video", who, 330);
  await grant("foto_video", "dieter", 300, "board_paper");
  await grant("foto_video", "walter", 300, "board_paper");
  await grant("foto_video", "noah", 250, "guardian", "eltern");
  await grant("foto_video", "mia", 250, "guardian", "eltern");
  await grant("foto_video", "tim", 900, "guardian", "eltern");
  await grant("foto_video", "finn", 200, "guardian", "mitglied");
  await grant("foto_video", "jugend", 120);
  await revoke("foto_video", "murat", 90);
  await revoke("foto_video", "julia", 40);
  // Now the club updates the text: later grants refer to version 2.
  await publishText(ctx, foto.id, 2, TEXTS.foto_video![1]!, 60);
  for (const who of ["mitglied", "trainer2", "peter", "katharina"]) await grant("foto_video", who, 30);

  await publishText(ctx, byKey.get("veroeffentlichung")!.id, 1, TEXTS.veroeffentlichung![0]!, 200);
  await activate("veroeffentlichung", true);
  await grant("veroeffentlichung", "vorsitz", 150);
  await grant("veroeffentlichung", "stellv", 150);
  await grant("veroeffentlichung", "schrift", 150);
  await revoke("veroeffentlichung", "schrift", 20);

  await publishText(ctx, byKey.get("messenger_verteiler")!.id, 1, TEXTS.messenger_verteiler![0]!, 200);
  await activate("messenger_verteiler", true);
  for (const who of ["trainer", "abtleit", "stefan", "julia", "murat", "peter"]) await grant("messenger_verteiler", who, 100);
  await revoke("messenger_verteiler", "anja", 15);
  await grant("messenger_verteiler", "anja", 200);
  await grant("messenger_verteiler", "noah", 90, "guardian", "eltern");

  await publishText(ctx, byKey.get("profilfoto_ausweis")!.id, 1, TEXTS.profilfoto_ausweis![0]!, 150);
  await activate("profilfoto_ausweis", false);
  for (const who of ["mitglied", "trainer"]) await grant("profilfoto_ausweis", who, 80);

  // Weitergabe an den Verband: only a draft text, the purpose stays inactive (nobody can be asked yet).
  await publishText(ctx, byKey.get("verbandsweitergabe")!.id, 1, "Entwurf: Ich willige ein, dass meine Stammdaten für Lizenzen und Meldungen an den Landesverband übermittelt werden.", 5, false);

  await publishText(ctx, byKey.get("newsletter")!.id, 1, TEXTS.newsletter![0]!, 120);
  await activate("newsletter", false);
  for (const who of ["vorsitz", "mitglied", "trainer", "abtleit", "stefan", "julia", "peter", "anja", "katharina", "dieter"]) await grant("newsletter", who, 70);
  await revoke("newsletter", "peter", 12);
  await revoke("newsletter", "dieter", 30);
  ctx.log("Einwilligungen: 6 Zwecke (ein Zweck mit geänderter Textversion, einer ohne veröffentlichten Text), Erteilungen, Widerrufe, Erziehungsberechtigte, Papiernachweise");
}

/** Privacy notice (two versions), notice handover to members without account, data subject requests, retention override and a DPA draft. */
export async function seedPrivacy(ctx: DemoCtx): Promise<void> {
  const vorsitz = accountOf(ctx, "vorsitz");
  const draft = await generateNoticeDraft(ctx.clubId);
  const v1 = await publishNotice(ctx.clubId, draft, vorsitz.userId);
  const v2 = await publishNotice(ctx.clubId, `${draft}\n\n7. Änderung\nSeit diesem Stand informieren wir zusätzlich über die Speicherdauer von Abwesenheitsmeldungen (60 Tage nach Ende).`, vorsitz.userId);

  // Art. 14 GDPR: the notice was handed to members without an account (printed / by mail).
  for (const [who, daysAgo] of [["dieter", 200], ["walter", 200], ["lina", 18], ["noah", 90]] as const) {
    await db
      .update(clubMembers)
      .set({ privacyNoticeSentAt: new Date(ctx.now.getTime() - daysAgo * 86_400_000), privacyNoticeVersionId: daysAgo > 100 ? v1.notice.id : v2.notice.id })
      .where(eq(clubMembers.id, clubMemberOf(ctx, who)));
    await writeAudit(db, { eventType: "club_member.privacy_notice_sent", subjectId: clubMemberOf(ctx, who), actorUserId: vorsitz.userId, payload: { clubId: ctx.clubId, version: daysAgo > 100 ? v1.notice.version : v2.notice.version } });
  }

  const request = async (who: string, kind: "access" | "erasure" | "rectification", status: string, receivedDaysAgo: number, extra: { result?: string; completedDaysAgo?: number; requestedBy?: string } = {}) => {
    const received = new Date(ctx.now.getTime() - receivedDaysAgo * 86_400_000);
    await db.insert(dataSubjectRequests).values({
      clubId: ctx.clubId,
      clubMemberId: clubMemberOf(ctx, who),
      kind,
      status,
      receivedAt: received,
      dueAt: dueAtOf(received),
      requestedByUserId: extra.requestedBy ? accountOf(ctx, extra.requestedBy).userId : null,
      handledByUserId: status === "open" ? null : vorsitz.userId,
      completedAt: extra.completedDaysAgo === undefined ? null : new Date(ctx.now.getTime() - extra.completedDaysAgo * 86_400_000),
      result: extra.result ?? null,
      createdAt: received,
    });
  };
  await request("klaus", "access", "done", 20, { result: "Auskunft als Export erteilt", completedDaysAgo: 12 });
  await request("uwe", "erasure", "in_progress", 10);
  await request("anja", "rectification", "open", 3, { requestedBy: "mitglied" });
  await request("svenja", "access", "open", 45);
  await request("rainer", "erasure", "rejected", 30, { result: "Löschung abgelehnt: Aufbewahrungs- und Haltefrist (offene Forderung)", completedDaysAgo: 25 });

  const rule = ruleOf("absence_reports");
  if (rule) await setClubOverride(ctx.clubId, rule, 60, vorsitz.userId);
  await db.insert(retentionRuns).values([
    { clubId: ctx.clubId, category: "former_members", dryRun: true, notice: true, scanned: 4, affected: 1, startedAt: new Date(ctx.now.getTime() - 3 * 86_400_000), finishedAt: new Date(ctx.now.getTime() - 3 * 86_400_000 + 4000) },
    { clubId: ctx.clubId, category: "absence_reports", dryRun: false, notice: false, scanned: 6, affected: 2, startedAt: new Date(ctx.now.getTime() - 86_400_000), finishedAt: new Date(ctx.now.getTime() - 86_400_000 + 2500) },
  ]);

  // Platform-level DPA (AV-Vertrag): only a DRAFT is created, nothing becomes mandatory for any club. It is not removed by --reset.
  const title = "Auftragsverarbeitungsvertrag (Demo-Entwurf)";
  const existing = await db.query.dpaVersions.findFirst({ where: eq(dpaVersions.title, title) });
  if (!existing) {
    const [last] = await db.select({ n: sql<number>`coalesce(max(${dpaVersions.version}), 0)::int` }).from(dpaVersions);
    const content = {
      title,
      body: "Entwurf eines Auftragsverarbeitungsvertrags zwischen dem Verein (Verantwortlicher) und dem Betreiber der Plattform (Auftragsverarbeiter). Nur zur Demonstration, keine Rechtsberatung.",
      subprocessors: [{ name: "Beispiel Hosting GmbH", purpose: "Serverbetrieb", location: "Deutschland" }],
      tomAnnex: "Technische und organisatorische Maßnahmen: Zugriffskontrolle, Verschlüsselung bei der Übertragung, Protokollierung.",
    };
    await db.insert(dpaVersions).values({ version: (last?.n ?? 0) + 1, ...content, sha256: dpaChecksum(content) });
  }
  ctx.log("Datenschutz: Hinweis (2 Versionen), Art.-14-Übergaben, 5 Betroffenenanfragen (offen/in Arbeit/erledigt/überfällig/abgelehnt), Aufbewahrungs-Override, AV-Vertrag-Entwurf, Rechtsvorbehalt bei einem Mitglied");
}
