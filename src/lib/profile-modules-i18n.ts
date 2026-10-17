import type { FieldDefinition } from "./custom-fields.js";
import { MODULE_GROUPS, PROFILE_MODULES, type ModuleGroup, type ProfileModule } from "./profile-modules.js";

/**
 * Texts of the profile module catalog in the supported languages. German stays the source (`profile-modules.ts`, and what is
 * stored in an activated definition); English lives here, complete for every module and group (a test enforces it).
 * Option labels (e.g. "Helfer bei Festen") are not translated: their stored `value` is language independent, the label is
 * club content.
 */

export const LANGS = ["de", "en"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "de";

export interface ModuleText {
  label: string;
  description: string;
  /** null when the module has no help text. */
  helpText: string | null;
}

export const GROUP_LABELS_EN: Record<ModuleGroup, string> = {
  fuehrerschein: "Driving licence",
  qualifikationen: "Qualifications",
  kinderschutz: "Child protection",
  mitarbeit: "Volunteering",
  sport: "Sport and practical",
  persoenlich: "Personal and communication",
};

const CRED_HELP_EN = "Only tick this if you hold this qualification. The expiry date (valid until) is visible to the board and club officers.";
const SELF_DECLARED_EN = "Entries made by the person themselves are self-declarations and are not verified; the board can see whether an entry was made by the member or by the board.";

type En = { label: string; description: string; helpText?: string };

export const MODULE_TEXTS_EN: Record<string, En> = {
  mod_fs_klassen: { label: "Driving licence classes", description: "Which driving licence classes the person holds." },
  mod_fs_cd_gueltig_bis: { label: "Class C/D valid until", description: "Expiry date of the licence for class C/D (truck, bus)." },
  mod_fs_schluesselzahl_95: { label: "Code 95", description: "Driver qualification (code 95) held." },
  mod_fs_p_schein: { label: "Passenger transport (P licence)", description: "Passenger transport licence with validity.", helpText: CRED_HELP_EN },
  mod_fs_stapler: { label: "Forklift licence", description: "Forklift operator licence.", helpText: CRED_HELP_EN },
  mod_fs_feuerwehr: { label: "Fire service driving licence", description: "Fire service driving licence held." },
  mod_q_uebungsleiter: { label: "Instructor licence", description: "Instructor licence with level and validity.", helpText: CRED_HELP_EN },
  mod_q_juleica: { label: "JuLeiCa (youth leader card)", description: "Youth leader card with validity.", helpText: CRED_HELP_EN },
  mod_q_schiedsrichter: { label: "Referee / judge licence", description: "Licence with level (free text) and validity.", helpText: CRED_HELP_EN },
  mod_q_rettungsschwimmer: { label: "Lifeguard", description: "Lifeguard badge with level and validity.", helpText: CRED_HELP_EN },
  mod_q_sanitaeter: { label: "Paramedic / first aider", description: "Medical first responder training with validity.", helpText: CRED_HELP_EN },
  mod_q_erste_hilfe: { label: "First aid course", description: "Latest first aid course with validity.", helpText: CRED_HELP_EN },
  mod_q_bootsfuehrerschein: { label: "Boating licence", description: "Recreational boating licence with area and validity.", helpText: CRED_HELP_EN },
  mod_q_segelschein: { label: "Sailing licence", description: "Sailing licence with validity.", helpText: CRED_HELP_EN },
  mod_q_tauchbrevet: { label: "Diving certificate", description: "Diving certificate with validity.", helpText: CRED_HELP_EN },
  mod_q_hygiene: { label: "Food hygiene briefing", description: "Briefing under the Infection Protection Act (e.g. for serving at festivals) with validity.", helpText: CRED_HELP_EN },
  mod_q_funkschein: { label: "Radio licence", description: "Radio operator certificate with validity.", helpText: CRED_HELP_EN },
  mod_ks_fuehrungszeugnis: {
    label: "Extended police certificate",
    description: "Note that an extended police certificate was presented (never its content).",
    helpText: `This only records THAT an extended police certificate exists, when it was presented and until when it is valid. The content of the certificate is neither collected nor stored. ${SELF_DECLARED_EN}`,
  },
  mod_ks_selbstverpflichtung: { label: "Code of conduct declaration", description: "Child protection code of conduct declaration signed (with date).", helpText: `Only a note that the declaration was signed, and the date. ${SELF_DECLARED_EN}` },
  mod_ks_praevention: { label: "Prevention training", description: "Training on preventing sexualised violence with validity.", helpText: `Only a note that the training was attended and until when it is valid. ${SELF_DECLARED_EN}` },
  mod_mw_einsatz: { label: "Willingness to help", description: "What the person would help out with in the club." },
  mod_mw_fahrzeug: { label: "Vehicle / trailer available", description: "Vehicle that can be used for the club." },
  mod_mw_sitzplaetze: { label: "Free seats", description: "Free seats in the vehicle for carpools." },
  mod_mw_berufe: { label: "Professional skills", description: "Skills that can benefit the club." },
  mod_mw_sprachen: { label: "Languages", description: "Spoken languages." },
  mod_sp_trikot: { label: "Jersey size", description: "Size for jerseys." },
  mod_sp_konfektion: { label: "Clothing size", description: "Size for club clothing (jackets, trousers)." },
  mod_sp_schuh: { label: "Shoe size", description: "Shoe size (EU)." },
  mod_sp_position: { label: "Position / playing hand", description: "Playing position or playing hand." },
  mod_sp_schwimmabzeichen: { label: "Swimming badge", description: "Highest swimming badge." },
  mod_sp_verbandspass: { label: "Association / player licence no.", description: "Number of the association or player licence." },
  mod_sp_zweitverein: { label: "Second club", description: "Other club the person is a member of." },
  mod_pe_anrede: { label: "Salutation / title", description: "Preferred salutation or title." },
  mod_pe_kanal: { label: "Preferred channel", description: "How the person prefers to be contacted." },
  mod_pe_telefon2: { label: "Second phone number", description: "Additional phone number." },
};

export function moduleText(m: ProfileModule, lang: Lang): ModuleText {
  if (lang === "en") {
    const en = MODULE_TEXTS_EN[m.id];
    if (en) return { label: en.label, description: en.description, helpText: en.helpText ?? null };
  }
  return { label: m.label, description: m.description, helpText: m.helpText ?? null };
}

export function moduleTranslations(m: ProfileModule): Record<Lang, ModuleText> {
  return { de: moduleText(m, "de"), en: moduleText(m, "en") };
}

export function groupLabel(id: ModuleGroup, german: string, lang: Lang): string {
  return lang === "en" ? GROUP_LABELS_EN[id] : german;
}

export function localizedGroups(lang: Lang) {
  return MODULE_GROUPS.map((g) => ({ id: g.id, label: groupLabel(g.id, g.label, lang), translations: { de: { label: g.label }, en: { label: GROUP_LABELS_EN[g.id] } } }));
}

const BY_ID = new Map(PROFILE_MODULES.map((m) => [m.id, m]));

/**
 * Translations of an activated, module-derived definition: only while the board has not changed its label or help text
 * (a board-edited text is club content and is never replaced); otherwise (and for manual fields) null.
 */
export function definitionTranslations(d: Pick<FieldDefinition, "key" | "label" | "helpText">): Record<Lang, { label: string; helpText: string | null }> | null {
  const m = BY_ID.get(d.key);
  if (!m || d.label !== m.label || (d.helpText ?? null) !== (m.helpText ?? null)) return null;
  const t = moduleTranslations(m);
  return { de: { label: t.de.label, helpText: t.de.helpText }, en: { label: t.en.label, helpText: t.en.helpText } };
}

/** `?lang=de|en` (explicit, wins); with `acceptLanguage` also the first matching `Accept-Language` entry; default German. Unknown values: German. */
export function resolveLang(query: string | undefined, acceptLanguage?: string | null): Lang {
  const pick = (v: string): Lang | undefined => {
    const base = v.trim().toLowerCase().split(/[-_;]/)[0];
    return (LANGS as readonly string[]).includes(base ?? "") ? (base as Lang) : undefined;
  };
  if (query !== undefined) return pick(query) ?? DEFAULT_LANG;
  for (const part of (acceptLanguage ?? "").split(",")) {
    const found = pick(part);
    if (found) return found;
  }
  return DEFAULT_LANG;
}
