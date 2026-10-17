import type { CustomFieldType } from "./custom-fields.js";
import type { FormField } from "./form-schema.js";

/**
 * Catalog of ready-made, OPTIONAL profile modules ("Profil-Bausteine") the board can activate per club with one click.
 * Code, not data: nothing exists in a club until `POST /member-fields/catalog/:moduleId/activate` creates the matching
 * custom field definition (`member_field_definitions`, key = module id, so every module is at most once per club).
 *
 * Rules (product decisions):
 * - modules are NEVER mandatory for members. Custom fields have no `required` flag at all, and a published form must not
 *   require a module field of the groups `fuehrerschein`, `qualifikationen`, `kinderschutz` (see `isNeverMandatoryKey`);
 * - qualification-like modules are `credential` fields (holds it + optional level + `validUntil`), the expiry is shown to the
 *   board / Funktionsträger with a computed status (`src/lib/credentials.ts`); there are NO reminders until Wave 9;
 * - default visibility `funktionstraeger` (board + trainer + Abteilungsleitung, see `custom-field-access.ts`), Kinderschutz
 *   modules are `sensitive` with visibility `vorstand` (values only for `members:read_sensitive` and the person itself);
 * - everything is editable by the person itself (`editableBy: self`) and by the board (`members:write`);
 * - health / emergency-medical data is NOT part of the catalog (Wave 10, GDPR Art. 9).
 */

export const MODULE_GROUPS = [
  { id: "fuehrerschein", label: "Führerschein" },
  { id: "qualifikationen", label: "Qualifikationen" },
  { id: "kinderschutz", label: "Kinderschutz" },
  { id: "mitarbeit", label: "Mitarbeit" },
  { id: "sport", label: "Sport und Praktisches" },
  { id: "persoenlich", label: "Persönlich und Kommunikation" },
] as const;
export type ModuleGroup = (typeof MODULE_GROUPS)[number]["id"];

/** Groups whose modules can never be made mandatory (not even through a form). */
export const NEVER_MANDATORY_GROUPS: readonly ModuleGroup[] = ["fuehrerschein", "qualifikationen", "kinderschutz"];

export interface ProfileModule {
  /** Stable id AND custom field key (prefix `mod_`, matches FIELD_KEY_RE). */
  id: string;
  group: ModuleGroup;
  label: string;
  description: string;
  helpText?: string;
  type: CustomFieldType;
  options?: Array<{ value: string; label: string }>;
  validation?: NonNullable<FormField["validation"]>;
  visibleTo: "vorstand" | "funktionstraeger" | "mitglied";
  editableBy: "self";
  sensitive: boolean;
}

const opts = (...labels: string[]) => labels.map((label) => ({ value: label.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label }));
const range = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => String(from + i * step));

type Seed = Omit<ProfileModule, "visibleTo" | "editableBy" | "sensitive" | "description"> & Partial<Pick<ProfileModule, "visibleTo" | "sensitive" | "description">>;

/** Kinderschutz entries made by the person itself or a guardian are claims, not checked by the club (the board sees `enteredBy`). */
const SELF_DECLARED = "Angaben des Mitglieds selbst oder seiner Erziehungsberechtigten sind eine Selbstangabe und werden nicht geprüft; der Vorstand sieht, ob ein Eintrag vom Mitglied, von Erziehungsberechtigten oder vom Vorstand stammt.";

const CRED_HELP = "Nur ankreuzen, wenn du diese Qualifikation hast. Das Ablaufdatum (gültig bis) sehen Vorstand und Funktionsträger.";

function build(seeds: Seed[]): ProfileModule[] {
  return seeds.map((s) => ({
    visibleTo: "funktionstraeger",
    sensitive: false,
    description: "",
    ...s,
    editableBy: "self" as const,
  }));
}

export const PROFILE_MODULES: readonly ProfileModule[] = build([
  // --- Führerschein ---
  { id: "mod_fs_klassen", group: "fuehrerschein", label: "Führerscheinklassen", description: "Welche Führerscheinklassen die Person besitzt.", type: "multiselect", options: opts("AM", "A1", "A2", "A", "B", "B96", "BE", "C1", "C1E", "C", "CE", "D1", "D1E", "D", "DE", "L", "T", "Mofa-Prüfbescheinigung") },
  { id: "mod_fs_cd_gueltig_bis", group: "fuehrerschein", label: "Klasse C/D gültig bis", description: "Ablaufdatum der Fahrerlaubnis für Klasse C/D (Lkw, Bus).", type: "date" },
  { id: "mod_fs_schluesselzahl_95", group: "fuehrerschein", label: "Schlüsselzahl 95", description: "Berufskraftfahrer-Qualifikation (Schlüsselzahl 95) vorhanden.", type: "checkbox" },
  { id: "mod_fs_p_schein", group: "fuehrerschein", label: "Fahrgastbeförderung (P-Schein)", description: "Personenbeförderungsschein mit Gültigkeit.", helpText: CRED_HELP, type: "credential" },
  { id: "mod_fs_stapler", group: "fuehrerschein", label: "Staplerschein", description: "Flurförderzeugführerschein (Gabelstapler).", helpText: CRED_HELP, type: "credential" },
  { id: "mod_fs_feuerwehr", group: "fuehrerschein", label: "Feuerwehr-Führerschein", description: "Feuerwehr-Führerschein vorhanden.", type: "checkbox" },
  // --- Qualifikationen ---
  { id: "mod_q_uebungsleiter", group: "qualifikationen", label: "Übungsleiter-Lizenz", description: "Übungsleiterlizenz mit Stufe und Gültigkeit.", helpText: CRED_HELP, type: "credential", options: opts("C", "B", "A", "Jugend") },
  { id: "mod_q_juleica", group: "qualifikationen", label: "JuLeiCa", description: "Jugendleiter-Card mit Gültigkeit.", helpText: CRED_HELP, type: "credential" },
  { id: "mod_q_schiedsrichter", group: "qualifikationen", label: "Schiedsrichter-/Kampfrichter-Lizenz", description: "Lizenz mit Stufe (Freitext) und Gültigkeit.", helpText: CRED_HELP, type: "credential", validation: { maxLength: 60 } },
  { id: "mod_q_rettungsschwimmer", group: "qualifikationen", label: "Rettungsschwimmer", description: "Rettungsschwimmabzeichen mit Stufe und Gültigkeit.", helpText: CRED_HELP, type: "credential", options: opts("Bronze", "Silber", "Gold") },
  { id: "mod_q_sanitaeter", group: "qualifikationen", label: "Sanitäter", description: "Sanitätsausbildung mit Gültigkeit.", helpText: CRED_HELP, type: "credential" },
  { id: "mod_q_erste_hilfe", group: "qualifikationen", label: "Erste-Hilfe-Kurs", description: "Letzter Erste-Hilfe-Kurs mit Gültigkeit.", helpText: CRED_HELP, type: "credential" },
  { id: "mod_q_bootsfuehrerschein", group: "qualifikationen", label: "Bootsführerschein", description: "Sportbootführerschein mit Revier und Gültigkeit.", helpText: CRED_HELP, type: "credential", options: opts("Binnen", "See") },
  { id: "mod_q_segelschein", group: "qualifikationen", label: "Segelschein", description: "Segelschein mit Gültigkeit.", helpText: CRED_HELP, type: "credential" },
  { id: "mod_q_tauchbrevet", group: "qualifikationen", label: "Tauchbrevet", description: "Tauchbrevet mit Gültigkeit.", helpText: CRED_HELP, type: "credential" },
  { id: "mod_q_hygiene", group: "qualifikationen", label: "Hygienebelehrung", description: "Belehrung nach Infektionsschutzgesetz (z. B. für Festausschank) mit Gültigkeit.", helpText: CRED_HELP, type: "credential" },
  { id: "mod_q_funkschein", group: "qualifikationen", label: "Funkschein", description: "Funkbetriebszeugnis mit Gültigkeit.", helpText: CRED_HELP, type: "credential" },
  // --- Kinderschutz (sensitive, board only) ---
  {
    id: "mod_ks_fuehrungszeugnis",
    group: "kinderschutz",
    label: "Erweitertes Führungszeugnis",
    description: "Vermerk, dass ein erweitertes Führungszeugnis vorgelegt wurde (nie der Inhalt).",
    helpText: `Hier wird nur festgehalten, DASS ein erweitertes Führungszeugnis vorliegt, wann es vorgelegt wurde und bis wann es gilt. Der Inhalt des Zeugnisses wird nicht erfasst und nicht gespeichert. ${SELF_DECLARED}`,
    type: "credential",
    visibleTo: "vorstand",
    sensitive: true,
  },
  { id: "mod_ks_selbstverpflichtung", group: "kinderschutz", label: "Selbstverpflichtungserklärung", description: "Selbstverpflichtungserklärung zum Kinderschutz abgegeben (mit Datum).", helpText: `Nur Vermerk, dass die Erklärung abgegeben wurde, und das Datum. ${SELF_DECLARED}`, type: "credential", visibleTo: "vorstand", sensitive: true },
  { id: "mod_ks_praevention", group: "kinderschutz", label: "Präventionsschulung", description: "Schulung zur Prävention sexualisierter Gewalt mit Gültigkeit.", helpText: `Nur Vermerk, dass die Schulung besucht wurde, und bis wann sie gilt. ${SELF_DECLARED}`, type: "credential", visibleTo: "vorstand", sensitive: true },
  // --- Mitarbeit ---
  { id: "mod_mw_einsatz", group: "mitarbeit", label: "Einsatzbereitschaft", description: "Wobei die Person im Verein mithelfen würde.", type: "multiselect", options: opts("Helfer bei Festen", "Fahrdienst", "Kuchen", "Trainer", "Schiedsrichter", "Aufbau", "Jugendleitung") },
  { id: "mod_mw_fahrzeug", group: "mitarbeit", label: "Fahrzeug/Anhänger vorhanden", description: "Fahrzeug, das für den Verein genutzt werden kann.", type: "select", options: opts("Auto", "Bus/Transporter", "Anhänger") },
  { id: "mod_mw_sitzplaetze", group: "mitarbeit", label: "Freie Sitzplätze", description: "Freie Sitzplätze im Fahrzeug für Fahrgemeinschaften.", type: "number", validation: { min: 0, max: 9 } },
  { id: "mod_mw_berufe", group: "mitarbeit", label: "Berufliche Fähigkeiten", description: "Fähigkeiten, die dem Verein nützen können.", type: "multiselect", options: opts("Handwerk", "IT", "Recht", "Steuern", "Medien", "Sonstiges") },
  { id: "mod_mw_sprachen", group: "mitarbeit", label: "Sprachen", description: "Gesprochene Sprachen.", type: "text", validation: { maxLength: 200 } },
  // --- Sport / Praktisches ---
  { id: "mod_sp_trikot", group: "sport", label: "Trikotgröße", description: "Größe für Trikots.", type: "select", options: [...range(116, 164, 12).map((v) => ({ value: v, label: v })), ...opts("XS", "S", "M", "L", "XL", "XXL", "3XL")] },
  { id: "mod_sp_konfektion", group: "sport", label: "Konfektionsgröße", description: "Größe für Vereinskleidung (Jacken, Hosen).", type: "select", options: range(32, 60, 2).map((v) => ({ value: v, label: v })) },
  { id: "mod_sp_schuh", group: "sport", label: "Schuhgröße", description: "Schuhgröße (EU).", type: "select", options: range(28, 50).map((v) => ({ value: v, label: v })) },
  { id: "mod_sp_position", group: "sport", label: "Position/Spielhand", description: "Spielposition oder Spielhand.", type: "text", validation: { maxLength: 60 } },
  { id: "mod_sp_schwimmabzeichen", group: "sport", label: "Schwimmabzeichen", description: "Höchstes Schwimmabzeichen.", type: "select", options: opts("Seepferdchen", "Bronze", "Silber", "Gold") },
  { id: "mod_sp_verbandspass", group: "sport", label: "Verbandspass-/Startpass-Nr.", description: "Nummer des Verbands- oder Startpasses.", type: "text", validation: { maxLength: 40 } },
  { id: "mod_sp_zweitverein", group: "sport", label: "Zweitverein", description: "Weiterer Verein, in dem die Person Mitglied ist.", type: "text", validation: { maxLength: 120 } },
  // --- Persönlich / Kommunikation ---
  { id: "mod_pe_anrede", group: "persoenlich", label: "Anrede/Titel", description: "Gewünschte Anrede oder Titel.", type: "text", validation: { maxLength: 40 } },
  { id: "mod_pe_kanal", group: "persoenlich", label: "Bevorzugter Kanal", description: "Wie die Person am liebsten kontaktiert wird.", type: "select", options: opts("E-Mail", "Telefon", "Messenger") },
  { id: "mod_pe_telefon2", group: "persoenlich", label: "Zweite Telefonnummer", description: "Weitere Telefonnummer.", type: "text", validation: { maxLength: 50 } },
]);

const BY_ID = new Map(PROFILE_MODULES.map((m) => [m.id, m]));

export function findModule(id: string): ProfileModule | undefined {
  return BY_ID.get(id);
}

/** True for definition keys of modules that must never be mandatory (driving licence, qualifications, Kinderschutz). */
export function isNeverMandatoryKey(key: string): boolean {
  const m = BY_ID.get(key);
  return m !== undefined && NEVER_MANDATORY_GROUPS.includes(m.group);
}

/** Position of a module in the catalog, used as `sort_order` (after manually created fields, which default to 0). */
export function moduleSortOrder(id: string): number {
  return 1000 + PROFILE_MODULES.findIndex((m) => m.id === id);
}
