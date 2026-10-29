/**
 * Retention classes of documents (Wave 13 B14), per `documents.doc_type`. The periods are PROPOSALS: the tool delivers the mechanism,
 * not the legal statement (open point E9 of the implementation plan); they have to be confirmed before `RETENTION_DRY_RUN=false`.
 * `startsOn`: `created` = from the creation of the document, `exit` = from the day the person leaves the club (documents of a
 * person that is still a member never expire; the date is set when the exit is booked and removed when the person comes back).
 * Doc types that are not listed (uploads, board uploads) have no retention date: they are kept until somebody deletes them.
 */

export type RetentionStart = "created" | "exit";

export interface DocumentRetentionClass {
  docType: string;
  class: "nachweis" | "protokoll" | "bericht" | "liste";
  label: string;
  years: number;
  startsOn: RetentionStart;
  description: string;
}

export const DOCUMENT_RETENTION_CLASSES: readonly DocumentRetentionClass[] = [
  { docType: "aufnahmebeleg", class: "nachweis", label: "Aufnahmebeleg", years: 3, startsOn: "exit", description: "Nachweis von Antrag und Einwilligungen, ab dem Austritt (regelmäßige Verjährungsfrist)" },
  { docType: "kuendigungsbestaetigung", class: "nachweis", label: "Kündigungsbestätigung", years: 3, startsOn: "exit", description: "Nachweis der Kündigung, ab dem Austritt" },
  { docType: "mitgliedsbestaetigung", class: "nachweis", label: "Mitgliedsbestätigung", years: 1, startsOn: "exit", description: "Bescheinigung auf Anfrage, ab dem Austritt" },
  { docType: "versammlung_protokoll", class: "protokoll", label: "Versammlungsprotokoll", years: 10, startsOn: "created", description: "Genehmigtes Protokoll, ab Ablage" },
  { docType: "versammlung_einladung", class: "protokoll", label: "Einladungsnachweis", years: 10, startsOn: "created", description: "Versandnachweis der Einladung, ab Ablage" },
  { docType: "bestaetigungsprotokoll", class: "nachweis", label: "Bestätigungsprotokoll", years: 10, startsOn: "created", description: "Nachweis über Bestätigungen von Dokumenten, ab Erzeugung" },
  { docType: "jahresbericht", class: "bericht", label: "Jahresbericht Mitglieder", years: 10, startsOn: "created", description: "Zahlenbericht ohne Namen, ab Erzeugung" },
  { docType: "mitgliederliste", class: "liste", label: "Mitgliederliste", years: 2, startsOn: "created", description: "Enthält personenbezogene Daten, kurze Frist, ab Erzeugung" },
  { docType: "anwesenheitsliste", class: "liste", label: "Anwesenheitsliste", years: 3, startsOn: "created", description: "Wie die Anwesenheitsdaten (3 Jahre), ab Erzeugung" },
  { docType: "teilnehmerliste", class: "liste", label: "Teilnehmerliste", years: 1, startsOn: "created", description: "Enthält Anmeldedaten, ab Erzeugung" },
];

export const classOfDocType = (docType: string): DocumentRetentionClass | undefined => DOCUMENT_RETENTION_CLASSES.find((c) => c.docType === docType);

/** `YYYY-MM-DD` plus whole years (29 Feb moves to 28 Feb). */
export function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y + years, m - 1, d));
  if (target.getUTCMonth() !== m - 1) target.setUTCDate(0);
  return target.toISOString().slice(0, 10);
}

/** `retention_until` of a new document of `docType`; `exitDate` is the exit day of the owner (null = still a member). */
export function retentionUntilFor(docType: string, createdOn: string, exitDate: string | null): string | null {
  const cls = classOfDocType(docType);
  if (!cls) return null;
  if (cls.startsOn === "created") return addYears(createdOn, cls.years);
  return exitDate ? addYears(exitDate, cls.years) : null;
}
