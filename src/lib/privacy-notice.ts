import { and, desc, eq, isNotNull, sql } from "drizzle-orm";

import { organization } from "../auth/auth-schema.js";
import { db } from "../db/client.js";
import { clubPrivacyNotices, type ClubPrivacyNoticeRow } from "../db/schema/club-privacy-notices.js";
import { clubRegistrations } from "../db/schema/club-registrations.js";
import { clubSettings } from "../db/schema/club-settings.js";
import { writeAudit } from "./audit.js";
import type { DbExecutor } from "./club-members.js";
import { sha256Hex } from "./consent.js";
import { APP_NAME } from "./emailTemplate.js";
import { ValidationError } from "./errors.js";
import { effectiveRules } from "./retention/policy.js";

/**
 * Privacy notice of a club (Wave 10 B11, Art. 13/14 GDPR). The notice is INFORMATION, not a consent: taking note of it is stamped
 * (`club_applications.privacy_notice_acknowledged_at` + version, `club_members.privacy_notice_sent_at` + version for people without an
 * account) but nothing -- no application, membership or feature -- ever depends on it, and it is never combined with a consent.
 * Versions are immutable once published (SHA-256 of the text); a new text is a new version.
 */

export const NOTICE_MIN = 100;
export const NOTICE_MAX = 50_000;

const days = (n: number): string => {
  if (n % 365 === 0 && n >= 365) return `${n / 365} ${n / 365 === 1 ? "Jahr" : "Jahren"}`;
  if (n % 30 === 0 && n >= 60) return `${n / 30} Monaten`;
  return `${n} Tagen`;
};

/** The template filled with the club's master data, settings and active retention periods (a starting point the board edits). */
export async function generateNoticeDraft(clubId: string, executor: DbExecutor = db): Promise<string> {
  const [club] = await executor.select({ name: organization.name }).from(organization).where(eq(organization.id, clubId));
  const [registration] = await executor
    .select()
    .from(clubRegistrations)
    .where(and(eq(clubRegistrations.clubId, clubId), eq(clubRegistrations.status, "approved")))
    .orderBy(desc(clubRegistrations.createdAt))
    .limit(1);
  const [settings] = await executor.select({ controller: clubSettings.privacyController, contact: clubSettings.privacyContact }).from(clubSettings).where(eq(clubSettings.clubId, clubId));

  const name = club?.name ?? "der Verein";
  const address = registration ? `${registration.street}, ${registration.postalCode} ${registration.city}` : "[Anschrift des Vereins ergänzen]";
  const register = registration?.registerNumber ? `, eingetragen beim ${registration.registerCourt ?? "Registergericht"} unter ${registration.registerNumber}` : "";
  const controller = settings?.controller?.trim() || `${name}${register}, ${address}`;
  const contact = settings?.contact?.trim() || "[Kontakt für Datenschutzfragen ergänzen, z. B. E-Mail-Adresse des Vorstands]";
  const retention = (await effectiveRules(clubId)).filter((r) => r.rule.scope === "club").map((r) => `- ${r.rule.label}: nach ${days(r.effectiveDays)}`);

  return [
    "MUSTER, KEINE RECHTSBERATUNG: Bitte vor der Veröffentlichung prüfen und anpassen.",
    "",
    "Datenschutzhinweis",
    "",
    "1. Verantwortlicher",
    controller,
    "",
    "2. Kontakt für Datenschutzfragen",
    contact,
    "",
    "3. Wofür wir deine Daten verarbeiten",
    "Wir verarbeiten deine Angaben (z. B. Name, Anschrift, Geburtsdatum, Kontaktdaten, Mitgliedskategorie, Teilnahme an Terminen und Treffen), um die Mitgliedschaft zu begründen und zu verwalten, Termine und Veranstaltungen zu organisieren und mit dir zu kommunizieren. Rechtsgrundlage ist die Mitgliedschaft bzw. der Antrag darauf (Art. 6 Abs. 1 lit. b DSGVO) und unser berechtigtes Interesse an einem geordneten Vereinsbetrieb (Art. 6 Abs. 1 lit. f DSGVO).",
    "",
    "4. Freiwillige Einwilligungen",
    "Für weitere Zwecke, etwa Fotos und Videos oder die Veröffentlichung von Namen, fragen wir dich gesondert. Diese Einwilligungen sind freiwillig, haben keinen Einfluss auf deine Mitgliedschaft und können jederzeit mit Wirkung für die Zukunft widerrufen werden.",
    "",
    "5. Kinder und Jugendliche",
    "Für Minderjährige entscheiden die Erziehungsberechtigten. Sie sehen nur die Daten ihres Kindes. Mit der Volljährigkeit entscheidet die Person selbst.",
    "",
    `6. Wer Zugriff hat und wo die Daten liegen`,
    `Zugriff haben die dafür zuständigen Vorstandsmitglieder, Abteilungs- und Übungsleitungen im jeweils nötigen Umfang. Die Daten werden mit der Vereinssoftware ${APP_NAME} verarbeitet; der Betreiber handelt als Auftragsverarbeiter nach Art. 28 DSGVO auf Grundlage eines Vertrags mit dem Verein. Eine Weitergabe an Dritte erfolgt nur, wenn du eingewilligt hast oder wir dazu verpflichtet sind.`,
    "",
    "7. Wie lange wir Daten speichern",
    ...retention,
    "Daten, die wir aus gesetzlichen Gründen aufbewahren müssen, löschen wir nach Ablauf dieser Pflichten.",
    "",
    "8. Deine Rechte",
    "Du hast das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch (Art. 15 bis 21 DSGVO). Auskunft und Datenexport findest du in der App und auf der Website unter „Mein Datenschutz“, sonst genügt eine Nachricht an die oben genannte Stelle. Du kannst dich außerdem bei der zuständigen Datenschutzaufsichtsbehörde beschweren.",
    "",
    "9. Woher wir deine Daten haben",
    "Wir erhalten deine Daten von dir selbst oder, bei Kindern, von den Erziehungsberechtigten bzw. vom Vorstand, der sie im Auftrag der Familie erfasst hat (Art. 14 DSGVO).",
  ].join("\n");
}

export async function latestPublishedNotice(clubId: string, executor: DbExecutor = db): Promise<ClubPrivacyNoticeRow | null> {
  const [row] = await executor
    .select()
    .from(clubPrivacyNotices)
    .where(and(eq(clubPrivacyNotices.clubId, clubId), isNotNull(clubPrivacyNotices.publishedAt)))
    .orderBy(desc(clubPrivacyNotices.version))
    .limit(1);
  return row ?? null;
}

/**
 * Publishes `body` as the next version (immutable). The same text as the current version is a no-op (`created: false`).
 * Serialised per club, so parallel publishes number correctly.
 */
export async function publishNotice(clubId: string, body: string, userId: string): Promise<{ notice: ClubPrivacyNoticeRow; created: boolean }> {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (text.length < NOTICE_MIN || text.length > NOTICE_MAX) {
    throw new ValidationError(`The privacy notice needs ${NOTICE_MIN} to ${NOTICE_MAX} characters`, { details: { code: "notice_length", min: NOTICE_MIN, max: NOTICE_MAX } });
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`privacy-notice:${clubId}`}, 0))`);
    const current = await latestPublishedNotice(clubId, tx);
    const hash = sha256Hex(text);
    if (current && current.sha256 === hash) return { notice: current, created: false };
    const [notice] = await tx
      .insert(clubPrivacyNotices)
      .values({ clubId, version: (current?.version ?? 0) + 1, body: text, sha256: hash, publishedAt: new Date(), publishedBy: userId })
      .returning();
    await writeAudit(tx, { eventType: "privacy_notice.publish", subjectId: notice!.id, payload: { clubId, version: notice!.version, sha256: hash } });
    return { notice: notice!, created: true };
  });
}
