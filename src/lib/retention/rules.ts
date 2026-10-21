import { categoryRunners, type CategoryContext, type CategoryResult } from "./categories.js";

/**
 * Retention rules (Wave 10 B9). The defaults are PROPOSALS from the implementation plan (table "Aufbewahrungs-Vorschlaege") and
 * ship as code; nothing is deleted for real until `RETENTION_DRY_RUN=false` is set deliberately after the legal review (K2/K4).
 * A club may change the club-scoped periods inside `[minDays, maxDays]` (table `retention_policies`); platform categories are
 * fixed (only a platform-level row in `retention_policies` with `club_id IS NULL` changes them, within the same limits).
 *
 * Not deleted by design: meeting minutes and resolutions, attendance of assemblies (Wave 11), anything the later billing module
 * must keep by law (it registers its own rule). Export documents are generated on the fly and never stored, so there is no
 * file to expire for them.
 */

export type RetentionScope = "platform" | "club";

export interface RetentionRule {
  category: keyof typeof categoryRunners;
  scope: RetentionScope;
  defaultDays: number;
  minDays: number;
  maxDays: number;
  /** German label for clubs and the privacy notice. */
  label: string;
  /** What is deleted / anonymised and from when the period counts. */
  description: string;
  run(ctx: CategoryContext): Promise<CategoryResult>;
}

const rule = (r: Omit<RetentionRule, "run">): RetentionRule => ({ ...r, run: categoryRunners[r.category] });

export const RETENTION_RULES: readonly RetentionRule[] = [
  rule({ category: "registration_proofs_approved", scope: "platform", defaultDays: 180, minDays: 30, maxDays: 3650, label: "Gründungsnachweise (freigegeben)", description: "Nachweisdokumente einer freigegebenen Vereinsregistrierung, gerechnet ab der Freigabe" }),
  rule({ category: "registration_proofs_rejected", scope: "platform", defaultDays: 90, minDays: 30, maxDays: 3650, label: "Gründungsnachweise (abgelehnt)", description: "Nachweisdokumente einer abgelehnten Vereinsregistrierung, gerechnet ab der Entscheidung" }),
  rule({ category: "registration_proofs_stale", scope: "platform", defaultDays: 30, minDays: 7, maxDays: 365, label: "Gründungsnachweise (nie eingereicht)", description: "Nachweisdokumente eines nicht eingereichten Registrierungsentwurfs, gerechnet ab der letzten Änderung" }),
  rule({ category: "audit_log_auth", scope: "platform", defaultDays: 180, minDays: 30, maxDays: 3650, label: "Anmeldeprotokoll", description: "Einträge über Anmeldungen (Sitzungen), gerechnet ab dem Ereignis" }),
  rule({ category: "audit_log", scope: "platform", defaultDays: 730, minDays: 180, maxDays: 3650, label: "Zugriffs- und Änderungsprotokoll", description: "Einträge über Zugriffe und Änderungen an Daten, gerechnet ab dem Ereignis" }),
  rule({ category: "applications_rejected", scope: "club", defaultDays: 180, minDays: 30, maxDays: 1095, label: "Abgelehnte Aufnahmeanträge", description: "Angaben in abgelehnten oder zurückgezogenen Aufnahmeanträgen, gerechnet ab der Entscheidung" }),
  rule({ category: "interested_without_join", scope: "club", defaultDays: 365, minDays: 90, maxDays: 1095, label: "Interessent:innen ohne Beitritt", description: "Erfasste Interessent:innen ohne Konto und ohne offenen Antrag, gerechnet ab der letzten Änderung" }),
  rule({ category: "former_members", scope: "club", defaultDays: 730, minDays: 365, maxDays: 3650, label: "Ehemalige Mitglieder", description: "Stammdaten ehemaliger Mitglieder werden anonymisiert, gerechnet ab dem Austritt" }),
  rule({ category: "emergency_contacts_left", scope: "club", defaultDays: 30, minDays: 0, maxDays: 365, label: "Notfallkontakte Ausgetretener", description: "Notfallkontakt ehemaliger Mitglieder, gerechnet ab dem Austritt" }),
  rule({ category: "absence_reports", scope: "club", defaultDays: 90, minDays: 30, maxDays: 365, label: "Krankmeldungen und Abwesenheiten", description: "Meldungen, gerechnet ab dem Ende der Abwesenheit" }),
  rule({ category: "consent_proofs", scope: "club", defaultDays: 1095, minDays: 365, maxDays: 3650, label: "Einwilligungsnachweise", description: "Nachweise widerrufener Einwilligungen (ab Widerruf) und Nachweise ehemaliger Mitglieder (ab Austritt)" }),
];

export function ruleOf(category: string): RetentionRule | undefined {
  return RETENTION_RULES.find((r) => r.category === category);
}

export const clamp = (rule: Pick<RetentionRule, "minDays" | "maxDays">, days: number): number => Math.min(rule.maxDays, Math.max(rule.minDays, Math.floor(days)));
